/**
 * WP-6.6's exit: a two-language site publishes one culture, falls back for the
 * other, and renders both under their hostnames. Publishing one culture leaves
 * the others as they were published; mandatory languages must be published.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, TemplateRepository } from '@bunbraco/data'
import { type Harness, signedInServer, signIn, V1 } from './support/harness.ts'

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

const TYPE_TOML = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
templates = ["page"]
default-template = "page"
varies-by-culture = true

[[property]]
alias = "title"
name = "Title"
type = "textstring"
varies-by-culture = true

[[property]]
alias = "footer"
name = "Footer"
type = "textstring"
`

const VIEW = `export default function Page({ model, nav, culture, dictionary }) {
  return (
    <main>
      <h1>{model.name}</h1>
      <p class="title">{model.text('title', { fallback: 'language' })}</p>
      <p class="own">{model.text('title')}</p>
      <p class="footer">{model.text('footer')}</p>
      <i>{culture ?? 'none'}</i>
      <b>{dictionary('Greeting')}</b>
      <ul>{nav.children(model).map((c) => <li><a href={c.url}>{c.name}</a></li>)}</ul>
    </main>
  )
}
`

const EN = 'http://en.example.com'
const DA = 'http://da.example.com'

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'variants-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE_TOML)
  writeFileSync(join(root, 'Views', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), viewsDir: join(root, 'Views') },
  })
  open.push(h)
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
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const templateKey = (await new TemplateRepository(h.server.db).byAlias('page'))?.key as string

  const body = (names: Record<string, string>, titles: Record<string, string>, footer = '') => ({
    template: { id: templateKey },
    values: [
      ...Object.entries(titles).map(([culture, value]) => ({
        alias: 'title',
        culture,
        segment: null,
        value,
      })),
      { alias: 'footer', culture: null, segment: null, value: footer },
    ],
    variants: Object.entries(names).map(([culture, name]) => ({ culture, segment: null, name })),
  })
  const create = async (
    names: Record<string, string>,
    titles: Record<string, string>,
    parent: string | null = null,
  ) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      parent: parent ? { id: parent } : null,
      ...body(names, titles, 'Shared footer'),
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  const publish = (key: string, cultures: string[]) =>
    h.put(`${V1}/document/${key}/publish`, {
      publishSchedules: cultures.map((culture) => ({ culture })),
    })
  const visit = async (url: string) => {
    const response = await h.server.fetch(new Request(url))
    return { status: response.status, html: response.status === 200 ? await response.text() : '' }
  }
  const text = (html: string, tag: string, cls?: string) =>
    new RegExp(cls ? `<${tag} class="${cls}">([^<]*)</${tag}>` : `<${tag}>([^<]*)</${tag}>`).exec(
      html,
    )?.[1]
  const states = async (key: string) =>
    Object.fromEntries(
      (
        await h.json<{ variants: Array<{ culture: string; state: string }> }>(
          `${V1}/document/${key}`,
        )
      ).variants.map((v) => [v.culture, v.state]),
    )
  return { h, create, publish, visit, text, states, body, typeKey }
}

describe('culture variants', () => {
  test('a two-language site publishes one culture, falls back for the other, and renders both under their hostnames', async () => {
    const { h, create, publish, visit, text, states, body } = await site()
    const home = await create(
      { 'en-US': 'Home', 'da-DK': 'Hjem' },
      { 'en-US': 'Welcome', 'da-DK': '' },
    )
    const about = await create(
      { 'en-US': 'About', 'da-DK': 'Om os' },
      { 'en-US': 'About us', 'da-DK': 'Om os' },
      home,
    )
    expect(
      (
        await h.put(`${V1}/document/${home}/domains`, {
          defaultIsoCode: null,
          domains: [
            { domainName: 'en.example.com', isoCode: 'en-US' },
            { domainName: 'da.example.com', isoCode: 'da-DK' },
          ],
        })
      ).status,
    ).toBe(200)
    await h.post(`${V1}/dictionary`, {
      name: 'Greeting',
      translations: [
        { isoCode: 'en-US', translation: 'Hello' },
        { isoCode: 'da-DK', translation: 'Hej' },
      ],
    })

    // One culture published: English serves, Danish does not exist yet
    expect((await publish(home, ['en-US'])).status).toBe(200)
    expect(await states(home)).toEqual({ 'en-US': 'Published', 'da-DK': 'Draft' })
    const en = await visit(`${EN}/`)
    expect(en.status).toBe(200)
    expect(text(en.html, 'h1')).toBe('Home')
    expect(text(en.html, 'p', 'title')).toBe('Welcome')
    expect(text(en.html, 'p', 'footer')).toBe('Shared footer')
    expect(text(en.html, 'i')).toBe('en-US')
    expect(text(en.html, 'b')).toBe('Hello')
    expect((await visit(`${DA}/`)).status).toBe(404)

    // The other culture: its own name, and its empty title falls back to English
    expect((await publish(home, ['da-DK'])).status).toBe(200)
    const da = await visit(`${DA}/`)
    expect(da.status).toBe(200)
    expect(text(da.html, 'h1')).toBe('Hjem')
    expect(text(da.html, 'p', 'title')).toBe('Welcome')
    expect(text(da.html, 'p', 'own')).toBe('')
    expect(text(da.html, 'i')).toBe('da-DK')
    expect(text(da.html, 'b')).toBe('Hej')

    // Children route by their own culture's name, and link within the culture
    await publish(about, ['en-US', 'da-DK'])
    const daHome = await visit(`${DA}/`)
    expect(daHome.html).toContain('<a href="//da.example.com/om-os">Om os</a>')
    expect((await visit(`${EN}/`)).html).toContain('<a href="//en.example.com/about">About</a>')
    expect(text((await visit(`${DA}/om-os`)).html, 'p', 'title')).toBe('Om os')
    expect(text((await visit(`${EN}/about`)).html, 'p', 'title')).toBe('About us')
    expect((await visit(`${DA}/about`)).status).toBe(404)
    const urls = await h.json<
      Array<{ id: string; urlInfos: Array<{ culture: string; url: string }> }>
    >(`${V1}/document/urls?id=${about}`)
    expect(urls[0]?.urlInfos.map((u) => [u.culture, u.url]).sort()).toEqual([
      ['da-DK', '//da.example.com/om-os'],
      ['en-US', '//en.example.com/about'],
    ])

    // Publishing Danish leaves English as it was published
    expect(
      (
        await h.put(
          `${V1}/document/${home}`,
          body(
            { 'en-US': 'Home', 'da-DK': 'Hjem' },
            { 'en-US': 'Welcome back', 'da-DK': 'Velkommen' },
            'Shared footer',
          ),
        )
      ).status,
    ).toBe(200)
    expect(await states(home)).toEqual({
      'en-US': 'PublishedPendingChanges',
      'da-DK': 'PublishedPendingChanges',
    })
    expect((await publish(home, ['da-DK'])).status).toBe(200)
    expect(await states(home)).toEqual({ 'en-US': 'PublishedPendingChanges', 'da-DK': 'Published' })
    expect(text((await visit(`${DA}/`)).html, 'p', 'title')).toBe('Velkommen')
    expect(text((await visit(`${EN}/`)).html, 'p', 'title')).toBe('Welcome')
    const published = await h.json<{
      values: Array<{ alias: string; culture: string | null; value: unknown }>
    }>(`${V1}/document/${home}/published`)
    expect(published.values.find((v) => v.alias === 'title' && v.culture === 'en-US')?.value).toBe(
      'Welcome',
    )
    expect(published.values.find((v) => v.alias === 'title' && v.culture === 'da-DK')?.value).toBe(
      'Velkommen',
    )

    // Taking Danish offline keeps English up; taking the mandatory English offline takes it all
    expect((await h.put(`${V1}/document/${home}/unpublish`, { cultures: ['da-DK'] })).status).toBe(
      200,
    )
    expect((await visit(`${DA}/`)).status).toBe(404)
    expect((await visit(`${EN}/`)).status).toBe(200)
    expect((await h.put(`${V1}/document/${home}/unpublish`, { cultures: ['en-US'] })).status).toBe(
      200,
    )
    expect((await visit(`${EN}/`)).status).toBe(404)
    expect(await states(home)).toEqual({ 'en-US': 'Draft', 'da-DK': 'Draft' })
  })

  test('a mandatory language must be published; only created variants can be', async () => {
    const { h, create, publish } = await site()
    const page = await create({ 'da-DK': 'Kun dansk' }, { 'da-DK': 'Titel' })
    const refused = await publish(page, ['da-DK'])
    expect(refused.status).toBe(400)
    expect((await refused.json()).detail).toContain('en-US')
    const missing = await publish(page, ['en-US'])
    expect(missing.status).toBe(400)
    expect((await missing.json()).detail).toContain('no en-US variant')
    // With English made optional, Danish alone is fine
    await h.put(`${V1}/language/en-US`, {
      name: 'English (United States)',
      isDefault: true,
      isMandatory: false,
      fallbackIsoCode: null,
    })
    expect((await publish(page, ['da-DK'])).status).toBe(200)
  })

  test('a group limited to some languages cannot publish the others', async () => {
    const { h, create } = await site()
    const home = await create(
      { 'en-US': 'Home', 'da-DK': 'Hjem' },
      { 'en-US': 'Welcome', 'da-DK': 'Velkommen' },
    )
    const group = await h.post(`${V1}/user-group`, {
      name: 'English editors',
      alias: 'englishEditors',
      sections: ['Umb.Section.Content'],
      languages: ['en-US'],
      hasAccessToAllLanguages: false,
      documentRootAccess: true,
      documentStartNode: null,
      mediaRootAccess: true,
      mediaStartNode: null,
      elementRootAccess: false,
      elementStartNode: null,
      fallbackPermissions: ['Umb.Document.Read', 'Umb.Document.Update', 'Umb.Document.Publish'],
      permissions: [],
    })
    const created = await h.post(`${V1}/user`, {
      kind: 'Default',
      email: 'english@example.com',
      userName: 'english@example.com',
      name: 'English',
      userGroupIds: [{ id: group.headers.get('umb-generated-resource') }],
    })
    const key = created.headers.get('umb-generated-resource') as string
    const reset = await h.json<{ resetPassword: string }>(`${V1}/user/${key}/reset-password`, {
      method: 'POST',
    })
    const english = await signIn(h.server, {
      username: 'english@example.com',
      password: reset.resetPassword,
    })
    expect((await english.json<{ languages: string[] }>(`${V1}/user/current`)).languages).toEqual([
      'en-US',
    ])
    const publish = (cultures: string[]) =>
      english.put(`${V1}/document/${home}/publish`, {
        publishSchedules: cultures.map((culture) => ({ culture })),
      })
    expect((await publish(['da-DK'])).status).toBe(403)
    expect((await publish(['en-US'])).status).toBe(200)
  })

  test('segments: with no segment provider there are none to offer', async () => {
    const { h, create } = await site()
    const home = await create({ 'en-US': 'Home' }, { 'en-US': 'Welcome' })
    expect(await h.json<unknown>(`${V1}/segment?skip=0&take=10`)).toEqual<unknown>({
      total: 0,
      items: [],
    })
    expect(
      await h.json<unknown>(`${V1}/document/${home}/available-segment-options?skip=0&take=10`),
    ).toEqual<unknown>({
      total: 0,
      items: [],
    })
  })
})
