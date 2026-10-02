/**
 * The full back-office sign-in flow, end to end through the real server:
 * login → authorize → code exchange → authenticated request → refresh → sign-out.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  AuthStore,
  cookieNames,
  deriveChallenge,
  generatePassword,
  generateToken,
  hashPassword,
  parseCookies,
  REDACTED,
  resetAdminPassword,
  timingSafeEqual,
  verifyChallenge,
  verifyPassword,
} from '@bunbraco/auth'
import { DEFAULT_BACKOFFICE_PATH as BACKOFFICE } from '@bunbraco/core'
import { createServer } from '@bunbraco/server'
import { resetPostgresSchema } from './support/db.ts'

const V1 = '/umbraco/management/api/v1'
const SECURITY = `${V1}/security/back-office`
const ORIGIN = 'http://localhost'
const REDIRECT_URI = `${ORIGIN}${BACKOFFICE}/oauth_complete`
const CLIENT_ID = 'umbraco-back-office'
const ADMIN = { username: 'admin@bunbraco.local', password: 'test-password' }

const names = cookieNames({ siteName: 'Bunbraco', securePrefix: true })

/** A minimal cookie jar, since the flow depends on cookies being carried. */
class Jar {
  #cookies = new Map<string, string>()

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';')
      const parsed = parseCookies(pair ?? '')
      for (const [name, value] of parsed) {
        if (value === '') this.#cookies.delete(name)
        else this.#cookies.set(name, value)
      }
    }
  }

  get header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name)
  }

  get size(): number {
    return this.#cookies.size
  }
}

/** Servers opened by a test, closed afterwards so pools are not exhausted. */
const openServers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop()
    // The whole server, poller and jobs included, not just its database
    await server?.close().catch(() => {})
  }
})

async function freshServer() {
  // Each test needs an untouched database: several of them change the admin
  // password, and on Postgres every test in this file shares one.
  await resetPostgresSchema()
  const server = await createServer()
  openServers.push(server)
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

  const form = (body: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })

  return { server, jar, call, form }
}

/** Runs the whole flow and returns the verifier/jar so tests can go further. */
async function signIn(harness: Awaited<ReturnType<typeof freshServer>>) {
  const { call, form } = harness
  const login = await call(`${SECURITY}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  })
  expect(login.status).toBe(200)

  const verifier = generateToken(96)
  const authorizeUrl = `${SECURITY}/authorize?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'offline_access',
    response_type: 'code',
    state: 'abc123',
    code_challenge: deriveChallenge(verifier),
    code_challenge_method: 'S256',
  })}`
  const authorize = await call(authorizeUrl)
  expect(authorize.status).toBe(302)

  const location = new URL(authorize.headers.get('location') as string)
  const code = location.searchParams.get('code') as string

  const token = await call(
    `${SECURITY}/token`,
    form({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    }),
  )
  return { token, code, verifier, location }
}

describe('password hashing', () => {
  test('argon2id round-trips and rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toStartWith('$argon2id$')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  test('a missing or malformed hash never verifies', async () => {
    expect(await verifyPassword('anything', null)).toBe(false)
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false)
  })
})

describe('PKCE', () => {
  test('S256 challenge verifies only against its own verifier', () => {
    const verifier = generateToken(96)
    const challenge = deriveChallenge(verifier)
    expect(verifyChallenge(verifier, challenge, 'S256')).toBe(true)
    expect(verifyChallenge(generateToken(96), challenge, 'S256')).toBe(false)
  })

  test('challenges are base64url, with no padding to confuse a query string', () => {
    expect(deriveChallenge('abc')).not.toContain('=')
    expect(deriveChallenge('abc')).not.toContain('+')
    expect(deriveChallenge('abc')).not.toContain('/')
  })

  test('comparison is length-safe', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('sign-in flow', () => {
  test('authorize redirects an anonymous browser to the login page', async () => {
    const { call } = await freshServer()
    const response = await call(
      `${SECURITY}/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: deriveChallenge('v'.repeat(64)),
        code_challenge_method: 'S256',
      })}`,
    )
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') as string)
    expect(location.pathname).toBe(`${BACKOFFICE}/login`)
    // The login page must be able to resume the flow.
    expect(location.searchParams.get('returnUrl')).toContain('/authorize')
  })

  test('login rejects bad credentials with 401 and sets no session', async () => {
    const { call, jar } = await freshServer()
    const response = await call(`${SECURITY}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN.username, password: 'wrong' }),
    })
    expect(response.status).toBe(401)
    expect(jar.get(names.session)).toBeUndefined()
  })

  test('login rejects an unknown user with the same shape', async () => {
    const { call } = await freshServer()
    const response = await call(`${SECURITY}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody@example.com', password: 'whatever' }),
    })
    expect(response.status).toBe(401)
  })

  test('completes login, authorize, and code exchange', async () => {
    const harness = await freshServer()
    const { token, location } = await signIn(harness)
    expect(token.status).toBe(200)

    // state must survive the round trip or the client discards the response.
    expect(location.searchParams.get('state')).toBe('abc123')

    const body = await token.json()
    expect(body.expires_in).toBeGreaterThan(0)
    expect(body.token_type).toBe('Bearer')
    // Real token values never reach the browser.
    expect(body.access_token).toBe(REDACTED)
    expect(body.refresh_token).toBe(REDACTED)

    // …they arrive as httpOnly cookies instead.
    const setCookies = token.headers.getSetCookie().join('\n')
    expect(setCookies).toContain(names.accessToken)
    expect(setCookies).toContain(names.refreshToken)
    expect(setCookies).toContain('HttpOnly')
    expect(setCookies).toContain('Secure')
    expect(harness.jar.get(names.accessToken)).not.toBe(REDACTED)
  })

  test('the issued session authenticates Management API requests', async () => {
    const harness = await freshServer()
    await signIn(harness)

    const response = await harness.call(`${V1}/user/current`)
    expect(response.status).toBe(200)
    const user = await response.json()
    expect(user.userName).toBe(ADMIN.username)
    expect(user.isAdmin).toBe(true)
    // Seeded from the admin group's section rows, translated to manifest aliases.
    expect(user.allowedSections).toContain('Umb.Section.Content')
    expect(user.allowedSections).toContain('Umb.Section.Users')
    expect(user.userGroupIds.length).toBeGreaterThan(0)
  })

  test('an authorization code cannot be exchanged twice', async () => {
    const harness = await freshServer()
    const { code, verifier } = await signIn(harness)
    const replay = await harness.call(
      `${SECURITY}/token`,
      harness.form({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      }),
    )
    expect(replay.status).toBe(400)
    expect((await replay.json()).error).toBe('invalid_grant')
  })

  test('the wrong PKCE verifier is rejected', async () => {
    const harness = await freshServer()
    const { call, form } = harness
    await call(`${SECURITY}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    })
    const authorize = await call(
      `${SECURITY}/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: deriveChallenge(generateToken(96)),
        code_challenge_method: 'S256',
      })}`,
    )
    const code = new URL(authorize.headers.get('location') as string).searchParams.get(
      'code',
    ) as string
    const token = await call(
      `${SECURITY}/token`,
      form({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code,
        code_verifier: generateToken(96),
      }),
    )
    expect(token.status).toBe(400)
    expect((await token.json()).error).toBe('invalid_grant')
  })

  test('an unregistered redirect_uri is refused', async () => {
    const { call } = await freshServer()
    const response = await call(
      `${SECURITY}/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: 'https://evil.example.com/steal',
        response_type: 'code',
        code_challenge: deriveChallenge('v'.repeat(64)),
        code_challenge_method: 'S256',
      })}`,
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_request')
  })

  test('PKCE is mandatory', async () => {
    const { call } = await freshServer()
    const response = await call(
      `${SECURITY}/authorize?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
      })}`,
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_request')
  })

  test('an unknown client is refused', async () => {
    const { call } = await freshServer()
    const response = await call(
      `${SECURITY}/authorize?${new URLSearchParams({
        client_id: 'not-umbraco',
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: deriveChallenge('v'.repeat(64)),
        code_challenge_method: 'S256',
      })}`,
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_client')
  })
})

describe('session lifetime', () => {
  test('refresh rotates the tokens and keeps the session working', async () => {
    const harness = await freshServer()
    await signIn(harness)
    const firstAccess = harness.jar.get(names.accessToken)

    // The client sends `[redacted]`; the server reads the real token from the cookie.
    const refreshed = await harness.call(
      `${SECURITY}/token`,
      harness.form({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        grant_type: 'refresh_token',
        refresh_token: REDACTED,
      }),
    )
    expect(refreshed.status).toBe(200)
    expect((await refreshed.json()).access_token).toBe(REDACTED)
    expect(harness.jar.get(names.accessToken)).not.toBe(firstAccess)

    expect((await harness.call(`${V1}/user/current`)).status).toBe(200)
  })

  test('reusing a rotated refresh token kills the session', async () => {
    const harness = await freshServer()
    await signIn(harness)
    const stolenRefresh = harness.jar.get(names.refreshToken) as string

    await harness.call(
      `${SECURITY}/token`,
      harness.form({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        grant_type: 'refresh_token',
        refresh_token: REDACTED,
      }),
    )

    // Replay the superseded token, as a thief would.
    const replay = await harness.server.fetch(
      new Request(`${ORIGIN}${SECURITY}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          grant_type: 'refresh_token',
          refresh_token: stolenRefresh,
        }).toString(),
      }),
    )
    expect(replay.status).toBe(400)
    expect((await replay.json()).error).toBe('invalid_grant')

    // The whole session is gone, including the honest client's access token.
    expect((await harness.call(`${V1}/user/current`)).status).toBe(401)
  })

  test('sign-out ends the session and clears the cookies', async () => {
    const harness = await freshServer()
    await signIn(harness)
    expect((await harness.call(`${V1}/user/current`)).status).toBe(200)

    const signout = await harness.call(
      `${SECURITY}/signout?post_logout_redirect_uri=${encodeURIComponent(`${ORIGIN}${BACKOFFICE}/logout`)}`,
    )
    expect(signout.status).toBe(302)
    expect(signout.headers.get('location')).toBe(`${ORIGIN}${BACKOFFICE}/logout`)
    expect(harness.jar.size).toBe(0)
    expect((await harness.call(`${V1}/user/current`)).status).toBe(401)
  })

  test('sign-out ignores an unregistered post-logout redirect', async () => {
    const harness = await freshServer()
    await signIn(harness)
    const signout = await harness.call(
      `${SECURITY}/signout?post_logout_redirect_uri=${encodeURIComponent('https://evil.example.com')}`,
    )
    expect(signout.headers.get('location')).toBe(`${ORIGIN}${BACKOFFICE}`)
  })

  test('revoke ends the session', async () => {
    const harness = await freshServer()
    await signIn(harness)
    const revoke = await harness.call(
      `${SECURITY}/revoke`,
      harness.form({ client_id: CLIENT_ID, token: REDACTED, token_type_hint: 'access_token' }),
    )
    expect(revoke.status).toBe(200)
    expect((await harness.call(`${V1}/user/current`)).status).toBe(401)
  })
})

describe('administrator recovery', () => {
  /**
   * A seeded password is printed once, on the run that creates the database, and
   * seeding is idempotent — so without this there is no way back in. This is what
   * `bun run start:local` uses to guarantee the credentials it prints are valid.
   */
  test('sets a password that works and invalidates the old one', async () => {
    const harness = await freshServer()
    const store = new AuthStore(harness.server.db)

    const reset = await resetAdminPassword(store, ADMIN.username, 'brand-new-password')
    expect(reset?.login).toBe(ADMIN.username)
    expect(reset?.password).toBe('brand-new-password')

    const withNew = await harness.call(`${SECURITY}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN.username, password: 'brand-new-password' }),
    })
    expect(withNew.status).toBe(200)

    const withOld = await harness.call(`${SECURITY}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    })
    expect(withOld.status).toBe(401)
  })

  test('generates a password when none is given', async () => {
    const harness = await freshServer()
    const store = new AuthStore(harness.server.db)
    const reset = await resetAdminPassword(store, ADMIN.username)
    expect(reset?.password).toBeTruthy()
    expect(reset?.password.length).toBeGreaterThanOrEqual(12)

    const response = await harness.call(`${SECURITY}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN.username, password: reset?.password }),
    })
    expect(response.status).toBe(200)
  })

  test('ends existing sessions, so a change really is a change', async () => {
    const harness = await freshServer()
    await signIn(harness)
    expect((await harness.call(`${V1}/user/current`)).status).toBe(200)

    const reset = await resetAdminPassword(
      new AuthStore(harness.server.db),
      ADMIN.username,
      'rotated',
    )
    expect(reset?.sessionsEnded).toBeGreaterThan(0)
    // The already-issued access token must stop working.
    expect((await harness.call(`${V1}/user/current`)).status).toBe(401)
  })

  test('keeps sessions when the password is unchanged, so a restart does not sign editors out', async () => {
    const harness = await freshServer()
    await signIn(harness)

    const reset = await resetAdminPassword(
      new AuthStore(harness.server.db),
      ADMIN.username,
      ADMIN.password,
    )
    expect(reset?.sessionsEnded).toBe(0)
    expect((await harness.call(`${V1}/user/current`)).status).toBe(200)
  })

  test('clears a lockout', async () => {
    const harness = await freshServer()
    const store = new AuthStore(harness.server.db)
    const user = await store.findUserByLogin(ADMIN.username)
    await store.lockOut(user?.id as number)
    expect((await store.findUserByLogin(ADMIN.username))?.isLockedOut).toBe(true)

    await resetAdminPassword(store, ADMIN.username, 'unlocked-me')
    expect((await store.findUserByLogin(ADMIN.username))?.isLockedOut).toBe(false)

    const response = await harness.call(`${SECURITY}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN.username, password: 'unlocked-me' }),
    })
    expect(response.status).toBe(200)
  })

  test('reports an unknown login rather than creating an account', async () => {
    const harness = await freshServer()
    const store = new AuthStore(harness.server.db)
    expect(await resetAdminPassword(store, 'nobody@example.com', 'x')).toBeUndefined()
  })

  test('generated passwords are URL-safe and distinct', () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()))
    expect(passwords.size).toBe(20)
    for (const password of passwords) expect(password).toMatch(/^[A-Za-z0-9]+$/)
  })
})
