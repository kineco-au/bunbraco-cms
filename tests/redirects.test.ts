/**
 * WP-6.9's URL tracker: a page that is renamed or moved keeps answering on the URL
 * it had, and the redirects a site declares in its configuration.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, RedirectRepository, TemplateRepository } from '@bunbraco/data'
import { redirect } from '@bunbraco/render'
import { type BunbracoConfig, syncConfiguredRedirects } from '@bunbraco/server'
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

const TYPE_TOML = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
templates = ["page"]
default-template = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

const VARIANT_TYPE_TOML = `[document-type]
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
`

const VIEW = `export default function Page({ model }) {
  return <main><h1>{model.name}</h1></main>
}
`

async function site(config: Partial<BunbracoConfig> = {}, variant = false) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'redirects-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(
    join(root, 'schema', 'document-types', 'page.toml'),
    variant ? VARIANT_TYPE_TOML : TYPE_TOML,
  )
  writeFileSync(join(root, 'Views', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), viewsDir: join(root, 'Views'), ...config },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const templateKey = (await new TemplateRepository(h.server.db).byAlias('page'))?.key as string

  const body = (names: Record<string, string>) => ({
    template: { id: templateKey },
    values: [],
    variants: Object.entries(names).map(([culture, name]) => ({
      culture: culture === '' ? null : culture,
      segment: null,
      name,
    })),
  })

  /** Creates and publishes a page; `names` is keyed by culture, `''` for invariant. */
  const page = async (names: Record<string, string>, parent: string | null = null) => {
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      parent: parent ? { id: parent } : null,
      ...body(names),
    })
    if (created.status !== 201) throw new Error(`create ${created.status}: ${await created.text()}`)
    const key = created.headers.get('umb-generated-resource') as string
    const published = await h.put(`${V1}/document/${key}/publish`, {
      publishSchedules: Object.keys(names).map((culture) => ({
        culture: culture === '' ? null : culture,
      })),
    })
    if (published.status !== 200)
      throw new Error(`publish ${published.status}: ${await published.text()}`)
    return key
  }

  /** Renames through "save and publish", which is how an editor does it. */
  const rename = async (key: string, names: Record<string, string>) => {
    const response = await h.put(`${V1}/document/${key}/update-and-publish`, {
      ...body(names),
      culturesToPublish: Object.keys(names).map((culture) => (culture === '' ? null : culture)),
    })
    if (response.status !== 200)
      throw new Error(`rename ${response.status}: ${await response.text()}`)
  }

  const visit = (url: string) => h.server.fetch(new Request(url, { redirect: 'manual' }))
  const at = async (url: string) => {
    const response = await visit(url)
    return { status: response.status, location: response.headers.get('location') }
  }
  const listed = () =>
    h.json<{
      total: number
      items: Array<{
        id: string
        originalUrl: string
        destinationUrl: string
        culture: string | null
      }>
    }>(`${V1}/redirect-management?skip=0&take=100`)

  return { h, page, rename, visit, at, listed, typeKey, templateKey }
}

describe('the URL tracker', () => {
  test('a rename redirects the old URL, permanently and uncacheably', async () => {
    const { page, rename, visit, at } = await site()
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    expect((await at('http://localhost/about')).status).toBe(200)

    await rename(about, { '': 'Contact' })
    const moved = await visit('http://localhost/about')
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toBe('/contact')
    // Umbraco sends these so a rename that is reverted is not stuck in caches.
    expect(moved.headers.get('cache-control')).toBe('no-store, must-revalidate')
    expect(moved.headers.get('pragma')).toBe('no-cache')
    expect((await at('http://localhost/contact')).status).toBe(200)
  })

  test('the query string survives the redirect', async () => {
    const { page, rename, at } = await site()
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    await rename(about, { '': 'Contact' })
    expect((await at('http://localhost/about?utm_source=news')).location).toBe(
      '/contact?utm_source=news',
    )
  })

  test('a move redirects the branch below it', async () => {
    const { page, h, at } = await site()
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    const team = await page({ '': 'Team' }, about)
    const services = await page({ '': 'Services' }, home)
    expect((await at('http://localhost/about/team')).status).toBe(200)

    expect((await h.put(`${V1}/document/${team}/move`, { target: { id: services } })).status).toBe(
      200,
    )
    expect(await at('http://localhost/about/team')).toEqual({
      status: 301,
      location: '/services/team',
    })
    expect((await at('http://localhost/services/team')).status).toBe(200)
  })

  test('re-ordering the roots redirects the one that stops being the home page', async () => {
    const { page, h, at } = await site()
    const home = await page({ '': 'Home' })
    const news = await page({ '': 'News' })
    // Umbraco hides the first root's segment, so it is `/` and the others are not.
    expect((await at('http://localhost/')).status).toBe(200)
    expect((await at('http://localhost/news')).status).toBe(200)

    expect(
      (
        await h.put(`${V1}/document/sort`, {
          parent: null,
          sorting: [
            { id: news, sortOrder: 0 },
            { id: home, sortOrder: 1 },
          ],
        })
      ).status,
    ).toBe(200)
    // News is `/` now, and its own old URL points at it; Home has gained a segment.
    expect(await at('http://localhost/news')).toEqual({ status: 301, location: '/' })
    expect((await at('http://localhost/home')).status).toBe(200)
  })

  test('two renames leave the oldest URL pointing at where the page is now', async () => {
    const { page, rename, at } = await site()
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    await rename(about, { '': 'Contact' })
    await rename(about, { '': 'Reach Us' })
    // A tracked rule names the document, not a path, so it resolves afresh every
    // request rather than chaining one redirect into the next.
    expect((await at('http://localhost/about')).location).toBe('/reach-us')
    expect((await at('http://localhost/contact')).location).toBe('/reach-us')
  })

  test('a rename that is reverted leaves no redirect on the live URL', async () => {
    const { page, rename, at, listed } = await site()
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    await rename(about, { '': 'Contact' })
    await rename(about, { '': 'About' })

    expect((await at('http://localhost/about')).status).toBe(200)
    expect((await at('http://localhost/contact')).location).toBe('/about')
    const rules = await listed()
    expect(rules.items.map((i) => i.originalUrl)).toEqual(['/contact'])
  })

  test('nothing is recorded when tracking is off', async () => {
    const { h, page, rename, at, listed } = await site({ trackRedirects: false })
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    await rename(about, { '': 'Contact' })
    expect((await at('http://localhost/about')).status).toBe(404)
    expect((await listed()).total).toBe(0)
    // And the dashboard says so, rather than offering a switch that does nothing.
    // This server already has tracking off, so it answers for itself: booting a
    // second one here reset the Postgres schema under the first, which is the
    // hazard `tests/support/db.ts` documents.
    expect(await h.json<{ status: string }>(`${V1}/redirect-management/status`)).toMatchObject({
      status: 'Disabled',
    })
  })

  test('a hostname scopes the rule to its own site', async () => {
    const { h, page, rename, at } = await site()
    const one = await page({ '': 'One' })
    const two = await page({ '': 'Two' })
    const aboutOne = await page({ '': 'About' }, one)
    await page({ '': 'About' }, two)
    for (const [root, host] of [
      [one, 'one.example.com'],
      [two, 'two.example.com'],
    ] as const)
      expect(
        (
          await h.put(`${V1}/document/${root}/domains`, {
            defaultIsoCode: null,
            domains: [{ domainName: host, isoCode: 'en-US' }],
          })
        ).status,
      ).toBe(200)

    expect((await at('http://one.example.com/about')).status).toBe(200)
    await rename(aboutOne, { '': 'Contact' })
    expect(await at('http://one.example.com/about')).toEqual({
      status: 301,
      location: '//one.example.com/contact',
    })
    // The other site still has its own /about, which the rule must not touch.
    expect((await at('http://two.example.com/about')).status).toBe(200)
  })

  test('a culture is redirected on its own', async () => {
    const { h, page, rename, at } = await site({}, true)
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
    const home = await page({ 'en-US': 'Home', 'da-DK': 'Hjem' })
    const about = await page({ 'en-US': 'About', 'da-DK': 'Om os' }, home)
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
    expect((await at('http://da.example.com/om-os')).status).toBe(200)

    await rename(about, { 'en-US': 'About', 'da-DK': 'Kontakt' })
    expect(await at('http://da.example.com/om-os')).toEqual({
      status: 301,
      location: '//da.example.com/kontakt',
    })
    // English never moved, so it was never redirected.
    expect((await at('http://en.example.com/about')).status).toBe(200)
  })
})

describe('configured redirects', () => {
  test('an exact route, a subtree and a regular expression', async () => {
    const { page, at } = await site({
      redirects: [
        redirect('/contact-us', '/contact'),
        redirect('/old-blog/*', '/news/$1'),
        redirect(/^\/product\/(\d+)$/, '/products/$1'),
        redirect('/docs/*', 'https://docs.example.com/$1', { status: 302 }),
      ],
    })
    const home = await page({ '': 'Home' })
    await page({ '': 'Contact' }, home)

    expect(await at('http://localhost/contact-us')).toEqual({ status: 301, location: '/contact' })
    expect((await at('http://localhost/old-blog/2024/hello')).location).toBe('/news/2024/hello')
    // The subtree root itself matches, with an empty tail.
    expect((await at('http://localhost/old-blog')).location).toBe('/news/')
    expect((await at('http://localhost/product/42')).location).toBe('/products/42')
    expect((await at('http://localhost/product/abc')).status).toBe(404)
    expect(await at('http://localhost/docs/guide')).toEqual({
      status: 302,
      location: 'https://docs.example.com/guide',
    })
  })

  test('`/*` is the whole site, for moving one somewhere else', async () => {
    const { page, at } = await site({
      redirects: [redirect('/*', 'https://new.example.com/$1')],
    })
    // Published pages still answer; only what would have 404ed is sent on.
    const home = await page({ '': 'Home' })
    await page({ '': 'About' }, home)
    expect((await at('http://localhost/about')).status).toBe(200)
    expect((await at('http://localhost/retired/page')).location).toBe(
      'https://new.example.com/retired/page',
    )
    expect((await at('http://localhost/retired')).location).toBe('https://new.example.com/retired')
  })

  test('a rule naming a document follows it, and stops matching once it is gone', async () => {
    const { h, page, rename, at } = await site()
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    // A key is only known once the page exists, which is why this is synced here
    // rather than declared in the config above.
    await syncConfiguredRedirects(new RedirectRepository(h.server.db), [
      redirect('/legacy', { document: about }),
    ])
    h.server.cache.invalidate()
    expect(await at('http://localhost/legacy')).toEqual({ status: 301, location: '/about' })

    await rename(about, { '': 'Contact' })
    expect((await at('http://localhost/legacy')).location).toBe('/contact')

    expect((await h.put(`${V1}/document/${about}/unpublish`, {})).status).toBe(200)
    // Sending a visitor to a page that is no longer there is worse than the 404.
    expect((await at('http://localhost/legacy')).status).toBe(404)
  })

  test('a live page wins over a configured rule for the same URL', async () => {
    const { h, page, at } = await site({ redirects: [redirect('/about', '/elsewhere')] })
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    await page({ '': 'Elsewhere' }, home)
    // The rule is accepted and simply never reached while a page answers there.
    expect((await at('http://localhost/about')).status).toBe(200)

    // Retire the page and the rule takes over, which is the point of the ordering:
    // a rule can sit in config for years without hiding anything.
    expect((await h.put(`${V1}/document/${about}/unpublish`, {})).status).toBe(200)
    expect(await at('http://localhost/about')).toEqual({ status: 301, location: '/elsewhere' })
  })

  test('the database follows the configuration: a rule dropped from it is removed', async () => {
    const { h, listed } = await site({
      redirects: [redirect('/one', '/1'), redirect('/two', '/2')],
    })
    expect((await listed()).items.map((i) => i.originalUrl).sort()).toEqual(['/one', '/two'])

    const repo = new RedirectRepository(h.server.db)
    const again = await syncConfiguredRedirects(repo, [redirect('/two', '/2')])
    expect(again).toEqual({ stored: 1, removed: 1 })
    expect((await repo.all()).map((r) => r.pattern)).toEqual(['/two'])
  })

  test('the API refuses to delete a configured rule but deletes a tracked one', async () => {
    const { h, page, rename, at, listed } = await site({
      redirects: [redirect('/from-config', '/home')],
    })
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    await rename(about, { '': 'Contact' })

    const rules = await listed()
    const configured = rules.items.find((i) => i.originalUrl === '/from-config')
    const tracked = rules.items.find((i) => i.originalUrl === '/about')
    expect(configured).toBeDefined()
    expect(tracked).toBeDefined()
    // Configured rules are matched first, so they head the list.
    expect(rules.items[0]?.originalUrl).toBe('/from-config')

    const refused = await h.del(`${V1}/redirect-management/${configured?.id}`)
    expect(refused.status).toBe(409)
    expect((await h.del(`${V1}/redirect-management/${tracked?.id}`)).status).toBe(200)
    expect((await h.del(`${V1}/redirect-management/${crypto.randomUUID()}`)).status).toBe(404)
    expect((await at('http://localhost/about')).status).toBe(404)
  })
})

describe('the Redirect URL Management dashboard', () => {
  test('lists, filters, reports the tracker status and answers per document', async () => {
    const { h, page, rename, listed } = await site()
    const home = await page({ '': 'Home' })
    const about = await page({ '': 'About' }, home)
    const team = await page({ '': 'Team' }, home)
    await rename(about, { '': 'Contact' })
    await rename(team, { '': 'People' })

    const all = await listed()
    expect(all.total).toBe(2)
    expect(all.items.map((i) => [i.originalUrl, i.destinationUrl]).sort()).toEqual([
      ['/about', '/contact'],
      ['/team', '/people'],
    ])

    const filtered = await h.json<{ total: number; items: Array<{ originalUrl: string }> }>(
      `${V1}/redirect-management?filter=team&skip=0&take=100`,
    )
    expect(filtered.items.map((i) => i.originalUrl)).toEqual(['/team'])

    // `{id}` is the document here, not the redirect: the Info tab's list.
    const forAbout = await h.json<{
      total: number
      items: Array<{ originalUrl: string; document: { id: string } }>
    }>(`${V1}/redirect-management/${about}?skip=0&take=100`)
    expect(forAbout.items.map((i) => i.originalUrl)).toEqual(['/about'])
    expect(forAbout.items[0]?.document.id).toBe(about)

    expect(
      await h.json<{ status: string; userIsAdmin: boolean }>(`${V1}/redirect-management/status`),
    ).toEqual({ status: 'Enabled', userIsAdmin: true })
    // Deprecated in Umbraco and a no-op there too; tracking is configuration.
    expect((await h.post(`${V1}/redirect-management/status?status=Disabled`, {})).status).toBe(200)
    expect(await h.json<{ status: string }>(`${V1}/redirect-management/status`)).toMatchObject({
      status: 'Enabled',
    })
  })
})
