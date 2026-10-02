/**
 * `BUNBRACO_ROLE`: splitting one deployment into an editing node and a public one.
 *
 * The gating is what these assert, because the failure mode is silent. A `web`
 * node that still served the Management API would expose the editor on the
 * public address; one that still ran the background jobs would publish every
 * scheduled document twice. Neither shows up as an error anywhere.
 *
 * Two servers share one database here — a file on SQLite, the schema on Postgres
 * — so the second boots against what the first migrated, which is the whole
 * point of the read-only role.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BunbracoConfig,
  createServer,
  DatabaseNotReadyError,
  loadConfig,
  type ServerHandle,
} from '@bunbraco/server'
import { dialectUnderTest, resetPostgresSchema } from './support/db.ts'
import { BACKOFFICE, ORIGIN, V1 } from './support/harness.ts'

describe(`server roles (${dialectUnderTest})`, () => {
  let dir: string
  let shared: string
  let all: ServerHandle
  let web: ServerHandle
  let api: ServerHandle

  const configFor = (overrides: Partial<BunbracoConfig> = {}) =>
    loadConfig({ sqliteFile: shared, ...overrides })

  const get = (server: ServerHandle, path: string, init?: RequestInit) =>
    server.fetch(new Request(`${ORIGIN}${path}`, init))

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bunbraco-roles-'))
    // Shared on SQLite, where ':memory:' would give each server its own database.
    // Ignored on Postgres, where the schema is what the two share.
    shared = join(dir, 'roles.sqlite')
    await resetPostgresSchema()
    all = await createServer(configFor())
    web = await createServer(configFor({ role: 'web' }))
    api = await createServer(configFor({ role: 'api' }))
  }, 60_000)

  afterAll(async () => {
    await Promise.all([all?.close(), web?.close(), api?.close()])
    rmSync(dir, { recursive: true, force: true })
  })

  test('default to one node that does everything', () => {
    expect(all.config.role).toBe('all')
    expect(all.health().role).toBe('all')
  })

  test('a web node does not serve the Management API', async () => {
    // Whatever it answers — a body, a 401 as problem+json, a 501 — the API
    // router owns the path and replies as JSON.
    const onAll = await get(all, `${V1}/server/information`)
    expect(onAll.headers.get('content-type')).toContain('json')

    // Not 401 or 403: the route does not exist here, so it falls through to the
    // site, which answers 404 as HTML. That is what proves the API is absent
    // rather than merely refusing.
    const onWeb = await get(web, `${V1}/server/information`)
    expect(onWeb.status).toBe(404)
    expect(onWeb.headers.get('content-type')).toContain('text/html')
  })

  test('a web node does not serve the backoffice shell or its sign-in route', async () => {
    const shell = await get(all, BACKOFFICE)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('importmap')

    const absent = await get(web, BACKOFFICE)
    expect(absent.status).toBe(404)
    expect(await absent.text()).not.toContain('importmap')

    const login = await get(web, `${V1}/security/back-office/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin@bunbraco.local', password: 'test-password' }),
    })
    expect(login.status).toBe(404)
  })

  test('an api node renders for preview only, so it is not a second public site', async () => {
    // A site with nothing published explains itself as HTML; both of the nodes
    // that serve the public site do that, and the api node refuses outright.
    for (const server of [all, web]) {
      const page = await get(server, '/')
      expect(page.status).toBe(404)
      expect(page.headers.get('content-type')).toContain('text/html')
    }

    const refused = await get(api, '/')
    expect(refused.status).toBe(404)
    expect(refused.headers.get('content-type')).toContain('text/plain')
  })

  test('an api node still serves the backoffice', async () => {
    const shell = await get(api, BACKOFFICE)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('importmap')
  })

  test('health answers on every role, and names which one', async () => {
    for (const [role, server] of [
      ['all', all],
      ['api', api],
      ['web', web],
    ] as const) {
      const response = await get(server, '/health')
      expect(await response.json()).toMatchObject({ role })
    }
  })

  test('only an owning node arms the background jobs', () => {
    expect(all.jobs.started()).toBe(true)
    expect(api.jobs.started()).toBe(true)
    expect(web.jobs.started()).toBe(false)
  })

  test('a misspelt role is refused rather than quietly treated as all', () => {
    expect(() => loadConfig({ role: 'webb' as never })).toThrow(/role must be one of/)
    const previous = Bun.env.BUNBRACO_ROLE
    try {
      Bun.env.BUNBRACO_ROLE = 'webb'
      expect(() => loadConfig()).toThrow(/role must be one of/)
    } finally {
      if (previous === undefined) delete Bun.env.BUNBRACO_ROLE
      else Bun.env.BUNBRACO_ROLE = previous
    }
  })

  const sqliteOnly = test.skipIf(dialectUnderTest !== 'sqlite')

  sqliteOnly('a web node refuses a database nothing has migrated', async () => {
    const file = join(dir, 'unmigrated.sqlite')
    await expect(createServer(loadConfig({ sqliteFile: file, role: 'web' }))).rejects.toThrow(
      DatabaseNotReadyError,
    )
  })
})
