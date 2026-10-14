/**
 * Search and sharing in the renderer: the fallbacks `effectiveMeta` applies, the
 * tags `<SeoHead>` writes, the reserved `umbracoUrlAlias` / `umbracoRedirect` /
 * `umbracoNaviHide` properties, and the sitemap and robots file.
 */
import { describe, expect, test } from 'bun:test'
import {
  absoluteUrl,
  effectiveMeta,
  PublishedCache,
  PublishedContent,
  type PublishedNode,
  type PublishedProperty,
  renderSitemap,
  robotsTxt,
  SeoHead,
  sitemapEntries,
} from '@crombolo/render'

const SITE = { siteName: 'Acme', indexable: true }
const ORIGIN = 'https://acme.test'

const text = (alias: string, value: unknown, culture: string | null = null): PublishedProperty => ({
  alias,
  editorAlias: 'Umbraco.TextBox',
  culture,
  segment: null,
  value,
})
const flag = (alias: string, value: boolean): PublishedProperty => ({
  alias,
  editorAlias: 'Umbraco.TrueFalse',
  culture: null,
  segment: null,
  value: value ? 1 : 0,
})

function content(properties: PublishedProperty[] = [], url = '/about'): PublishedContent {
  return new PublishedContent({
    key: '11111111-1111-4111-8111-111111111111',
    id: 1,
    name: 'About us',
    contentTypeAlias: 'page',
    urlSegment: 'about',
    url,
    level: 1,
    path: '-1,1',
    sortOrder: 0,
    createDate: new Date('2026-01-01'),
    updateDate: new Date('2026-02-01'),
    componentAlias: 'page',
    cultures: [],
    properties,
    variationCulture: null,
  })
}

let nextId = 1
function node(name: string, parentId = -1, properties: PublishedProperty[] = []): PublishedNode {
  const id = nextId++
  return {
    key: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    id,
    parentId,
    level: parentId <= 0 ? 1 : 2,
    path: parentId <= 0 ? `-1,${id}` : `-1,${parentId},${id}`,
    sortOrder: id,
    name,
    contentTypeAlias: 'page',
    componentAlias: 'page',
    createDate: new Date('2026-01-01'),
    updateDate: new Date('2026-03-04T05:06:07Z'),
    cultures: [],
    properties,
  }
}

describe('absoluteUrl', () => {
  test('makes root-relative and protocol-relative addresses absolute', () => {
    expect(absoluteUrl('/about', ORIGIN)).toBe('https://acme.test/about')
    expect(absoluteUrl('//other.test/x', ORIGIN)).toBe('https://other.test/x')
    expect(absoluteUrl('https://cdn.test/a.png', ORIGIN)).toBe('https://cdn.test/a.png')
  })

  test('has nothing for a page with no address in a culture', () => {
    expect(absoluteUrl('#', ORIGIN)).toBeUndefined()
    expect(absoluteUrl('', ORIGIN)).toBeUndefined()
  })
})

describe('effectiveMeta', () => {
  test('falls back to the page name and its own address', () => {
    const meta = effectiveMeta(content(), { origin: ORIGIN, alternates: [], site: SITE })
    expect(meta.title).toEqual({ value: 'About us', source: 'name' })
    expect(meta.fullTitle).toBe('About us')
    expect(meta.description).toEqual({ value: undefined, source: 'none' })
    expect(meta.canonical).toEqual({ value: 'https://acme.test/about', source: 'name' })
    expect(meta.noindex).toEqual({ value: false, source: 'none' })
    expect(meta.type).toBe('website')
  })

  test("the page's own fields win over the template's", () => {
    const meta = effectiveMeta(
      content([
        text('seoTitle', 'Who we are'),
        text('seoDescription', 'Our story'),
        text('seoCanonical', '/story'),
      ]),
      { origin: ORIGIN, alternates: [], site: SITE },
      { title: 'From the template', description: 'Template text', canonical: '/elsewhere' },
    )
    expect(meta.title).toEqual({ value: 'Who we are', source: 'page' })
    expect(meta.description).toEqual({ value: 'Our story', source: 'page' })
    expect(meta.canonical).toEqual({ value: 'https://acme.test/story', source: 'page' })
  })

  test('the template fills what the page leaves empty, then the site', () => {
    const meta = effectiveMeta(
      content([text('seoTitle', '  ')]),
      {
        origin: ORIGIN,
        alternates: [],
        site: { ...SITE, titleSuffix: ' | Acme', defaultImage: '/media/share.png' },
      },
      { title: 'About', description: 'From the strapline' },
    )
    expect(meta.title).toEqual({ value: 'About', source: 'template' })
    expect(meta.fullTitle).toBe('About | Acme')
    expect(meta.description.source).toBe('template')
    expect(meta.image).toEqual({ value: 'https://acme.test/media/share.png', source: 'site' })
  })

  test('a template can drop the site suffix', () => {
    const meta = effectiveMeta(
      content(),
      { origin: ORIGIN, alternates: [], site: { ...SITE, titleSuffix: ' | Acme' } },
      { titleSuffix: null },
    )
    expect(meta.fullTitle).toBe('About us')
  })

  test('a site kept out of search hides every page, whatever the page says', () => {
    const hidden = effectiveMeta(content(), {
      origin: ORIGIN,
      alternates: [],
      site: { ...SITE, indexable: false },
    })
    expect(hidden.noindex).toEqual({ value: true, source: 'site' })
    const page = effectiveMeta(content([flag('seoNoindex', true)]), {
      origin: ORIGIN,
      alternates: [],
      site: SITE,
    })
    expect(page.noindex).toEqual({ value: true, source: 'page' })
  })

  test('offers language versions only when there is more than one', () => {
    const one = effectiveMeta(content(), {
      origin: ORIGIN,
      alternates: [{ culture: 'en-US', url: '/about', isDefault: true }],
      site: SITE,
    })
    expect(one.alternates).toEqual([])
    expect(one.xDefault).toBeUndefined()
    const two = effectiveMeta(content(), {
      origin: ORIGIN,
      alternates: [
        { culture: 'en-US', url: '/about', isDefault: true },
        { culture: 'da-DK', url: '//acme.dk/om', isDefault: false },
        { culture: 'de-DE', url: '#', isDefault: false },
      ],
      site: SITE,
    })
    expect(two.alternates).toEqual([
      { culture: 'en-US', url: 'https://acme.test/about' },
      { culture: 'da-DK', url: 'https://acme.dk/om' },
    ])
    expect(two.xDefault).toBe('https://acme.test/about')
  })
})

describe('<SeoHead>', () => {
  const head = (model: PublishedContent, extra: Record<string, unknown> = {}) =>
    SeoHead({
      model,
      request: { origin: ORIGIN, url: `${ORIGIN}/about` },
      urls: { alternates: () => [] },
      seo: { ...SITE, titleSuffix: ' | Acme' },
      ...extra,
    }).value

  test('writes the title, description, address and sharing tags', () => {
    const html = head(content([text('seoDescription', 'Our <story>')]))
    expect(html).toContain('<title>About us | Acme</title>')
    expect(html).toContain('<meta name="description" content="Our &lt;story&gt;" />')
    expect(html).toContain('<link rel="canonical" href="https://acme.test/about" />')
    expect(html).toContain('<meta property="og:title" content="About us" />')
    expect(html).toContain('<meta property="og:url" content="https://acme.test/about" />')
    expect(html).toContain('<meta property="og:site_name" content="Acme" />')
    expect(html).toContain('<meta name="twitter:card" content="summary" />')
    expect(html).not.toContain('robots')
    expect(html).not.toContain('og:image')
  })

  test('asks search engines to stay away from a hidden page', () => {
    expect(head(content([flag('seoNoindex', true)]))).toContain(
      '<meta name="robots" content="noindex" />',
    )
  })

  test('lists language versions with a default', () => {
    const html = head(content(), {
      urls: {
        alternates: () => [
          { culture: 'en-US', url: '/about', isDefault: true },
          { culture: 'da-DK', url: '/da/om', isDefault: false },
        ],
      },
    })
    expect(html).toContain(
      '<link rel="alternate" hreflang="en-US" href="https://acme.test/about" />',
    )
    expect(html).toContain(
      '<link rel="alternate" hreflang="da-DK" href="https://acme.test/da/om" />',
    )
    expect(html).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://acme.test/about" />',
    )
  })
})

describe('the reserved properties', () => {
  test('umbracoUrlAlias adds addresses, but never takes one a page already has', async () => {
    const home = node('Home')
    const about = node('About', home.id, [
      text('umbracoUrlAlias', 'who-we-are, /contact , team/people'),
    ])
    const contact = node('Contact', home.id)
    const cache = new PublishedCache({ loadPublished: async () => [home, about, contact] })
    expect((await cache.resolve('', '/who-we-are'))?.content.key).toBe(about.key)
    expect((await cache.resolve('', '/team/people/'))?.content.key).toBe(about.key)
    // The real page keeps its address, and the alias page keeps its own URL.
    expect((await cache.resolve('', '/contact'))?.content.key).toBe(contact.key)
    expect((await cache.resolve('', '/who-we-are'))?.content.url).toBe('/about')
  })

  test('umbracoRedirect sends the visitor to the picked page', async () => {
    const home = node('Home')
    const target = node('Target', home.id)
    const moved = node('Moved', home.id, [
      {
        alias: 'umbracoRedirect',
        editorAlias: 'Umbraco.ContentPicker',
        culture: null,
        segment: null,
        value: `umb://document/${target.key.replaceAll('-', '')}`,
      },
    ])
    const cache = new PublishedCache({ loadPublished: async () => [home, target, moved] })
    expect((await cache.resolve('', '/moved'))?.redirect).toBe('/target')
    expect((await cache.resolve('', '/target'))?.redirect).toBeUndefined()
  })

  test('umbracoNaviHide leaves a page out of navigation that asks for visible pages', async () => {
    const home = node('Home')
    const shown = node('Shown', home.id)
    const hidden = node('Hidden', home.id, [flag('umbracoNaviHide', true)])
    const cache = new PublishedCache({ loadPublished: async () => [home, shown, hidden] })
    const nav = await cache.navigation()
    const root = nav.root()[0] as PublishedContent
    expect(nav.children(root).map((c) => c.name)).toEqual(['Shown', 'Hidden'])
    expect(nav.children(root, { visibleOnly: true }).map((c) => c.name)).toEqual(['Shown'])
    expect(nav.byKey(hidden.key)?.isVisible).toBe(false)
  })
})

describe('the sitemap and robots file', () => {
  test('lists published pages with a template, except those hidden from it', async () => {
    const home = node('Home')
    const about = node('About', home.id)
    const secret = node('Secret', home.id, [flag('seoSitemapHide', true)])
    const folder = { ...node('Folder', home.id), componentAlias: null }
    const cache = new PublishedCache({ loadPublished: async () => [home, about, secret, folder] })
    const entries = sitemapEntries(await cache.snapshot(), { host: 'acme.test', origin: ORIGIN })
    expect(entries.map((e) => e.url)).toEqual(['https://acme.test/', 'https://acme.test/about'])
    const xml = renderSitemap(entries)
    expect(xml).toContain('<loc>https://acme.test/about</loc>')
    expect(xml).toContain('<lastmod>2026-03-04T05:06:07.000Z</lastmod>')
  })

  test('only the pages a hostname roots appear on that hostname', async () => {
    const english = node('English')
    const danish = node('Danish')
    const cache = new PublishedCache({
      loadPublished: async () => [english, danish],
      loadDomains: async () => [
        { nodeId: danish.id, domainName: 'acme.dk', isoCode: null, isWildcard: false },
      ],
    })
    const snapshot = await cache.snapshot()
    const onDk = sitemapEntries(snapshot, { host: 'acme.dk', origin: 'https://acme.dk' })
    expect(onDk.map((e) => e.content.name)).toEqual(['Danish'])
    const onDefault = sitemapEntries(snapshot, { host: 'acme.test', origin: ORIGIN })
    expect(onDefault.map((e) => e.content.name)).toEqual(['English'])
  })

  test("robots carries the site's rules and the sitemap's address", () => {
    expect(
      robotsTxt('User-agent: *\nDisallow: /private', {
        origin: ORIGIN,
        indexable: true,
        sitemap: true,
      }),
    ).toBe('User-agent: *\nDisallow: /private\n\nSitemap: https://acme.test/sitemap.xml\n')
    expect(
      robotsTxt('User-agent: *\nAllow: /', { origin: ORIGIN, indexable: false, sitemap: true }),
    ).toBe('User-agent: *\nDisallow: /\n')
    expect(
      robotsTxt('User-agent: *\nAllow: /', { origin: ORIGIN, indexable: true, sitemap: false }),
    ).toBe('User-agent: *\nAllow: /\n')
  })
})
