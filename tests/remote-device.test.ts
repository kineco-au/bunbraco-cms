/**
 * Story 107: signing a terminal in by the OAuth device grant (RFC 8628) — the
 * codes, the waiting, a person approving or declining in the back office, the
 * tokens, and signing the device out again.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { DEVICE_CODE_GRANT, REMOTE_CLIENT_ID } from '@crombolo/auth'
import { dialectUnderTest } from './support/db.ts'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

const SECURITY = `${V1}/security/back-office`

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

/** A request from the terminal: no cookies, a form body. */
const terminal = (h: Harness, path: string, fields: Record<string, string>) =>
  h.server.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  )

async function start(h: Harness) {
  const response = await terminal(h, `${SECURITY}/device`, {
    client_id: REMOTE_CLIENT_ID,
    client_name: 'crombolo on a laptop',
  })
  expect(response.status).toBe(200)
  return (await response.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    verification_uri_complete: string
    expires_in: number
    interval: number
  }
}

const poll = (h: Harness, deviceCode: string) =>
  terminal(h, `${SECURITY}/token`, {
    grant_type: DEVICE_CODE_GRANT,
    device_code: deviceCode,
    client_id: REMOTE_CLIENT_ID,
  })

describe(`device sign-in (${dialectUnderTest})`, () => {
  test('waits, is approved by a signed-in person, and gives that person’s tokens once', async () => {
    const h = await signedInServer()
    open.push(h)
    const codes = await start(h)
    expect(codes.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/)
    expect(codes.verification_uri).toBe(`${ORIGIN}/crombolo/device`)
    expect(codes.verification_uri_complete).toContain(encodeURIComponent(codes.user_code))
    expect(codes.interval).toBe(5)

    const waiting = await poll(h, codes.device_code)
    expect(waiting.status).toBe(400)
    expect(((await waiting.json()) as { error: string }).error).toBe('authorization_pending')
    const tooSoon = await poll(h, codes.device_code)
    expect(((await tooSoon.json()) as { error: string }).error).toBe('slow_down')

    // The approval page, as the person signed in to the back office sees it.
    const pending = await h.json<{ userCode: string; clientName: string }>(
      `${SECURITY}/device/pending?user_code=${codes.user_code.toLowerCase().replace('-', ' ')}`,
    )
    expect(pending).toMatchObject({ userCode: codes.user_code, clientName: 'crombolo on a laptop' })
    expect(
      (await h.post(`${SECURITY}/device/decide`, { userCode: codes.user_code, approve: true }))
        .status,
    ).toBe(204)

    const granted = await poll(h, codes.device_code)
    expect(granted.status).toBe(200)
    const tokens = (await granted.json()) as { access_token: string; refresh_token: string }
    expect(tokens.access_token.length).toBeGreaterThan(20)
    const me = await h.server.fetch(
      new Request(`${ORIGIN}${V1}/user/current`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
    )
    expect(me.status).toBe(200)
    expect(((await me.json()) as { email: string }).email).toBe('admin@crombolo.local')

    // Once only.
    const again = await poll(h, codes.device_code)
    expect(((await again.json()) as { error: string }).error).toBe('invalid_grant')

    // A refresh keeps it signed in.
    const refreshed = await terminal(h, `${SECURITY}/token`, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: REMOTE_CLIENT_ID,
    })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { access_token: string }

    // Listed, and signed out from the profile.
    const devices = await h.json<{ id: number; name: string }[]>(`${SECURITY}/devices`)
    expect(devices.map((d) => d.name)).toEqual(['crombolo on a laptop'])
    expect((await h.del(`${SECURITY}/devices/${devices[0]?.id}`)).status).toBe(204)
    const after = await h.server.fetch(
      new Request(`${ORIGIN}${V1}/user/current`, {
        headers: { authorization: `Bearer ${next.access_token}` },
      }),
    )
    expect(after.status).toBe(401)
    expect(await h.json<unknown[]>(`${SECURITY}/devices`)).toEqual([])
  })

  test('a declined sign-in is refused, and a code cannot be decided twice', async () => {
    const h = await signedInServer()
    open.push(h)
    const codes = await start(h)
    expect(
      (await h.post(`${SECURITY}/device/decide`, { userCode: codes.user_code, approve: false }))
        .status,
    ).toBe(204)
    const refused = await poll(h, codes.device_code)
    expect(((await refused.json()) as { error: string }).error).toBe('access_denied')
    expect(
      (await h.post(`${SECURITY}/device/decide`, { userCode: codes.user_code, approve: true }))
        .status,
    ).toBe(404)
  })

  test('only the terminal’s client may start one, and only a signed-in person may decide', async () => {
    const h = await signedInServer()
    open.push(h)
    const wrong = await terminal(h, `${SECURITY}/device`, { client_id: 'someone-else' })
    expect(wrong.status).toBe(401)
    const codes = await start(h)
    const anonymous = await h.server.fetch(
      new Request(`${ORIGIN}${SECURITY}/device/pending?user_code=${codes.user_code}`),
    )
    expect(anonymous.status).toBe(401)
    const crossSite = await h.call(`${SECURITY}/device/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ userCode: codes.user_code, approve: true }),
    })
    expect(crossSite.status).toBe(403)
  })

  test('the approval page sends a visitor to sign in first, and back', async () => {
    const h = await signedInServer()
    open.push(h)
    const response = await h.server.fetch(
      new Request(`${ORIGIN}/crombolo/device?user_code=ABCD-EFGH`, { redirect: 'manual' }),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      `/crombolo/login?returnUrl=${encodeURIComponent('/crombolo/device?user_code=ABCD-EFGH')}`,
    )
    const page = await h.call('/crombolo/device?user_code=ABCD-EFGH')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('user-code="ABCD-EFGH"')
  })
})
