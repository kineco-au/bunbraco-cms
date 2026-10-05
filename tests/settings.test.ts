/**
 * WP-6.2: the Settings section end to end — what the document-type, data-type
 * and template workspaces call, folders that live in the files, the editor
 * picker, languages, and every tree the section renders answering.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEMBER_TYPE } from '@bunbraco/data'
import { parseDataType, parseDocumentType } from '@bunbraco/schema'
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

const TEXTSTRING = '0cc0eba1-9960-42c9-bf9b-60e150b429ae'

/** A site directory the backoffice may write to. */
async function site(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'settings-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'schema', 'data-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  return { h, root, schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') }
}

function property(alias: string, name: string, dataTypeId: string, sortOrder = 0) {
  return {
    id: crypto.randomUUID(),
    container: null,
    sortOrder,
    alias,
    name,
    description: null,
    dataType: { id: dataTypeId },
    variesByCulture: false,
    variesBySegment: false,
    validation: { mandatory: false, mandatoryMessage: null, regEx: null, regExMessage: null },
    appearance: { labelOnTop: false },
  }
}

function documentType(alias: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    name: alias.charAt(0).toUpperCase() + alias.slice(1),
    icon: 'icon-document',
    description: null,
    allowedAsRoot: false,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collection: null,
    cleanup: {
      preventCleanup: false,
      keepAllVersionsNewerThanDays: null,
      keepLatestVersionPerDayForDays: null,
    },
    properties: [] as unknown[],
    containers: [],
    compositions: [] as unknown[],
    allowedDocumentTypes: [] as unknown[],
    allowedTemplates: [],
    defaultTemplate: null,
    parent: null as { id: string } | null,
    ...overrides,
  }
}

async function createType(h: Harness, body: Record<string, unknown>): Promise<string> {
  const response = await h.post(`${V1}/document-type`, body)
  if (response.status !== 201)
    throw new Error(`document type: ${response.status} ${await response.text()}`)
  return response.headers.get('umb-generated-resource') as string
}

describe('WP-6.2 document types', () => {
  test('configuration, batch, search, allowed parents and composition references', async () => {
    const { h } = await site()
    const configuration = await h.json<{
      dataTypesCanBeChanged: string
      reservedFieldNames: string[]
    }>(`${V1}/document-type/configuration`)
    expect(configuration.dataTypesCanBeChanged).toBe('True')
    expect(configuration.reservedFieldNames).toContain('name')

    const seo = await createType(
      h,
      documentType('seoFields', {
        isElement: true,
        properties: [property('metaTitle', 'Meta title', TEXTSTRING)],
      }),
    )
    const page = await createType(
      h,
      documentType('textPage', {
        compositions: [{ documentType: { id: seo }, compositionType: 'Composition' }],
      }),
    )
    const home = await createType(
      h,
      documentType('homePage', {
        allowedAsRoot: true,
        allowedDocumentTypes: [{ documentType: { id: page }, sortOrder: 0 }],
      }),
    )

    const batch = await h.json<{ total: number; items: Array<{ id: string }> }>(
      `${V1}/document-type/batch?id=${seo}&id=${home}`,
    )
    expect(batch.items.map((i) => i.id).sort()).toEqual([seo, home].sort())

    const search = await h.json<{
      total: number
      items: Array<{ id: string; name: string; isElement: boolean }>
    }>(`${V1}/item/document-type/search?query=page&skip=0&take=10`)
    expect(search.items.map((i) => i.name).sort()).toEqual(['HomePage', 'TextPage'])
    const elements = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/item/document-type/search?query=&isElement=true&skip=0&take=10`,
    )
    expect(elements.items.map((i) => i.id)).toEqual([seo])

    expect(
      await h.json<Record<string, unknown>>(`${V1}/document-type/${page}/allowed-parents`),
    ).toEqual({
      allowedParentIds: [{ id: home }],
    })
    const refs = await h.json<Array<{ id: string; name: string }>>(
      `${V1}/document-type/${seo}/composition-references`,
    )
    expect(refs.map((r) => r.id)).toEqual([page])
  })

  test('available compositions follow the rules and flag clashes', async () => {
    const { h } = await site()
    const seo = await createType(
      h,
      documentType('seoFields', {
        isElement: true,
        properties: [property('metaTitle', 'Meta title', TEXTSTRING)],
      }),
    )
    const nav = await createType(
      h,
      documentType('navFields', {
        isElement: true,
        properties: [property('title', 'Title', TEXTSTRING)],
      }),
    )
    const page = await createType(
      h,
      documentType('textPage', {
        compositions: [{ documentType: { id: seo }, compositionType: 'Composition' }],
      }),
    )
    const plain = await createType(h, documentType('plainPage'))

    const forPage = await h.json<
      Array<{ id: string; isCompatible: boolean; folderPath: string[] }>
    >(`${V1}/document-type/available-compositions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: page,
        isElement: false,
        currentPropertyAliases: ['title'],
        currentCompositeIds: [seo],
      }),
    })
    // itself never; the type that composes it never (none here); types with compositions never
    expect(forPage.map((c) => c.id).sort()).toEqual([nav, plain, seo].sort())
    expect(forPage.find((c) => c.id === nav)?.isCompatible).toBe(false)
    expect(forPage.find((c) => c.id === seo)?.isCompatible).toBe(true)
    // seo may not compose the page that composes it, and an element type sees only element types
    const forSeo = await h.json<Array<{ id: string }>>(
      `${V1}/document-type/available-compositions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: seo,
          isElement: true,
          currentPropertyAliases: [],
          currentCompositeIds: [],
        }),
      },
    )
    expect(forSeo.map((c) => c.id)).toEqual([nav])
  })

  test('folders: tree, siblings, move, rename, refuse to delete when full, and the files say where a type lives', async () => {
    const { h, schemaDir } = await site()
    const folder = await h.post(`${V1}/document-type/folder`, { name: 'Pages', parent: null })
    expect(folder.status).toBe(201)
    const folderKey = folder.headers.get('umb-generated-resource') as string
    const sub = await h.post(`${V1}/document-type/folder`, {
      name: 'Blog',
      parent: { id: folderKey },
    })
    const subKey = sub.headers.get('umb-generated-resource') as string
    expect(await h.json<Record<string, unknown>>(`${V1}/document-type/folder/${subKey}`)).toEqual({
      id: subKey,
      name: 'Blog',
      isTrashed: false,
    })

    const post = await createType(h, documentType('blogPost', { parent: { id: subKey } }))
    const other = await createType(h, documentType('other'))

    const root = await h.json<{
      items: Array<{ id: string; isFolder: boolean; hasChildren: boolean }>
    }>(`${V1}/tree/document-type/root?skip=0&take=10`)
    expect(root.items.map((i) => [i.isFolder, i.hasChildren])).toEqual([
      [true, true],
      [false, false],
    ])
    const onlyFolders = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/tree/document-type/root?skip=0&take=10&foldersOnly=true`,
    )
    expect(onlyFolders.items.map((i) => i.id)).toEqual([folderKey])
    const inBlog = await h.json<{ items: Array<{ id: string; parent: { id: string } }> }>(
      `${V1}/tree/document-type/children?parentId=${subKey}&skip=0&take=10`,
    )
    expect(inBlog.items.map((i) => [i.id, i.parent.id])).toEqual([[post, subKey]])
    const ancestors = await h.json<Array<{ id: string }>>(
      `${V1}/tree/document-type/ancestors?descendantId=${post}`,
    )
    expect(ancestors.map((a) => a.id)).toEqual([folderKey, subKey])
    const siblings = await h.json<{ items: Array<{ id: string }>; totalBefore: number }>(
      `${V1}/tree/document-type/siblings?target=${other}&before=5&after=5`,
    )
    expect(siblings.items.map((i) => i.id)).toEqual([folderKey, other])

    // The file carries the folder path, and the composition picker shows it
    const file = parseDocumentType(
      'blog-post',
      readFileSync(join(schemaDir, 'document-types', 'blog-post.toml'), 'utf8'),
    )
    expect(file.value?.folder).toBe('Pages/Blog')
    const available = await h.json<Array<{ id: string; folderPath: string[] }>>(
      `${V1}/document-type/available-compositions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: other,
          isElement: false,
          currentPropertyAliases: [],
          currentCompositeIds: [],
        }),
      },
    )
    expect(available.find((a) => a.id === post)?.folderPath).toEqual(['Pages', 'Blog'])

    // Rename the folder: the file follows
    expect((await h.put(`${V1}/document-type/folder/${subKey}`, { name: 'Articles' })).status).toBe(
      200,
    )
    expect(
      parseDocumentType(
        'x',
        readFileSync(join(schemaDir, 'document-types', 'blog-post.toml'), 'utf8'),
      ).value?.folder,
    ).toBe('Pages/Articles')
    // Move the type to the root: the key goes away
    expect((await h.put(`${V1}/document-type/${post}/move`, { target: null })).status).toBe(200)
    expect(
      parseDocumentType(
        'x',
        readFileSync(join(schemaDir, 'document-types', 'blog-post.toml'), 'utf8'),
      ).value?.folder,
    ).toBeUndefined()
    // A folder with something in it refuses to go; empty, it goes
    expect((await h.del(`${V1}/document-type/folder/${folderKey}`)).status).toBe(400)
    expect((await h.del(`${V1}/document-type/folder/${subKey}`)).status).toBe(200)
    expect((await h.del(`${V1}/document-type/folder/${folderKey}`)).status).toBe(200)
  })

  test('a folder in the file is created by the sync', async () => {
    const { h } = await site({
      'schema/document-types/news.toml':
        '[document-type]\nkey = "0b1c8e3a-5555-4a5b-9c1d-000000000001"\nalias = "news"\nname = "News"\nfolder = "Content/Editorial"\n\n[[property]]\nkey = "0b1c8e3a-5555-4a5b-9c1d-000000000002"\nalias = "title"\nname = "Title"\ntype = "textstring"\n',
    })
    const root = await h.json<{ items: Array<{ name: string; isFolder: boolean }> }>(
      `${V1}/tree/document-type/root?skip=0&take=10`,
    )
    expect(root.items).toMatchObject([{ name: 'Content', isFolder: true }])
    const ancestors = await h.json<Array<{ name: string }>>(
      `${V1}/tree/document-type/ancestors?descendantId=0b1c8e3a-5555-4a5b-9c1d-000000000001`,
    )
    expect(ancestors.map((a) => a.name)).toEqual(['Content', 'Editorial'])
  })

  test('copy, and "create template" writes the view and attaches it', async () => {
    const { h, componentsDir, schemaDir } = await site()
    const key = await createType(
      h,
      documentType('article', { properties: [property('title', 'Title', TEXTSTRING)] }),
    )
    const copied = await h.post(`${V1}/document-type/${key}/copy`, { target: null })
    expect(copied.status).toBe(201)
    const copyKey = copied.headers.get('umb-generated-resource') as string
    const copy = await h.json<{
      alias: string
      name: string
      properties: Array<{ id: string; alias: string }>
    }>(`${V1}/document-type/${copyKey}`)
    expect(copy).toMatchObject({ alias: 'articleCopy', name: 'Article (copy)' })
    expect(copy.properties[0]?.alias).toBe('title')
    expect(existsSync(join(schemaDir, 'document-types', 'article-copy.toml'))).toBe(true)

    const template = await h.post(`${V1}/document-type/${key}/template`, {
      alias: 'article',
      name: 'Article',
      isDefault: true,
    })
    expect(template.status).toBe(201)
    const componentKey = template.headers.get('umb-generated-resource') as string
    expect(readFileSync(join(componentsDir, 'article.tsx'), 'utf8')).toContain(
      'export default function Article',
    )
    const type = await h.json<{
      allowedTemplates: Array<{ id: string }>
      defaultTemplate: { id: string } | null
    }>(`${V1}/document-type/${key}`)
    expect(type.allowedTemplates).toEqual([{ id: componentKey }])
    expect(type.defaultTemplate).toEqual({ id: componentKey })
    expect(readFileSync(join(schemaDir, 'document-types', 'article.toml'), 'utf8')).toContain(
      'components = ["article"]',
    )
  })
})

describe('WP-6.2 data types', () => {
  test('the editor picker filters, search finds, references list, and a saved data type becomes a file', async () => {
    const { h, schemaDir } = await site()
    const byUi = await h.json<{
      total: number
      items: Array<{ name: string; editorAlias: string; isDeletable: boolean }>
    }>(`${V1}/filter/data-type?editorUiAlias=Umb.PropertyEditorUi.TextBox&skip=0&take=10`)
    expect(byUi.items.map((i) => i.name)).toEqual(['Textstring'])
    const byName = await h.json<{ items: Array<{ name: string }> }>(
      `${V1}/filter/data-type?name=date&skip=0&take=10`,
    )
    expect(byName.items.map((i) => i.name).sort()).toEqual([
      'Date Picker',
      'Date Picker with time',
      'Date Time Picker (with time zone)',
      'Label (datetime)',
    ])
    const search = await h.json<{ items: Array<{ name: string }> }>(
      `${V1}/item/data-type/search?query=text&skip=0&take=10`,
    )
    expect(search.items.map((i) => i.name).sort()).toEqual([
      'Richtext editor',
      'Textarea',
      'Textstring',
    ])
    expect(await h.json<Record<string, unknown>>(`${V1}/data-type/configuration`)).toMatchObject({
      canBeChanged: 'True',
    })

    const created = await h.post(`${V1}/data-type`, {
      name: 'Big Text',
      editorAlias: 'Umbraco.TextArea',
      editorUiAlias: 'Umb.PropertyEditorUi.TextArea',
      values: [{ alias: 'maxChars', value: 500 }],
      parent: null,
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    const file = join(schemaDir, 'data-types', 'big-text.toml')
    expect(existsSync(file)).toBe(true)
    const parsed = parseDataType('big-text', readFileSync(file, 'utf8'))
    expect(parsed.value).toMatchObject({
      key,
      alias: 'bigText',
      name: 'Big Text',
      editor: 'Umbraco.TextArea',
      config: { maxChars: 500 },
    })

    const typeKey = await createType(
      h,
      documentType('article', { properties: [property('body', 'Body', key)] }),
    )
    const refs = await h.json<{
      total: number
      items: Array<{ $type: string; alias: string; documentType: { id: string; alias: string } }>
    }>(`${V1}/data-type/${key}/referenced-by?skip=0&take=10`)
    expect(refs.total).toBe(1)
    expect(refs.items[0]).toMatchObject({
      $type: 'DocumentTypePropertyTypeReferenceResponseModel',
      alias: 'body',
      documentType: { id: typeKey, alias: 'article' },
    })

    // A built-in only gets a file once it is changed
    expect(existsSync(join(schemaDir, 'data-types', 'textstring.toml'))).toBe(false)
    await h.put(`${V1}/data-type/${TEXTSTRING}`, {
      name: 'Textstring',
      editorAlias: 'Umbraco.TextBox',
      editorUiAlias: 'Umb.PropertyEditorUi.TextBox',
      values: [{ alias: 'maxChars', value: 80 }],
    })
    expect(existsSync(join(schemaDir, 'data-types', 'textstring.toml'))).toBe(true)

    // Delete removes the file
    expect((await h.del(`${V1}/data-type/${key}`)).status).toBe(400)
    await h.del(`${V1}/document-type/${typeKey}`)
    expect((await h.del(`${V1}/data-type/${key}`)).status).toBe(200)
    expect(existsSync(file)).toBe(false)
  })

  test('folders, copy and move for data types', async () => {
    const { h, schemaDir } = await site()
    const folder = await h.post(`${V1}/data-type/folder`, { name: 'Custom', parent: null })
    const folderKey = folder.headers.get('umb-generated-resource') as string
    const created = await h.post(`${V1}/data-type`, {
      name: 'Short Text',
      editorAlias: 'Umbraco.TextBox',
      editorUiAlias: 'Umb.PropertyEditorUi.TextBox',
      values: [],
      parent: { id: folderKey },
    })
    const key = created.headers.get('umb-generated-resource') as string
    expect(
      parseDataType('x', readFileSync(join(schemaDir, 'data-types', 'short-text.toml'), 'utf8'))
        .value?.folder,
    ).toBe('Custom')

    const children = await h.json<{
      items: Array<{ id: string; isFolder: boolean; editorUiAlias: string | null }>
    }>(`${V1}/tree/data-type/children?parentId=${folderKey}&skip=0&take=10`)
    expect(children.items).toMatchObject([
      { id: key, isFolder: false, editorUiAlias: 'Umb.PropertyEditorUi.TextBox' },
    ])
    const ancestors = await h.json<Array<{ id: string }>>(
      `${V1}/tree/data-type/ancestors?descendantId=${key}`,
    )
    expect(ancestors.map((a) => a.id)).toEqual([folderKey])
    const siblings = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/tree/data-type/siblings?target=${key}&before=1&after=1`,
    )
    expect(siblings.items.map((i) => i.id)).toEqual([key])

    const copied = await h.post(`${V1}/data-type/${key}/copy`, { target: null })
    expect(copied.status).toBe(201)
    const copyKey = copied.headers.get('umb-generated-resource') as string
    expect((await h.json<{ name: string }>(`${V1}/data-type/${copyKey}`)).name).toBe(
      'Short Text (copy)',
    )
    expect(existsSync(join(schemaDir, 'data-types', 'short-text-copy.toml'))).toBe(true)

    expect((await h.put(`${V1}/data-type/${key}/move`, { target: null })).status).toBe(200)
    expect(
      parseDataType('x', readFileSync(join(schemaDir, 'data-types', 'short-text.toml'), 'utf8'))
        .value?.folder,
    ).toBeUndefined()
    expect((await h.del(`${V1}/data-type/folder/${folderKey}`)).status).toBe(200)
  })
})

describe('WP-6.2 templates and languages', () => {
  test('the template tree hangs children under the layout their view names', async () => {
    const { h } = await site()
    const layout = await h.post(`${V1}/template`, {
      name: 'Site Layout',
      alias: 'siteLayout',
      content: 'export default function L({ children }) { return <html>{children}</html> }\n',
    })
    const layoutKey = layout.headers.get('umb-generated-resource') as string
    const page = await h.post(`${V1}/template`, {
      name: 'Page',
      alias: 'page',
      content: "export const layout = 'siteLayout'\nexport default function P() { return <p /> }\n",
    })
    const pageKey = page.headers.get('umb-generated-resource') as string
    const loose = await h.post(`${V1}/template`, {
      name: 'Loose',
      alias: 'loose',
      content: 'export default function X() { return <p /> }\n',
    })
    const looseKey = loose.headers.get('umb-generated-resource') as string

    const root = await h.json<{ items: Array<{ id: string; hasChildren: boolean }> }>(
      `${V1}/tree/template/root?skip=0&take=10`,
    )
    expect(root.items.map((i) => [i.id, i.hasChildren])).toEqual([
      [layoutKey, true],
      [looseKey, false],
    ])
    const children = await h.json<{ items: Array<{ id: string; parent: { id: string } }> }>(
      `${V1}/tree/template/children?parentId=${layoutKey}&skip=0&take=10`,
    )
    expect(children.items.map((i) => [i.id, i.parent.id])).toEqual([[pageKey, layoutKey]])
    expect(
      (
        await h.json<Array<{ id: string }>>(`${V1}/tree/template/ancestors?descendantId=${pageKey}`)
      ).map((a) => a.id),
    ).toEqual([layoutKey])
    const siblings = await h.json<{ items: Array<{ id: string }>; totalAfter: number }>(
      `${V1}/tree/template/siblings?target=${layoutKey}&before=0&after=1`,
    )
    expect(siblings.items.map((i) => i.id)).toEqual([layoutKey, looseKey])
    const read = await h.json<{
      layoutTemplate: { id: string } | null
      masterTemplate: { id: string } | null
    }>(`${V1}/template/${pageKey}`)
    expect([read.layoutTemplate, read.masterTemplate]).toEqual([
      { id: layoutKey },
      { id: layoutKey },
    ])
    const search = await h.json<{ items: Array<{ alias: string }> }>(
      `${V1}/item/template/search?query=lay&skip=0&take=10`,
    )
    expect(search.items.map((i) => i.alias)).toEqual(['siteLayout'])
    // The template editor writes the master's alias into the view it is editing
    expect(await h.json<unknown>(`${V1}/item/template?id=${layoutKey}`)).toEqual<unknown>([
      { id: layoutKey, name: 'Site Layout', alias: 'siteLayout', flags: [] },
    ])
  })

  test('languages: create, read, update, delete, and the file follows', async () => {
    const { h, schemaDir } = await site()
    const created = await h.post(`${V1}/language`, {
      isoCode: 'da-DK',
      name: 'Danish',
      isDefault: false,
      isMandatory: false,
      fallbackIsoCode: 'en-US',
    })
    expect(created.status).toBe(201)
    expect(
      (
        await h.post(`${V1}/language`, {
          isoCode: 'da-DK',
          name: 'Danish',
          isDefault: false,
          isMandatory: false,
        })
      ).status,
    ).toBe(400)
    expect(await h.json<Record<string, unknown>>(`${V1}/language/da-DK`)).toEqual({
      isoCode: 'da-DK',
      name: 'Danish',
      isDefault: false,
      isMandatory: false,
      fallbackIsoCode: 'en-US',
    })
    const items = await h.json<Array<{ isoCode: string; name: string }>>(
      `${V1}/item/language?isoCode=da-DK`,
    )
    expect(items).toEqual([{ isoCode: 'da-DK', name: 'Danish' }])
    expect(readFileSync(join(schemaDir, 'languages.toml'), 'utf8')).toContain('iso = "da-DK"')

    // Making it the default unmakes the old one
    expect(
      (
        await h.put(`${V1}/language/da-DK`, {
          name: 'Dansk',
          isDefault: true,
          isMandatory: true,
          fallbackIsoCode: null,
        })
      ).status,
    ).toBe(200)
    const all = await h.json<{
      items: Array<{ isoCode: string; isDefault: boolean; name: string }>
    }>(`${V1}/language`)
    expect(all.items.filter((l) => l.isDefault).map((l) => l.isoCode)).toEqual(['da-DK'])
    expect((await h.json<{ isoCode: string }>(`${V1}/item/language/default`)).isoCode).toBe('da-DK')
    // The default cannot go; a non-default can
    expect((await h.del(`${V1}/language/da-DK`)).status).toBe(400)
    expect((await h.del(`${V1}/language/en-US`)).status).toBe(200)
    expect((await h.call(`${V1}/language/en-US`)).status).toBe(404)
    expect(readFileSync(join(schemaDir, 'languages.toml'), 'utf8')).not.toContain('en-US')
  })

  test('tree search finds folders and items, filtered by itemKind', async () => {
    const { h } = await site()
    const folder = await h.post(`${V1}/document-type/folder`, { name: 'Page types', parent: null })
    const folderKey = folder.headers.get('umb-generated-resource') as string
    const typeKey = await createType(h, documentType('landingPage', { parent: { id: folderKey } }))
    const all = await h.json<{ total: number; items: Array<{ id: string; isFolder: boolean }> }>(
      `${V1}/tree/document-type/search?query=page&skip=0&take=10`,
    )
    expect(all.items.map((i) => [i.id, i.isFolder])).toEqual([
      [folderKey, true],
      [typeKey, false],
    ])
    const items = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/tree/document-type/search?query=page&itemKind=Item&skip=0&take=10`,
    )
    expect(items.items.map((i) => i.id)).toEqual([typeKey])
    const folders = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/tree/document-type/search?query=page&itemKind=Folder&skip=0&take=10`,
    )
    expect(folders.items.map((i) => i.id)).toEqual([folderKey])
    const dataTypes = await h.json<{
      items: Array<{ name: string; editorUiAlias: string | null }>
    }>(`${V1}/tree/data-type/search?query=textstring&skip=0&take=10`)
    expect(dataTypes.items).toMatchObject([
      { name: 'Textstring', editorUiAlias: 'Umb.PropertyEditorUi.TextBox' },
    ])
  })

  test('every tree the Settings section renders answers, including expansion and deep links', async () => {
    const { h } = await site()
    const id = crypto.randomUUID()
    const paged = [
      `tree/member-type/children?parentId=${id}&`,
      'tree/partial-view/root',
      'tree/partial-view/children?parentPath=a&',
      'tree/script/root',
      'tree/script/children?parentPath=a&',
      'tree/stylesheet/root',
      'tree/stylesheet/children?parentPath=a&',
      'tree/dictionary/root',
      `tree/dictionary/children?parentId=${id}&`,
      'tree/document-blueprint/root',
      `tree/document-blueprint/children?parentId=${id}&`,
      'tree/media/root',
      `tree/media/children?parentId=${id}&`,
      'tree/element/root',
      'recycle-bin/media/root',
      'recycle-bin/element/root',
      'recycle-bin/document/referenced-by',
      `document-type/${id}/blueprint`,
      'tree/member-group/root',
      'tree/static-file/root',
      'dictionary',
      'relation-type',
      'webhook',
    ]
    for (const path of paged) {
      const url = `${V1}/${path}${path.endsWith('&') ? '' : '?'}skip=0&take=10`
      const response = await h.call(url)
      expect([path, response.status]).toEqual([path, 200])
      expect(await response.json()).toEqual({ total: 0, items: [] })
    }
    // The member-type tree is never empty: the framework's own "Member" type is there.
    const memberTypes = await h.json<{ total: number; items: Array<{ id: string; name: string }> }>(
      `${V1}/tree/member-type/root?skip=0&take=10`,
    )
    expect(memberTypes.total).toBe(1)
    expect(memberTypes.items[0]).toMatchObject({ id: SYSTEM_MEMBER_TYPE.key, name: 'Member' })
    for (const path of [
      `tree/media-type/ancestors?descendantId=${id}`,
      `tree/member-type/ancestors?descendantId=${id}`,
      `tree/dictionary/ancestors?descendantId=${id}`,
      `tree/document-blueprint/ancestors?descendantId=${id}`,
      `tree/media/ancestors?descendantId=${id}`,
      `tree/element/ancestors?descendantId=${id}`,
      'tree/static-file/ancestors?descendantPath=a',
      'tree/partial-view/ancestors?descendantPath=a',
      'tree/script/ancestors?descendantPath=a',
      'tree/stylesheet/ancestors?descendantPath=a',
    ]) {
      const response = await h.call(`${V1}/${path}`)
      expect([path, response.status]).toEqual([path, 200])
      expect(await response.json()).toEqual([])
    }
    // Blueprint and media siblings are real since WP-6.5 and 6.4
    for (const path of [
      'tree/partial-view/siblings?path=a',
      'tree/script/siblings?path=a',
      'tree/stylesheet/siblings?path=a',
    ]) {
      const response = await h.call(`${V1}/${path}&before=1&after=1`)
      expect([path, response.status]).toEqual([path, 200])
      expect(await response.json()).toEqual({ totalBefore: 0, totalAfter: 0, items: [] })
    }
    // An empty bin has nothing whose original parent could be asked for
    expect((await h.call(`${V1}/recycle-bin/media/${id}/original-parent`)).status).toBe(404)
    // The editor reads the upload settings before it offers a file picker
    expect(await h.json<Record<string, unknown>>(`${V1}/temporary-file/configuration`)).toEqual({
      imageFileTypes: ['jpeg', 'jpg', 'gif', 'bmp', 'png', 'tiff', 'tif', 'webp'],
      disallowedUploadedFilesExtensions: expect.arrayContaining(['aspx', 'config']),
      allowedUploadedFileExtensions: [],
      maxFileSize: null,
    })
    // The Content section's welcome dashboard: no feed, so no items
    expect(await h.json<{ items: unknown[] }>(`${V1}/news-dashboard`)).toEqual({ items: [] })
  })
})
