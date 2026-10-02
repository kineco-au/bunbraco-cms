/**
 * WP-6.8: public access — protecting a branch by member group or by named
 * member — and the member sign-in it depends on.
 *
 * The rendering half is what matters: Umbraco *rewrites* a protected page to its
 * login or error page rather than redirecting, so the visitor keeps the URL they
 * asked for. These tests assert the body that comes back at the protected URL.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, SYSTEM_MEMBER_TYPE, TemplateRepository } from '@bunbraco/data'
import type { BunbracoConfig } from '@bunbraco/server'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

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

const PAGE = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
templates = ["page"]
default-template = "page"
`

const VIEW = `export default function Page({ model, member }) {
  return (
    <main>
      <h1>{model.name}</h1>
      <p class="who">{member ? member.username : 'anonymous'}</p>
      <p class="roles">{member ? member.roles.join(',') : ''}</p>
    </main>
  )
}
`

async function site(config: Partial<BunbracoConfig> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'public-access-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), PAGE)
  writeFileSync(join(root, 'Views', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), viewsDir: join(root, 'Views'), ...config },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const templateKey = (await new TemplateRepository(h.server.db).byAlias('page'))?.key as string

  const page = async (name: string, parent: string | null = null) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: templateKey },
      parent: parent ? { id: parent } : null,
      values: [],
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${name}: ${response.status} ${await response.text()}`)
    const key = response.headers.get('umb-generated-resource') as string
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    return key
  }
  const group = async (name: string) => {
    const response = await h.post(`${V1}/member-group`, { name })
    return response.headers.get('umb-generated-resource') as string
  }
  const member = async (username: string, groups: string[] = []) => {
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
    if (response.status !== 201)
      throw new Error(`create member ${username}: ${response.status} ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  /**
   * A visitor, not the editor: the harness carries the signed-in editor's
   * cookies, so anything to do with a member session goes straight to the server
   * with only the cookies that member holds.
   */
  const visit = (path: string, init: RequestInit = {}) =>
    h.server.fetch(new Request(`http://localhost${path}`, init))
  const signIn = async (username: string, password = 'correct-horse-battery') => {
    const response = await visit('/umbraco/members/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    return {
      status: response.status,
      cookie: (response.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '',
    }
  }
  const get = async (path: string, cookie?: string) => {
    const response = await visit(path, cookie ? { headers: { cookie } } : {})
    return { status: response.status, body: await response.text() }
  }
  return { h, page, group, member, signIn, get, visit }
}

const heading = (body: string) => /<h1>([^<]*)<\/h1>/.exec(body)?.[1]
const who = (body: string) => /class="who">([^<]*)</.exec(body)?.[1]

describe(`public access (${process.env.BUNBRACO_DB ?? 'sqlite'})`, () => {
  test('an entry is created, read back with its group resolved, changed and removed', async () => {
    const { h, page, group } = await site()
    const home = await page('Home')
    const login = await page('Login')
    const denied = await page('Denied')
    const subscribers = await group('Subscribers')

    const created = await h.post(`${V1}/document/${home}/public-access`, {
      memberUserNames: [],
      memberGroupNames: ['Subscribers'],
      loginDocument: { id: login },
      errorDocument: { id: denied },
    })
    expect(created.status).toBe(201)

    const read = await h.json<{
      loginDocument: { id: string }
      errorDocument: { id: string }
      groups: Array<{ id: string; name: string; flags: unknown[] }>
      members: unknown[]
      isProtectedByAncestor: boolean
    }>(`${V1}/document/${home}/public-access`)
    expect(read.loginDocument).toEqual({ id: login })
    expect(read.errorDocument).toEqual({ id: denied })
    expect(read.groups).toEqual([{ id: subscribers, name: 'Subscribers', flags: [] }])
    expect(read.members).toEqual([])
    expect(read.isProtectedByAncestor).toBe(false)

    // A rule may name members instead, and replacing the entry replaces its rules.
    expect(
      (
        await h.put(`${V1}/document/${home}/public-access`, {
          memberUserNames: ['ada'],
          memberGroupNames: [],
          loginDocument: { id: login },
          errorDocument: { id: denied },
        })
      ).status,
    ).toBe(200)
    const replaced = await h.json<{ groups: unknown[]; members: unknown[] }>(
      `${V1}/document/${home}/public-access`,
    )
    expect(replaced.groups).toEqual([])
    // "ada" is not a member yet, so the name resolves to nothing — which is
    // exactly what the rule means once a member is renamed away from it.
    expect(replaced.members).toEqual([])

    expect((await h.del(`${V1}/document/${home}/public-access`)).status).toBe(200)
    expect((await h.call(`${V1}/document/${home}/public-access`)).status).toBe(404)
    expect((await h.del(`${V1}/document/${home}/public-access`)).status).toBe(404)
  })

  test('a named member resolves, and a descendant reports being protected above it', async () => {
    const { h, page, group, member } = await site()
    const home = await page('Home')
    const child = await page('Child', home)
    const login = await page('Login')
    await group('Subscribers')
    const ada = await member('ada')

    await h.post(`${V1}/document/${home}/public-access`, {
      memberUserNames: ['ada'],
      memberGroupNames: [],
      loginDocument: { id: login },
      errorDocument: { id: login },
    })
    const read = await h.json<{
      members: Array<{ id: string; variants: Array<{ name: string }> }>
    }>(`${V1}/document/${home}/public-access`)
    expect(read.members.map((m) => m.id)).toEqual([ada])
    expect(read.members[0]?.variants.map((v) => v.name)).toEqual(['ada'])

    // The child has no entry of its own...
    expect((await h.call(`${V1}/document/${child}/public-access`)).status).toBe(404)
    // ...but asking with ancestors finds the one that governs it.
    const inherited = await h.json<{ isProtectedByAncestor: boolean }>(
      `${V1}/document/${child}/public-access?includeAncestors=true`,
    )
    expect(inherited.isProtectedByAncestor).toBe(true)
  })

  test('refuse a rule with nothing in it, a rule with both kinds, and unknown pages', async () => {
    const { h, page } = await site()
    const home = await page('Home')
    const login = await page('Login')
    const both = {
      memberUserNames: ['ada'],
      memberGroupNames: ['Subscribers'],
      loginDocument: { id: login },
      errorDocument: { id: login },
    }
    const ambiguous = await h.post(`${V1}/document/${home}/public-access`, both)
    expect(ambiguous.status).toBe(400)
    expect((await ambiguous.json()).title).toBe('Ambiguous Rule')

    const empty = await h.post(`${V1}/document/${home}/public-access`, {
      ...both,
      memberUserNames: [],
      memberGroupNames: [],
    })
    expect(empty.status).toBe(400)
    expect((await empty.json()).title).toBe('No allowed entities given')

    expect(
      (
        await h.post(`${V1}/document/${home}/public-access`, {
          ...both,
          memberUserNames: [],
          loginDocument: { id: crypto.randomUUID() },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await h.post(`${V1}/document/${crypto.randomUUID()}/public-access`, {
          ...both,
          memberUserNames: [],
        })
      ).status,
    ).toBe(404)
  })

  test('protect a branch: anonymous sees the login page, an outsider the error page, a member the page', async () => {
    const { h, page, group, member, signIn, get } = await site()
    const home = await page('Home')
    const secret = await page('Secret', home)
    const login = await page('Login')
    const denied = await page('Denied')
    const subscribers = await group('Subscribers')
    await member('ada', [subscribers])
    await member('mallory')

    await h.post(`${V1}/document/${secret}/public-access`, {
      memberUserNames: [],
      memberGroupNames: ['Subscribers'],
      loginDocument: { id: login },
      errorDocument: { id: denied },
    })

    // The URL never changes: what changes is which page renders at it.
    const anonymous = await get('/secret')
    expect(anonymous.status).toBe(200)
    expect(heading(anonymous.body)).toBe('Login')

    const outsider = await signIn('mallory')
    expect(outsider.status).toBe(200)
    const refused = await get('/secret', outsider.cookie)
    expect(heading(refused.body)).toBe('Denied')

    const insider = await signIn('ada')
    const allowed = await get('/secret', insider.cookie)
    expect(heading(allowed.body)).toBe('Secret')
    expect(who(allowed.body)).toBe('ada')
    expect(/class="roles">([^<]*)</.exec(allowed.body)?.[1]).toBe('Subscribers')

    // An unprotected page is unaffected, signed in or not. Home is the site root,
    // so it answers at '/'.
    expect(heading((await get('/')).body)).toBe('Home')
    expect(who((await get('/', insider.cookie)).body)).toBe('ada')
  })

  test('protection is inherited by descendants, and a rule naming a member admits only that one', async () => {
    const { h, page, member, signIn, get } = await site()
    const area = await page('Area')
    await page('Deep', area)
    const login = await page('Login')
    const denied = await page('Denied')
    await member('ada')
    await member('mallory')

    await h.post(`${V1}/document/${area}/public-access`, {
      memberUserNames: ['ada'],
      memberGroupNames: [],
      loginDocument: { id: login },
      errorDocument: { id: denied },
    })

    expect(heading((await get('/deep')).body)).toBe('Login')
    const ada = await signIn('ada')
    expect(heading((await get('/deep', ada.cookie)).body)).toBe('Deep')
    expect(heading((await get('/', ada.cookie)).body)).toBe('Area')
    const mallory = await signIn('mallory')
    expect(heading((await get('/deep', mallory.cookie)).body)).toBe('Denied')
  })

  test('a login page inside the branch it protects still renders', async () => {
    const { h, page, member, get } = await site()
    const area = await page('Area')
    const login = await page('Sign in', area)

    await h.post(`${V1}/document/${area}/public-access`, {
      memberUserNames: ['ada'],
      memberGroupNames: [],
      loginDocument: { id: login },
      errorDocument: { id: login },
    })
    await member('ada')

    // Without this exception the substitution would never terminate.
    expect(heading((await get('/sign-in')).body)).toBe('Sign in')
    expect(heading((await get('/')).body)).toBe('Sign in')
  })

  test('sign-in refuses bad credentials, locks out after too many, and sign-out ends the session', async () => {
    const { page, member, signIn, get } = await site({ maxFailedPasswordAttempts: 3 })
    await page('Home')
    await member('ada')

    expect((await signIn('ada', 'wrong')).status).toBe(401)
    expect((await signIn('nobody')).status).toBe(401)
    const good = await signIn('ada')
    expect(good.status).toBe(200)
    expect(who((await get('/', good.cookie)).body)).toBe('ada')

    // Three wrong passwords lock the account, and the right one no longer works.
    for (let attempt = 0; attempt < 3; attempt++) await signIn('ada', 'wrong')
    expect((await signIn('ada')).status).toBe(401)
    // The lockout ends the session the member already had, too.
    expect(who((await get('/', good.cookie)).body)).toBe('anonymous')
  })

  test('a password change ends every session that member had', async () => {
    const { h, page, member, signIn, get } = await site()
    await page('Home')
    const key = await member('ada')
    const session = await signIn('ada')
    expect(who((await get('/', session.cookie)).body)).toBe('ada')

    expect(
      (
        await h.put(`${V1}/member/${key}`, {
          email: 'ada@example.test',
          username: 'ada',
          newPassword: 'a-different-one',
          isApproved: true,
          isLockedOut: false,
          isTwoFactorEnabled: false,
          values: [],
          variants: [{ culture: null, segment: null, name: 'ada' }],
        })
      ).status,
    ).toBe(200)

    // The security stamp rotated, so the ticket issued against the old one is over.
    expect(who((await get('/', session.cookie)).body)).toBe('anonymous')
    expect((await signIn('ada')).status).toBe(401)
    expect((await signIn('ada', 'a-different-one')).status).toBe(200)
  })

  test('registration is refused unless the site turns it on', async () => {
    const { page, visit } = await site()
    await page('Home')
    const off = await visit('/umbraco/members/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.test', username: 'new', password: 'a-password' }),
    })
    expect(off.status).toBe(404)
  })

  test('with registration on, a new member is created, signed in and in its default groups', async () => {
    const { h, page, group, get, visit } = await site({
      allowMemberRegistration: true,
      memberRegistrationGroups: ['Subscribers'],
    })
    await page('Home')
    await group('Subscribers')

    const register = async (body: Record<string, unknown>) =>
      visit('/umbraco/members/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const created = await register({
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      username: 'ada',
      password: 'correct-horse-battery',
    })
    expect(created.status).toBe(200)
    const cookie = (created.headers.getSetCookie()[0] ?? '').split(';')[0] as string
    const page1 = await get('/', cookie)
    expect(who(page1.body)).toBe('ada')
    expect(/class="roles">([^<]*)</.exec(page1.body)?.[1]).toBe('Subscribers')

    // The editor sees it in the Members collection.
    const listed = await h.json<{ items: Array<{ username: string; groups: string[] }> }>(
      `${V1}/filter/member?skip=0&take=10`,
    )
    expect(listed.items.map((m) => m.username)).toEqual(['ada'])
    expect(listed.items[0]?.groups.length).toBe(1)

    // The same username twice is a conflict, and a missing field is a 400.
    expect(
      (
        await register({
          name: 'Ada',
          email: 'other@example.test',
          username: 'ada',
          password: 'x',
        })
      ).status,
    ).toBe(409)
    expect((await register({ username: 'bob' })).status).toBe(400)

    // Members were held to no password policy at all while backoffice users
    // were; now they meet the same minimum.
    expect(
      (
        await register({
          name: 'Bob',
          email: 'bob@example.test',
          username: 'bob',
          password: 'short',
        })
      ).status,
    ).toBe(400)
  })

  test('a visitor registers as the configured type, whatever type they ask for', async () => {
    const { h, page, visit } = await site({
      allowMemberRegistration: true,
      memberRegistrationType: 'Member',
    })
    await page('Home')

    // A second type exists for the site's own purposes; registering is not the
    // way to become one.
    const other = await h.post(`${V1}/member-type`, {
      alias: 'staffMember',
      name: 'Staff Member',
      properties: [],
      containers: [],
      allowedAsRoot: false,
      variesByCulture: false,
      variesBySegment: false,
      isElement: false,
      compositions: [],
    })
    expect(other.status).toBe(201)

    const created = await visit('/umbraco/members/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada',
        email: 'ada@example.test',
        username: 'ada',
        password: 'correct-horse-battery',
        memberType: 'staffMember',
      }),
    })
    expect(created.status).toBe(200)

    const listed = await h.json<{ items: Array<{ username: string; memberType: { id: string } }> }>(
      `${V1}/filter/member?skip=0&take=10`,
    )
    expect(listed.items[0]?.username).toBe('ada')
    expect(listed.items[0]?.memberType.id).toBe(SYSTEM_MEMBER_TYPE.key)
  })

  test('sign-out clears the cookie, and current reports who is signed in', async () => {
    const { page, member, signIn, get, visit } = await site()
    await page('Home')
    await member('ada')
    const session = await signIn('ada')

    const current = await visit('/umbraco/members/current', {
      headers: { cookie: session.cookie },
    })
    expect(current.status).toBe(200)
    expect((await current.json()).member.username).toBe('ada')
    expect((await visit('/umbraco/members/current')).status).toBe(401)

    const out = await visit('/umbraco/members/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      body: '{}',
    })
    expect(out.status).toBe(200)
    const cleared = (out.headers.getSetCookie()[0] ?? '').split(';')[0] as string
    expect(cleared.endsWith('=')).toBe(true)
    expect(who((await get('/', cleared)).body)).toBe('anonymous')
  })

  test('a form post redirects instead of answering JSON, and a returnUrl must be local', async () => {
    const { page, member, visit } = await site()
    await page('Home')
    await member('ada')

    const form = async (body: Record<string, string>) =>
      visit('/umbraco/members/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      })

    const ok = await form({
      username: 'ada',
      password: 'correct-horse-battery',
      returnUrl: '/',
    })
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location')).toBe('/')

    const failed = await form({ username: 'ada', password: 'wrong', returnUrl: '/' })
    expect(failed.status).toBe(303)
    expect(failed.headers.get('location')).toBe('/?memberLoginFailed=1')

    // An absolute or protocol-relative returnUrl is ignored, so a login form
    // cannot be used to bounce a visitor off the site.
    const offsite = await form({
      username: 'ada',
      password: 'correct-horse-battery',
      returnUrl: 'https://elsewhere.test/',
    })
    expect(offsite.headers.get('location')).toBe('/')
    const protocolRelative = await form({
      username: 'ada',
      password: 'correct-horse-battery',
      returnUrl: '//elsewhere.test/',
    })
    expect(protocolRelative.headers.get('location')).toBe('/')

    // A browser reads `\` in a URL as `/`, so this one reached the same place
    // while starting with a single slash.
    const backslash = await form({
      username: 'ada',
      password: 'correct-horse-battery',
      returnUrl: '/\\elsewhere.test/',
    })
    expect(backslash.headers.get('location')).toBe('/')
  })

  test('a form on another site cannot sign a visitor in or out', async () => {
    const { page, member, visit } = await site()
    await page('Home')
    await member('ada')

    const crossSite = (
      path: string,
      body: Record<string, string>,
      headers: Record<string, string>,
    ) =>
      visit(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(body).toString(),
      })

    const credentials = { username: 'ada', password: 'correct-horse-battery', returnUrl: '/' }
    // What a browser sends when the form lives somewhere else. Signing a visitor
    // into an account the attacker holds is the point of doing this.
    const elsewhere: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example' },
    ]
    for (const headers of elsewhere) {
      expect((await crossSite('/umbraco/members/login', credentials, headers)).status).toBe(403)
      expect((await crossSite('/umbraco/members/logout', {}, headers)).status).toBe(403)
    }

    // The site's own form still works, however the browser labels it.
    expect(
      (await crossSite('/umbraco/members/login', credentials, { 'sec-fetch-site': 'same-origin' }))
        .status,
    ).toBe(303)
    expect(
      (await crossSite('/umbraco/members/login', credentials, { origin: 'http://localhost' }))
        .status,
    ).toBe(303)
  })
})
