/**
 * A signed-in server for tests: boots the real app, completes the OAuth flow, and
 * carries cookies so subsequent calls are authenticated.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { deriveChallenge, generateToken, parseCookies } from '@bunbraco/auth'
import {
  type BunbracoConfig,
  createServer,
  DEFAULTS,
  loadConfig,
  type ServerHandle,
} from '@bunbraco/server'
import { resetPostgresSchema } from './db.ts'

/**
 * The views cache, per test process *and* per site.
 *
 * Relative on purpose, so `loadConfig` resolves it against whichever `siteDir`
 * is in play. Both halves matter:
 *
 * - **Per site**, which the default `.bunbraco/views` already gave: the cache is
 *   content-addressed, so two fixture sites whose views happen to be identical
 *   would otherwise share a generation, and evicting it would pull the files out
 *   from under whichever server still needed them.
 * - **Per process**, which it did not: two suites at once — two
 *   `docker compose run`s, or one file beside a full run — compute the same
 *   generation hash under the same default site, and one renames
 *   `.partial-<hash>` while the other is still writing into it
 *   (`render/src/snapshots.ts`). Every render in the losing process then fails
 *   with ENOENT.
 */
const VIEWS_CACHE = join('.bunbraco', `views-${process.pid}`)

/** The default site's copy; a fixture site's goes with the fixture. */
process.on('exit', () => {
  rmSync(join(import.meta.dir, '..', '..', VIEWS_CACHE), { recursive: true, force: true })
})

export const ORIGIN = 'http://localhost'
/**
 * Where the editor is mounted. Derived, so moving it is one change in
 * `@bunbraco/core` rather than a sweep through the suite; `V1` does not move
 * with it, because the Management API is fixed by the contract.
 */
export const BACKOFFICE = DEFAULTS.backOfficePath
export const V1 = '/umbraco/management/api/v1'
const SECURITY = `${V1}/security/back-office`
// The SPA's own route, which moves with the backoffice; the API does not.
const REDIRECT_URI = `${ORIGIN}${DEFAULTS.backOfficePath}/oauth_complete`
const CLIENT_ID = 'umbraco-back-office'
export const ADMIN = { username: 'admin@bunbraco.local', password: 'test-password' }

class Jar {
  #cookies = new Map<string, string>()

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';')
      for (const [name, value] of parseCookies(pair ?? '')) {
        if (value === '') this.#cookies.delete(name)
        else this.#cookies.set(name, value)
      }
    }
  }

  get header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  }
}

export interface Harness {
  server: ServerHandle
  /** Closing the harness closes the server, watcher and poller included. */
  db: { close(): Promise<void> }
  call(path: string, init?: RequestInit): Promise<Response>
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>
  post(path: string, body: unknown): Promise<Response>
  put(path: string, body: unknown): Promise<Response>
  del(path: string): Promise<Response>
  /** The signed-in session's Cookie header, for a WebSocket or another client. */
  cookie(): string
}

export interface HarnessOptions {
  config?: Partial<BunbracoConfig>
  /** Keep the Postgres schema: a second instance on the same database. */
  keepDatabase?: boolean
}

export async function signedInServer(options: HarnessOptions = {}): Promise<Harness> {
  if (!options.keepDatabase) await resetPostgresSchema()
  const server = await createServer(loadConfig({ viewsCacheDir: VIEWS_CACHE, ...options.config }))
  return signIn(server, ADMIN)
}

/**
 * A second signed-in client, in a group named by alias — for checking that a
 * route asks for more than a session. `writer` holds Content and not Settings.
 */
export async function signInAsGroup(
  h: Harness,
  groupAlias = 'writer',
  email = `${groupAlias}@example.com`,
): Promise<Harness> {
  const groups = await h.json<{ items: { id: string; alias: string }[] }>(
    `${V1}/user-group?take=100`,
  )
  const group = groups.items.find((candidate) => candidate.alias === groupAlias)?.id
  if (!group) throw new Error(`There is no user group with the alias "${groupAlias}".`)
  const created = await h.post(`${V1}/user`, {
    kind: 'Default',
    email,
    userName: email,
    name: email,
    userGroupIds: [{ id: group }],
  })
  if (created.status !== 201)
    throw new Error(`Creating the user failed with ${created.status}: ${await created.text()}`)
  const key = created.headers.get('umb-generated-resource') as string
  const reset = await h.json<{ resetPassword: string }>(`${V1}/user/${key}/reset-password`, {
    method: 'POST',
  })
  return signIn(h.server, { username: email, password: reset.resetPassword })
}

/** A client of `server` signed in as `credentials`, through the same flow the backoffice uses. */
export async function signIn(
  server: ServerHandle,
  credentials: { username: string; password: string },
): Promise<Harness> {
  const jar = new Jar()

  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    if (jar.header) headers.set('cookie', jar.header)
    const response = await server.fetch(
      new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }),
    )
    jar.absorb(response)
    return response
  }

  const login = await call(`${SECURITY}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  })
  if (login.status !== 200) throw new Error(`Test login failed with ${login.status}`)

  const verifier = generateToken(96)
  const authorize = await call(
    `${SECURITY}/authorize?${new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'offline_access',
      response_type: 'code',
      code_challenge: deriveChallenge(verifier),
      code_challenge_method: 'S256',
    })}`,
  )
  const code = new URL(authorize.headers.get('location') as string).searchParams.get(
    'code',
  ) as string
  const token = await call(`${SECURITY}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    }).toString(),
  })
  if (token.status !== 200) throw new Error(`Test token exchange failed with ${token.status}`)

  const withBody = (method: string) => async (path: string, body: unknown) =>
    call(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  return {
    server,
    db: { close: () => server.close() },
    call,
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await call(path, init)
      if (!response.ok) {
        throw new Error(`${path} responded ${response.status}: ${await response.text()}`)
      }
      return (await response.json()) as T
    },
    post: withBody('POST'),
    put: withBody('PUT'),
    del: (path: string) => call(path, { method: 'DELETE' }),
    cookie: () => jar.header,
  }
}
