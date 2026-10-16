/**
 * Story 032: two-factor sign-in with an authenticator app, for backoffice users
 * and for members: the RFC 6238 codes themselves, turning it on, signing in with
 * a code or a recovery code, and an administrator turning it off.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from '@crombolo/auth'
import { SYSTEM_MEMBER_TYPE } from '@crombolo/data'
import {
  ADMIN,
  bootServer,
  type Harness,
  ORIGIN,
  signedInServer,
  signInAsGroup,
  V1,
} from './support/harness.ts'

const SECRET_KEY = 'a-test-secret-key-that-is-long-enough-to-use'
const USER_PROVIDER = 'UmbracoUserAppAuthenticator'
const SECURITY = `${V1}/security/back-office`
const DIALECT = process.env.CROMBOLO_DB ?? 'sqlite'

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
})

/** The app's code for a secret, `offset` steps from now. */
const codeFor = (secret: string, offset = 0) => totpCode(base32Decode(secret), totpStep() + offset)

/** Cookies from responses, kept by name, as a browser would. */
class Jar {
  cookies = new Map<string, string>()
  absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at)
      const value = pair.slice(at + 1)
      if (value === '' || /max-age=0/i.test(header)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }
  get header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

describe('the codes', () => {
  // RFC 6238 appendix B, SHA-1, eight digits.
  const rfc = new TextEncoder().encode('12345678901234567890')
  test.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('at %i seconds the code is %s', (seconds, expected) => {
    expect(totpCode(rfc, Math.floor(seconds / 30), 8)).toBe(expected)
  })

  test('base32 round-trips, whatever the case and spacing', () => {
    const encoded = base32Encode(rfc)
    expect(encoded).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(rfc)
  })

  test('a code a step either side of now is accepted, further is not', () => {
    const secret = base32Encode(rfc)
    const at = new Date(1_700_000_000_000)
    const step = totpStep(at)
    expect(verifyTotp(secret, totpCode(rfc, step), { at })).toBe(step)
    expect(verifyTotp(secret, totpCode(rfc, step - 1), { at })).toBe(step - 1)
    expect(verifyTotp(secret, totpCode(rfc, step + 1), { at })).toBe(step + 1)
    expect(verifyTotp(secret, totpCode(rfc, step - 2), { at })).toBeUndefined()
    expect(verifyTotp(secret, totpCode(rfc, step + 2), { at })).toBeUndefined()
    expect(verifyTotp(secret, 'abcdef', { at })).toBeUndefined()
  })

  test('a code at or before the last step used is refused', () => {
    const secret = base32Encode(rfc)
    const at = new Date(1_700_000_000_000)
    const step = totpStep(at)
    expect(verifyTotp(secret, totpCode(rfc, step), { at, lastUsedStep: step })).toBeUndefined()
    expect(verifyTotp(secret, totpCode(rfc, step + 1), { at, lastUsedStep: step })).toBe(step + 1)
  })

  test('recovery codes are ten, distinct, and hashed ignoring case and dashes', () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
    const [first = ''] = codes
    expect(hashRecoveryCode(first.toUpperCase().replace('-', ' '))).toBe(hashRecoveryCode(first))
  })

  test('the otpauth URI names the issuer and account', () => {
    expect(otpauthUri({ secret: 'ABC', account: 'ada@example.test', issuer: 'Harbour' })).toBe(
      'otpauth://totp/Harbour%3Aada%40example.test?secret=ABC&issuer=Harbour&algorithm=SHA1&digits=6&period=30',
    )
  })
})

/** Signs in to the backoffice by hand, through the 402 when a code is needed. */
async function backofficeLogin(h: Harness, credentials: { username: string; password: string }) {
  const jar = new Jar()
  const send = async (path: string, body: unknown) =>
    jar.absorb(
      await h.server.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: jar.header },
          body: JSON.stringify(body),
        }),
      ),
    )
  const login = await send(`${SECURITY}/login`, credentials)
  return {
    login,
    jar,
    verify: (code: string, provider = USER_PROVIDER) =>
      send(`${SECURITY}/verify-2fa`, { provider, code }),
  }
}

/** Turns the authenticator on for the signed-in client; its secret and recovery codes. */
async function turnOn(h: Harness) {
  const setup = await h.json<{ secret: string; qrCodeSetupImageUrl: string }>(
    `${V1}/user/current/2fa/${USER_PROVIDER}`,
  )
  const used = codeFor(setup.secret)
  const enabled = await h.post(`${V1}/user/current/2fa/${USER_PROVIDER}`, {
    secret: setup.secret,
    code: used,
  })
  expect(enabled.status).toBe(200)
  const { recoveryCodes } = (await enabled.json()) as { recoveryCodes: string[] }
  return { secret: setup.secret, recoveryCodes, used }
}

describe(`backoffice users (${DIALECT})`, () => {
  const server = async (secretKey: string | undefined = SECRET_KEY) => {
    const h = await signedInServer({ config: { secretKey } })
    open.push(h.db)
    return h
  }

  test('setting up shows a QR code, and a wrong first code turns nothing on', async () => {
    const h = await server()
    const setup = await h.json<{ secret: string; qrCodeSetupImageUrl: string }>(
      `${V1}/user/current/2fa/${USER_PROVIDER}`,
    )
    expect(setup.qrCodeSetupImageUrl).toStartWith('data:image/svg+xml;base64,')
    expect(base32Decode(setup.secret)).toHaveLength(20)
    const wrong = await h.post(`${V1}/user/current/2fa/${USER_PROVIDER}`, {
      secret: setup.secret,
      code: '000000' === codeFor(setup.secret) ? '111111' : '000000',
    })
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { operationStatus: string }).operationStatus).toBe(
      'InvalidCode',
    )
    const providers = await h.json<{ providerName: string; isEnabledOnUser: boolean }[]>(
      `${V1}/user/current/2fa`,
    )
    expect(providers.find((p) => p.providerName === USER_PROVIDER)?.isEnabledOnUser).toBe(false)
  })

  test('once on, signing in asks for a code, and takes it once', async () => {
    const h = await server()
    const { secret, recoveryCodes, used } = await turnOn(h)
    expect(recoveryCodes).toHaveLength(10)
    const providers = await h.json<{ providerName: string; isEnabledOnUser: boolean }[]>(
      `${V1}/user/current/2fa`,
    )
    expect(providers.find((p) => p.providerName === USER_PROVIDER)?.isEnabledOnUser).toBe(true)

    const attempt = await backofficeLogin(h, ADMIN)
    expect(attempt.login.status).toBe(402)
    expect(await attempt.login.json()).toMatchObject({
      enabledTwoFactorProviderNames: [USER_PROVIDER],
    })
    expect(attempt.jar.cookies.size).toBe(1)
    // The code used to turn it on cannot be used again; the next one can.
    expect((await attempt.verify(used)).status).toBe(400)
    const next = codeFor(secret, 1)
    expect((await attempt.verify(next)).status).toBe(200)
    expect([...attempt.jar.cookies.keys()].some((name) => /umbAccess|UMB/i.test(name))).toBe(true)

    const again = await backofficeLogin(h, ADMIN)
    expect((await again.verify(next)).status).toBe(400)
  })

  test('a recovery code signs in once', async () => {
    const h = await server()
    const { recoveryCodes } = await turnOn(h)
    const [code = ''] = recoveryCodes
    const first = await backofficeLogin(h, ADMIN)
    expect((await first.verify(code.toUpperCase())).status).toBe(200)
    const second = await backofficeLogin(h, ADMIN)
    expect((await second.verify(code)).status).toBe(400)
  })

  test('a code without the password first is refused', async () => {
    const h = await server()
    const { secret } = await turnOn(h)
    const response = await h.server.fetch(
      new Request(`${ORIGIN}${SECURITY}/verify-2fa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: USER_PROVIDER, code: codeFor(secret, 1) }),
      }),
    )
    expect(response.status).toBe(401)
  })

  test('turning it off needs a code, and an administrator can turn it off for someone', async () => {
    const h = await server()
    const writer = await signInAsGroup(h, 'writer', 'writer@example.test')
    const { secret } = await turnOn(writer)
    const refused = await writer.del(`${V1}/user/current/2fa/${USER_PROVIDER}?code=nope`)
    expect(refused.status).toBe(400)

    const me = await writer.json<{ id: string }>(`${V1}/user/current`)
    expect((await h.del(`${V1}/user/${me.id}/2fa/${USER_PROVIDER}`)).status).toBe(200)
    const byAdmin = await h.json<{ isEnabledOnUser: boolean }[]>(`${V1}/user/${me.id}/2fa`)
    expect(byAdmin.some((p) => p.isEnabledOnUser)).toBe(false)
    // A code no longer matters to the writer's own disable, as nothing is on.
    expect(
      (await writer.del(`${V1}/user/current/2fa/${USER_PROVIDER}?code=${codeFor(secret, 1)}`))
        .status,
    ).toBe(400)
  })

  test('the owner turns it off with a code, and signing in no longer asks', async () => {
    const h = await server()
    const { secret } = await turnOn(h)
    expect(
      (await h.del(`${V1}/user/current/2fa/${USER_PROVIDER}?code=${codeFor(secret, 1)}`)).status,
    ).toBe(200)
    expect((await backofficeLogin(h, ADMIN)).login.status).toBe(200)
  })

  test('without the secret key it cannot be turned on', async () => {
    const h = await server('')
    const setup = await h.call(`${V1}/user/current/2fa/${USER_PROVIDER}`)
    expect(setup.status).toBe(400)
    const configuration = await h.json<{ allowTwoFactor: boolean }>(
      `${V1}/user/current/configuration`,
    )
    expect(configuration.allowTwoFactor).toBe(false)
  })

  test('another provider name is not installed', async () => {
    const h = await server()
    expect((await h.call(`${V1}/user/current/2fa/SomethingElse`)).status).toBe(404)
  })
})

describe(`members (${DIALECT})`, () => {
  const site = async () => {
    const h = await signedInServer({ config: { secretKey: SECRET_KEY } })
    open.push(h.db)
    const created = await h.post(`${V1}/member`, {
      memberType: { id: SYSTEM_MEMBER_TYPE.key },
      email: 'ada@example.test',
      username: 'ada',
      password: 'correct-horse-battery',
      isApproved: true,
      groups: [],
      values: [],
      variants: [{ culture: null, segment: null, name: 'Ada' }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    const jar = new Jar()
    const send = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      if (jar.header) headers.set('cookie', jar.header)
      return jar.absorb(
        await h.server.fetch(
          new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init, headers }),
        ),
      )
    }
    const post = (path: string, body: Record<string, string> = {}) =>
      send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const login = () =>
      post('/umbraco/members/login', { username: 'ada', password: 'correct-horse-battery' })
    const turnOnForMember = async () => {
      expect((await login()).status).toBe(200)
      const setup = (await (await post('/umbraco/members/2fa/setup')).json()) as {
        secret: string
        qrCodeSetupImageUrl: string
      }
      expect(setup.qrCodeSetupImageUrl).toStartWith('data:image/svg+xml')
      const used = codeFor(setup.secret)
      const enabled = await post('/umbraco/members/2fa/enable', {
        secret: setup.secret,
        code: used,
      })
      expect(enabled.status).toBe(200)
      const { recoveryCodes } = (await enabled.json()) as { recoveryCodes: string[] }
      await post('/umbraco/members/logout')
      jar.cookies.clear()
      return { secret: setup.secret, recoveryCodes, used }
    }
    return { h, key, jar, send, post, login, turnOnForMember }
  }

  test('once on, the password alone does not sign in, and the code does', async () => {
    const { send, post, login, turnOnForMember } = await site()
    const { secret, used } = await turnOnForMember()
    const first = await login()
    expect(await first.json()).toEqual({ twoFactorRequired: true })
    expect((await send('/umbraco/members/current')).status).toBe(401)
    expect((await post('/umbraco/members/login/2fa', { code: used })).status).toBe(400)
    const verified = await post('/umbraco/members/login/2fa', { code: codeFor(secret, 1) })
    expect(verified.status).toBe(200)
    const current = await send('/umbraco/members/current')
    expect(current.status).toBe(200)
    const state = (await (await send('/umbraco/members/2fa')).json()) as Record<string, unknown>
    expect(state).toEqual({ available: true, enabled: true, recoveryCodesLeft: 10 })
  })

  test('a form post is sent back with a flag to ask for the code', async () => {
    const { send, turnOnForMember } = await site()
    await turnOnForMember()
    const response = await send('/umbraco/members/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: 'ada',
        password: 'correct-horse-battery',
        returnUrl: '/account',
      }).toString(),
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/account?memberTwoFactorRequired=1')
  })

  test('a recovery code signs a member in once', async () => {
    const { send, post, login, jar, turnOnForMember } = await site()
    const { recoveryCodes } = await turnOnForMember()
    const [code = ''] = recoveryCodes
    await login()
    expect((await post('/umbraco/members/login/2fa', { code })).status).toBe(200)
    expect((await send('/umbraco/members/current')).status).toBe(200)
    jar.cookies.clear()
    await login()
    expect((await post('/umbraco/members/login/2fa', { code })).status).toBe(400)
  })

  test('the code step without the password first is refused', async () => {
    const { post, turnOnForMember } = await site()
    const { secret } = await turnOnForMember()
    expect((await post('/umbraco/members/login/2fa', { code: codeFor(secret, 1) })).status).toBe(
      401,
    )
  })

  test('the member workspace shows it on, and turning it off there resets it', async () => {
    const { h, key, login, turnOnForMember } = await site()
    await turnOnForMember()
    const member = await h.json<Record<string, unknown>>(`${V1}/member/${key}`)
    expect(member.isTwoFactorEnabled).toBe(true)
    const saved = await h.put(`${V1}/member/${key}`, { ...member, isTwoFactorEnabled: false })
    expect(saved.status).toBe(200)
    expect((await h.json<Record<string, unknown>>(`${V1}/member/${key}`)).isTwoFactorEnabled).toBe(
      false,
    )
    expect(await (await login()).json()).toMatchObject({ member: { username: 'ada' } })
  })

  test('the settings need a signed-in member', async () => {
    const server = await bootServer({ config: { secretKey: SECRET_KEY } })
    open.push({ close: () => server.close() })
    const response = await server.fetch(new Request(`${ORIGIN}/umbraco/members/2fa`))
    expect(response.status).toBe(401)
  })
})
