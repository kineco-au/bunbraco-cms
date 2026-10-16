/**
 * Story 140: site search for visitors. What a page puts in the index (its
 * published values, per culture, by weight), what keeps it current, and the
 * query a results page runs, with protected branches left out.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accessTo } from '@crombolo/api-delivery'
import { branchAccess, memberMayOpen } from '@crombolo/core'
import {
  ComponentRepository,
  ContentTypeRepository,
  NodeRepository,
  PublicAccessRepository,
  SiteSearch,
  SYSTEM_MEMBER_TYPE,
} from '@crombolo/data'
import { excerpt, excerptHtml } from '@crombolo/render'
import { parseContentType, writeContentType } from '@crombolo/schema'
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

const PAGE = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page", "hidden", "settings"]
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
site-search = "high"

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"

[[property]]
alias = "summary"
name = "Summary"
type = "textarea"
site-search = "low"

[[property]]
alias = "internalNotes"
name = "Internal notes"
type = "textarea"
site-search = false

[[property]]
alias = "secret"
name = "Secret"
type = "textarea"
searchable = false
`

const HIDDEN = `[content-type]
alias = "hidden"
name = "Hidden"
allow-at-root = true
components = ["page"]
default-component = "page"
site-search = false

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"
`

const SETTINGS = `[content-type]
alias = "settings"
name = "Settings"
allow-at-root = true

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"
`

const STORY = `[content-type]
alias = "story"
name = "Story"
allow-at-root = true
varies-by-culture = true
components = ["page"]
default-component = "page"

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"
varies-by-culture = true
`

async function site(extraTypes: Record<string, string> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'site-search-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  for (const [file, toml] of Object.entries({
    page: PAGE,
    hidden: HIDDEN,
    settings: SETTINGS,
    ...extraTypes,
  }))
    writeFileSync(join(root, 'schema', 'content-types', `${file}.toml`), toml)
  writeFileSync(
    join(root, 'components', 'page.tsx'),
    'export default function Page({ model }) { return <h1>{model.name}</h1> }\n',
  )
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  // The tests run the indexer themselves, so nothing indexes behind their back.
  h.server.jobs.stop()
  const types = new ContentTypeRepository(h.server.db)
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string

  const create = async (
    type: string,
    names: Record<string, string>,
    values: Record<string, string> = {},
    parent: string | null = null,
  ) => {
    const typeKey = (await types.byAlias(type))?.key as string
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: parent ? { id: parent } : null,
      values: Object.entries(values).map(([alias, value]) => {
        const [name, culture] = alias.split('@')
        return { alias: name, value, culture: culture ?? null, segment: null }
      }),
      variants: Object.entries(names).map(([culture, name]) => ({
        culture: culture === '' ? null : culture,
        segment: null,
        name,
      })),
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  const publish = async (key: string, cultures: Array<string | null> = [null]) => {
    const response = await h.put(`${V1}/document/${key}/publish`, {
      publishSchedules: cultures.map((culture) => ({ culture })),
    })
    if (response.status !== 200)
      throw new Error(`publish ${response.status}: ${await response.text()}`)
  }
  /** Creates and publishes an invariant page. */
  const page = async (
    name: string,
    values: Record<string, string> = {},
    parent: string | null = null,
    type = 'page',
  ) => {
    const key = await create(type, { '': name }, values, parent)
    await publish(key)
    return key
  }
  const index = () => h.server.jobs.runSearchIndexing()
  const nodes = new NodeRepository(h.server.db)
  const ids = async (keys: readonly string[]) =>
    Promise.all(keys.map(async (key) => (await nodes.byKey(key))?.id as number))
  const search = async (
    term: string,
    options: { culture?: string; types?: string[]; denied?: string[]; allowed?: string[] } = {},
  ) =>
    new SiteSearch(h.server.db).query(term, {
      culture: options.culture ?? 'en-us',
      types: options.types,
      access: {
        denied: await ids(options.denied ?? []),
        allowed: await ids(options.allowed ?? []),
      },
      skip: 0,
      take: 50,
    })
  const keys = async (term: string, options?: Parameters<typeof search>[1]) =>
    (await search(term, options)).items.map((item) => item.key)
  return { h, root, create, publish, page, index, search, keys }
}

describe('the site-search keys', () => {
  test('read and write back: a level or false on a property, false on a page type', () => {
    const page = parseContentType('page.toml', PAGE)
    expect(page.problems).toEqual([])
    const by = (alias: string) => page.value?.properties.find((p) => p.alias === alias)?.siteSearch
    expect([by('title'), by('bodyText'), by('summary'), by('internalNotes')]).toEqual([
      'high',
      undefined,
      'low',
      false,
    ])
    const written = writeContentType(page.value as NonNullable<typeof page.value>)
    expect(written.match(/site-search = .*/g)).toEqual([
      'site-search = "high"',
      'site-search = "low"',
      'site-search = false',
    ])

    const hidden = parseContentType('hidden.toml', HIDDEN)
    expect(hidden.value?.siteSearch).toBe(false)
    expect(writeContentType(hidden.value as NonNullable<typeof hidden.value>)).toContain(
      'site-search = false',
    )
  })

  test('refuse anything but a level or false', () => {
    const bad = parseContentType(
      'page.toml',
      PAGE.replace('site-search = "high"', 'site-search = "loud"'),
    )
    expect(bad.problems.map((p) => p.path)).toEqual(['property[0].site-search'])
    const badType = parseContentType(
      'hidden.toml',
      HIDDEN.replace('site-search = false', 'site-search = true'),
    )
    expect(badType.problems.map((p) => p.path)).toEqual(['content-type.site-search'])
  })
})

describe(`the site-search index (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('holds published values only, and keeps them current on publish', async () => {
    const { create, publish, index, keys, h } = await site()
    const key = await create('page', { '': 'Harbour' }, { bodyText: 'lighthouse keeper' })
    await index()
    // Not published: nothing for a visitor to find.
    expect(await keys('lighthouse')).toEqual([])
    await publish(key)
    await index()
    expect(await keys('lighthouse')).toEqual([key])

    // A saved draft does not change what visitors find until it is published.
    const draft = await h.put(`${V1}/document/${key}`, {
      template: null,
      values: [{ alias: 'bodyText', value: 'foghorn', culture: null, segment: null }],
      variants: [{ culture: null, segment: null, name: 'Harbour' }],
    })
    expect(draft.status).toBe(200)
    await index()
    expect(await keys('foghorn')).toEqual([])
    expect(await keys('lighthouse')).toEqual([key])
    await publish(key)
    await index()
    expect(await keys('foghorn')).toEqual([key])
    expect(await keys('lighthouse')).toEqual([])
  })

  test('leaves out opted-out properties, opted-out types and types with no address', async () => {
    const { page, index, keys } = await site()
    const visible = await page('Visible', {
      bodyText: 'visible words',
      internalNotes: 'staffonly',
      secret: 'classified',
    })
    await page('Hidden', { bodyText: 'visible words' }, null, 'hidden')
    await page('Settings', { bodyText: 'visible words' }, null, 'settings')
    await index()
    expect(await keys('visible')).toEqual([visible])
    expect(await keys('staffonly')).toEqual([])
    expect(await keys('classified')).toEqual([])
  })

  test('ranks the name, then high, normal and low properties', async () => {
    const { page, index, keys } = await site()
    const low = await page('Low', { summary: 'anchor' })
    const normal = await page('Normal', { bodyText: 'anchor' })
    const high = await page('High', { title: 'anchor' })
    const named = await page('Anchor')
    await index()
    expect(await keys('anchor')).toEqual([named, high, normal, low])
  })

  test('narrows to content types, and matches every word by prefix', async () => {
    const { page, index, keys } = await site()
    const a = await page('Quay', { bodyText: 'harbour master' })
    await page('Dock', { bodyText: 'harbour' })
    await index()
    expect(await keys('harb mast')).toEqual([a])
    expect(await keys('harbour', { types: ['hidden'] })).toEqual([])
    expect((await keys('harbour', { types: ['page'] })).length).toBe(2)
  })

  test('drops a page when it is unpublished or trashed, and keeps it when moved', async () => {
    const { h, page, index, keys } = await site()
    const parent = await page('Parent', { bodyText: 'tidal' })
    const child = await page('Child', { bodyText: 'tidal' }, parent)
    const other = await page('Other', { bodyText: 'tidal' })
    await index()
    expect((await keys('tidal')).sort()).toEqual([parent, child, other].sort())

    expect((await h.put(`${V1}/document/${other}/unpublish`, { cultures: null })).status).toBe(200)
    await index()
    expect((await keys('tidal')).sort()).toEqual([parent, child].sort())

    const target = await page('Target')
    expect((await h.put(`${V1}/document/${child}/move`, { target: { id: target } })).status).toBe(
      200,
    )
    await index()
    expect((await keys('tidal')).sort()).toEqual([parent, child].sort())

    // Trashing takes the whole branch out, children included.
    expect((await h.put(`${V1}/document/${target}/move-to-recycle-bin`, {})).status).toBe(200)
    await index()
    expect(await keys('tidal')).toEqual([parent])
  })

  test('holds each published culture on its own, and an invariant page in every culture', async () => {
    const { h, create, publish, page, index, keys } = await site({ story: STORY })
    expect(
      (
        await h.post(`${V1}/language`, {
          isoCode: 'da-DK',
          name: 'Danish',
          isDefault: false,
          isMandatory: false,
          fallbackIsoCode: 'en-US',
        })
      ).status,
    ).toBe(201)
    const story = await create(
      'story',
      { 'en-US': 'Story', 'da-DK': 'Historie' },
      { 'bodyText@en-US': 'seagull', 'bodyText@da-DK': 'maage' },
    )
    await publish(story, ['en-US'])
    const shared = await page('Shared', { bodyText: 'seagull maage' })
    await index()
    expect((await keys('seagull', { culture: 'en-us' })).sort()).toEqual([story, shared].sort())
    // Danish is saved but not published: only the invariant page answers.
    expect(await keys('maage', { culture: 'da-dk' })).toEqual([shared])
    await publish(story, ['da-DK'])
    await index()
    expect((await keys('maage', { culture: 'da-dk' })).sort()).toEqual([story, shared].sort())
    expect(await keys('maage', { culture: 'en-us' })).toEqual([shared])
  })

  test('leaves out what the searcher may not open, and counts only what is left', async () => {
    const { page, index, search } = await site()
    const members = await page('Members', { bodyText: 'regatta' })
    const inside = await page('Inside', { bodyText: 'regatta' }, members)
    const crew = await page('Crew', { bodyText: 'regatta' }, members)
    const below = await page('Below', { bodyText: 'regatta' }, crew)
    const open = await page('Open', { bodyText: 'regatta' })
    await index()
    expect((await search('regatta')).total).toBe(5)

    const closed = await search('regatta', { denied: [members, crew] })
    expect(closed.total).toBe(1)
    expect(closed.items.map((item) => item.key)).toEqual([open])

    // The nearest protected node governs: an allowed branch inside a denied one is open.
    const nested = await search('regatta', { denied: [members], allowed: [crew] })
    expect(nested.total).toBe(3)
    expect(nested.items.map((item) => item.key).sort()).toEqual([open, crew, below].sort())
    expect(nested.items.map((item) => item.key)).not.toContain(inside)
  })

  test('keeps the text as written for excerpts, by weight', async () => {
    const { page, index, search } = await site()
    await page('Café Ø', { title: 'Crème brûlée', bodyText: '<p>Fresh <b>bread</b> daily</p>' })
    await index()
    const [hit] = (await search('creme')).items
    expect(hit?.text).toEqual({
      name: 'Café Ø',
      high: ['Crème brûlée'],
      normal: ['Fresh bread daily'],
      low: [],
    })
  })
})

describe('who a protection rule lets in', () => {
  test('a member named by user name, or in a named group, in any case', () => {
    const rule = { memberUserNames: ['Ada'], memberGroupNames: ['Staff'] }
    expect(memberMayOpen(rule, { username: 'ada', groups: [] })).toBe(true)
    expect(memberMayOpen(rule, { username: 'bo', groups: ['staff'] })).toBe(true)
    expect(memberMayOpen(rule, { username: 'bo', groups: ['Guests'] })).toBe(false)
    expect(memberMayOpen(rule, undefined)).toBe(false)
  })

  test('splits protected nodes into those a member may and may not open', () => {
    const rules = [
      { nodeId: 1, memberUserNames: [], memberGroupNames: ['Staff'] },
      { nodeId: 2, memberUserNames: ['ada'], memberGroupNames: [] },
    ]
    expect(branchAccess(rules, undefined)).toEqual({ denied: [1, 2], allowed: [] })
    expect(branchAccess(rules, { username: 'ada', groups: [] })).toEqual({
      denied: [1],
      allowed: [2],
    })
  })

  test('the Delivery API compares groups in any case, as the site does', () => {
    const rules = new Map([[7, { nodeId: 7, memberUserNames: [], memberGroupNames: ['staff'] }]])
    const member = { key: 'k', userName: 'bo', groups: ['Staff'], approved: true, lockedOut: false }
    expect(accessTo('-1,7', rules, member)).toBe('allowed')
  })
})

describe('excerpts', () => {
  const text = (normal: string[], high: string[] = []) => ({ name: 'Page', high, normal, low: [] })

  test('mark each word the query starts, folded as the index folds', () => {
    expect(excerpt(text(['A crème brûlée, then Harbour views']), 'creme harb')).toEqual([
      { text: 'A ', match: false },
      { text: 'crème', match: true },
      { text: ' brûlée, then ', match: false },
      { text: 'Harbour', match: true },
      { text: ' views', match: false },
    ])
  })

  test('are cut around the first match in the highest-weighted text that has one', () => {
    const long = `${'word '.repeat(80)}lighthouse ${'more '.repeat(80)}`
    const segments = excerpt(text([long], ['no match here']), 'lighthouse', 60)
    const shown = segments.map((s) => s.text).join('')
    expect(shown.startsWith('… ')).toBe(true)
    expect(shown.endsWith(' …')).toBe(true)
    expect(shown).toContain('lighthouse')
    expect(shown.length).toBeLessThan(80)
  })

  test('show one ellipsis where a cut lands between two texts', () => {
    const first = `${'alpha '.repeat(30)}end`
    const segments = excerpt(text([first, 'beta lighthouse gamma']), 'lighthouse', 40)
    const shown = segments.map((s) => s.text).join('')
    expect(shown).not.toContain('… …')
    expect(shown).toContain('lighthouse')
  })

  test('fall back to the start of the text when only the name matched', () => {
    expect(excerpt(text(['Opening words']), 'page')).toEqual([
      { text: 'Opening words', match: false },
    ])
  })

  test('escape everything as HTML, marking only the matches', () => {
    expect(
      excerptHtml([
        { text: '<b>"Tom" & ', match: false },
        { text: 'Jerry', match: true },
      ]),
    ).toBe('&lt;b&gt;&quot;Tom&quot; &amp; <mark>Jerry</mark>')
  })
})

const RESULTS_VIEW = `import { search } from '@crombolo/crombolo'

export default async function Page({ model, request }) {
  const q = new URL(request.url).searchParams.get('q') ?? ''
  if (!q) return <h1>{model.name}</h1>
  const results = await search(q)
  return (
    <main>
      <p class="total">{results.total}</p>
      <ul>
        {results.items.map((item) => (
          <li data-url={item.url}>
            {item.name}:{' '}
            {item.excerpt.map((s) => (s.match ? <mark>{s.text}</mark> : s.text))}
          </li>
        ))}
      </ul>
    </main>
  )
}
`

const SIMPLE_PAGE = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"
`

/** A site with a members-only branch, open to the Staff group, and a token per member. */
async function protectedSite() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'site-search-access-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), SIMPLE_PAGE)
  writeFileSync(join(root, 'components', 'page.tsx'), RESULTS_VIEW)
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      deliveryApi: {
        enabled: true,
        memberAuthorization: {
          clientCredentialsFlow: {
            enabled: true,
            associatedMembers: [
              { userName: 'ada', clientId: 'ada', clientSecret: 'ada-secret' },
              { userName: 'outsider', clientId: 'outsider', clientSecret: 'outsider-secret' },
            ],
          },
        },
      },
    },
  })
  open.push(h)
  h.server.jobs.stop()
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const page = async (name: string, parent: string | null, bodyText = '') => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: parent ? { id: parent } : null,
      values: bodyText
        ? [{ alias: 'bodyText', value: bodyText, culture: null, segment: null }]
        : [],
      variants: [{ culture: null, segment: null, name }],
    })
    expect(response.status, name).toBe(201)
    const key = response.headers.get('umb-generated-resource') as string
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    return key
  }
  const staff = (await h.post(`${V1}/member-group`, { name: 'Staff' })).headers.get(
    'umb-generated-resource',
  ) as string
  for (const [username, groups] of [
    ['ada', [staff]],
    ['outsider', []],
  ] as const) {
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
    expect(response.status, username).toBe(201)
  }
  const home = await page('Home', null)
  const open_ = await page('Open', home, 'The harbour at dawn')
  const secret = await page('Secret', home, 'The harbour at night')
  await new PublicAccessRepository(h.server.db).save({
    nodeKey: secret,
    loginNodeKey: home,
    errorNodeKey: home,
    memberGroupNames: ['staff'],
    memberUserNames: [],
  })
  await h.server.jobs.runSearchIndexing()
  h.server.cache.invalidate()

  const visit = (path: string, init: RequestInit = {}) =>
    h.server.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init }))
  const signIn = async (username: string) => {
    const response = await visit('/umbraco/members/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct-horse-battery' }),
    })
    return (response.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  }
  const token = async (id: string, secretValue: string) => {
    const response = await visit('/umbraco/delivery/api/v1/security/member/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: `umbraco-member-${id}`,
        client_secret: secretValue,
      }).toString(),
    })
    return ((await response.json()) as { access_token: string }).access_token
  }
  return { open: open_, secret, visit, signIn, token }
}

describe(`searching from a page and the Delivery API (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('a results page lists what the visitor may open, with marked excerpts', async () => {
    const { visit, signIn } = await protectedSite()
    const anonymous = await (await visit('/?q=harbour')).text()
    expect(/class="total">(\d+)</.exec(anonymous)?.[1]).toBe('1')
    expect(anonymous).toContain('Open: The <mark>harbour</mark> at dawn')
    expect(anonymous).not.toContain('Secret')

    const cookie = await signIn('ada')
    const member = await (await visit('/?q=harbour', { headers: { cookie } })).text()
    expect(/class="total">(\d+)</.exec(member)?.[1]).toBe('2')
    expect(member).toContain('Secret: The <mark>harbour</mark> at night')
  })

  test('the Delivery API answers v2/search, leaving out what the caller may not open', async () => {
    const { visit, token, open, secret } = await protectedSite()
    const searchAs = async (bearer?: string) => {
      const response = await visit('/umbraco/delivery/api/v2/search?term=harbour', {
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      })
      expect(response.status).toBe(200)
      return (await response.json()) as {
        total: number
        items: Array<{ id: string; name: string; excerpt: string; score: number }>
      }
    }
    const anonymous = await searchAs()
    expect(anonymous.total).toBe(1)
    expect(anonymous.items.map((item) => item.id)).toEqual([open])
    expect(anonymous.items[0]?.excerpt).toBe('The <mark>harbour</mark> at dawn')

    const staff = await searchAs(await token('ada', 'ada-secret'))
    expect(staff.total).toBe(2)
    expect(staff.items.map((item) => item.id).sort()).toEqual([open, secret].sort())

    const outsider = await searchAs(await token('outsider', 'outsider-secret'))
    expect(outsider.items.map((item) => item.id)).toEqual([open])

    expect((await visit('/umbraco/delivery/api/v2/search?term=')).status).toBe(200)
    expect((await visit('/umbraco/delivery/api/v2/search?term=x&take=-1')).status).toBe(400)
  })
})

describe(`the starter's search page (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('lists the matching pages with marked excerpts, and the header searches it', async () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'site-search-starter-'))
    dirs.push(root)
    cpSync(join(process.cwd(), 'sites/starter/schema'), join(root, 'schema'), { recursive: true })
    cpSync(join(process.cwd(), 'sites/starter/components'), join(root, 'components'), {
      recursive: true,
    })
    const h = await signedInServer({
      config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
    })
    open.push(h)
    h.server.jobs.stop()
    const types = new ContentTypeRepository(h.server.db)
    const components = new ComponentRepository(h.server.db)
    const page = async (
      type: string,
      component: string,
      name: string,
      values: Record<string, unknown>,
      parent: string | null = null,
    ) => {
      const response = await h.post(`${V1}/document`, {
        documentType: { id: (await types.byAlias(type))?.key },
        template: { id: (await components.byAlias(component))?.key },
        parent: parent ? { id: parent } : null,
        values: Object.entries(values).map(([alias, value]) => ({
          alias,
          value,
          culture: null,
          segment: null,
        })),
        variants: [{ culture: null, segment: null, name }],
      })
      expect(response.status, name).toBe(201)
      const key = response.headers.get('umb-generated-resource') as string
      await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
      return key
    }
    const home = await page('contentPage', 'pages/contentPage', 'Home', { title: 'Welcome' })
    await page(
      'contentPage',
      'pages/contentPage',
      'About',
      { title: 'About us', bodyText: { markup: '<p>We roast coffee daily.</p>', blocks: null } },
      home,
    )
    await page('searchPage', 'pages/searchPage', 'Search', { title: 'Search' }, home)
    await h.server.jobs.runSearchIndexing()
    h.server.cache.invalidate()
    const visit = async (path: string) =>
      (await h.server.fetch(new Request(`http://localhost${path}`))).text()

    const results = await visit('/search?q=coffee')
    expect(results).toContain('1 page matches “coffee”.')
    expect(results).toContain('<a href="/about">About us</a>')
    expect(results).toContain('We roast <mark>coffee</mark> daily.')
    // The search page is left out of its own results.
    expect(await visit('/search?q=search')).toContain('Nothing matches “search”.')

    const front = await visit('/')
    expect(front).toContain('<search><form class="site-search" action="/search"')
    expect(front).not.toContain('>Search</a>')
  })
})
