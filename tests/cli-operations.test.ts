/**
 * The commands for running a site (stories 151, 152, 153): its users, its
 * search index, cache, health and recycle bin, and its media in bulk. Each is
 * driven through the CLI against a SQLite site of its own; what the recycle bin
 * relies on in the data layer is tested on both dialects at the end.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuthStore, verifyPassword } from '@crombolo/auth'
import { ObjectTypes } from '@crombolo/core'
import {
  ContentTypeRepository,
  cacheInstructionsAfter,
  connect,
  currentSchemaState,
  type Db,
  DocumentRepository,
  NodeRepository,
  UserRepository,
} from '@crombolo/data'
import { ensureApiClient } from '@crombolo/server'
import { ERROR_KINDS, OUTCOMES } from '../packages/cli/src/errors.ts'
import { ROOT } from '../scripts/packages.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const BIN = join(ROOT, 'packages/cli/bin/crombolo.ts')
const ADMIN = 'admin@crombolo.local'
let site: string

const env = () => ({
  ...process.env,
  CROMBOLO_DB: 'sqlite',
  CROMBOLO_SQLITE_FILE: join(site, 'site.sqlite'),
  CROMBOLO_MEDIA_DIR: join(site, 'media'),
  CROMBOLO_ADMIN_LOGIN: ADMIN,
  CROMBOLO_SECRET_KEY: 'a-test-secret-key-that-is-long-enough-to-use',
})

function cli(args: string[], stdin?: string) {
  const proc = Bun.spawnSync(['bun', BIN, ...args], {
    cwd: site,
    env: env(),
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
  })
  const out = proc.stdout.toString()
  const err = proc.stderr.toString()
  return {
    code: proc.exitCode,
    out,
    err,
    json: <T>() => JSON.parse(out) as T,
    envelope: () =>
      (JSON.parse(err.trim().split('\n').at(-1) ?? '{}') as { error?: Record<string, unknown> })
        .error ?? {},
  }
}

/** The site's database, opened beside the CLI: nothing else has it open. */
async function withDb<T>(work: (db: Db) => Promise<T>): Promise<T> {
  const db = await connect({ dialect: 'sqlite', file: join(site, 'site.sqlite') })
  try {
    return await work(db)
  } finally {
    await db.close()
  }
}

beforeAll(() => {
  site = mkdtempSync(join(process.cwd(), 'output', 'cli-operations-'))
  mkdirSync(join(site, 'schema'), { recursive: true })
  writeFileSync(join(site, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  // The first command creates the database and its administrator.
  expect(cli(['users', 'list', '-o', 'json']).code).toBe(0)
})
afterAll(() => rmSync(site, { recursive: true, force: true }))

describe('users (151)', () => {
  test('lists every user, the built-in administrator included, with their groups', () => {
    const { items } = cli(['users', 'list', '-o', 'json']).json<{
      items: Array<{ email: string; groups: string[]; state: string }>
    }>()
    expect(items.find((u) => u.email === ADMIN)?.groups).toContain('admin')
  })

  test('invites a user and prints the link, with no e-mail delivery', () => {
    const result = cli(['users', 'invite', 'ada@example.test', '--group', 'editor', '-o', 'json'])
    expect(result.code, result.err).toBe(0)
    const invited = result.json<{ link: string; groups: string[] }>()
    expect(invited.link).toContain('flow=invite-user')
    expect(invited.link).toContain('inviteCode=')
    const { items } = cli(['users', 'list', '-o', 'json']).json<{
      items: Array<{ email: string; state: string }>
    }>()
    expect(items.find((u) => u.email === 'ada@example.test')?.state).toBe('Invited')
    expect(cli(['users', 'invite', 'bob@example.test', '--group', 'nobody']).code).toBe(
      ERROR_KINDS.not_found.exitCode,
    )
    expect(cli(['users', 'invite', 'bob@example.test']).code).toBe(ERROR_KINDS.usage.exitCode)
  })

  test('unlocks a locked-out user, and says when there was nothing to do', async () => {
    await withDb(async (db) => {
      const user = await new AuthStore(db).findUserByLogin(ADMIN)
      await new AuthStore(db).lockOut(user?.id as number)
    })
    const unlocked = cli(['users', 'unlock', ADMIN, '-o', 'json'])
    expect(unlocked.code, unlocked.err).toBe(0)
    expect(unlocked.json<{ changed: boolean }>().changed).toBe(true)
    expect(cli(['users', 'unlock', ADMIN, '-o', 'json']).json<{ changed: boolean }>().changed).toBe(
      false,
    )
    expect(cli(['users', 'unlock', 'nobody@example.test']).code).toBe(
      ERROR_KINDS.not_found.exitCode,
    )
  })

  test('disables and enables a user', () => {
    cli(['users', 'invite', 'cy@example.test', '--group', 'writer'])
    // An invitation is not a user that can be disabled yet.
    expect(cli(['users', 'disable', 'cy@example.test']).code).toBe(ERROR_KINDS.refused.exitCode)
    expect(cli(['users', 'disable', ADMIN, '-o', 'json']).json<{ state: string }>().state).toBe(
      'Disabled',
    )
    expect(cli(['users', 'enable', ADMIN, '-o', 'json']).json<{ state: string }>().state).not.toBe(
      'Disabled',
    )
  })

  test('resets a password, generated or given on stdin', async () => {
    const generated = cli(['users', 'reset-password', ADMIN, '-o', 'json']).json<{
      password: string
    }>()
    const hash = async () =>
      withDb(async (db) => (await new AuthStore(db).findUserByLogin(ADMIN))?.passwordHash ?? '')
    expect(await verifyPassword(generated.password, await hash())).toBe(true)
    const given = cli(
      ['users', 'reset-password', ADMIN, '--stdin', '-o', 'json'],
      'a long chosen password',
    )
    expect(given.code, given.err).toBe(0)
    expect(given.json<{ password: string | null }>().password).toBeNull()
    expect(await verifyPassword('a long chosen password', await hash())).toBe(true)
    expect(cli(['users', 'reset-password', ADMIN, '--stdin'], 'short').code).toBe(
      ERROR_KINDS.usage.exitCode,
    )
  })

  test('a reset of a second factor nobody has changes nothing', () => {
    const result = cli(['users', 'reset-2fa', ADMIN, '-o', 'json'])
    expect(result.json()).toMatchObject({ removed: [], changed: false })
  })

  test('rotates the API client secret: the new one works, the old one does not', async () => {
    await withDb((db) =>
      ensureApiClient(db, { id: 'crombolo-back-office-ci', secret: 'the old secret, long' }),
    )
    const rotated = cli([
      'api-client',
      'rotate',
      '--client',
      'crombolo-back-office-ci',
      '-o',
      'json',
    ])
    expect(rotated.code, rotated.err).toBe(0)
    const { secret } = rotated.json<{ secret: string }>()
    const stored = await withDb(
      async (db) =>
        (await new UserRepository(db).clientCredentialOwner('crombolo-back-office-ci'))
          ?.secretHash ?? '',
    )
    expect(await verifyPassword(secret, stored)).toBe(true)
    expect(await verifyPassword('the old secret, long', stored)).toBe(false)
    expect(cli(['api-client', 'rotate', '--client', 'nobody']).code).toBe(
      ERROR_KINDS.not_found.exitCode,
    )
  })
})

describe('media in bulk (153)', () => {
  let photos: string
  beforeAll(() => {
    photos = join(site, 'incoming')
    mkdirSync(join(photos, 'trips', 'spring'), { recursive: true })
    cpSync(join(ROOT, 'tests/fixtures/pixel.png'), join(photos, 'cover.png'))
    cpSync(join(ROOT, 'tests/fixtures/halves.png'), join(photos, 'trips', 'spring', 'lake.png'))
    writeFileSync(join(photos, 'trips', 'notes.txt'), 'a note')
  })

  test('a dry run says what it would create, and creates nothing', async () => {
    const dry = cli(['media', 'import', photos, '--dry-run', '-o', 'json']).json<{
      created: number
      folders: number
    }>()
    expect(dry).toMatchObject({ created: 3, folders: 2 })
    const count = await withDb(async (db) =>
      Number(
        (
          await db.query<{ n: number }>(
            'SELECT COUNT(*) AS n FROM node WHERE node_object_type = ?',
            [ObjectTypes.Media],
          )
        )[0]?.n,
      ),
    )
    expect(count).toBe(0)
  })

  test('imports the folders and files, typed by extension', async () => {
    const result = cli(['media', 'import', photos, '-o', 'json'])
    expect(result.code, result.err).toBe(0)
    expect(result.json()).toMatchObject({ created: 3, folders: 2, skipped: 0, changed: true })
    const names = await withDb(async (db) =>
      (
        await db.query<{ text: string }>(
          'SELECT text FROM node WHERE node_object_type = ? ORDER BY text',
          [ObjectTypes.Media],
        )
      ).map((r) => r.text),
    )
    expect(names).toEqual(['cover.png', 'lake.png', 'notes.txt', 'spring', 'trips'])
  })

  test('runs again from where it got to: the same bytes are skipped, different ones reported', () => {
    expect(cli(['media', 'import', photos, '-o', 'json']).json()).toMatchObject({
      created: 0,
      folders: 0,
      skipped: 3,
      changed: false,
    })
    writeFileSync(join(photos, 'trips', 'notes.txt'), 'a different note')
    expect(
      cli(['media', 'import', photos, '-o', 'json']).json<{ differs: string[] }>().differs,
    ).toEqual([join('trips', 'notes.txt')])
  })

  test('exports them back out as the same files in the same folders', () => {
    const out = join(site, 'exported')
    const result = cli(['media', 'export', '--out', out, '-o', 'json'])
    expect(result.code, result.err).toBe(0)
    expect(result.json<{ files: number }>().files).toBe(3)
    expect(readFileSync(join(out, 'trips', 'spring', 'lake.png'))).toEqual(
      readFileSync(join(ROOT, 'tests/fixtures/halves.png')),
    )
    expect(readFileSync(join(out, 'trips', 'notes.txt'), 'utf8')).toBe('a note')
  })
})

describe('operating the site (152)', () => {
  test('lists the search indexes, and rebuilds them here, for every node', () => {
    const listed = cli(['index', 'list', '-o', 'json']).json<{ items: Array<{ name: string }> }>()
    expect(listed.items.map((i) => i.name)).toEqual(['InternalIndex', 'MembersIndex'])
    const queued = cli(['index', 'rebuild', 'InternalIndex', '--queue-only', '-o', 'json'])
    expect(queued.json()).toMatchObject({ indexes: ['InternalIndex'], queued: true })
    const after = cli(['index', 'list', '-o', 'json']).json<{
      items: Array<{ name: string; pending: number }>
    }>()
    expect(after.items[0]?.pending).toBeGreaterThan(0)
    const rebuilt = cli(['index', 'rebuild', '-o', 'json']).json<{ indexed: number }>()
    expect(rebuilt.indexed).toBeGreaterThan(0)
    const done = cli(['index', 'list', '-o', 'json']).json<{
      items: Array<{ pending: number; healthy: boolean }>
    }>()
    expect(done.items.every((i) => i.healthy)).toBe(true)
  })

  test('a cache rebuild is an instruction every node acts on, from no node of its own', async () => {
    const before = await withDb(async (db) => (await cacheInstructionsAfter(db, 0)).length)
    const result = cli(['cache', 'rebuild', '-o', 'json'])
    expect(result.code, result.err).toBe(0)
    const latest = await withDb(async (db) => (await cacheInstructionsAfter(db, 0)).at(-1))
    expect(await withDb(async (db) => (await cacheInstructionsAfter(db, 0)).length)).toBe(
      before + 1,
    )
    expect(latest).toMatchObject({ kind: 'content', payload: { all: true } })
    expect(latest?.createdBy).toStartWith('cli:')
  })

  test('runs the health checks, and exits 20 only when one fails', () => {
    const result = cli(['health', '-o', 'json'])
    const report = result.json<{ groups: Array<{ name: string }>; failed: number }>()
    expect(report.groups.map((g) => g.name)).toContain('Database')
    expect(result.code).toBe(report.failed > 0 ? OUTCOMES.problems_found.code : 0)
    const database = cli(['health', '--group', 'database', '-o', 'json'])
    expect(database.json<{ groups: unknown[] }>().groups).toHaveLength(1)
    expect(cli(['health', '--group', 'nothing']).code).toBe(ERROR_KINDS.not_found.exitCode)
  })

  test('empties the recycle bin: a dry run, a recent item kept by --older-than, then for good', async () => {
    await withDb(async (db) => {
      const state = await currentSchemaState(db)
      const repo = new DocumentRepository(db, {
        kind: 'media',
        nodeState: { version: state.version, revision: state.revision },
      })
      const cover = (
        await db.query<{ unique_id: string }>("SELECT unique_id FROM node WHERE text = 'cover.png'")
      )[0]
      await repo.moveToRecycleBin(String(cover?.unique_id))
    })
    const dry = cli(['recycle-bin', 'empty', '--dry-run', '-o', 'json']).json<{
      items: Array<{ name: string; trashedAt: string | null }>
    }>()
    expect(dry.items.map((i) => i.name)).toEqual(['cover.png'])
    expect(dry.items[0]?.trashedAt).not.toBeNull()
    expect(
      cli(['recycle-bin', 'empty', '--older-than', '1', '--yes', '-o', 'json']).json(),
    ).toMatchObject({ items: [], kept: 1 })
    const asked = cli(['recycle-bin', 'empty', '-o', 'json'])
    expect(asked.code).toBe(ERROR_KINDS.confirmation_required.exitCode)
    expect(String(asked.envelope().hint)).toContain('--yes')
    expect(cli(['recycle-bin', 'empty', '--media', '--yes', '-o', 'json']).json()).toMatchObject({
      changed: true,
    })
    const left = await withDb(
      async (db) => (await db.query("SELECT id FROM node WHERE text = 'cover.png'")).length,
    )
    expect(left).toBe(0)
  })
})

describe(`the date an item was trashed (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  let h: Harness
  beforeAll(async () => {
    h = await signedInServer()
  })
  afterAll(async () => {
    await h.db.close()
  })

  test('is recorded when it goes into the recycle bin, and cleared when it comes back', async () => {
    const folder = await new ContentTypeRepository(h.server.db, { kind: 'media' }).byAlias('Folder')
    const created = await h.post(`${V1}/media`, {
      mediaType: { id: folder?.key },
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'A folder' }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    const node = await new NodeRepository(h.server.db).byKey(key)
    const id = node?.id as number
    const repo = new DocumentRepository(h.server.db, { kind: 'media' })
    const before = Date.now() - 1000
    expect((await h.put(`${V1}/media/${key}/move-to-recycle-bin`, {})).status).toBe(200)
    expect((await repo.trashedDates([id])).get(id)?.getTime()).toBeGreaterThanOrEqual(before)
    expect((await h.put(`${V1}/recycle-bin/media/${key}/restore`, { target: null })).status).toBe(
      200,
    )
    expect((await repo.trashedDates([id])).size).toBe(0)
  })
})
