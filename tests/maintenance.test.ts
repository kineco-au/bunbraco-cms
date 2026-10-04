/**
 * Operating a live cluster: the cluster-wide pause on editing, and which nodes
 * keep serving while the database moves ahead of them.
 *
 * The failure modes are silent. A pause that drained nodes would take the site
 * down for a restore that only needed editors to stop; a `web` node that drained
 * the moment it fell behind would drain every renderer at an upgrade's cut-over,
 * before a single new node could boot — and readers would see the gap.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, editingPaused, pauseEditing, resumeEditing } from '@bunbraco/cli'
import {
  appendSchemaState,
  assertNodeMayWrite,
  bunbracoPlan,
  connect,
  currentSchemaState,
  type Db,
  liveNodes,
  migrate,
  pauseWrites,
  readWritesPaused,
  recordInLedger,
  resumeWrites,
  WriteRejectedError,
  WritesPausedError,
} from '@bunbraco/data'
import { type BunbracoConfig, createServer, loadConfig, type ServerHandle } from '@bunbraco/server'
import { dialectUnderTest, freshDb } from './support/db.ts'

const open: Db[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
})

async function installed(): Promise<Db> {
  const db = await freshDb()
  open.push(db)
  await migrate(db, bunbracoPlan)
  return db
}

describe(`the pause on editing (${dialectUnderTest})`, () => {
  test('refuses a write from a current node, with the reason, until resumed', async () => {
    const db = await installed()
    const current = await currentSchemaState(db)
    const node = { version: current.version, revision: current.revision }
    await expect(assertNodeMayWrite(db, node)).resolves.toMatchObject({ id: current.id })

    await pauseWrites(db, { reason: 'restoring Monday’s backup', by: 'operator' })
    const refused = await assertNodeMayWrite(db, node).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(WritesPausedError)
    // A subclass, so every adapter that answers a refused write with 409 already does here.
    expect(refused).toBeInstanceOf(WriteRejectedError)
    expect((refused as Error).message).toContain('restoring Monday’s backup')
    expect(await readWritesPaused(db)).toMatchObject({
      reason: 'restoring Monday’s backup',
      by: 'operator',
    })

    await resumeWrites(db)
    expect(await readWritesPaused(db)).toBeUndefined()
    await expect(assertNodeMayWrite(db, node)).resolves.toMatchObject({ id: current.id })
  })
})

// Two nodes over one database: a file on SQLite, which is what can be shared here.
describe.skipIf(dialectUnderTest !== 'sqlite')('nodes while the database moves (sqlite)', () => {
  let dir: string
  let shared: string
  let editing: ServerHandle
  let web: ServerHandle
  let operator: Db

  const configFor = (overrides: Partial<BunbracoConfig> = {}) =>
    loadConfig({ sqliteFile: shared, development: false, ...overrides })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bunbraco-maintenance-'))
    shared = join(dir, 'site.sqlite')
    editing = await createServer(configFor({ nodeId: 'node-editing' }))
    web = await createServer(configFor({ role: 'web', nodeId: 'node-web' }))
    operator = await connect({ dialect: 'sqlite', file: shared })
  }, 60_000)

  afterAll(async () => {
    await operator?.close()
    await Promise.all([editing?.close(), web?.close()])
    rmSync(dir, { recursive: true, force: true })
  })

  test('the cluster reads back by role: every node that has polled lately', async () => {
    await Promise.all([editing.poll(), web.poll()])
    expect(
      (await liveNodes(operator, { seenWithinMs: 60_000 })).map((n) => [n.nodeId, n.role]),
    ).toEqual([
      ['node-editing', 'all'],
      ['node-web', 'web'],
    ])
    // A node that has not polled within the window is not part of it.
    expect(await liveNodes(operator, { seenWithinMs: -60_000 })).toEqual([])
  })

  test('the command-line functions pause and resume editing, and take a backup', async () => {
    const config = configFor({ nodeId: 'operator' })
    expect(await editingPaused(config)).toBeUndefined()
    expect(await pauseEditing(config, { reason: 'restore' })).toMatchObject({
      reason: 'restore',
      by: 'operator',
    })
    expect(await editingPaused(config)).toMatchObject({ reason: 'restore' })
    await resumeEditing(config)
    expect(await editingPaused(config)).toBeUndefined()

    const taken = await backup(config, { reason: 'before-swap' })
    expect(taken.kind).toBe('sqlite-copy')
    expect(taken.path).toContain('before-swap')
    rmSync(taken.path as string, { force: true })
  })

  test('a pause makes every node read-only and drains none of them', async () => {
    await pauseWrites(operator, { reason: 'swapping in the rehearsal' })
    await Promise.all([editing.poll(), web.poll()])
    for (const node of [editing, web])
      expect(node.health()).toMatchObject({
        ok: true,
        readOnly: true,
        paused: { reason: 'swapping in the rehearsal' },
      })

    await resumeWrites(operator)
    await Promise.all([editing.poll(), web.poll()])
    for (const node of [editing, web])
      expect(node.health()).toMatchObject({ ok: true, readOnly: false, paused: null })
  })

  test('behind the database: the editing node drains, a web node keeps serving until a contract passes it', async () => {
    const current = await currentSchemaState(operator)
    await appendSchemaState(operator, {
      version: `${current.version}.1`,
      revision: `${Number(current.revision) + 1}`,
      status: 'current',
      by: 'operator',
    })
    await Promise.all([editing.poll(), web.poll()])

    expect(editing.health()).toMatchObject({ ok: false, readOnly: true })
    expect(web.health()).toMatchObject({ ok: true, readOnly: true })
    expect((await web.fetch(new Request('http://localhost/health'))).status).toBe(200)

    // A purge removes what an old node may still read: from here it must stop.
    await recordInLedger(operator, {
      name: 'purge article.summary',
      kind: 'contract',
      durationMs: 1,
    })
    await web.poll()
    expect(web.health()).toMatchObject({ ok: false, readOnly: true })
    expect((await web.fetch(new Request('http://localhost/health'))).status).toBe(503)

    // And it stays drained: only a replacement node is trusted again.
    await web.poll()
    expect(web.health().ok).toBe(false)
  })
})
