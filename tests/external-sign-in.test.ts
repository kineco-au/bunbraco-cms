/**
 * Story 031: signing in through an external identity provider, for members on
 * the site and users in the backoffice, against an OpenID Connect provider the
 * test serves itself.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ComponentRepository,
  ContentTypeRepository,
  ExternalLoginRepository,
  externalLoginProvider,
  MemberRepository,
  PublicAccessRepository,
  SYSTEM_MEMBER_TYPE,
} from '@crombolo/data'
import {
  awsIdentityCenter,
  type CromboloConfig,
  decideSignIn,
  entra,
  type IdentityProvider,
  IdentityProviderOverrides,
  oidc,
  syncedGroups,
} from '@crombolo/server'
import { type FakeOidc, startFakeOidc } from './support/fake-oidc.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
const fakes: FakeOidc[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (fakes.length > 0) fakes.pop()?.stop()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('the presets', () => {
  test('know their issuer, scopes and claims', () => {
    const microsoft = entra({ tenantId: 'contoso', clientId: 'c', clientSecret: 's' })
    expect(microsoft.oidc).toMatchObject({
      id: 'entra',
      name: 'Microsoft',
      issuer: 'https://login.microsoftonline.com/contoso/v2.0',
      scopes: ['openid', 'profile', 'email'],
      claims: { email: 'email', name: 'name', groups: 'groups' },
    })
    const aws = awsIdentityCenter({ issuer: 'https://idc.example', clientId: 'c' })
    expect(aws.oidc).toMatchObject({ id: 'aws', name: 'AWS', issuer: 'https://idc.example' })
    const custom = oidc({
      id: 'okta',
      name: 'Okta',
      issuer: 'https://okta.example',
      clientId: 'c',
      claims: { email: 'mail' },
      groups: { claim: 'roles', map: { admin: 'Staff' } },
    })
    expect(custom.oidc.claims).toEqual({ email: 'mail', name: 'name', groups: 'roles' })
    expect(custom.groupMap).toEqual({ admin: 'Staff' })
    expect([custom.autoCreate, custom.linkByEmail, custom.emailsVerified]).toEqual([
      true,
      false,
      false,
    ])
  })

  test('refuse a bad id and missing settings', () => {
    expect(() => oidc({ id: 'Not OK', name: 'x', issuer: 'https://x', clientId: 'c' })).toThrow()
    expect(() => entra({ tenantId: '', clientId: 'c' })).toThrow()
    expect(() => awsIdentityCenter({ issuer: '', clientId: 'c' })).toThrow()
  })
})

describe('what a first sign-in comes to', () => {
  const provider = { autoCreate: true, linkByEmail: false, emailsVerified: false, name: 'Fake' }
  const identity = { email: 'ada@example.test', emailVerified: true }

  test('an account already linked signs in, whatever its email', () => {
    expect(decideSignIn({ linked: 'a', sameEmail: 'b', identity, provider })).toEqual({
      kind: 'signIn',
      ownerKey: 'a',
    })
  })

  test('an email already taken is linked only when allowed and verified', () => {
    expect(decideSignIn({ linked: undefined, sameEmail: 'b', identity, provider }).kind).toBe(
      'refuse',
    )
    const linking = { ...provider, linkByEmail: true }
    expect(
      decideSignIn({ linked: undefined, sameEmail: 'b', identity, provider: linking }),
    ).toEqual({ kind: 'link', ownerKey: 'b' })
    const unverified = { ...identity, emailVerified: false }
    expect(
      decideSignIn({ linked: undefined, sameEmail: 'b', identity: unverified, provider: linking })
        .kind,
    ).toBe('refuse')
    expect(
      decideSignIn({
        linked: undefined,
        sameEmail: 'b',
        identity: unverified,
        provider: { ...linking, emailsVerified: true },
      }).kind,
    ).toBe('link')
  })

  test('nobody yet is created when allowed, and an account with no email never is', () => {
    expect(decideSignIn({ linked: undefined, sameEmail: undefined, identity, provider })).toEqual({
      kind: 'create',
    })
    expect(
      decideSignIn({
        linked: undefined,
        sameEmail: undefined,
        identity,
        provider: { ...provider, autoCreate: false },
      }).kind,
    ).toBe('refuse')
    expect(
      decideSignIn({
        linked: undefined,
        sameEmail: undefined,
        identity: { email: undefined, emailVerified: false },
        provider,
      }).kind,
    ).toBe('refuse')
  })
})

describe('groups that follow the account', () => {
  const map = { 'staff-claim': 'Staff', 'vip-claim': 'VIP' }

  test('match the claim for the mapped groups and keep the rest', () => {
    expect(syncedGroups(['Staff', 'Newsletter'], ['vip-claim'], map)).toEqual(['Newsletter', 'VIP'])
    expect(syncedGroups([], ['staff-claim', 'unmapped'], map)).toEqual(['Staff'])
    expect(syncedGroups(['staff'], ['staff-claim'], map)).toEqual(['Staff'])
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

const VIEW = `export default function Page({ model, member }) {
  return (
    <main>
      <h1>{model.name}</h1>
      <p class="who">{member ? member.username : 'anonymous'}</p>
    </main>
  )
}
`

const CLIENT_ID = 'crombolo-site'

/** A site with a members-only page open to the Staff group, and a provider that maps `staff-claim` to it. */
async function memberSite(
  options: Partial<Parameters<typeof oidc>[0]> = {},
  config: Partial<CromboloConfig> = {},
) {
  const fake = await startFakeOidc(CLIENT_ID)
  fakes.push(fake)
  const root = mkdtempSync(join(process.cwd(), 'output', 'external-sign-in-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  const provider: IdentityProvider = oidc({
    id: 'fake',
    name: 'Fake',
    issuer: fake.issuer,
    clientId: CLIENT_ID,
    clientSecret: 'shh',
    groups: { map: { 'staff-claim': 'Staff' } },
    ...options,
  })
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      memberIdentityProviders: [provider],
      ...config,
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const page = async (name: string, parent: string | null = null) => {
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
  await h.post(`${V1}/member-group`, { name: 'Staff' })
  const home = await page('Home')
  const login = await page('Login', home)
  const secret = await page('Secret', home)
  await new PublicAccessRepository(h.server.db).save({
    nodeKey: secret,
    loginNodeKey: login,
    errorNodeKey: home,
    memberGroupNames: ['Staff'],
    memberUserNames: [],
  })
  h.server.cache.invalidate()

  const visit = (path: string, init: RequestInit = {}) =>
    h.server.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))
  const cookieOf = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1)

  /** The whole round trip: leave for the provider, sign in there, come back. */
  const signIn = async (returnUrl = '/secret') => {
    const started = await visit(
      `/umbraco/members/external/fake?returnUrl=${encodeURIComponent(returnUrl)}`,
    )
    expect(started.status).toBe(302)
    const flow = cookieOf(started, 'crombolo-external-member') as string
    const atProvider = await fetch(started.headers.get('location') as string, {
      redirect: 'manual',
    })
    const callback = new URL(atProvider.headers.get('location') as string)
    const back = await visit(`${callback.pathname}${callback.search}`, {
      headers: { cookie: flow },
    })
    const member = back.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => /^(__Host-)?umbMember/.test(c) && !c.endsWith('='))
    return { status: back.status, location: back.headers.get('location') ?? '', member }
  }
  const page_ = async (path: string, cookie?: string) => {
    const response = await visit(path, cookie ? { headers: { cookie } } : {})
    const body = await response.text()
    return {
      heading: /<h1>([^<]*)<\/h1>/.exec(body)?.[1],
      who: /class="who">([^<]*)</.exec(body)?.[1],
    }
  }
  return { h, fake, signIn, page: page_, visit }
}

describe(`members signing in through a provider (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('exit: a page protected by a member group is served after signing in through the provider', async () => {
    const { h, fake, signIn, page } = await memberSite()
    expect((await page('/secret')).heading).toBe('Login')

    fake.as({ sub: 'ada-1', email: 'Ada@Example.test', name: 'Ada', groups: ['staff-claim'] })
    const result = await signIn()
    expect(result.status).toBe(302)
    expect(result.location).toBe('/secret')
    expect(result.member).toBeDefined()
    expect(await page('/secret', result.member)).toEqual({
      heading: 'Secret',
      who: 'ada@example.test',
    })

    // A member was created, linked, and put in the mapped group, with no password.
    const member = await new MemberRepository(h.server.db).byEmail('ada@example.test')
    expect(member?.roles).toEqual(['Staff'])
    expect(member?.passwordHash).toBeNull()
    const links = await new ExternalLoginRepository(h.server.db).forOwner(member?.key as string)
    expect(links.map((l) => [l.loginProvider, l.providerKey])).toEqual([
      [externalLoginProvider('member', 'fake'), 'ada-1'],
    ])
    expect(fake.lastAuthorize()?.get('code_challenge_method')).toBe('S256')
  })

  test('the next sign-in finds the same member, and their groups follow the claim', async () => {
    const { h, fake, signIn, page } = await memberSite()
    fake.as({ sub: 'ada-1', email: 'ada@example.test', groups: ['staff-claim'] })
    await signIn()
    fake.as({ sub: 'ada-1', email: 'ada@example.test', groups: [] })
    const again = await signIn()
    expect(again.status).toBe(302)
    const members = await new MemberRepository(h.server.db).filter({ skip: 0, take: 10 })
    expect(members.total).toBe(1)
    expect(members.items[0]?.roles).toEqual([])
    // No longer in Staff: the page is the error page now.
    expect((await page('/secret', again.member)).heading).toBe('Home')
  })

  test('an email already taken is refused unless linking by verified email is on', async () => {
    const refused = await memberSite()
    await refused.h.post(`${V1}/member`, {
      memberType: { id: SYSTEM_MEMBER_TYPE.key },
      email: 'ada@example.test',
      username: 'ada',
      password: 'correct-horse-battery',
      isApproved: true,
      groups: [],
      values: [],
      variants: [{ culture: null, segment: null, name: 'Ada' }],
    })
    refused.fake.as({ sub: 'ada-1', email: 'ada@example.test', email_verified: true })
    const no = await refused.signIn()
    expect(no.member).toBeUndefined()
    expect(no.location).toContain('memberLoginFailed=1')
    expect(decodeURIComponent(no.location)).toContain('already exists')
    // Closed before the next site boots: on Postgres the next one resets the
    // schema this one is still connected to.
    await refused.h.db.close()
    open.splice(open.indexOf(refused.h), 1)

    const linking = await memberSite({ linkByEmail: true })
    await linking.h.post(`${V1}/member`, {
      memberType: { id: SYSTEM_MEMBER_TYPE.key },
      email: 'ada@example.test',
      username: 'ada',
      password: 'correct-horse-battery',
      isApproved: true,
      groups: [],
      values: [],
      variants: [{ culture: null, segment: null, name: 'Ada' }],
    })
    linking.fake.as({ sub: 'ada-1', email: 'ada@example.test', email_verified: false })
    expect((await linking.signIn()).member).toBeUndefined()
    linking.fake.as({ sub: 'ada-1', email: 'ada@example.test', email_verified: true })
    const yes = await linking.signIn('/')
    expect(yes.member).toBeDefined()
    expect((await linking.page('/', yes.member)).who).toBe('ada')
  })

  test('a forged, stale or misdirected token signs nobody in', async () => {
    const { fake, signIn } = await memberSite()
    fake.as({ sub: 'eve', email: 'eve@example.test' })
    for (const change of [
      { foreignKey: true },
      { expired: true },
      { audience: 'someone-else' },
      { nonce: 'replayed' },
    ]) {
      fake.tamper(change)
      const result = await signIn('/')
      expect([JSON.stringify(change), result.member]).toEqual([JSON.stringify(change), undefined])
      expect(result.location).toContain('memberLoginFailed=1')
    }
  })

  test('a callback without the flow it started from is refused', async () => {
    const { visit } = await memberSite()
    const response = await visit('/umbraco/members/external/fake/callback?code=x&state=y')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('memberLoginFailed=1')
    expect((await visit('/umbraco/members/external/nope')).status).toBe(404)
  })

  test("an administrator's override applies at the next sign-in", async () => {
    // The code names the wrong client, which the provider refuses.
    const { h, fake, signIn } = await memberSite({ clientId: 'wrong-client' })
    fake.as({ sub: 'ada-1', email: 'ada@example.test', groups: ['staff-claim'] })
    expect((await signIn('/')).member).toBeUndefined()

    await new IdentityProviderOverrides(h.server.db, undefined).update('member', 'fake', {
      clientId: CLIENT_ID,
    })
    expect((await signIn('/')).member).toBeDefined()
  })

  test("an app's sign-in naming the provider goes straight to it", async () => {
    const app = 'https://app.example.test/callback'
    const { visit } = await memberSite(
      {},
      {
        deliveryApi: {
          enabled: true,
          memberAuthorization: {
            authorizationCodeFlow: { enabled: true, loginRedirectUrls: [app], loginPage: '/login' },
          },
        },
      },
    )
    const authorize = `/umbraco/delivery/api/v1/security/member/authorize?client_id=umbraco-member&redirect_uri=${encodeURIComponent(app)}&response_type=code&code_challenge=abc&code_challenge_method=S256&scope=openid`
    const named = await visit(`${authorize}&identity_provider=UmbracoMembers.fake`)
    expect(named.status).toBe(302)
    const location = new URL(named.headers.get('location') as string, 'http://localhost')
    expect(location.pathname).toBe('/umbraco/members/external/fake')
    expect(location.searchParams.get('returnUrl')).toContain(
      '/umbraco/delivery/api/v1/security/member/authorize',
    )
    expect((await visit(`${authorize}&identity_provider=nope`)).status).toBe(400)
  })
})

describe(`backoffice users signing in through a provider (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('a new user is created in the mapped group, and the session carries the OAuth flow on', async () => {
    const fake = await startFakeOidc(CLIENT_ID)
    fakes.push(fake)
    const h = await signedInServer({
      config: {
        allowLocalLogin: false,
        backofficeIdentityProviders: [
          oidc({
            id: 'fake',
            name: 'Fake',
            issuer: fake.issuer,
            clientId: CLIENT_ID,
            groups: { map: { 'editors-claim': 'editor' } },
          }),
        ],
      },
    })
    open.push(h)
    const visit = (path: string, init: RequestInit = {}) =>
      h.server.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))
    const security = '/umbraco/management/api/v1/security/back-office'

    // Without a session, authorize sends the browser to the login page, which offers the provider.
    const backOffice = h.server.config.backOfficePath
    const authorize = `${security}/authorize?client_id=umbraco-back-office&redirect_uri=${encodeURIComponent(`http://localhost${backOffice}/oauth_complete`)}&response_type=code&code_challenge=abc&code_challenge_method=S256`
    const toLogin = await visit(authorize)
    const loginUrl = new URL(toLogin.headers.get('location') as string)
    const loginPage = await (await visit(`${loginUrl.pathname}${loginUrl.search}`)).text()
    expect(loginPage).toContain('disable-local-login')
    expect(loginPage).toContain('Fake')
    expect(loginPage).toContain(`${security}/external/fake?returnUrl=`)

    fake.as({
      sub: 'grace-1',
      email: 'grace@example.test',
      name: 'Grace',
      groups: ['editors-claim'],
    })
    const started = await visit(
      `${security}/external/fake?returnUrl=${encodeURIComponent(authorize)}`,
    )
    const flow = started.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => c.startsWith('crombolo-external-user=')) as string
    const atProvider = await fetch(started.headers.get('location') as string, {
      redirect: 'manual',
    })
    const callback = new URL(atProvider.headers.get('location') as string)
    const back = await visit(`${callback.pathname}${callback.search}`, {
      headers: { cookie: flow },
    })
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe(authorize)
    const session = back.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] as string)
      .find((c) => /umbSession/.test(c) && !c.endsWith('=')) as string
    expect(session).toBeDefined()

    // With the session, authorize hands out a code: the backoffice signs in from here.
    const resumed = await visit(authorize, { headers: { cookie: session } })
    expect(resumed.status).toBe(302)
    expect(new URL(resumed.headers.get('location') as string).searchParams.get('code')).toBeTruthy()

    const users = await h.json<{
      items: Array<{ email: string; userGroupIds: Array<{ id: string }> }>
    }>(`${V1}/user?skip=0&take=50`)
    const grace = users.items.find((u) => u.email === 'grace@example.test')
    expect(grace).toBeDefined()
    const groups = await h.json<{ items: Array<{ id: string; alias: string }> }>(
      `${V1}/user-group?skip=0&take=50`,
    )
    const editor = groups.items.find((g) => g.alias === 'editor')
    expect(grace?.userGroupIds.map((g) => g.id)).toEqual([editor?.id as string])

    const providers = await h.json<Array<{ providerSchemeName: string; isLinkedOnUser: boolean }>>(
      `${V1}/user/current/login-providers`,
    )
    expect(providers).toEqual([
      expect.objectContaining({ providerSchemeName: 'Umbraco.fake', isLinkedOnUser: false }),
    ])
  })
})
