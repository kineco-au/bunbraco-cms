/**
 * Search and sharing on a running site: the "Search & sharing" system type,
 * `/sitemap.xml` and `/robots.txt`, the site-wide settings and their
 * precedence, the editor's preview, the not-found page and `umbracoRedirect`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEO_FIELDS_PROPERTIES, SYSTEM_DOCUMENT_TYPE_KEYS } from '@bunbraco/core'
import {
  ComponentRepository,
  ContentTypeRepository,
  ensureSystemDocumentTypes,
} from '@bunbraco/data'
import { exportSchemaSet, loadSchemaDirectory, validateSchemaSet } from '@bunbraco/schema'
import type { BunbracoConfig } from '@bunbraco/server'
import { BACKOFFICE, type Harness, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

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

const SEO_KEY = SYSTEM_DOCUMENT_TYPE_KEYS.SeoFields

const PAGE_TOML = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page", "plain"]
compositions = ["seoFields"]
components = ["page"]
default-component = "page"

[[property]]
alias = "umbracoRedirect"
name = "Redirect"
type = "contentPicker"
`

const PLAIN_TOML = `[content-type]
alias = "plain"
name = "Plain"
allow-at-root = true
components = ["page"]
default-component = "page"
`

const VIEW = `import { SeoHead } from 'bunbraco'
export default function Page(props) {
  return <html><head><SeoHead {...props} /></head><body><h1>{props.model.name}</h1></body></html>
}
`

async function site(config: Partial<BunbracoConfig> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'seo-'))
  dirs.push(root)
  const schemaDir = join(root, 'schema')
  mkdirSync(join(schemaDir, 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(schemaDir, 'content-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(schemaDir, 'content-types', 'plain.toml'), PLAIN_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: { schemaDir, componentsDir: join(root, 'components'), ...config },
  })
  open.push(h)
  const types = new ContentTypeRepository(h.server.db)
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const typeKey = async (alias: string) => (await types.byAlias(alias))?.key as string

  const create = async (
    name: string,
    options: {
      parent?: string
      type?: string
      values?: Array<{ alias: string; value: unknown }>
    } = {},
  ) => {
    const created = await h.post(`${V1}/document`, {
      documentType: { id: await typeKey(options.type ?? 'page') },
      parent: options.parent ? { id: options.parent } : null,
      template: { id: componentKey },
      values: (options.values ?? []).map((v) => ({ ...v, culture: null, segment: null })),
      variants: [{ culture: null, segment: null, name }],
    })
    if (created.status !== 201) throw new Error(`create ${created.status}: ${await created.text()}`)
    return created.headers.get('umb-generated-resource') as string
  }
  const publish = async (key: string) => {
    const published = await h.put(`${V1}/document/${key}/publish`, {
      publishSchedules: [{ culture: null }],
    })
    if (published.status !== 200)
      throw new Error(`publish ${published.status}: ${await published.text()}`)
  }
  const page = async (...args: Parameters<typeof create>) => {
    const key = await create(...args)
    await publish(key)
    return key
  }
  const visit = (url: string, init: RequestInit = {}) =>
    h.server.fetch(new Request(url, { redirect: 'manual', ...init }))
  const seoApi = (path: string) => `${BACKOFFICE}/bunbraco/api/seo${path}`
  return { h, root, schemaDir, create, publish, page, visit, seoApi, typeKey }
}

describe('the Search & sharing type', () => {
  test('ships with the CMS, so a type composes it without a file', async () => {
    const { h, typeKey } = await site()
    const seo = await new ContentTypeRepository(h.server.db).byKey(SEO_KEY)
    expect(seo?.alias).toBe('seoFields')
    expect(seo?.properties.map((p) => p.alias)).toEqual(SEO_FIELDS_PROPERTIES.map((p) => p.alias))
    const page = await new ContentTypeRepository(h.server.db).byKey(await typeKey('page'))
    expect(page?.compositions.map((c) => c.contentTypeKey.toLowerCase())).toEqual([SEO_KEY])
    expect(await ensureSystemDocumentTypes(h.server.db)).toEqual([])
  })

  test('cannot be deleted or renamed', async () => {
    const { h } = await site()
    expect((await h.del(`${V1}/document-type/${SEO_KEY}`)).status).toBe(400)
    const type = await h.json<Record<string, unknown>>(`${V1}/document-type/${SEO_KEY}`)
    const renamed = await h.put(`${V1}/document-type/${SEO_KEY}`, { ...type, alias: 'mySeo' })
    expect(renamed.status).toBe(400)
  })

  test('keeps the fields it ships with, but takes new ones', async () => {
    const { h, schemaDir } = await site({ schemaWritable: true })
    const type = await h.json<{ properties: Array<Record<string, unknown>> }>(
      `${V1}/document-type/${SEO_KEY}`,
    )
    const removed = await h.put(`${V1}/document-type/${SEO_KEY}`, {
      ...type,
      properties: type.properties.filter((p) => p.alias !== 'seoTitle'),
    })
    expect(removed.status).toBe(400)
    expect(JSON.stringify(await removed.json())).toContain(
      "'Search title' field is provided by Bunbraco",
    )

    const extra = {
      ...(type.properties[0] as Record<string, unknown>),
      id: crypto.randomUUID(),
      alias: 'seoKeywords',
      name: 'Keywords',
      sortOrder: 99,
    }
    const extended = await h.put(`${V1}/document-type/${SEO_KEY}`, {
      ...type,
      properties: [...type.properties, extra],
    })
    expect(extended.status).toBe(200)
    // The extension is written down as the site's own file, which still validates.
    const file = join(schemaDir, 'content-types', 'seo-fields.toml')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('seoKeywords')
    expect(validateSchemaSet(loadSchemaDirectory(schemaDir).set)).toEqual([])
  })

  test('a file that drops a shipped field is refused, naming it', async () => {
    const { schemaDir } = await site()
    writeFileSync(
      join(schemaDir, 'content-types', 'seo-fields.toml'),
      `[content-type]\nkey = "${SEO_KEY}"\nalias = "seoFields"\nname = "Search & sharing"\n\n[[property]]\nalias = "seoTitle"\nname = "Search title"\ntype = "textarea"\n`,
    )
    const messages = validateSchemaSet(loadSchemaDirectory(schemaDir).set).map((p) => p.message)
    expect(messages).toContainEqual(
      expect.stringContaining('"seoTitle" field is provided by Bunbraco'),
    )
    expect(messages).toContainEqual(
      expect.stringContaining('"seoDescription" field is provided by Bunbraco'),
    )
  })

  test('a type that does not vary cannot compose fields that do', async () => {
    const { schemaDir } = await site()
    const original = readFileSync(join(schemaDir, 'content-types', 'page.toml'), 'utf8')
    writeFileSync(
      join(schemaDir, 'content-types', 'shared.toml'),
      `[content-type]\nalias = "shared"\nname = "Shared"\nvaries-by-culture = true\n\n[[property]]\nalias = "tagline"\nname = "Tagline"\ntype = "textstring"\nvaries-by-culture = true\n`,
    )
    writeFileSync(
      join(schemaDir, 'content-types', 'page.toml'),
      original.replace('compositions = ["seoFields"]', 'compositions = ["seoFields", "shared"]'),
    )
    const messages = validateSchemaSet(loadSchemaDirectory(schemaDir).set).map((p) => p.message)
    expect(messages).toContainEqual(
      expect.stringContaining('"shared" has fields that vary by culture'),
    )
  })

  test('export writes no file until a site has extended it', async () => {
    const { h } = await site()
    const set = await exportSchemaSet(h.server.db, '1.0.0')
    expect(set.documentTypes.map((t) => t.alias)).not.toContain('seoFields')
  })
})

describe('the sitemap and robots file', () => {
  test('list the published pages a visitor may see', async () => {
    const { h, page, create, visit } = await site()
    const home = await page('Home')
    await page('About', { parent: home })
    await page('Hidden', { parent: home, values: [{ alias: 'seoSitemapHide', value: true }] })
    await create('Draft', { parent: home })
    const response = await visit('http://acme.test/sitemap.xml')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/xml')
    const xml = await response.text()
    expect(xml).toContain('<loc>http://acme.test/</loc>')
    expect(xml).toContain('<loc>http://acme.test/about</loc>')
    expect(xml).not.toContain('hidden')
    expect(xml).not.toContain('draft')

    const robots = await (await visit('http://acme.test/robots.txt')).text()
    expect(robots).toBe('User-agent: *\nAllow: /\n\nSitemap: http://acme.test/sitemap.xml\n')
    expect(h).toBeDefined()
  })

  test('follow a proxy for the address search engines see', async () => {
    const { page, visit } = await site()
    await page('Home')
    const robots = await (
      await visit('http://internal:3000/robots.txt', {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'www.acme.test' },
      })
    ).text()
    expect(robots).toContain('Sitemap: https://www.acme.test/sitemap.xml')
  })

  test('a site kept out of search offers no list and refuses every crawler', async () => {
    const { page, visit } = await site({ seo: { indexable: false } })
    await page('Home')
    expect((await visit('http://acme.test/sitemap.xml')).status).toBe(404)
    expect(await (await visit('http://acme.test/robots.txt')).text()).toBe(
      'User-agent: *\nDisallow: /\n',
    )
    const html = await (await visit('http://acme.test/')).text()
    expect(html).toContain('<meta name="robots" content="noindex" />')
  })
})

describe('the page head', () => {
  test("uses the page's own values, and the site's suffix", async () => {
    const { page, visit } = await site({ seo: { titleSuffix: ' | Acme', siteName: 'Acme Ltd' } })
    await page('Home', {
      values: [
        { alias: 'seoTitle', value: 'Welcome' },
        { alias: 'seoDescription', value: 'All about Acme' },
      ],
    })
    const html = await (await visit('http://acme.test/')).text()
    expect(html).toContain('<title>Welcome | Acme</title>')
    expect(html).toContain('<meta name="description" content="All about Acme" />')
    expect(html).toContain('<link rel="canonical" href="http://acme.test/" />')
    expect(html).toContain('<meta property="og:site_name" content="Acme Ltd" />')
  })
})

describe('site-wide settings', () => {
  test('a value set in the backoffice wins over the config, and clearing it restores it', async () => {
    const { h, seoApi, visit, page } = await site({ seo: { titleSuffix: ' | Config' } })
    await page('Home')
    const before = await h.json<{
      effective: { titleSuffix: string }
      sources: Record<string, string>
    }>(seoApi('/settings'))
    expect(before.effective.titleSuffix).toBe(' | Config')
    expect(before.sources).toMatchObject({ titleSuffix: 'config', robotsTxt: 'default' })

    const saved = await h.put(seoApi('/settings'), {
      titleSuffix: ' | Backoffice',
      robotsTxt: 'User-agent: *\nDisallow: /tmp',
    })
    expect(saved.status).toBe(200)
    expect(await (await visit('http://acme.test/')).text()).toContain(
      '<title>Home | Backoffice</title>',
    )
    expect(await (await visit('http://acme.test/robots.txt')).text()).toContain('Disallow: /tmp')

    const cleared = await h.json<{
      effective: { titleSuffix: string }
      sources: Record<string, string>
    }>(seoApi('/settings'), { method: 'PUT', body: JSON.stringify({ titleSuffix: null }) })
    expect(cleared.effective.titleSuffix).toBe(' | Config')
    expect(cleared.sources).toMatchObject({ titleSuffix: 'config', robotsTxt: 'backoffice' })
  })

  test('refuses a malformed value, and someone without Settings', async () => {
    const { h, seoApi } = await site()
    expect((await h.put(seoApi('/settings'), { indexable: 'yes' })).status).toBe(400)
    const writer = await signInAsGroup(h)
    expect((await writer.call(seoApi('/settings'))).status).toBe(403)
  })
})

describe('the editor preview', () => {
  test('shows saved values before they are published, with where each came from', async () => {
    const { h, page, seoApi } = await site()
    const home = await page('Home')
    const update = await h.put(`${V1}/document/${home}`, {
      values: [
        { alias: 'seoDescription', value: 'Saved, not published', culture: null, segment: null },
      ],
      variants: [{ culture: null, segment: null, name: 'Home' }],
      template: null,
    })
    expect(update.status).toBe(200)
    const preview = await h.json<{
      hasSeoFields: boolean
      published: boolean
      meta: { title: { source: string }; description: { value: string; source: string } }
      snippet: { title: string; description: string }
    }>(seoApi(`/preview?document=${home}`))
    expect(preview.hasSeoFields).toBe(true)
    expect(preview.published).toBe(true)
    expect(preview.meta.title.source).toBe('name')
    expect(preview.meta.description).toEqual({ value: 'Saved, not published', source: 'page' })
    expect(preview.snippet).toMatchObject({ title: 'Home', description: 'Saved, not published' })
  })

  test('says when a type has no Search & sharing fields', async () => {
    const { h, create, seoApi } = await site()
    const plain = await create('Plain', { type: 'plain' })
    const preview = await h.json<{ hasSeoFields: boolean; published: boolean }>(
      seoApi(`/preview?document=${plain}`),
    )
    expect(preview).toMatchObject({ hasSeoFields: false, published: false })
  })
})

describe('addresses nothing answers', () => {
  test('render the chosen page with a not-found status', async () => {
    const { h, page, visit, seoApi } = await site()
    const home = await page('Home')
    const missing = await page('Page not found', { parent: home })
    expect(await (await visit('http://acme.test/nowhere')).text()).toBe('Not Found')

    await h.put(seoApi('/settings'), { notFoundPage: [{ document: missing }] })
    const response = await visit('http://acme.test/nowhere')
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('<h1>Page not found</h1>')
  })

  test('umbracoRedirect sends the visitor on, temporarily', async () => {
    const { page, visit } = await site()
    const home = await page('Home')
    const target = await page('Target', { parent: home })
    await page('Old', {
      parent: home,
      values: [{ alias: 'umbracoRedirect', value: `umb://document/${target.replaceAll('-', '')}` }],
    })
    const response = await visit('http://acme.test/old?from=menu')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/target?from=menu')
  })
})
