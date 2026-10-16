/**
 * Story 034: an unattended install seeds the API client a pipeline signs in
 * with, so a site whose backoffice only takes an identity provider can still be
 * administered by a machine — and seeds no password administrator unless asked.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readSetupState } from '@crombolo/data'
import { type CromboloConfig, loadConfig, type ServerHandle } from '@crombolo/server'
import { dialectUnderTest } from './support/db.ts'
import { bootServer, ORIGIN, V1 } from './support/harness.ts'

const SECURITY = `${V1}/security/back-office`
const CLIENT = { id: 'crombolo-back-office-pipeline', secret: 'a-pipeline-secret-1' }

const open: ServerHandle[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** A database file of its own, so a second boot finds what the first left. */
const sqliteFile = () => {
  const dir = mkdtempSync(join(process.cwd(), 'output', 'api-client-'))
  dirs.push(dir)
  return join(dir, 'site.sqlite')
}

/** Production, with the environment's admin password cleared. */
async function boot(config: Partial<CromboloConfig>, keepDatabase = false): Promise<ServerHandle> {
  const server = await bootServer({
    config: { development: false, adminPassword: '', ...config },
    keepDatabase,
  })
  open.push(server)
  return server
}

const clientToken = (server: ServerHandle, secret = CLIENT.secret) =>
  server.fetch(
    new Request(`${ORIGIN}${SECURITY}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT.id,
        client_secret: secret,
      }).toString(),
    }),
  )

const passwordUsers = async (server: ServerHandle) =>
  (
    await server.db.query<{ login: string }>(
      'SELECT login FROM user_account WHERE password_hash IS NOT NULL',
    )
  ).map((row) => String(row.login))

describe(`seeding an API client (${dialectUnderTest})`, () => {
  test('a fresh install seeds the client and no password administrator, and counts as set up', async () => {
    const server = await boot({ apiClient: CLIENT, allowLocalLogin: false })
    expect(await passwordUsers(server)).toEqual([])
    expect(await readSetupState(server.db)).not.toBe('pending')
    expect(server.seededAdminPassword).toBeUndefined()

    // A token with local sign-in off, and it administers the site.
    const granted = await clientToken(server)
    expect(granted.status).toBe(200)
    const { access_token } = (await granted.json()) as { access_token: string }
    const me = await server.fetch(
      new Request(`${ORIGIN}${V1}/user/current`, {
        headers: { authorization: `Bearer ${access_token}` },
      }),
    )
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ userName: CLIENT.id, isAdmin: true })
    const users = await server.fetch(
      new Request(`${ORIGIN}${V1}/user?take=10`, {
        headers: { authorization: `Bearer ${access_token}` },
      }),
    )
    expect(users.status).toBe(200)
  })

  test('with an admin password as well, both exist', async () => {
    const server = await boot({ apiClient: CLIENT, adminPassword: 'test-password' })
    expect(await passwordUsers(server)).toEqual(['admin@crombolo.local'])
    expect((await clientToken(server)).status).toBe(200)
  })

  test('an install waiting for setup gains the client, and setup is closed', async () => {
    const file = sqliteFile()
    const first = await boot({ sqliteFile: file })
    expect(await readSetupState(first.db)).toBe('pending')
    await first.close()
    open.pop()

    const second = await boot({ sqliteFile: file, apiClient: CLIENT }, true)
    expect(await readSetupState(second.db)).toBe('complete')
    expect((await clientToken(second)).status).toBe(200)
  })

  test('a client that exists is never rotated from config', async () => {
    const file = sqliteFile()
    const first = await boot({ sqliteFile: file, apiClient: CLIENT })
    await first.close()
    open.pop()

    const changed = { ...CLIENT, secret: 'a-different-secret-2' }
    const second = await boot({ sqliteFile: file, apiClient: changed }, true)
    expect((await clientToken(second)).status).toBe(200)
    expect((await clientToken(second, changed.secret)).status).toBe(401)
    const clients = await second.db.query('SELECT client_id FROM user_client_credential')
    expect(clients).toHaveLength(1)
  })
})

describe('the configuration', () => {
  test('refuses a client the Management API would refuse', () => {
    expect(() => loadConfig({ apiClient: { id: 'pipeline', secret: CLIENT.secret } })).toThrow(
      'must start with "crombolo-back-office-"',
    )
    expect(() => loadConfig({ apiClient: { id: CLIENT.id, secret: 'short' } })).toThrow(
      'CROMBOLO_API_CLIENT_SECRET',
    )
    expect(() => loadConfig({ apiClient: { id: CLIENT.id, secret: '' } })).toThrow('go together')
  })
})

describe(`a local administrator (${dialectUnderTest})`, () => {
  test('is seeded on localhost when asked, and nowhere else', async () => {
    const local = await boot({ development: true, apiClient: CLIENT, localAdmin: true })
    expect(await passwordUsers(local)).toEqual(['admin@crombolo.local'])
    expect(local.seededAdminPassword).toBeDefined()
    await local.close()
    open.pop()

    const hosted = await boot({
      development: true,
      apiClient: CLIENT,
      localAdmin: true,
      applicationUrl: 'https://example.com',
    })
    expect(await passwordUsers(hosted)).toEqual([])
    await hosted.close()
    open.pop()

    const unasked = await boot({ development: true, apiClient: CLIENT })
    expect(await passwordUsers(unasked)).toEqual([])
  })
})
