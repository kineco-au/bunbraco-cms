/**
 * Story 047: health checks for what actually goes wrong here, telemetry that
 * says nothing is collected, profiling that is honestly off, and the server's
 * troubleshooting report and upgrade check. docs/diagnostics.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cromboloPlan, type Db, migrate, touchServer } from '@crombolo/data'
import {
  createDiagnosticsPort,
  fileSystemMediaStore,
  loadConfig,
  type MediaStore,
  UPGRADE_PACKAGE,
  upgradeType,
  VERSION,
} from '@crombolo/server'
import { dialectUnderTest, freshDb } from './support/db.ts'
import { ADMIN, type Harness, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

const open: Harness[] = []
const dbs: Db[] = []
const dirs: string[] = []

afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dbs.length > 0)
    await dbs
      .pop()
      ?.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

interface Result {
  message: string
  resultType: 'Success' | 'Warning' | 'Error' | 'Info'
}
type Ran = { checks: Array<{ id: string; results: Result[] }> }

async function server(): Promise<Harness> {
  const h = await signedInServer()
  open.push(h)
  return h
}

async function run(h: Harness, group: string): Promise<Result[][]> {
  const response = await h.post(`${V1}/health-check-group/${encodeURIComponent(group)}/check`, {})
  expect(response.status).toBe(200)
  return ((await response.json()) as Ran).checks.map((check) => check.results)
}

function mediaDir(): MediaStore {
  const dir = mkdtempSync(join(tmpdir(), 'crombolo-health-'))
  dirs.push(dir)
  return fileSystemMediaStore(dir)
}

async function migratedDb(): Promise<Db> {
  const db = await freshDb()
  dbs.push(db)
  await migrate(db, cromboloPlan)
  return db
}

describe(`health checks (${dialectUnderTest})`, () => {
  test('list the groups, describe their checks, and run them against the live site', async () => {
    const h = await server()
    const groups = await h.json<{ total: number; items: Array<{ name: string }> }>(
      `${V1}/health-check-group?skip=0&take=10`,
    )
    expect(groups.items.map((group) => group.name)).toEqual([
      'Database',
      'Media',
      'E-mail',
      'Servers',
    ])
    expect(groups.total).toBe(4)

    const database = await h.json<{ name: string; checks: Array<{ name: string; id: string }> }>(
      `${V1}/health-check-group/database`,
    )
    expect(database.checks.map((check) => check.name)).toEqual([
      'Database connection',
      'Database upgrades',
    ])

    const [connection, upgrades] = await run(h, 'Database')
    expect(connection?.[0]?.resultType).toBe('Success')
    expect(connection?.[0]?.message).toContain(
      dialectUnderTest === 'postgres' ? 'PostgreSQL' : 'SQLite',
    )
    expect(upgrades?.map((r) => r.resultType)).toEqual(['Success'])
    expect(upgrades?.[0]?.message).toContain(VERSION)

    const [media] = await run(h, 'Media')
    expect(media?.[0]?.resultType).toBe('Success')

    const [email] = await run(h, 'E-mail')
    expect(['Warning', 'Info']).toContain(email?.[0]?.resultType as string)

    const [nodes] = await run(h, 'Servers')
    expect(nodes?.[0]).toEqual({
      resultType: 'Success',
      message: `1 server(s) running Crombolo ${VERSION}.`,
    })
    expect(nodes?.[1]?.message).toContain(`runs Crombolo ${VERSION}`)

    expect((await h.call(`${V1}/health-check-group/nothing`)).status).toBe(404)
    expect((await h.post(`${V1}/health-check-group/nothing/check`, {})).status).toBe(404)
    const action = await h.post(`${V1}/health-check/execute-action`, {
      healthCheck: { id: database.checks[0]?.id },
      valueRequired: false,
    })
    expect(action.status).toBe(400)
  })

  test('need the Settings section', async () => {
    const h = await server()
    const writer = await signInAsGroup(h)
    expect((await writer.call(`${V1}/health-check-group?skip=0&take=10`)).status).toBe(403)
    expect((await writer.call(`${V1}/telemetry/level`)).status).toBe(403)
  })

  test('say when the servers disagree about the release they run', async () => {
    const db = await migratedDb()
    await touchServer(db, {
      nodeId: 'web-1',
      version: '1',
      revision: '1',
      role: 'web',
      cromboloVersion: '0.12.0',
    })
    await touchServer(db, {
      nodeId: 'web-2',
      version: '1',
      revision: '1',
      role: 'web',
      cromboloVersion: '0.11.0',
    })
    const port = createDiagnosticsPort({ config: loadConfig(), db, media: mediaDir() })
    const [nodes] = (await port.run('Servers')) ?? []
    expect(nodes?.results?.[0]?.resultType).toBe('Warning')
    expect(nodes?.results?.[0]?.message).toContain('0.12.0, 0.11.0')
    expect(nodes?.results?.slice(1).map((r) => r.message.split(' ')[0])).toEqual(['web-1', 'web-2'])
  })

  test('report a database that has upgrades still to run, and storage that cannot be written', async () => {
    const db = await freshDb()
    dbs.push(db)
    const broken: MediaStore = {
      description: 's3://nowhere',
      get: async () => undefined,
      put: async () => {
        throw new Error('access denied')
      },
      delete: async () => {},
      list: async () => [],
    }
    const port = createDiagnosticsPort({ config: loadConfig(), db, media: broken })
    const [connection, upgrades] = (await port.run('Database')) ?? []
    expect(connection?.results?.[0]?.resultType).toBe('Success')
    expect(upgrades?.results?.[0]?.resultType).toBe('Error')
    expect(upgrades?.results?.[0]?.message).toContain('crombolo upgrade')
    const [media] = (await port.run('Media')) ?? []
    expect(media?.results).toEqual([
      { resultType: 'Error', message: 's3://nowhere could not be used: access denied' },
    ])
  })
})

describe(`telemetry and profiling (${dialectUnderTest})`, () => {
  test('collect nothing, and cannot be switched on', async () => {
    const h = await server()
    expect(await h.json<unknown>(`${V1}/telemetry/level`)).toEqual({ telemetryLevel: 'Minimal' })
    expect(await h.json<unknown>(`${V1}/telemetry?skip=0&take=10`)).toEqual({
      total: 1,
      items: [{ telemetryLevel: 'Minimal' }],
    })
    expect((await h.post(`${V1}/telemetry/level`, { telemetryLevel: 'Detailed' })).status).toBe(400)
    expect((await h.post(`${V1}/telemetry/level`, { telemetryLevel: 'Minimal' })).status).toBe(200)

    expect(await h.json<unknown>(`${V1}/profiling/status`)).toEqual({ enabled: false })
    expect((await h.put(`${V1}/profiling/status`, { enabled: true })).status).toBe(400)
    expect((await h.put(`${V1}/profiling/status`, { enabled: false })).status).toBe(200)
    expect(await h.json<unknown>(`${V1}/profiling/status`)).toEqual({ enabled: false })
  })
})

describe(`troubleshooting and the upgrade check (${dialectUnderTest})`, () => {
  test('troubleshooting names the runtime and versions, and no secret', async () => {
    const h = await server()
    const response = await h.call(`${V1}/server/troubleshooting`)
    const text = await response.text()
    const { items } = JSON.parse(text) as { items: Array<{ name: string; data: string }> }
    const named = Object.fromEntries(items.map((item) => [item.name, item.data]))
    expect(named['Crombolo version']).toBe(VERSION)
    expect(named.Runtime).toBe(`Bun ${Bun.version}`)
    expect(named.Database).toBe(dialectUnderTest === 'postgres' ? 'PostgreSQL' : 'SQLite')
    expect(text).not.toContain(ADMIN.password)
    const url = Bun.env.CROMBOLO_POSTGRES_URL ?? Bun.env.DATABASE_URL
    // As the credentials appear in a URL: the test password is a word found elsewhere.
    const parsed = url ? new URL(url) : undefined
    if (parsed?.password) expect(text).not.toContain(`${parsed.username}:${parsed.password}`)
    if (parsed?.password) expect(text).not.toContain(`:${parsed.password}@`)
  })

  test('the upgrade check answers from the registry, and remembers for the check period', async () => {
    const db = await migratedDb()
    const asked: string[] = []
    let latest = '99.0.0'
    let reachable = true
    const fakeFetch = (async (url: string) => {
      asked.push(url)
      if (!reachable) throw new Error('offline')
      return Response.json({ 'dist-tags': { latest } })
    }) as unknown as typeof fetch
    let now = new Date('2026-10-14T00:00:00Z')
    const port = (period: number) =>
      createDiagnosticsPort({
        config: {
          ...loadConfig(),
          versionCheckPeriod: period,
          npmRegistry: 'https://registry.test/',
        },
        db,
        media: mediaDir(),
        fetch: fakeFetch,
        now: () => now,
      })

    const weekly = port(7)
    expect(await weekly.upgradeCheck()).toEqual({
      type: 'Major',
      comment: `Crombolo 99.0.0 is available; this site runs ${VERSION}.`,
      url: `https://www.npmjs.com/package/${UPGRADE_PACKAGE}/v/99.0.0`,
    })
    expect(asked).toEqual([`https://registry.test/${encodeURIComponent(UPGRADE_PACKAGE)}`])
    latest = VERSION
    expect((await weekly.upgradeCheck()).type).toBe('Major')
    expect(asked).toHaveLength(1)
    now = new Date('2026-10-22T00:00:00Z')
    expect(await weekly.upgradeCheck()).toEqual({
      type: 'None',
      comment: `Crombolo ${VERSION} is the latest release.`,
      url: '',
    })

    reachable = false
    const offline = port(7)
    expect((await offline.upgradeCheck()).comment).toContain('could not be reached')
    expect((await offline.upgradeCheck()).type).toBe('None')
    expect(asked).toHaveLength(4)

    const off = port(0)
    expect((await off.upgradeCheck()).comment).toBe('Checking for new releases is turned off.')
    expect(asked).toHaveLength(4)
  })

  test('an upgrade is named by the part of the version that moved', () => {
    expect(upgradeType('1.0.0', '0.12.0')).toBe('Major')
    expect(upgradeType('0.13.0', '0.12.4')).toBe('Minor')
    expect(upgradeType('0.12.5', '0.12.4')).toBe('Patch')
    expect(upgradeType('0.12.4', '0.12.4')).toBe('None')
    expect(upgradeType('0.11.9', '0.12.0')).toBe('None')
  })
})
