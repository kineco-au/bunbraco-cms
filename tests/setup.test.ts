/**
 * Story 080: "Set up your new site". A production install given no password
 * waits for its owner; the setup code guards it and is never shown; setup closes
 * for good, and a restart neither reopens it nor touches the administrator.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readSetupState } from '@crombolo/data'
import {
  AttemptLimiter,
  type CromboloConfig,
  checkSetupCode,
  MIN_SETUP_CODE_LENGTH,
  type ServerHandle,
  setupPage,
  validateSetupForm,
} from '@crombolo/server'
import { dialectUnderTest } from './support/db.ts'
import { bootServer, ORIGIN, signIn, V1 } from './support/harness.ts'

const CODE = 'correct-horse-battery-staple'
const servers: ServerHandle[] = []
const dirs: string[] = []
afterEach(async () => {
  while (servers.length > 0)
    await servers
      .pop()
      ?.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const form = (overrides: Record<string, string> = {}) => ({
  name: 'Ada Owner',
  email: 'ada@example.com',
  password: 'a long enough password',
  confirm: 'a long enough password',
  code: CODE,
  ...overrides,
})

describe('the setup code', () => {
  test('without a configured code, setup is unavailable whatever is entered', () => {
    expect(checkSetupCode(undefined, CODE)).toBe('unavailable')
    expect(checkSetupCode('', '')).toBe('unavailable')
  })

  test(`a configured code shorter than ${MIN_SETUP_CODE_LENGTH} characters keeps setup closed`, () => {
    expect(checkSetupCode('short-code', 'short-code')).toBe('unavailable')
  })

  test('only the exact code is accepted', () => {
    expect(checkSetupCode(CODE, CODE)).toBe('accepted')
    expect(checkSetupCode(CODE, `${CODE} `)).toBe('refused')
    expect(checkSetupCode(CODE, '')).toBe('refused')
  })
})

describe('the setup form', () => {
  test('a complete form has no errors', () => {
    expect(validateSetupForm(form())).toEqual({})
  })

  test('each field says what is wrong with it', () => {
    expect(
      validateSetupForm(form({ name: ' ', email: 'nope', password: 'short', code: '' })),
    ).toEqual({
      name: 'Enter your name.',
      email: 'Enter an e-mail address.',
      password: 'Use at least 10 characters.',
      code: 'Enter the setup code.',
    })
    expect(validateSetupForm(form({ confirm: 'something else entirely' }))).toEqual({
      confirm: 'The passwords do not match.',
    })
  })
})

describe('the attempt limit', () => {
  test('blocks a caller after its failures, until the window passes', () => {
    let now = 0
    const limiter = new AttemptLimiter({ max: 2, windowMs: 1000, now: () => now })
    limiter.fail('a')
    expect(limiter.blocked('a')).toBe(false)
    limiter.fail('a')
    expect(limiter.blocked('a')).toBe(true)
    expect(limiter.blocked('b')).toBe(false)
    now = 1001
    expect(limiter.blocked('a')).toBe(false)
  })

  test('blocks everyone once the failures across all callers reach the cap', () => {
    const limiter = new AttemptLimiter({ max: 5, maxAll: 3, now: () => 0 })
    for (const caller of ['a', 'b', 'c']) limiter.fail(caller)
    expect(limiter.blocked('d')).toBe(true)
  })
})

describe('the setup page', () => {
  test('without a code it says which setting to add, and nothing else', () => {
    const html = setupPage({ kind: 'unavailable' }, 'Acme')
    expect(html).toContain('CROMBOLO_SETUP_CODE')
    expect(html).not.toContain('<form')
  })

  test('keeps what was typed, except the password and the code', () => {
    const html = setupPage(
      {
        kind: 'form',
        errors: { code: 'That is not the setup code.' },
        name: 'Ada',
        email: 'a@b.c',
      },
      'Acme',
    )
    expect(html).toContain('value="Ada"')
    expect(html).toContain('value="a@b.c"')
    expect(html.match(/type="password" value=""/g)).toHaveLength(3)
  })

  test('escapes what it echoes', () => {
    const html = setupPage({ kind: 'form', errors: {}, name: '<script>', email: '' }, '<b>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>')
  })
})

/** A production boot, with the test environment's administrator password taken away. */
async function production(
  config: Partial<CromboloConfig> = {},
  keepDatabase = false,
): Promise<ServerHandle> {
  const saved = Bun.env.CROMBOLO_ADMIN_PASSWORD
  if (!('adminPassword' in config) || config.adminPassword === undefined)
    delete Bun.env.CROMBOLO_ADMIN_PASSWORD
  try {
    const server = await bootServer({
      keepDatabase,
      config: { development: false, setupCode: CODE, ...config },
    })
    servers.push(server)
    return server
  } finally {
    Bun.env.CROMBOLO_ADMIN_PASSWORD = saved
  }
}

const base = (server: ServerHandle) => server.config.backOfficePath
const get = (server: ServerHandle, path: string) =>
  server.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual' }))
const post = (server: ServerHandle, values: Record<string, string>) =>
  server.fetch(
    new Request(`${ORIGIN}${base(server)}/setup`, {
      method: 'POST',
      body: new URLSearchParams(values),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      redirect: 'manual',
    }),
  )

describe('setting up a new site', () => {
  test('a production install given no password seeds no administrator and waits', async () => {
    const server = await production()
    expect(await readSetupState(server.db)).toBe('pending')
    expect(await server.db.query('SELECT id FROM user_account')).toEqual([])
    const root = base(server)
    for (const path of [root, `${root}/login`, `${root}/section/content`]) {
      const response = await get(server, path)
      expect([path, response.status, response.headers.get('location')]).toEqual([
        path,
        303,
        `${root}/setup`,
      ])
    }
  })

  test('a development install, or one given a password, is set up already', async () => {
    const server = await production({ development: true })
    expect(await readSetupState(server.db)).toBe('none')
    expect((await get(server, `${base(server)}/setup`)).status).toBe(303)
  })

  test('without a code configured the page explains, and accepts nothing', async () => {
    const server = await production({ setupCode: undefined })
    const page = await get(server, `${base(server)}/setup`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('add a setting named <code>CROMBOLO_SETUP_CODE</code>')
    expect((await post(server, form())).status).toBe(200)
    expect(await readSetupState(server.db)).toBe('pending')
  })

  test('a wrong code is refused, never echoed, and limited', async () => {
    const server = await production()
    const wrong = await post(server, form({ code: 'not-the-code-at-all' }))
    expect(wrong.status).toBe(400)
    const text = await wrong.text()
    expect(text).toContain('That is not the setup code.')
    expect(text).not.toContain('not-the-code-at-all')
    expect(text).not.toContain(CODE)
    for (let i = 0; i < 4; i++) await post(server, form({ code: `wrong-${i}` }))
    const limited = await post(server, form())
    expect(limited.status).toBe(429)
    expect(await readSetupState(server.db)).toBe('pending')
  })

  test('a post from another origin is refused', async () => {
    const server = await production()
    const response = await server.fetch(
      new Request(`${ORIGIN}${base(server)}/setup`, {
        method: 'POST',
        body: new URLSearchParams(form()),
        headers: { origin: 'https://elsewhere.example' },
      }),
    )
    expect(response.status).toBe(403)
  })

  test('the right code creates the administrator, who can sign in, and closes setup', async () => {
    const server = await production()
    const done = await post(server, form())
    expect(done.status).toBe(200)
    const page = await done.text()
    expect(page).toContain('Your site is ready')
    expect(page).not.toContain(CODE)
    expect(await readSetupState(server.db)).toBe('complete')

    const h = await signIn(server, { username: 'ada@example.com', password: form().password })
    const me = await h.json<{ name: string; email: string }>(`${V1}/user/current`)
    expect(me).toMatchObject({ name: 'Ada Owner', email: 'ada@example.com' })

    expect((await get(server, `${base(server)}/setup`)).headers.get('location')).toBe(base(server))
    const again = await post(server, form({ email: 'mallory@example.com' }))
    expect(again.status).toBe(303)
    expect(await server.db.query('SELECT id FROM user_account')).toHaveLength(1)
  })

  test('two attempts at once create one administrator', async () => {
    const server = await production()
    const results = await Promise.all([
      post(server, form({ email: 'one@example.com' })),
      post(server, form({ email: 'two@example.com' })),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 303])
    expect(await server.db.query('SELECT id FROM user_account')).toHaveLength(1)
  })

  test('a restart leaves setup closed and the administrator as they were', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'output', 'crombolo-setup-'))
    dirs.push(dir)
    const sqliteFile = join(dir, 'site.sqlite')
    const first = await production({ sqliteFile })
    expect((await post(first, form())).status).toBe(200)
    const before = await first.db.query('SELECT password_hash, security_stamp FROM user_account')
    await first.close()
    servers.splice(servers.indexOf(first), 1)

    const restarted = await production(
      { sqliteFile, adminPassword: 'an attacker-chosen password' },
      dialectUnderTest === 'postgres',
    )
    expect(await readSetupState(restarted.db)).toBe('complete')
    expect((await get(restarted, `${base(restarted)}/setup`)).status).toBe(303)
    expect(
      await restarted.db.query('SELECT password_hash, security_stamp FROM user_account'),
    ).toEqual(before)
  })
})
