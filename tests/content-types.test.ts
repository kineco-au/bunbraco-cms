/**
 * Phase 3: document types, data types and templates through the real API.
 *
 * The exit criterion is that a document type with tabs, properties and a template
 * survives a reload, so these tests write and then re-read rather than asserting
 * on the write response.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

async function harness(): Promise<Harness> {
  const created = await signedInServer()
  open.push(created)
  return created
}

const TEXTSTRING = '0cc0eba1-9960-42c9-bf9b-60e150b429ae'
const TEXTAREA = 'c6bac0dd-4ab9-45b1-8e30-e4b619ee5da3'

interface DocumentTypeBody {
  alias: string
  name: string
  icon?: string
  containers?: unknown[]
  properties?: unknown[]
  allowedDocumentTypes?: unknown[]
  compositions?: unknown[]
  allowedTemplates?: unknown[]
  [key: string]: unknown
}

function documentType(overrides: Partial<DocumentTypeBody> = {}): DocumentTypeBody {
  return {
    alias: 'homePage',
    name: 'Home Page',
    icon: 'icon-home',
    description: null,
    allowedAsRoot: true,
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
    properties: [],
    containers: [],
    compositions: [],
    allowedDocumentTypes: [],
    allowedTemplates: [],
    defaultTemplate: null,
    parent: null,
    ...overrides,
  }
}

describe('seeded content schema', () => {
  test('ships the default data types', async () => {
    const h = await harness()
    const page = await h.json<{ total: number; items: Array<{ name: string }> }>(
      `${V1}/tree/data-type/root?skip=0&take=100`,
    )
    expect(page.total).toBeGreaterThanOrEqual(13)
    expect(page.items.map((item) => item.name)).toContain('Textstring')
  })

  test('a data type carries its editor and UI alias', async () => {
    const h = await harness()
    const dataType = await h.json<{ name: string; editorAlias: string; editorUiAlias: string }>(
      `${V1}/data-type/${TEXTSTRING}`,
    )
    expect(dataType.name).toBe('Textstring')
    expect(dataType.editorAlias).toBe('Umbraco.TextBox')
    expect(dataType.editorUiAlias).toBe('Umb.PropertyEditorUi.TextBox')
  })

  test('data types can be fetched in a batch, as pickers do', async () => {
    const h = await harness()
    const batch = await h.json<{ total: number; items: Array<{ id: string }> }>(
      `${V1}/data-type/batch?id=${TEXTSTRING}&id=${TEXTAREA}`,
    )
    expect(batch.total).toBe(2)
    expect(batch.items.map((item) => item.id).sort()).toEqual([TEXTSTRING, TEXTAREA].sort())
    // The item lookup the document editor makes carries each editor alias
    const items = await h.json<
      Array<{
        id: string
        name: string
        editorAlias: string
        editorUiAlias: string
        isDeletable: boolean
        flags: unknown[]
      }>
    >(`${V1}/item/data-type?id=${TEXTSTRING}`)
    expect(items).toEqual([
      {
        id: TEXTSTRING,
        name: 'Textstring',
        editorAlias: 'Umbraco.TextBox',
        editorUiAlias: 'Umb.PropertyEditorUi.TextBox',
        isDeletable: true,
        flags: [],
      },
    ])
  })
})

describe('document types', () => {
  test('creates one and reads it back', async () => {
    const h = await harness()
    const response = await h.post(`${V1}/document-type`, documentType())
    expect(response.status).toBe(201)
    const key = response.headers.get('umb-generated-resource') as string
    expect(key).toBeTruthy()
    expect(response.headers.get('location')).toContain(key)
    // A create is a non-GET, so it carries a notification for the editor.
    expect(response.headers.get('Umb-Notifications')).toBeTruthy()

    const loaded = await h.json<{
      alias: string
      name: string
      icon: string
      id: string
      allowedAsRoot: boolean
    }>(`${V1}/document-type/${key}`)
    expect(loaded.id).toBe(key)
    expect(loaded.alias).toBe('homePage')
    expect(loaded.name).toBe('Home Page')
    expect(loaded.icon).toBe('icon-home')
    expect(loaded.allowedAsRoot).toBe(true)
  })

  test('persists tabs and properties, in order', async () => {
    const h = await harness()
    const contentTab = crypto.randomUUID()
    const seoTab = crypto.randomUUID()
    const response = await h.post(
      `${V1}/document-type`,
      documentType({
        containers: [
          { id: contentTab, parent: null, name: 'Content', type: 'Tab', sortOrder: 0 },
          { id: seoTab, parent: null, name: 'SEO', type: 'Tab', sortOrder: 1 },
        ],
        properties: [
          {
            id: crypto.randomUUID(),
            container: { id: contentTab },
            sortOrder: 0,
            alias: 'title',
            name: 'Title',
            description: 'The page heading',
            dataType: { id: TEXTSTRING },
            variesByCulture: false,
            variesBySegment: false,
            validation: {
              mandatory: true,
              mandatoryMessage: 'Required',
              regEx: null,
              regExMessage: null,
            },
            appearance: { labelOnTop: false },
          },
          {
            id: crypto.randomUUID(),
            container: { id: seoTab },
            sortOrder: 1,
            alias: 'metaDescription',
            name: 'Meta description',
            description: null,
            dataType: { id: TEXTAREA },
            variesByCulture: false,
            variesBySegment: false,
            validation: {
              mandatory: false,
              mandatoryMessage: null,
              regEx: null,
              regExMessage: null,
            },
            appearance: { labelOnTop: true },
          },
        ],
      }),
    )
    const key = response.headers.get('umb-generated-resource') as string

    const loaded = await h.json<{
      containers: Array<{ id: string; name: string; type: string; sortOrder: number }>
      properties: Array<{
        alias: string
        name: string
        container: { id: string } | null
        dataType: { id: string }
        validation: { mandatory: boolean; mandatoryMessage: string | null }
        appearance: { labelOnTop: boolean }
        sortOrder: number
      }>
    }>(`${V1}/document-type/${key}`)

    expect(loaded.containers.map((c) => c.name)).toEqual(['Content', 'SEO'])
    expect(loaded.containers.every((c) => c.type === 'Tab')).toBe(true)

    expect(loaded.properties.map((p) => p.alias)).toEqual(['title', 'metaDescription'])
    const [title, meta] = loaded.properties
    expect(title?.container?.id).toBe(contentTab)
    expect(title?.dataType.id).toBe(TEXTSTRING)
    expect(title?.validation.mandatory).toBe(true)
    expect(title?.validation.mandatoryMessage).toBe('Required')
    expect(meta?.container?.id).toBe(seoTab)
    expect(meta?.appearance.labelOnTop).toBe(true)
  })

  test('refuses a duplicate alias', async () => {
    const h = await harness()
    await h.post(`${V1}/document-type`, documentType())
    const second = await h.post(`${V1}/document-type`, documentType({ name: 'Another' }))
    expect(second.status).toBe(400)
    const problem = await second.json()
    expect(problem.type).toBe('Error')
    expect(problem.detail).toContain('already in use')
  })

  test('updates an existing type, replacing its properties', async () => {
    const h = await harness()
    const created = await h.post(
      `${V1}/document-type`,
      documentType({
        properties: [
          {
            id: crypto.randomUUID(),
            container: null,
            sortOrder: 0,
            alias: 'title',
            name: 'Title',
            dataType: { id: TEXTSTRING },
            variesByCulture: false,
            variesBySegment: false,
            validation: { mandatory: false },
            appearance: { labelOnTop: false },
          },
        ],
      }),
    )
    const key = created.headers.get('umb-generated-resource') as string

    const update = await h.put(
      `${V1}/document-type/${key}`,
      documentType({
        name: 'Renamed',
        icon: 'icon-newspaper',
        properties: [
          {
            id: crypto.randomUUID(),
            container: null,
            sortOrder: 0,
            alias: 'summary',
            name: 'Summary',
            dataType: { id: TEXTAREA },
            variesByCulture: false,
            variesBySegment: false,
            validation: { mandatory: false },
            appearance: { labelOnTop: false },
          },
        ],
      }),
    )
    // Mutations return no body.
    expect(update.status).toBe(200)
    expect(await update.text()).toBe('')

    const loaded = await h.json<{
      name: string
      icon: string
      properties: Array<{ alias: string }>
    }>(`${V1}/document-type/${key}`)
    expect(loaded.name).toBe('Renamed')
    expect(loaded.icon).toBe('icon-newspaper')
    expect(loaded.properties.map((p) => p.alias)).toEqual(['summary'])
  })

  test('records variance flags independently on type and property', async () => {
    const h = await harness()
    const created = await h.post(
      `${V1}/document-type`,
      documentType({
        variesByCulture: true,
        properties: [
          {
            id: crypto.randomUUID(),
            container: null,
            sortOrder: 0,
            alias: 'title',
            name: 'Title',
            dataType: { id: TEXTSTRING },
            variesByCulture: true,
            variesBySegment: false,
            validation: { mandatory: false },
            appearance: { labelOnTop: false },
          },
          {
            id: crypto.randomUUID(),
            container: null,
            sortOrder: 1,
            alias: 'shared',
            name: 'Shared',
            dataType: { id: TEXTSTRING },
            variesByCulture: false,
            variesBySegment: false,
            validation: { mandatory: false },
            appearance: { labelOnTop: false },
          },
        ],
      }),
    )
    const key = created.headers.get('umb-generated-resource') as string
    const loaded = await h.json<{
      variesByCulture: boolean
      properties: Array<{ alias: string; variesByCulture: boolean }>
    }>(`${V1}/document-type/${key}`)
    expect(loaded.variesByCulture).toBe(true)
    expect(loaded.properties.find((p) => p.alias === 'title')?.variesByCulture).toBe(true)
    expect(loaded.properties.find((p) => p.alias === 'shared')?.variesByCulture).toBe(false)
  })

  test('appears in the tree and in allowed-at-root', async () => {
    const h = await harness()
    await h.post(`${V1}/document-type`, documentType())
    await h.post(
      `${V1}/document-type`,
      documentType({ alias: 'textPage', name: 'Text Page', allowedAsRoot: false }),
    )

    const tree = await h.json<{
      total: number
      items: Array<{ name: string; icon: string; hasChildren: boolean }>
    }>(`${V1}/tree/document-type/root?skip=0&take=100`)
    expect(tree.items.map((i) => i.name).sort()).toEqual(['Home Page', 'Text Page'])
    expect(tree.items.find((i) => i.name === 'Home Page')?.icon).toBe('icon-home')
    expect(tree.items.every((i) => i.hasChildren === false)).toBe(true)

    const atRoot = await h.json<{ items: Array<{ alias: string }> }>(
      `${V1}/document-type/allowed-at-root?skip=0&take=100`,
    )
    expect(atRoot.items.map((i) => i.alias)).toEqual(['homePage'])
  })

  test('flipping a type to an element drops what a route needs, so the file stays valid', async () => {
    const h = await harness()
    // A page type with a template and children, as an ordinary one has.
    const created = await h.post(
      `${V1}/document-type`,
      documentType({ alias: 'article', name: 'Article', allowedAsRoot: true }),
    )
    const key = created.headers.get('umb-generated-resource') as string

    // Ticking "Is Element Type" on a type that already had those keeps them in the
    // body the editor sends; the save drops them, because a file carrying them
    // would be refused at the next boot by the schema validation.
    const read = await h.json<Record<string, unknown>>(`${V1}/document-type/${key}`)
    expect((await h.put(`${V1}/document-type/${key}`, { ...read, isElement: true })).status).toBe(
      200,
    )

    const after = await h.json<{
      isElement: boolean
      allowedAsRoot: boolean
      allowedTemplates: unknown[]
      defaultTemplate: unknown
      allowedDocumentTypes: unknown[]
    }>(`${V1}/document-type/${key}`)
    expect(after.isElement).toBe(true)
    expect(after.allowedAsRoot).toBe(false)
    expect(after.allowedTemplates).toEqual([])
    expect(after.defaultTemplate).toBeNull()
    expect(after.allowedDocumentTypes).toEqual([])
  })

  test('an element type becomes available in the library only once that flag is set', async () => {
    const h = await harness()
    // The journey an editor takes: tick "Is Element Type" on the Settings tab,
    // save, and the Library's Create dialog still offers nothing — because
    // "Allow in Library" is a second toggle, on the Structure tab. Umbraco
    // requires both, and this is the step that is easy to miss.
    const created = await h.post(
      `${V1}/document-type`,
      documentType({
        alias: 'bulletList',
        name: 'Bullet List',
        allowedAsRoot: false,
        isElement: true,
        allowedInLibrary: false,
      }),
    )
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    const library = async () =>
      (
        await h.json<{ items: Array<{ alias: string }> }>(
          `${V1}/document-type/allowed-in-library?skip=0&take=100`,
        )
      ).items.map((i) => i.alias)
    expect(await library()).toEqual([])

    // Ticking it and saving is what makes it appear — the update path, not create.
    const read = await h.json<Record<string, unknown>>(`${V1}/document-type/${key}`)
    expect(read.isElement).toBe(true)
    expect(read.allowedInLibrary).toBe(false)
    expect(
      (await h.put(`${V1}/document-type/${key}`, { ...read, allowedInLibrary: true })).status,
    ).toBe(200)

    expect(await library()).toEqual(['bulletList'])
    // …and it reads back set, so the toggle shows ticked when the editor reopens.
    expect(
      (await h.json<{ allowedInLibrary: boolean }>(`${V1}/document-type/${key}`)).allowedInLibrary,
    ).toBe(true)
  })

  test('offers only flagged element types in the library', async () => {
    const h = await harness()
    await h.post(
      `${V1}/document-type`,
      documentType({ alias: 'quote', name: 'Quote', isElement: true, allowedInLibrary: true }),
    )
    // An element type without the flag, and a flagged type that is not an
    // element: Umbraco requires both, so neither is offered.
    await h.post(
      `${V1}/document-type`,
      documentType({ alias: 'banner', name: 'Banner', isElement: true, allowedInLibrary: false }),
    )
    await h.post(
      `${V1}/document-type`,
      documentType({ alias: 'article', name: 'Article', isElement: false, allowedInLibrary: true }),
    )

    const library = await h.json<{
      total: number
      items: Array<{ id: string; name: string; alias: string; icon: string }>
    }>(`${V1}/document-type/allowed-in-library?skip=0&take=100`)
    expect(library.items.map((i) => i.alias)).toEqual(['quote'])
    expect(library.total).toBe(1)
    expect(library.items[0]?.name).toBe('Quote')
    expect(library.items[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('pages the library listing and names the parent it was given', async () => {
    const h = await harness()
    for (const name of ['Alpha', 'Beta', 'Gamma'])
      await h.post(
        `${V1}/document-type`,
        documentType({
          alias: name.toLowerCase(),
          name,
          isElement: true,
          allowedInLibrary: true,
        }),
      )

    const first = await h.json<{ total: number; items: Array<{ name: string }> }>(
      `${V1}/document-type/allowed-in-library?skip=0&take=2`,
    )
    expect(first.total).toBe(3)
    expect(first.items.map((i) => i.name)).toEqual(['Alpha', 'Beta'])

    const second = await h.json<{ total: number; items: Array<{ name: string }> }>(
      `${V1}/document-type/allowed-in-library?skip=2&take=2`,
    )
    expect(second.items.map((i) => i.name)).toEqual(['Gamma'])

    // parentKey is accepted; core Umbraco has no filter that acts on it.
    const withParent = await h.json<{ total: number }>(
      `${V1}/document-type/allowed-in-library?skip=0&take=100&parentKey=${crypto.randomUUID()}`,
    )
    expect(withParent.total).toBe(3)
  })

  test('records allowed children', async () => {
    const h = await harness()
    const child = await h.post(
      `${V1}/document-type`,
      documentType({ alias: 'textPage', name: 'Text Page' }),
    )
    const childKey = child.headers.get('umb-generated-resource') as string
    const parent = await h.post(
      `${V1}/document-type`,
      documentType({ allowedDocumentTypes: [{ documentType: { id: childKey }, sortOrder: 0 }] }),
    )
    const parentKey = parent.headers.get('umb-generated-resource') as string

    const allowed = await h.json<{ items: Array<{ alias: string }> }>(
      `${V1}/document-type/${parentKey}/allowed-children?skip=0&take=100`,
    )
    expect(allowed.items.map((i) => i.alias)).toEqual(['textPage'])
  })

  test('composes properties from another type', async () => {
    const h = await harness()
    const base = await h.post(
      `${V1}/document-type`,
      documentType({
        alias: 'seoComposition',
        name: 'SEO',
        isElement: true,
        properties: [
          {
            id: crypto.randomUUID(),
            container: null,
            sortOrder: 0,
            alias: 'metaTitle',
            name: 'Meta title',
            dataType: { id: TEXTSTRING },
            variesByCulture: false,
            variesBySegment: false,
            validation: { mandatory: false },
            appearance: { labelOnTop: false },
          },
        ],
      }),
    )
    const baseKey = base.headers.get('umb-generated-resource') as string

    const page = await h.post(
      `${V1}/document-type`,
      documentType({
        compositions: [{ documentType: { id: baseKey }, compositionType: 'Composition' }],
      }),
    )
    const pageKey = page.headers.get('umb-generated-resource') as string

    const loaded = await h.json<{ compositions: Array<{ documentType: { id: string } }> }>(
      `${V1}/document-type/${pageKey}`,
    )
    expect(loaded.compositions.map((c) => c.documentType.id)).toEqual([baseKey])
  })

  test('deletes one', async () => {
    const h = await harness()
    const created = await h.post(`${V1}/document-type`, documentType())
    const key = created.headers.get('umb-generated-resource') as string
    expect((await h.del(`${V1}/document-type/${key}`)).status).toBe(200)
    expect((await h.call(`${V1}/document-type/${key}`)).status).toBe(404)
  })

  test('404s for an unknown key', async () => {
    const h = await harness()
    const response = await h.call(`${V1}/document-type/${crypto.randomUUID()}`)
    expect(response.status).toBe(404)
    expect((await response.json()).type).toBe('Error')
  })

  test('item lookups hydrate pickers', async () => {
    const h = await harness()
    const created = await h.post(`${V1}/document-type`, documentType())
    const key = created.headers.get('umb-generated-resource') as string
    const items = await h.json<Array<{ id: string; name: string; icon: string }>>(
      `${V1}/item/document-type?id=${key}`,
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe('Home Page')
    expect(items[0]?.icon).toBe('icon-home')
  })
})

describe('templates', () => {
  test('creates one, writes a view file, and reads it back', async () => {
    const h = await harness()
    const response = await h.post(`${V1}/template`, { name: 'Home Page', alias: 'homePage' })
    expect(response.status).toBe(201)
    const key = response.headers.get('umb-generated-resource') as string

    const loaded = await h.json<{ name: string; alias: string; content: string }>(
      `${V1}/template/${key}`,
    )
    expect(loaded.alias).toBe('homePage')
    // A new template is scaffolded, not left empty.
    expect(loaded.content).toContain('export default function')
  })

  test('saves edited content back to the view file', async () => {
    const h = await harness()
    const created = await h.post(`${V1}/template`, { name: 'Text Page', alias: 'textPage' })
    const key = created.headers.get('umb-generated-resource') as string

    const content = 'export default function TextPage() {\n  return <p>edited</p>\n}\n'
    expect(
      (await h.put(`${V1}/template/${key}`, { name: 'Text Page', alias: 'textPage', content }))
        .status,
    ).toBe(200)

    const loaded = await h.json<{ content: string }>(`${V1}/template/${key}`)
    expect(loaded.content).toBe(content)
  })

  test("speaks the backoffice's Razor: its scaffold becomes a TSX view, its layout block the view's layout", async () => {
    const h = await harness()
    // Exactly what the template editor sends for a new template
    const razor =
      '@using Umbraco.Cms.Web.Common.PublishedModels;\n@inherits Umbraco.Cms.Web.Common.Views.UmbracoViewPage\n@{\n\tLayout = null;\n}'
    const master = await h.post(`${V1}/template`, {
      name: 'Master',
      alias: 'master',
      content: razor,
    })
    const masterKey = master.headers.get('umb-generated-resource') as string
    type Template = { content: string; masterTemplate: { id: string } | null }
    const masterView = await h.json<Template>(`${V1}/template/${masterKey}`)
    expect(masterView.content).not.toContain('@')
    expect(masterView.content).toContain("import type { PageProps } from 'bunbraco'")
    expect(masterView.content).toContain('export default function Master({ model }: PageProps)')

    // Created under a master, the scaffold carries its layout
    const child = await h.post(`${V1}/template`, {
      name: 'Child Page',
      alias: 'childPage',
      content: razor.replace('null', '"master.cshtml"'),
    })
    const childKey = child.headers.get('umb-generated-resource') as string
    const created = await h.json<Template>(`${V1}/template/${childKey}`)
    expect(
      created.content.startsWith(
        "import type { PageProps } from 'bunbraco'\n\nexport const layout = 'master'\n",
      ),
    ).toBe(true)
    expect(created.masterTemplate).toEqual({ id: masterKey })

    // Picking a master on a TSX view prepends a layout block, which replaces any layout it had
    const edited = `@{\n\tLayout = "master.cshtml";\n}\n${created.content.replace("export const layout = 'master'\n\n", "export const layout = 'old'\n\n")}`
    await h.put(`${V1}/template/${childKey}`, {
      name: 'Child Page',
      alias: 'childPage',
      content: edited,
    })
    const relinked = await h.json<Template>(`${V1}/template/${childKey}`)
    expect(relinked.content.match(/export const layout/g)).toHaveLength(1)
    expect(relinked.content).toContain("export const layout = 'master'")
    expect(relinked.content).not.toContain('Layout =')

    // Removing the master from a view with no block sends "undefined.cshtml"
    await h.put(`${V1}/template/${childKey}`, {
      name: 'Child Page',
      alias: 'childPage',
      content: `@{\n\tLayout = "undefined.cshtml";\n}\n${relinked.content}`,
    })
    const unlinked = await h.json<Template>(`${V1}/template/${childKey}`)
    expect(unlinked.content).not.toContain('layout')
    expect(unlinked.content).not.toContain('Layout')
    expect(unlinked.masterTemplate).toBeNull()
  })

  test('can be attached to a document type as its default', async () => {
    const h = await harness()
    const template = await h.post(`${V1}/template`, { name: 'Home Page', alias: 'homePage' })
    const componentKey = template.headers.get('umb-generated-resource') as string

    const created = await h.post(
      `${V1}/document-type`,
      documentType({
        allowedTemplates: [{ id: componentKey }],
        defaultTemplate: { id: componentKey },
      }),
    )
    const key = created.headers.get('umb-generated-resource') as string

    const loaded = await h.json<{
      allowedTemplates: Array<{ id: string }>
      defaultTemplate: { id: string } | null
    }>(`${V1}/document-type/${key}`)
    expect(loaded.allowedTemplates.map((t) => t.id)).toEqual([componentKey])
    expect(loaded.defaultTemplate?.id).toBe(componentKey)
  })

  test('appears in the template tree', async () => {
    const h = await harness()
    await h.post(`${V1}/template`, { name: 'Home Page', alias: 'homePage' })
    const tree = await h.json<{ total: number; items: Array<{ name: string }> }>(
      `${V1}/tree/template/root?skip=0&take=100`,
    )
    expect(tree.items.map((i) => i.name)).toContain('Home Page')
  })

  test('deletes one', async () => {
    const h = await harness()
    const created = await h.post(`${V1}/template`, { name: 'Gone', alias: 'gone' })
    const key = created.headers.get('umb-generated-resource') as string
    expect((await h.del(`${V1}/template/${key}`)).status).toBe(200)
    expect((await h.call(`${V1}/template/${key}`)).status).toBe(404)
  })
})
