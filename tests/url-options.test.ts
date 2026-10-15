/**
 * Story 110: the URL options Umbraco sites rely on — the top-level page in the
 * path, and right-to-left segment order — with redirects from the old URLs
 * whenever the setting changes, and the importer carrying the source's across.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ComponentRepository,
  ContentTypeRepository,
  DocumentRepository,
  parseUrlOptions,
  readUrlOptions,
  sameUrlOptions,
} from '@crombolo/data'
import { hideTopLevelFrom, parseAppSettings } from '@crombolo/import-umbraco'
import { isRightToLeft, PublishedCache, type PublishedNode } from '@crombolo/render'
import {
  hashSchemaSet,
  parseSchemaSettings,
  type SchemaSet,
  writeSchemaVersion,
} from '@crombolo/schema'
import { BACKOFFICE, type Harness, ORIGIN, signedInServer } from './support/harness.ts'

describe('the setting in schema.toml', () => {
  test('is read from [urls], and left out when it is the default', () => {
    expect(
      parseSchemaSettings(
        's.toml',
        '[schema]\nversion = "1.0.0"\n\n[urls]\nhide-top-level = false\n',
      ).value,
    ).toEqual({ version: '1.0.0', urls: { hideTopLevel: false } })
    expect(parseSchemaSettings('s.toml', '[schema]\nversion = "1.0.0"\n').value).toEqual({
      version: '1.0.0',
    })
    expect(writeSchemaVersion('1.0.0', { hideTopLevel: false })).toBe(
      '[schema]\nversion = "1.0.0"\n\n[urls]\nhide-top-level = false\n',
    )
    expect(writeSchemaVersion('1.0.0', { hideTopLevel: true })).toBe(
      '[schema]\nversion = "1.0.0"\n',
    )
  })

  test('a key it does not know is a problem, not ignored', () => {
    const parsed = parseSchemaSettings(
      's.toml',
      '[schema]\nversion = "1.0.0"\n\n[urls]\nhide-top-levle = false\n',
    )
    expect(parsed.value).toBeUndefined()
    expect(parsed.problems[0]?.path).toContain('urls')
  })

  test('a site on the default keeps the hash it had, so its next deploy is not a schema change', () => {
    const set: SchemaSet = {
      version: '1.0.0',
      contentTypes: [],
      dataTypes: [],
      languages: [],
    }
    expect(hashSchemaSet({ ...set, urls: { hideTopLevel: true } })).toBe(hashSchemaSet(set))
    expect(hashSchemaSet({ ...set, urls: { hideTopLevel: false } })).not.toBe(hashSchemaSet(set))
  })

  test('a stored value is read leniently', () => {
    expect(parseUrlOptions(undefined)).toEqual({ hideTopLevel: true })
    expect(parseUrlOptions('{"hideTopLevel":false}')).toEqual({ hideTopLevel: false })
    expect(parseUrlOptions('nonsense')).toEqual({ hideTopLevel: true })
    expect(sameUrlOptions({ hideTopLevel: true }, { hideTopLevel: false })).toBe(false)
  })
})

describe('the importer', () => {
  test('reads appsettings as .NET does: comments, trailing commas, any case', () => {
    const settings = parseAppSettings(`{
      // The Umbraco section
      "Umbraco": { "CMS": { "Global": {
        /* kept as it was */ "HideTopLevelNodeFromPath": false,
        "Url": "https://example.com//not-a-comment",
      } } },
    }`)
    expect(hideTopLevelFrom(settings)).toBe(false)
    expect(
      hideTopLevelFrom({ umbraco: { cms: { global: { hidetoplevelnodefrompath: 'True' } } } }),
    ).toBe(true)
    expect(hideTopLevelFrom({ Umbraco: {} })).toBeUndefined()
  })
})

describe('routes', () => {
  const node = (
    id: number,
    parentId: number,
    names: Record<string, string>,
    sortOrder = 0,
  ): PublishedNode => ({
    id,
    key: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    parentId,
    level: parentId <= 0 ? 1 : 2,
    path: '',
    sortOrder,
    name: names['en-US'] ?? Object.values(names)[0] ?? '',
    contentTypeAlias: 'page',
    componentAlias: 'page',
    createDate: new Date(0),
    updateDate: new Date(0),
    cultures: Object.keys(names),
    names,
    properties: [],
  })

  const site = (hideTopLevel: boolean, defaultCulture = 'en-US') => {
    const home = node(1, -1, { 'en-US': 'Home', 'ar-SA': 'Bayt' })
    const news = node(2, 1, { 'en-US': 'News', 'ar-SA': 'Akhbar' })
    const story = { ...node(3, 2, { 'en-US': 'Story', 'ar-SA': 'Qissa' }), level: 3 }
    const other = node(4, -1, { 'en-US': 'Other', 'ar-SA': 'Akhar' }, 1)
    return new PublishedCache({
      loadPublished: async () => [home, news, story, other],
      loadLanguages: async () => [
        { isoCode: 'en-US', isDefault: defaultCulture === 'en-US', fallbackIsoCode: null },
        { isoCode: 'ar-SA', isDefault: defaultCulture === 'ar-SA', fallbackIsoCode: null },
      ],
      loadUrlOptions: async () => ({ hideTopLevel }),
    })
  }
  const path = async (cache: PublishedCache, id: number, culture: string) =>
    (await cache.routes(`00000000-0000-4000-8000-${String(id).padStart(12, '0')}`)).find(
      (r) => r.culture === culture,
    )?.path

  test('by default the top-level page is left out, and the first is /', async () => {
    const cache = site(true)
    expect(await path(cache, 1, 'en-US')).toBe('/')
    expect(await path(cache, 3, 'en-US')).toBe('/news/story')
    expect(await path(cache, 4, 'en-US')).toBe('/other')
  })

  test('shown, every path starts with its top-level page, and / still finds the first', async () => {
    const cache = site(false)
    expect(await path(cache, 1, 'en-US')).toBe('/home')
    expect(await path(cache, 3, 'en-US')).toBe('/home/news/story')
    expect(await path(cache, 4, 'en-US')).toBe('/other')
    expect((await cache.resolve('localhost', '/'))?.content.name).toBe('Home')
  })

  test('a right-to-left culture keeps the page’s own segment first, as Umbraco does', async () => {
    expect(isRightToLeft('ar-SA')).toBe(true)
    expect(isRightToLeft('he-IL')).toBe(true)
    expect(isRightToLeft('en-US')).toBe(false)
    expect(await path(site(true, 'ar-SA'), 3, 'ar-SA')).toBe('/qissa/akhbar')
    expect(await path(site(false, 'ar-SA'), 3, 'ar-SA')).toBe('/qissa/akhbar/bayt')
  })
})

const PAGE_TOML = `[content-type]
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

const SETTING = `${BACKOFFICE}/crombolo/api/url-options`

/** Home with News under it, published; `urls` is what schema.toml says. */
async function served(options: { urls?: string; writable?: boolean } = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'url-options-'))
  dirs.push(root)
  const schemaDir = join(root, 'schema')
  mkdirSync(join(schemaDir, 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(
    join(schemaDir, 'schema.toml'),
    `[schema]\nversion = "1.0.0"\n${options.urls ?? ''}`,
  )
  writeFileSync(join(schemaDir, 'content-types', 'page.toml'), PAGE_TOML)
  writeFileSync(
    join(root, 'components', 'page.tsx'),
    'export default function Page({ model }) { return <main>{model.name}</main> }\n',
  )
  const h = await signedInServer({
    config: {
      schemaDir,
      componentsDir: join(root, 'components'),
      ...(options.writable === false ? { schemaWritable: false } : {}),
    },
  })
  open.push(h)
  const db = h.server.db
  const docs = new DocumentRepository(db, { nodeState: h.server.schema.nodeState })
  const typeKey = (await new ContentTypeRepository(db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(db).byAlias('page'))?.key as string
  const page = async (name: string, parentKey: string | null) => {
    const doc = await docs.create({
      key: crypto.randomUUID(),
      contentTypeKey: typeKey,
      componentKey,
      parentKey,
      variants: [{ culture: null, segment: null, name }],
      values: [],
    })
    await docs.publish(doc.key, null)
    return doc.key
  }
  const home = await page('Home', null)
  await page('News', home)
  h.server.cache.invalidate()
  const visit = (path: string) =>
    h.server.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual' }))
  return { h, schemaDir, visit }
}

describe('a site that shows the top-level page', () => {
  test('a schema.toml saying so is synced, and its pages answer on the full path', async () => {
    const { h, visit } = await served({ urls: '\n[urls]\nhide-top-level = false\n' })
    expect(await readUrlOptions(h.server.db)).toEqual({ hideTopLevel: false })
    expect((await visit('/home/news/')).status).toBe(200)
    expect((await visit('/')).status).toBe(200)
  })

  test('changing it in Settings writes the file, and the old addresses redirect', async () => {
    const { h, schemaDir, visit } = await served()
    expect((await visit('/news/')).status).toBe(200)
    expect(await h.json<unknown>(SETTING)).toEqual({ hideTopLevel: true, editable: true })

    const saved = await h.put(SETTING, { hideTopLevel: false })
    expect(saved.status).toBe(200)
    expect(readFileSync(join(schemaDir, 'schema.toml'), 'utf8')).toContain('hide-top-level = false')
    expect((await visit('/home/news/')).status).toBe(200)
    const moved = await visit('/news/')
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toContain('/home/news')
  })

  test('a change to the file reaches the database on the next sync, with redirects', async () => {
    const { h, schemaDir, visit } = await served()
    writeFileSync(
      join(schemaDir, 'schema.toml'),
      '[schema]\nversion = "1.0.0"\n\n[urls]\nhide-top-level = false\n',
    )
    expect((await h.post(`${BACKOFFICE}/crombolo/api/schema-import`, {})).status).toBe(200)
    // The development watcher may have applied it first; either way it lands once.
    for (let n = 0; n < 50 && (await visit('/news/')).status !== 301; n++) await Bun.sleep(40)
    expect((await visit('/news/')).status).toBe(301)
    expect((await visit('/home/news/')).status).toBe(200)
  })

  test('where the files are read-only, Settings shows it and refuses the change', async () => {
    const { h } = await served({ writable: false })
    expect(await h.json<unknown>(SETTING)).toEqual({ hideTopLevel: true, editable: false })
    expect((await h.put(SETTING, { hideTopLevel: false })).status).toBe(409)
    expect(await readUrlOptions(h.server.db)).toEqual({ hideTopLevel: true })
  })
})
