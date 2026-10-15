/**
 * Story 050: members signing in to the Delivery API — client credentials for
 * the members a site names, and the authorization code flow with PKCE — and
 * what a token then opens.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type DeliveryApiOptions,
  memberAuthorizationProblems,
  resolveDeliveryApiSettings,
} from '@crombolo/api-delivery'
import {
  ComponentRepository,
  ContentTypeRepository,
  hashToken,
  newToken,
  PublicAccessRepository,
  pkceMatches,
  SYSTEM_MEMBER_TYPE,
} from '@crombolo/data'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const ORIGIN = 'http://localhost'
const SECURITY = '/umbraco/delivery/api/v1/security/member'
const APP = 'https://app.example.test/callback'

describe('tokens and PKCE', () => {
  test('a token is stored only as its hash, and S256 is checked exactly', () => {
    const { token, hash } = newToken()
    expect(hash).toBe(hashToken(token))
    expect(hash).not.toContain(token)
    const verifier = 'a'.repeat(50)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    expect(pkceMatches(verifier, challenge)).toBe(true)
    expect(pkceMatches(`${verifier}x`, challenge)).toBe(false)
  })

  test('a misconfigured app sign-in is said at boot', () => {
    const problems = memberAuthorizationProblems(
      resolveDeliveryApiSettings({
        memberAuthorization: {
          authorizationCodeFlow: { enabled: true, loginRedirectUrls: ['/relative'] },
        },
      }),
    )
    expect(problems.join(' ')).toContain('must be absolute')
    expect(problems.join(' ')).toContain('No member login page')
  })
})

const PAGE = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"
`

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

const SETTINGS: DeliveryApiOptions = {
  enabled: true,
  memberAuthorization: {
    clientCredentialsFlow: {
      enabled: true,
      associatedMembers: [
        { userName: 'shop', clientId: 'shop', clientSecret: 'shop-secret' },
        { userName: 'outsider', clientId: 'outsider', clientSecret: 'outsider-secret' },
      ],
    },
    authorizationCodeFlow: {
      enabled: true,
      loginRedirectUrls: [APP],
      logoutRedirectUrls: ['https://app.example.test/bye'],
      loginPage: '/login',
    },
  },
}

/** Home with a members-only page under it, open to the Staff group. */
async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'delivery-members-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE)
  writeFileSync(join(root, 'components', 'page.tsx'), 'export default () => <main />\n')
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      deliveryApi: SETTINGS,
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const page = async (name: string, parent: string | null) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: parent ? { id: parent } : null,
      values: [],
      variants: [{ culture: null, segment: null, name }],
    })
    const key = response.headers.get('umb-generated-resource') as string
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    return key
  }
  const staff = (await h.post(`${V1}/member-group`, { name: 'Staff' })).headers.get(
    'umb-generated-resource',
  ) as string
  const member = async (username: string, groups: string[]) => {
    const response = await h.post(`${V1}/member`, {
      memberType: { id: SYSTEM_MEMBER_TYPE.key },
      email: `${username}@example.test`,
      username,
      password: 'correct-horse-battery',
      isApproved: true,
      groups,
      values: [],
      variants: [{ culture: null, segment: null, name: username }],
    })
    expect(response.status, `member ${username}`).toBe(201)
    return response.headers.get('umb-generated-resource') as string
  }
  const home = await page('Home', null)
  const secret = await page('Secret', home)
  await new PublicAccessRepository(h.server.db).save({
    nodeKey: secret,
    loginNodeKey: home,
    errorNodeKey: home,
    memberGroupNames: ['Staff'],
    memberUserNames: [],
  })
  const shop = await member('shop', [staff])
  await member('outsider', [])
  const ada = await member('ada', [staff])
  h.server.cache.invalidate()

  const visit = (path: string, init: RequestInit = {}) =>
    h.server.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }))
  const form = (path: string, fields: Record<string, string>) =>
    visit(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })
  const clientToken = async (id: string, secretValue: string, scope = '') =>
    form(`${SECURITY}/token`, {
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secretValue,
      ...(scope ? { scope } : {}),
    })
  const secretItem = (token?: string) =>
    visit(`/umbraco/delivery/api/v2/content/item/${secret}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  const signIn = async (username: string) => {
    const response = await visit('/umbraco/members/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct-horse-battery' }),
    })
    return (response.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  }
  return { h, secret, shop, ada, visit, form, clientToken, secretItem, signIn }
}

const pkce = () => {
  const verifier = crypto.randomUUID() + crypto.randomUUID()
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

describe(`client credentials (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('a configured member gets a token that opens what their groups allow', async () => {
    const { clientToken, secretItem } = await site()
    expect((await secretItem()).status).toBe(401)
    const granted = await clientToken('umbraco-member-shop', 'shop-secret')
    expect(granted.status).toBe(200)
    const body = (await granted.json()) as Record<string, unknown>
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 300 })
    expect(body.refresh_token).toBeUndefined()
    expect((await secretItem(body.access_token as string)).status).toBe(200)
  })

  test('a member outside the page’s groups is forbidden; a bad token is anonymous', async () => {
    const { clientToken, secretItem } = await site()
    const outsider = (await (
      await clientToken('umbraco-member-outsider', 'outsider-secret')
    ).json()) as {
      access_token: string
    }
    expect((await secretItem(outsider.access_token)).status).toBe(403)
    expect((await secretItem('not-a-token')).status).toBe(401)
  })

  test('the id must carry its prefix, the secret must match, and no refresh is offered', async () => {
    const { clientToken } = await site()
    expect((await clientToken('shop', 'shop-secret')).status).toBe(401)
    const wrong = await clientToken('umbraco-member-shop', 'nope')
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({ error: 'invalid_client' })
    expect((await clientToken('umbraco-member-shop', 'shop-secret', 'offline_access')).status).toBe(
      400,
    )
  })

  test('the token reads the member as they are now: a member locked out is let in no more', async () => {
    const { h, clientToken, secretItem, shop } = await site()
    const { access_token } = (await (
      await clientToken('umbraco-member-shop', 'shop-secret')
    ).json()) as {
      access_token: string
    }
    expect((await secretItem(access_token)).status).toBe(200)
    await h.server.db.exec(
      'UPDATE member SET is_locked_out = ? WHERE node_id = (SELECT id FROM node WHERE unique_id = ?)',
      [h.server.db.dialect.boolValue(true), shop],
    )
    expect((await secretItem(access_token)).status).toBe(401)
  })

  test('the backoffice shows a configured client member as kind Api', async () => {
    const { h, shop, ada } = await site()
    expect((await h.json<{ kind: string }>(`${V1}/member/${shop}`)).kind).toBe('Api')
    expect((await h.json<{ kind: string }>(`${V1}/member/${ada}`)).kind).toBe('Default')
  })
})

describe(`signing in from an app (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  const authorizeUrl = (challenge: string, extra: Record<string, string> = {}) =>
    `${SECURITY}/authorize?${new URLSearchParams({
      client_id: 'umbraco-member',
      redirect_uri: APP,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'openid offline_access',
      state: 'xyz',
      ...extra,
    })}`

  test('a member not signed in is sent to the login page, and comes back with a code', async () => {
    const { visit, signIn, form, secretItem } = await site()
    const { verifier, challenge } = pkce()
    const toLogin = await visit(authorizeUrl(challenge))
    expect(toLogin.status).toBe(302)
    const location = toLogin.headers.get('location') as string
    expect(location.startsWith('/login?returnUrl=')).toBe(true)
    expect(decodeURIComponent(location)).toContain('/security/member/authorize?')

    const cookie = await signIn('ada')
    const back = await visit(authorizeUrl(challenge), { headers: { cookie } })
    expect(back.status).toBe(302)
    const redirect = new URL(back.headers.get('location') as string)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(APP)
    expect(redirect.searchParams.get('state')).toBe('xyz')
    const code = redirect.searchParams.get('code') as string

    const tokens = await form(`${SECURITY}/token`, {
      grant_type: 'authorization_code',
      client_id: 'umbraco-member',
      code,
      redirect_uri: APP,
      code_verifier: verifier,
    })
    expect(tokens.status).toBe(200)
    const body = (await tokens.json()) as { access_token: string; refresh_token: string }
    expect((await secretItem(body.access_token)).status).toBe(200)

    // A code is spent once; a refresh is rolled, so the old one is spent too.
    const again = await form(`${SECURITY}/token`, {
      grant_type: 'authorization_code',
      client_id: 'umbraco-member',
      code,
      redirect_uri: APP,
      code_verifier: verifier,
    })
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' })
    const refreshed = await form(`${SECURITY}/token`, {
      grant_type: 'refresh_token',
      client_id: 'umbraco-member',
      refresh_token: body.refresh_token,
    })
    expect(refreshed.status).toBe(200)
    const reused = await form(`${SECURITY}/token`, {
      grant_type: 'refresh_token',
      client_id: 'umbraco-member',
      refresh_token: body.refresh_token,
    })
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' })
  })

  test('PKCE must be S256, the redirect must be registered, and the verifier must match', async () => {
    const { visit, signIn, form } = await site()
    const { challenge } = pkce()
    const plain = await visit(authorizeUrl(challenge, { code_challenge_method: 'plain' }))
    expect(plain.status).toBe(400)
    expect(await plain.text()).toContain("'code_challenge_method' is not supported")
    const elsewhere = await visit(
      authorizeUrl(challenge, { redirect_uri: 'https://evil.example/cb' }),
    )
    expect(await elsewhere.text()).toContain('not valid for this client application')

    const cookie = await signIn('ada')
    const back = await visit(authorizeUrl(challenge), { headers: { cookie } })
    const code = new URL(back.headers.get('location') as string).searchParams.get('code') as string
    const wrong = await form(`${SECURITY}/token`, {
      grant_type: 'authorization_code',
      client_id: 'umbraco-member',
      code,
      redirect_uri: APP,
      code_verifier: 'not-the-verifier',
    })
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' })
  })

  test('signing out ends the member’s tokens, and userinfo describes the member', async () => {
    const { visit, signIn, form, secretItem } = await site()
    const { verifier, challenge } = pkce()
    const cookie = await signIn('ada')
    const back = await visit(authorizeUrl(challenge), { headers: { cookie } })
    const code = new URL(back.headers.get('location') as string).searchParams.get('code') as string
    const { access_token } = (await (
      await form(`${SECURITY}/token`, {
        grant_type: 'authorization_code',
        client_id: 'umbraco-member',
        code,
        redirect_uri: APP,
        code_verifier: verifier,
      })
    ).json()) as { access_token: string }

    const info = await visit(`${SECURITY}/userinfo`, {
      headers: { authorization: `Bearer ${access_token}` },
    })
    expect(await info.json()).toMatchObject({
      name: 'ada',
      email: 'ada@example.test',
      role: ['Staff'],
    })

    const out = await visit(
      `${SECURITY}/signout?post_logout_redirect_uri=${encodeURIComponent('https://app.example.test/bye')}`,
      {
        headers: { cookie },
      },
    )
    expect(out.status).toBe(302)
    expect((await secretItem(access_token)).status).toBe(401)
    expect(
      (
        await visit(
          `${SECURITY}/signout?post_logout_redirect_uri=${encodeURIComponent('https://evil.example/')}`,
        )
      ).status,
    ).toBe(400)
  })
})
