/**
 * The redirects bundle, end to end: a rule typed in the backoffice has to
 * actually redirect a visitor, which is the only assertion that proves the
 * client half, the bundle's routes, the capability and core's matcher all agree.
 *
 * It also holds the line the capability draws. Writing is confined to `manual`
 * rules, so this bundle cannot delete a rule the site's configuration owns, nor
 * edit one the URL tracker recorded, however the request is phrased.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REDIRECTS_BUNDLE_ID, redirects as redirectsBundle } from '@bunbraco/bundle-redirects'
import { ContentTypeRepository, RedirectRepository, TemplateRepository } from '@bunbraco/data'
import { redirect } from '@bunbraco/render'
import type { BunbracoConfig } from '@bunbraco/server'
import { type Harness, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

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

/**
 * Where the bundle answers. Derived from the host rather than written out,
 * because the backoffice path is configurable and the plugin path moves with it
 * — which is exactly why the client reads `<base href>` instead of assuming one.
 */
const rulesPath = (h: Harness) =>
  `${h.server.paths.pluginPath}/api/bundle/${REDIRECTS_BUNDLE_ID}/rules`

const TYPE_TOML = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
templates = ["page"]
default-template = "page"
`

const VIEW = `export default function Page({ model }) {
  return <main><h1>{model.name}</h1></main>
}
`

interface Rule {
  key: string
  source: string
  editable: boolean
  matchKind: string
  pattern: string
  targetKind: string
  target: string
  statusCode: number
  culture: string | null
  destinationUrl?: string
}

async function site(config: Partial<BunbracoConfig> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bundle-redirects-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE_TOML)
  writeFileSync(join(root, 'Views', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      viewsDir: join(root, 'Views'),
      bundles: [redirectsBundle()],
      ...config,
    },
  })
  open.push(h)

  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const templateKey = (await new TemplateRepository(h.server.db).byAlias('page'))?.key as string

  const page = async (name: string, parent: string | null = null) => {
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      parent: parent ? { id: parent } : null,
      template: { id: templateKey },
      values: [],
      variants: [{ culture: null, segment: null, name }],
    })
    if (created.status !== 201) throw new Error(`create ${created.status}: ${await created.text()}`)
    const key = created.headers.get('umb-generated-resource') as string
    const published = await h.put(`${V1}/document/${key}/publish`, {
      publishSchedules: [{ culture: null }],
    })
    if (published.status !== 200)
      throw new Error(`publish ${published.status}: ${await published.text()}`)
    return key
  }

  const rename = async (key: string, name: string) => {
    const response = await h.put(`${V1}/document/${key}/update-and-publish`, {
      template: { id: templateKey },
      values: [],
      variants: [{ culture: null, segment: null, name }],
      culturesToPublish: [null],
    })
    if (response.status !== 200)
      throw new Error(`rename ${response.status}: ${await response.text()}`)
  }

  const rules = rulesPath(h)
  const list = () => h.json<{ total: number; items: Rule[] }>(rules)
  const add = (rule: Record<string, unknown>) => h.post(rules, rule)
  const at = async (url: string) => {
    const response = await h.server.fetch(new Request(url, { redirect: 'manual' }))
    return { status: response.status, location: response.headers.get('location') }
  }

  return { h, page, rename, list, add, at, rules }
}

describe('a rule somebody typed', () => {
  test('redirects a visitor, which is the whole point', async () => {
    const { page, add, at } = await site()
    await page('Home')
    expect((await at('http://localhost/brochure')).status).toBe(404)

    const created = await add({
      matchKind: 'exact',
      pattern: '/brochure',
      targetKind: 'url',
      target: 'https://example.com/brochure.pdf',
    })
    expect(created.status).toBe(200)

    expect(await at('http://localhost/brochure')).toEqual({
      status: 301,
      location: 'https://example.com/brochure.pdf',
    })
  })

  test('is stored as manual, so it is told apart from the other two kinds', async () => {
    const { page, add, list } = await site()
    await page('Home')
    await add({ matchKind: 'exact', pattern: '/a', targetKind: 'path', target: '/b' })
    const rule = (await list()).items.find((item) => item.pattern === '/a')
    expect(rule?.source).toBe('manual')
    expect(rule?.editable).toBe(true)
  })

  test('points at a page by key, so it follows the page when it is renamed', async () => {
    const { page, rename, add, at } = await site()
    const home = await page('Home')
    const about = await page('About', home)
    await add({ matchKind: 'exact', pattern: '/company', targetKind: 'document', target: about })
    expect(await at('http://localhost/company')).toEqual({ status: 301, location: '/about' })

    await rename(about, 'Our Company')
    expect(await at('http://localhost/company')).toEqual({
      status: 301,
      location: '/our-company',
    })
  })

  test('reports where a page target resolves, so the table is never stale', async () => {
    const { page, add, list } = await site()
    const home = await page('Home')
    const about = await page('About', home)
    await add({ matchKind: 'exact', pattern: '/company', targetKind: 'document', target: about })
    const rule = (await list()).items.find((item) => item.pattern === '/company')
    expect(rule?.destinationUrl).toBe('/about')
  })

  test('honours the chosen status code', async () => {
    const { page, add, at } = await site()
    await page('Home')
    await add({
      matchKind: 'exact',
      pattern: '/temporary',
      targetKind: 'path',
      target: '/home',
      statusCode: 302,
    })
    expect((await at('http://localhost/temporary')).status).toBe(302)
  })

  test('redirects a whole subtree, passing the remainder through', async () => {
    const { page, add, at } = await site()
    await page('Home')
    await add({
      matchKind: 'prefix',
      pattern: '/legacy',
      targetKind: 'path',
      target: '/archive/$1',
    })
    expect((await at('http://localhost/legacy/2019/report')).location).toBe('/archive/2019/report')
  })

  test('redirects by regular expression, with its captures', async () => {
    const { page, add, at } = await site()
    await page('Home')
    await add({
      matchKind: 'regex',
      pattern: '^/news/(\\d+)/(.+)$',
      targetKind: 'path',
      target: '/articles/$2',
    })
    expect((await at('http://localhost/news/2019/budget')).location).toBe('/articles/budget')
  })

  test('never shadows a page that resolves', async () => {
    // Matching happens only after route resolution has found nothing, so a rule
    // cannot make a live URL unreachable however it is written.
    const { page, add, at } = await site()
    const home = await page('Home')
    await page('About', home)
    await add({
      matchKind: 'prefix',
      pattern: '/',
      targetKind: 'url',
      target: 'https://example.com',
    })
    expect((await at('http://localhost/about')).status).toBe(200)
  })

  test('is refused with a message the screen can show, not a 500', async () => {
    const { page, add } = await site()
    await page('Home')
    const response = await add({
      matchKind: 'regex',
      pattern: '([a-',
      targetKind: 'path',
      target: '/x',
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toContain('regular expression')
  })

  test('is deleted when asked', async () => {
    const { page, add, list, h, at, rules } = await site()
    await page('Home')
    await add({ matchKind: 'exact', pattern: '/gone', targetKind: 'path', target: '/home' })
    const key = (await list()).items.find((item) => item.pattern === '/gone')?.key as string

    expect((await h.del(`${rules}/${key}`)).status).toBe(200)
    expect((await list()).items.find((item) => item.pattern === '/gone')).toBeUndefined()
    expect((await at('http://localhost/gone')).status).toBe(404)
  })
})

describe('editing one', () => {
  test('changes where it points', async () => {
    const { page, add, list, h, at, rules } = await site()
    await page('Home')
    await add({ matchKind: 'exact', pattern: '/offer', targetKind: 'path', target: '/old' })
    const key = (await list()).items.find((item) => item.pattern === '/offer')?.key as string

    const updated = await h.put(`${rules}/${key}`, {
      matchKind: 'exact',
      pattern: '/offer',
      targetKind: 'path',
      target: '/new',
    })
    expect(updated.status).toBe(200)
    expect((await at('http://localhost/offer')).location).toBe('/new')
  })

  test('changing the pattern does not leave the old rule behind', async () => {
    // A rule is identified by what it matches, so an edit to the pattern is a
    // different row. Leaving the original would keep redirecting a URL the
    // administrator believes they have stopped redirecting.
    const { page, add, list, h, at, rules } = await site()
    await page('Home')
    await add({ matchKind: 'exact', pattern: '/first', targetKind: 'path', target: '/home' })
    const key = (await list()).items.find((item) => item.pattern === '/first')?.key as string

    expect(
      (
        await h.put(`${rules}/${key}`, {
          matchKind: 'exact',
          pattern: '/second',
          targetKind: 'path',
          target: '/home',
        })
      ).status,
    ).toBe(200)

    const patterns = (await list()).items.map((item) => item.pattern)
    expect(patterns).toContain('/second')
    expect(patterns).not.toContain('/first')
    expect((await at('http://localhost/first')).status).toBe(404)
  })

  test('a refusal costs nothing, because the rule is checked before it is replaced', async () => {
    const { page, add, list, h, at, rules } = await site()
    await page('Home')
    await add({ matchKind: 'exact', pattern: '/keep', targetKind: 'path', target: '/home' })
    const key = (await list()).items.find((item) => item.pattern === '/keep')?.key as string

    const refused = await h.put(`${rules}/${key}`, {
      matchKind: 'regex',
      pattern: '([a-',
      targetKind: 'path',
      target: '/home',
    })
    expect(refused.status).toBe(400)
    // Still there, still redirecting.
    expect((await at('http://localhost/keep')).location).toBe('/home')
  })

  test('a key that no longer exists is a 404', async () => {
    const { page, h, rules } = await site()
    await page('Home')
    const response = await h.put(`${rules}/f0000000-0000-0000-0000-00000000dead`, {
      matchKind: 'exact',
      pattern: '/a',
      targetKind: 'path',
      target: '/b',
    })
    expect(response.status).toBe(404)
  })
})

describe('the rules this bundle must not touch', () => {
  test('lists a configured rule, and refuses to delete it', async () => {
    const { page, list, h, rules } = await site({ redirects: [redirect('/declared', '/home')] })
    await page('Home')
    const rule = (await list()).items.find((item) => item.pattern === '/declared')
    expect(rule?.source).toBe('config')
    expect(rule?.editable).toBe(false)

    const refused = await h.del(`${rules}/${rule?.key}`)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { message: string }).message).toContain('configured')
    // And it is still in force, which is the part that matters.
    expect((await list()).items.some((item) => item.pattern === '/declared')).toBe(true)
  })

  test('refuses to edit a configured rule', async () => {
    const { page, list, h, rules } = await site({ redirects: [redirect('/declared', '/home')] })
    await page('Home')
    const key = (await list()).items.find((item) => item.pattern === '/declared')?.key as string
    const refused = await h.put(`${rules}/${key}`, {
      matchKind: 'exact',
      pattern: '/declared',
      targetKind: 'url',
      target: 'https://example.com',
    })
    expect(refused.status).toBe(409)
  })

  test('lists a tracked rule, and refuses to delete or edit it', async () => {
    const { page, rename, list, h, rules } = await site()
    const home = await page('Home')
    const about = await page('About', home)
    await rename(about, 'Contact')

    const rule = (await list()).items.find((item) => item.pattern === '/about')
    expect(rule?.source).toBe('tracked')
    expect(rule?.editable).toBe(false)

    expect((await h.del(`${rules}/${rule?.key}`)).status).toBe(409)
    expect(
      (
        await h.put(`${rules}/${rule?.key}`, {
          matchKind: 'exact',
          pattern: '/about',
          targetKind: 'path',
          target: '/elsewhere',
        })
      ).status,
    ).toBe(409)
  })

  test('cannot forge a configured rule by asking for one', async () => {
    // `source` is not an input the bundle can set: the capability writes it.
    const { page, add, list } = await site()
    await page('Home')
    await add({
      matchKind: 'exact',
      pattern: '/sneaky',
      targetKind: 'path',
      target: '/home',
      source: 'config',
    })
    expect((await list()).items.find((item) => item.pattern === '/sneaky')?.source).toBe('manual')
  })

  test('a manual rule survives the configuration being synced at boot', async () => {
    // `syncConfigured` removes config rows the file no longer declares. A manual
    // rule caught by that would vanish on the next deploy.
    const { page, add, h } = await site()
    await page('Home')
    await add({ matchKind: 'exact', pattern: '/typed', targetKind: 'path', target: '/home' })

    const repository = new RedirectRepository(h.server.db)
    await repository.syncConfigured([])
    expect((await repository.list()).items.some((item) => item.pattern === '/typed')).toBe(true)
  })

  test('a manual rule survives a rename being reverted', async () => {
    // `removeSelfReferencing` drops a tracked rule that would point a live URL at
    // itself. It is scoped to tracked rules, and a manual rule for the same route
    // is somebody's deliberate decision.
    const { page, rename, add, h } = await site()
    const home = await page('Home')
    const about = await page('About', home)
    await add({ matchKind: 'exact', pattern: '/about', targetKind: 'path', target: '/home' })

    await rename(about, 'Contact')
    await rename(about, 'About')

    const repository = new RedirectRepository(h.server.db)
    const rules = (await repository.list()).items.filter((item) => item.pattern === '/about')
    expect(rules.map((rule) => rule.source)).toContain('manual')
  })
})

describe('precedence', () => {
  test('a manual rule outranks a tracked one for the same URL', async () => {
    // Both rows exist — they are different sources, so they do not collide — and
    // the administrator's decision is the one that should answer.
    const { page, rename, add, at } = await site()
    const home = await page('Home')
    const about = await page('About', home)
    const news = await page('News', home)
    await rename(about, 'Contact')
    expect((await at('http://localhost/about')).location).toBe('/contact')

    await add({ matchKind: 'exact', pattern: '/about', targetKind: 'document', target: news })
    expect((await at('http://localhost/about')).location).toBe('/news')
  })

  test('a configured rule outranks a manual one, because the file is the deploy', async () => {
    const { page, add, at } = await site({ redirects: [redirect('/both', '/from-config')] })
    await page('Home')
    await add({ matchKind: 'exact', pattern: '/both', targetKind: 'path', target: '/from-manual' })
    expect((await at('http://localhost/both')).location).toBe('/from-config')
  })
})

describe('who may use it', () => {
  test('refuses a caller with no session', async () => {
    const { h, rules } = await site()
    const response = await h.server.fetch(new Request(`http://localhost${rules}`))
    expect(response.status).toBe(401)
  })

  test('refuses a signed-in user without the Settings section', async () => {
    const { h, page, rules } = await site()
    await page('Home')
    const writer = await signInAsGroup(h, 'writer')
    expect((await writer.call(rules)).status).toBe(403)
    expect(
      (
        await writer.post(rules, {
          matchKind: 'exact',
          pattern: '/x',
          targetKind: 'path',
          target: '/y',
        })
      ).status,
    ).toBe(403)
  })

  test('answers an unknown path below its own namespace with a 404', async () => {
    const { h } = await site()
    expect(
      (await h.call(`${h.server.paths.pluginPath}/api/bundle/${REDIRECTS_BUNDLE_ID}/nonsense`))
        .status,
    ).toBe(404)
  })
})

describe('the bundle as a package', () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'packages/bundle-redirects/package.json'), 'utf8'),
  ) as {
    version: string
    keywords: string[]
    bunbraco: { id: string; extensions: Array<Record<string, unknown>> }
  }

  test('declares the two extensions the screen needs', () => {
    // A menu item in Settings' Advanced menu and the workspace it points at —
    // the pattern Umbraco's own log viewer uses, so no vendored element is
    // replaced to put a screen in Settings.
    const types = manifest.bunbraco.extensions.map((extension) => extension.type)
    expect(types).toEqual(['menuItem', 'workspace'])
  })

  test('its menu item and workspace agree on the entity type', () => {
    // The menu item's href is `section/settings/workspace/<entityType>`, so a
    // mismatch here is a link to a screen that does not exist.
    const [menuItem, workspace] = manifest.bunbraco.extensions as Array<{
      meta: { entityType: string; menus?: string[] }
    }>
    expect(menuItem?.meta.entityType).toBe(workspace?.meta.entityType as string)
    expect(menuItem?.meta.menus).toContain('Umb.Menu.AdvancedSettings')
  })

  test('its element path is inside the files npm will carry', () => {
    const [, workspace] = manifest.bunbraco.extensions as Array<{ element?: string }>
    expect(workspace?.element).toBe('plugin/redirects-workspace.js')
  })

  test('carries the keyword the Bundles section searches', () => {
    expect(manifest.keywords).toContain('bunbraco-bundle')
  })

  test('is versioned with the rest of the set', () => {
    const umbrella = JSON.parse(
      readFileSync(join(process.cwd(), 'packages/bunbraco/package.json'), 'utf8'),
    ) as { version: string }
    expect(manifest.version).toBe(umbrella.version)
  })
})

describe('the client half', () => {
  const source = (file: string) =>
    readFileSync(join(process.cwd(), 'packages/bundle-redirects/plugin', file), 'utf8')

  test('calls the path its own bundle id is mounted at', () => {
    expect(source('redirects-client.js')).toContain(`/bunbraco/api/bundle/${REDIRECTS_BUNDLE_ID}`)
  })

  test('reads the backoffice path rather than assuming /umbraco', () => {
    expect(source('redirects-client.js')).toContain("querySelector('base')")
  })

  test('offers every match and target kind the matcher implements', () => {
    // A screen quietly weaker than `bunbraco.config.ts` is the failure mode
    // here, and it is invisible until somebody needs the missing option.
    const workspace = source('redirects-workspace.js')
    for (const kind of ['exact', 'prefix', 'regex', 'document', 'path', 'url'])
      expect(workspace, kind).toContain(`'${kind}'`)
    for (const status of [301, 302, 307, 308]) expect(workspace).toContain(`[${status},`)
  })

  test('names all three sources, so the table says where a rule came from', () => {
    const workspace = source('redirects-workspace.js')
    for (const name of ['manual', 'config', 'tracked']) expect(workspace).toContain(name)
  })

  test('offers edit and delete only for a rule the server will let it change', () => {
    expect(source('redirects-workspace.js')).toContain('rule.editable')
  })

  test('registers the elements it renders that the shell loads lazily', () => {
    // `uui-*` comes with the app shell, but `umb-body-layout` and
    // `umb-input-document` live in chunks it loads on demand — and this module
    // is not part of the client's chunk graph, so an unimported element renders
    // as an empty box with no error to find it by.
    const workspace = source('redirects-workspace.js')
    expect(workspace).toContain("import '@umbraco-cms/backoffice/components'")
    expect(workspace).toContain("import '@umbraco-cms/backoffice/document'")
    for (const tag of ['umb-body-layout', 'umb-input-document'])
      expect(workspace, tag).toContain(`<${tag}`)
  })
})
