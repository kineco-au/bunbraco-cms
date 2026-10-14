/**
 * A wired bundle that owns tables, on a real site: the boot that migrates it,
 * a route that uses `context.host.tables`, the upgrade commands that plan and
 * apply its steps after core's, what `/status` and the Changes dashboard say,
 * and `bundle purge`. story 062, docs/bundles.md Part 4.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  bundlePurge,
  bundlePurgePlan,
  CommandError,
  upgradeCheck,
  upgradePlan,
  upgradeRun,
} from '@crombolo/cli'
import { bundleTablesIn, connect } from '@crombolo/data'
import { bootstrapDatabase, loadConfig, siteStatus, VERSION } from '@crombolo/server'
import { siteDeclaring } from './support/bundles.ts'
import { dialectUnderTest, resetPostgresSchema } from './support/db.ts'
import { TASKS_ID, tasksBundle } from './support/fixture-bundle.ts'
import { BACKOFFICE, type Harness, signedInServer } from './support/harness.ts'

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** A site that depends on the fixture's package at 1.1.0. */
function siteDir(): string {
  const dir = siteDeclaring('bundle-tables-site', {
    '@acme/tasks': {
      json: {
        version: '1.1.0',
        crombolo: { id: TASKS_ID, name: 'Tasks', server: 'tasks', migrations: 'compatible' },
      },
    },
  })
  dirs.push(dir)
  return dir
}

const KEY = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe(`a wired bundle with tables (${dialectUnderTest})`, () => {
  test('is migrated at a development boot, and its routes use context.host.tables', async () => {
    const dir = siteDir()
    const h = await signedInServer({
      config: { siteDir: dir, componentsDir: join(dir, 'components'), bundles: [tasksBundle()] },
    })
    open.push(h)
    expect(await bundleTablesIn(h.server.db, TASKS_ID)).toEqual(['bundle_acme_tasks__task'])

    const route = `${BACKOFFICE}/crombolo/api/bundle/${TASKS_ID}/tasks`
    const response = await h.call(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: KEY(1), node: KEY(10) }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ count: 1 })

    // The Changes dashboard lists what ran, under the bundle's own name.
    const report = await h.json<{
      bundles: { id: string; name: string; applied: { name: string }[] }[]
    }>(`${BACKOFFICE}/crombolo/api/change-report`)
    expect(report.bundles).toEqual([
      expect.objectContaining({
        id: TASKS_ID,
        name: 'Tasks',
        pending: [],
        applied: [
          expect.objectContaining({ name: 'tasks' }),
          expect.objectContaining({ name: 'task-priority' }),
        ],
      }),
    ])
  })
})

describe(`the upgrade commands (${dialectUnderTest})`, () => {
  /** A database with core installed and the bundle not yet, as before a deploy that wires it. */
  async function behind() {
    await resetPostgresSchema()
    const dir = siteDir()
    const config = loadConfig({
      siteDir: dir,
      componentsDir: join(dir, 'components'),
      schemaDir: join(dir, 'schema'),
      sqliteFile: join(dir, 'site.sqlite'),
      development: false,
    })
    const boot = await bootstrapDatabase(config)
    await boot.db.close()
    return { ...config, bundles: [tasksBundle()] }
  }

  test('plan, check and status list the bundle’s steps under it; upgrade applies them after core', async () => {
    const config = await behind()
    const plan = await upgradePlan(config)
    expect(plan.steps).toEqual([])
    expect(
      plan.bundles.map((bundle) => [bundle.id, bundle.steps.map((step) => step.name)]),
    ).toEqual([[TASKS_ID, ['tasks', 'task-priority']]])
    expect(plan.bundles[0]?.steps[0]?.statements[0]).toContain(
      'CREATE TABLE "bundle_acme_tasks__task"',
    )
    expect(plan.bundles[0]?.steps[1]?.unplannable).toContain('backfills data')

    const check = await upgradeCheck(config)
    expect(check.bundles).toEqual([
      {
        id: TASKS_ID,
        name: 'Tasks',
        pending: [
          { name: 'tasks', kind: 'expand' },
          { name: 'task-priority', kind: 'expand' },
        ],
      },
    ])
    const status = await siteStatus(config)
    expect(status.bundles[TASKS_ID]?.pending).toEqual(['tasks', 'task-priority'])
    expect(status.problems.join('\n')).toContain(`the bundle "${TASKS_ID}" has 2 step(s) pending`)

    const result = await upgradeRun(config, { backupTaken: true })
    expect(result.action).toBe('upgraded')
    if (result.action !== 'upgraded') return
    expect(result.bundlesApplied).toEqual([{ id: TASKS_ID, applied: ['tasks', 'task-priority'] }])
    expect((await siteStatus(config)).bundles[TASKS_ID]?.pending).toEqual([])
  })

  test('purge is refused while the bundle is wired, and drops its tables once it is not', async () => {
    const config = await behind()
    await upgradeRun(config, { backupTaken: true })
    await expect(bundlePurgePlan(config, TASKS_ID)).rejects.toBeInstanceOf(CommandError)
    await expect(bundlePurge(config, TASKS_ID, { backupTaken: true })).rejects.toThrow(
      /still wired in crombolo.config.ts/,
    )

    const unwired = { ...config, bundles: [] }
    expect((await bundlePurgePlan(unwired, TASKS_ID)).tables).toEqual(['bundle_acme_tasks__task'])
    const purged = await bundlePurge(unwired, TASKS_ID, { backupTaken: true })
    expect(purged.dropped).toEqual(['bundle_acme_tasks__task'])
    const db = await connect({ file: config.sqliteFile })
    try {
      expect(await bundleTablesIn(db, TASKS_ID)).toEqual([])
    } finally {
      await db.close()
    }
  })

  test('a bundle whose peer range excludes the running version is refused, by name', async () => {
    const dir = siteDeclaring('bundle-tables-peer', {
      '@acme/tasks': {
        json: {
          version: '1.1.0',
          peerDependencies: { '@crombolo/crombolo': '^0.1.0' },
          crombolo: { id: TASKS_ID, server: 'tasks', migrations: 'compatible' },
        },
      },
    })
    dirs.push(dir)
    const config = loadConfig({ siteDir: dir, sqliteFile: join(dir, 'site.sqlite') })
    const error = await upgradePlan({ ...config, bundles: [tasksBundle()] }).catch((e) => e)
    expect(error).toBeInstanceOf(CommandError)
    expect((error as CommandError).problems.join('\n')).toContain(VERSION)
  })
})
