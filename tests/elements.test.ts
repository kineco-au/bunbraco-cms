/**
 * The Library section: Umbraco 18's Elements.
 *
 * An element is publishable, versioned content with no URL — so these cover the
 * document journey without the parts a route needs: create, save, publish and
 * unpublish, validation, copy and move, the recycle bin, versions and rollback,
 * the tree that mixes folders with elements, and what the create dialog reads to
 * decide which types it may offer.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComponentRepository, ContentTypeRepository } from '@bunbraco/data'
import { generateTypes, loadSchemaDirectory, validateSchemaSet } from '@bunbraco/schema'
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

/** An element type: a document type carrying `is-element` and `allow-in-library`. */
const QUOTE_TOML = `[document-type]
alias = "quote"
name = "Quote"
icon = "icon-quote"
is-element = true
allow-in-library = true

[[property]]
alias = "body"
name = "Body"
type = "textstring"
mandatory = true
`

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'elements-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'quote.toml'), QUOTE_TOML)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('quote'))?.key as string

  const body = (name: string, text: string) => ({
    documentType: { id: typeKey },
    values: [{ alias: 'body', culture: null, segment: null, value: text }],
    variants: [{ culture: null, segment: null, name }],
  })

  const create = async (name: string, text = 'Hello', parent: string | null = null) => {
    const response = await h.post(`${V1}/element`, {
      ...body(name, text),
      parent: parent ? { id: parent } : null,
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  const folder = async (name: string, parent: string | null = null) => {
    const response = await h.post(`${V1}/element/folder`, {
      name,
      parent: parent ? { id: parent } : null,
    })
    if (response.status !== 201)
      throw new Error(`folder ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  const state = async (key: string) =>
    (await h.json<{ variants: Array<{ state: string }> }>(`${V1}/element/${key}`)).variants[0]
      ?.state
  const tree = (parent?: string) =>
    h.json<{
      total: number
      items: Array<{ id: string; name: string; isFolder: boolean; documentType: unknown }>
    }>(
      parent
        ? `${V1}/tree/element/children?parentId=${parent}&skip=0&take=100`
        : `${V1}/tree/element/root?skip=0&take=100`,
    )

  return { h, typeKey, body, create, folder, state, tree }
}

describe('the Library tree', () => {
  test('offers the element types the create dialog asks for, and only those', async () => {
    const { h, typeKey } = await site()
    // This is the call the Library's create dialog makes.
    const allowed = await h.json<{ total: number; items: Array<{ id: string; name: string }> }>(
      `${V1}/document-type/allowed-in-library?skip=0&take=100`,
    )
    expect(allowed.items.map((i) => i.id)).toEqual([typeKey])
  })

  test('mixes folders and elements, and a folder reports no type and no content', async () => {
    const { create, folder, tree } = await site()
    const box = await folder('Quotes')
    const inside = await create('Inside', 'In a folder', box)
    const loose = await create('Loose')

    const root = await tree()
    expect(root.total).toBe(2)
    const folderRow = root.items.find((i) => i.isFolder)
    const elementRow = root.items.find((i) => !i.isFolder)
    expect(folderRow?.name).toBe('Quotes')
    // The contract makes `documentType` nullable precisely for this row.
    expect(folderRow?.documentType).toBeNull()
    expect(elementRow?.id).toBe(loose)
    expect(elementRow?.documentType).toMatchObject({ icon: 'icon-quote' })

    const children = await tree(box)
    expect(children.items.map((i) => i.id)).toEqual([inside])
    expect(children.items[0]?.isFolder).toBe(false)
  })

  test('answers ancestors, siblings and the item lookups a picker makes', async () => {
    const { h, create, folder } = await site()
    const box = await folder('Quotes')
    const one = await create('One', 'a', box)
    const two = await create('Two', 'b', box)

    const ancestors = await h.json<Array<{ id: string; isFolder: boolean }>>(
      `${V1}/tree/element/ancestors?descendantId=${one}`,
    )
    expect(ancestors.map((a) => a.id)).toEqual([box])
    expect(ancestors[0]?.isFolder).toBe(true)

    const siblings = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/tree/element/siblings?target=${one}&before=1&after=1`,
    )
    expect(siblings.items.map((i) => i.id)).toContain(two)

    const items = await h.json<Array<{ id: string; variants: Array<{ name: string }> }>>(
      `${V1}/item/element?id=${one}&id=${two}`,
    )
    expect(items.map((i) => i.variants[0]?.name)).toEqual(['One', 'Two'])

    const folders = await h.json<Array<{ id: string }>>(`${V1}/item/element/folder?id=${box}`)
    expect(folders.map((f) => f.id)).toEqual([box])

    const found = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/item/element/search?query=Two&skip=0&take=10`,
    )
    expect(found.items.map((i) => i.id)).toEqual([two])
  })
})

describe('the element editor', () => {
  test('creates, reads back, saves and reports its configuration', async () => {
    const { h, create, body } = await site()
    expect(await h.json<Record<string, boolean>>(`${V1}/element/configuration`)).toEqual({
      disableDeleteWhenReferenced: false,
      disableUnpublishWhenReferenced: false,
      allowEditInvariantFromNonDefault: true,
      allowNonExistingSegmentsCreation: false,
    })

    const key = await create('A quote', 'Original')
    const read = await h.json<{
      id: string
      isTrashed: boolean
      documentType: { id: string }
      values: Array<{ alias: string; value: unknown; editorAlias: string }>
      variants: Array<{ name: string; state: string }>
    }>(`${V1}/element/${key}`)
    expect(read.id).toBe(key)
    expect(read.isTrashed).toBe(false)
    expect(read.values.find((v) => v.alias === 'body')?.value).toBe('Original')
    expect(read.variants[0]).toMatchObject({ name: 'A quote', state: 'Draft' })

    expect((await h.put(`${V1}/element/${key}`, body('A quote', 'Edited'))).status).toBe(200)
    const again = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/element/${key}`,
    )
    expect(again.values.find((v) => v.alias === 'body')?.value).toBe('Edited')
  })

  test('a draft may leave a mandatory property empty; publishing may not', async () => {
    const { h, typeKey } = await site()
    const empty = {
      documentType: { id: typeKey },
      values: [{ alias: 'body', culture: null, segment: null, value: '' }],
      variants: [{ culture: null, segment: null, name: 'Empty' }],
      parent: null,
    }
    // Umbraco's rule, and the one documents already follow here: a draft is a
    // work in progress, so `mandatory` is enforced when it goes live, not on save.
    expect((await h.post(`${V1}/element`, empty)).status).toBe(201)

    // The editor marks a field red from `validate`, which does enforce it, and
    // reports the same JSON path a document reports.
    const refused = await h.post(`${V1}/element/validate`, empty)
    expect(refused.status).toBe(400)
    const problem = (await refused.json()) as { errors: Record<string, string[]> }
    expect(Object.keys(problem.errors)).toEqual(['$.values[0].value'])

    // …and publishing refuses with the same errors.
    const published = await h.post(`${V1}/element/create-and-publish`, empty)
    expect(published.status).toBe(400)
    expect(
      Object.keys(((await published.json()) as { errors: Record<string, string[]> }).errors),
    ).toEqual(['$.values[0].value'])
  })

  test('publishes, reports the published values apart from the draft, and unpublishes', async () => {
    const { h, create, body, state } = await site()
    const key = await create('Quote', 'v1')
    expect(await state(key)).toBe('Draft')
    // Nothing is published, so there is nothing to read.
    expect((await h.call(`${V1}/element/${key}/published`)).status).toBe(404)

    expect((await h.put(`${V1}/element/${key}/publish`, { cultures: [] })).status).toBe(200)
    expect(await state(key)).toBe('Published')

    // A draft edit on top: the published read keeps the published value.
    await h.put(`${V1}/element/${key}`, body('Quote', 'v2 draft'))
    const published = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/element/${key}/published`,
    )
    expect(published.values.find((v) => v.alias === 'body')?.value).toBe('v1')
    expect(await state(key)).toBe('PublishedPendingChanges')

    expect((await h.put(`${V1}/element/${key}/unpublish`, { cultures: [] })).status).toBe(200)
    expect(await state(key)).toBe('Draft')
    expect((await h.call(`${V1}/element/${key}/published`)).status).toBe(404)
  })

  test('save-and-publish in one call, and create-and-publish refusing before it creates', async () => {
    const { h, typeKey, create, body, state, tree } = await site()
    const bad = await h.post(`${V1}/element/create-and-publish`, {
      documentType: { id: typeKey },
      values: [{ alias: 'body', culture: null, segment: null, value: '' }],
      variants: [{ culture: null, segment: null, name: 'Bad' }],
      parent: null,
    })
    expect(bad.status).toBe(400)
    expect((await tree()).total).toBe(0)

    const created = await h.post(`${V1}/element/create-and-publish`, {
      documentType: { id: typeKey },
      values: [{ alias: 'body', culture: null, segment: null, value: 'Live' }],
      variants: [{ culture: null, segment: null, name: 'Good' }],
      parent: null,
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    expect(await state(key)).toBe('Published')

    const other = await create('Other', 'draft')
    expect(
      (
        await h.put(`${V1}/element/${other}/update-and-publish`, {
          ...body('Other', 'now live'),
          culturesToPublish: [],
        })
      ).status,
    ).toBe(200)
    expect(await state(other)).toBe('Published')
  })
})

describe('moving, copying and the recycle bin', () => {
  test('moves into a folder, copies with a free name, and refuses to move below itself', async () => {
    const { h, create, folder, tree } = await site()
    const box = await folder('Quotes')
    const inner = await folder('Inner', box)
    const key = await create('Movable')

    expect((await h.put(`${V1}/element/${key}/move`, { target: { id: box } })).status).toBe(200)
    expect((await tree(box)).items.map((i) => i.id)).toContain(key)

    const copied = await h.post(`${V1}/element/${key}/copy`, { target: null })
    expect(copied.status).toBe(201)
    expect((await tree()).items.filter((i) => !i.isFolder)).toHaveLength(1)

    // A folder moves too, which no other area's folders do.
    expect((await h.put(`${V1}/element/folder/${inner}/move`, { target: null })).status).toBe(200)
    expect((await tree()).items.filter((i) => i.isFolder).map((i) => i.name)).toEqual(
      expect.arrayContaining(['Quotes', 'Inner']),
    )
    // …and never inside itself.
    expect((await h.put(`${V1}/element/folder/${box}/move`, { target: { id: box } })).status).toBe(
      400,
    )
  })

  test('trashes, lists the bin, restores where it came from, and empties', async () => {
    const { h, create, tree } = await site()
    const key = await create('Doomed')
    expect((await h.put(`${V1}/element/${key}/move-to-recycle-bin`, {})).status).toBe(200)
    expect((await tree()).total).toBe(0)

    const bin = await h.json<{ total: number; items: Array<{ id: string }> }>(
      `${V1}/recycle-bin/element/root?skip=0&take=100`,
    )
    expect(bin.items.map((i) => i.id)).toEqual([key])
    expect(
      await h.json<{ id: string } | null>(`${V1}/recycle-bin/element/${key}/original-parent`),
    ).toBeNull()

    expect((await h.put(`${V1}/recycle-bin/element/${key}/restore`, {})).status).toBe(200)
    expect((await tree()).items.map((i) => i.id)).toEqual([key])

    // Emptying removes the branch for good.
    await h.put(`${V1}/element/${key}/move-to-recycle-bin`, {})
    expect((await h.del(`${V1}/recycle-bin/element`)).status).toBe(200)
    expect(
      (await h.json<{ total: number }>(`${V1}/recycle-bin/element/root?skip=0&take=100`)).total,
    ).toBe(0)
    expect((await h.call(`${V1}/element/${key}`)).status).toBe(404)
  })

  test('a trashed element is unpublished, and a trashed folder takes its branch with it', async () => {
    const { h, create, folder, tree } = await site()
    const box = await folder('Quotes')
    const key = await create('Inside', 'live', box)
    await h.put(`${V1}/element/${key}/publish`, { cultures: [] })

    expect((await h.put(`${V1}/element/folder/${box}/move-to-recycle-bin`, {})).status).toBe(200)
    expect((await tree()).total).toBe(0)
    // Trashed content never stays published, as a document does not.
    const read = await h.json<{ isTrashed: boolean; variants: Array<{ state: string }> }>(
      `${V1}/element/${key}`,
    )
    expect(read.isTrashed).toBe(true)
    expect(read.variants[0]?.state).not.toBe('Published')
  })
})

describe('history', () => {
  test('lists versions, reads one back, rolls back and pins against cleanup', async () => {
    const { h, create, body } = await site()
    const key = await create('Quote', 'first')
    await h.put(`${V1}/element/${key}`, body('Quote', 'second'))

    const versions = await h.json<{
      total: number
      items: Array<{ id: string; element: { id: string }; preventCleanup: boolean }>
    }>(`${V1}/element-version?elementId=${key}&skip=0&take=100`)
    expect(versions.total).toBeGreaterThanOrEqual(2)
    expect(versions.items[0]?.element.id).toBe(key)

    const oldest = versions.items[versions.items.length - 1]?.id as string
    const atVersion = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/element-version/${oldest}`,
    )
    expect(atVersion.values.find((v) => v.alias === 'body')?.value).toBe('first')

    expect(
      (
        await h.put(`${V1}/element-version/${oldest}/prevent-cleanup`, {
          preventCleanup: true,
        })
      ).status,
    ).toBe(200)

    expect((await h.post(`${V1}/element-version/${oldest}/rollback`, {})).status).toBe(200)
    const rolled = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/element/${key}`,
    )
    expect(rolled.values.find((v) => v.alias === 'body')?.value).toBe('first')
  })

  test('the audit log records who made each version', async () => {
    const { h, create, body } = await site()
    const key = await create('Quote', 'first')
    await h.put(`${V1}/element/${key}`, body('Quote', 'second'))
    const log = await h.json<{
      total: number
      items: Array<{ logType: string; user: { id: string } }>
    }>(`${V1}/element/${key}/audit-log?skip=0&take=10`)
    expect(log.total).toBeGreaterThanOrEqual(2)
    expect(log.items.every((i) => typeof i.user.id === 'string')).toBe(true)
  })
})

describe('references', () => {
  test('an element reports what points at it, derived from the values themselves', async () => {
    const { h, create } = await site()
    const key = await create('Quote', 'body')
    // Nothing references it yet, and the endpoint answers rather than 501ing.
    for (const path of [
      `element/${key}/referenced-by?skip=0&take=10`,
      `element/are-referenced?id=${key}&skip=0&take=10`,
    ])
      expect(await h.json<{ total: number; items: unknown[] }>(`${V1}/${path}`)).toEqual({
        total: 0,
        items: [],
      })
  })
})

describe('published elements in a template', () => {
  const HERO_TOML = `[data-type]
key = "7d9e3a44-2c11-4f6a-9d1b-2f0a5c8e4411"
alias = "heroPicker"
name = "Hero Picker"
editor = "Umbraco.ElementPicker"
editor-ui = "Umb.PropertyEditorUi.ElementPicker"
`

  const PAGE_TOML = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
components = ["page"]
default-component = "page"

[[property]]
alias = "heroes"
name = "Heroes"
type = "heroPicker"
`

  const VIEW = `export default function Page({ model }) {
  const heroes = model.value('heroes') ?? []
  return (
    <main>
      <p class="count">{heroes.length}</p>
      {heroes.map((hero) => (
        <section class="hero">
          <i>{hero.contentType.alias}</i>
          <b>{hero.text('body')}</b>
        </section>
      ))}
    </main>
  )
}
`

  /** A site with an element type, a picker data type and a page that renders picks. */
  async function pickerSite() {
    const root = mkdtempSync(join(process.cwd(), 'output', 'element-picker-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(root, 'schema', 'data-types'), { recursive: true })
    mkdirSync(join(root, 'components'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'document-types', 'quote.toml'), QUOTE_TOML)
    writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), PAGE_TOML)
    writeFileSync(join(root, 'schema', 'data-types', 'hero-picker.toml'), HERO_TOML)
    writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
    const h = await signedInServer({
      config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
    })
    open.push(h)
    const types = new ContentTypeRepository(h.server.db)
    const quoteKey = (await types.byAlias('quote'))?.key as string
    const pageKey = (await types.byAlias('page'))?.key as string
    const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string

    const element = async (name: string, text: string, publish = true) => {
      const created = await h.post(`${V1}/element`, {
        documentType: { id: quoteKey },
        parent: null,
        values: [{ alias: 'body', culture: null, segment: null, value: text }],
        variants: [{ culture: null, segment: null, name }],
      })
      const key = created.headers.get('umb-generated-resource') as string
      if (publish) await h.put(`${V1}/element/${key}/publish`, { cultures: [] })
      return key
    }
    const page = async (picks: string[]) => {
      const created = await h.post(`${V1}/document`, {
        documentType: { id: pageKey },
        template: { id: componentKey },
        parent: null,
        values: [{ alias: 'heroes', culture: null, segment: null, value: picks }],
        variants: [{ culture: null, segment: null, name: 'Home' }],
      })
      if (created.status !== 201) throw new Error(`page ${created.status}: ${await created.text()}`)
      const key = created.headers.get('umb-generated-resource') as string
      await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
      return key
    }
    const render = async () => (await h.call('/')).text()
    return { h, element, page, render }
  }

  test('a page renders the elements it picked, in order, with their own values', async () => {
    const { element, page, render } = await pickerSite()
    const first = await element('First', 'One')
    const second = await element('Second', 'Two')
    await page([second, first])

    const html = await render()
    expect(html).toContain('<p class="count">2</p>')
    // In the order picked, not the order created.
    expect(html.indexOf('<b>Two</b>')).toBeLessThan(html.indexOf('<b>One</b>'))
    // The element knows its own type, as a block's element does.
    expect(html).toContain('<i>quote</i>')
  })

  test('an unpublished element is dropped from the page that picked it, and comes back when published', async () => {
    const { h, element, page, render } = await pickerSite()
    const key = await element('Hero', 'Live')
    await page([key])
    expect(await render()).toContain('<b>Live</b>')

    expect((await h.put(`${V1}/element/${key}/unpublish`, { cultures: [] })).status).toBe(200)
    const without = await render()
    expect(without).toContain('<p class="count">0</p>')
    expect(without).not.toContain('Live')

    // Publishing it again brings it back with no change to the page.
    await h.put(`${V1}/element/${key}/publish`, { cultures: [] })
    expect(await render()).toContain('<b>Live</b>')
  })

  test('a trashed element is dropped too, and an edit reaches the page on publish only', async () => {
    const { h, element, page, render } = await pickerSite()
    const key = await element('Hero', 'First')
    await page([key])
    expect(await render()).toContain('<b>First</b>')

    // A draft edit is not what a visitor sees. The save keeps the element's own
    // type, so the body need not repeat it.
    await h.put(`${V1}/element/${key}`, {
      values: [{ alias: 'body', culture: null, segment: null, value: 'Second' }],
      variants: [{ culture: null, segment: null, name: 'Hero' }],
    })
    expect(await render()).toContain('<b>First</b>')
    await h.put(`${V1}/element/${key}/publish`, { cultures: [] })
    expect(await render()).toContain('<b>Second</b>')

    // Trashing takes it out of the page, as unpublishing does.
    expect((await h.put(`${V1}/element/${key}/move-to-recycle-bin`, {})).status).toBe(200)
    expect(await render()).toContain('<p class="count">0</p>')
  })

  test('a picked element that no longer exists leaves no gap', async () => {
    const { h, element, page, render } = await pickerSite()
    const key = await element('Hero', 'Live')
    const other = await element('Other', 'Kept')
    await page([key, other])
    expect(await render()).toContain('<p class="count">2</p>')

    await h.put(`${V1}/element/${key}/move-to-recycle-bin`, {})
    expect((await h.del(`${V1}/recycle-bin/element`)).status).toBe(200)
    const html = await render()
    expect(html).toContain('<p class="count">1</p>')
    expect(html).toContain('<b>Kept</b>')
  })
})

describe('`bunbraco generate` for the element picker', () => {
  const QUOTE_KEY = 'b1f2c3d4-0000-4a11-9c22-3e4f5a6b7c88'
  const files: Record<string, string> = {
    'schema/schema.toml': '[schema]\nversion = "1.0.0"\n',
    'schema/document-types/quote.toml': `[document-type]
key = "${QUOTE_KEY}"
alias = "quote"
name = "Quote"
is-element = true
allow-in-library = true

[[property]]
alias = "body"
name = "Body"
type = "textstring"
`,
    'schema/document-types/aside.toml': `[document-type]
key = "c2e3d4f5-0000-4b22-8d33-4f5a6b7c8d99"
alias = "aside"
name = "Aside"
is-element = true
allow-in-library = true
`,
    'schema/data-types/any-hero.toml': `[data-type]
key = "11111111-0000-4c33-9e44-5a6b7c8d9e00"
alias = "anyHero"
name = "Any Hero"
editor = "Umbraco.ElementPicker"
editor-ui = "Umb.PropertyEditorUi.ElementPicker"
`,
    'schema/data-types/quote-hero.toml': `[data-type]
key = "22222222-0000-4d44-af55-6b7c8d9e0f11"
alias = "quoteHero"
name = "Quote Hero"
editor = "Umbraco.ElementPicker"
editor-ui = "Umb.PropertyEditorUi.ElementPicker"
config = { allowedContentTypes = "${QUOTE_KEY}" }
`,
    'schema/data-types/either-hero.toml': `[data-type]
key = "33333333-0000-4e55-bf66-7c8d9e0f1122"
alias = "eitherHero"
name = "Either Hero"
editor = "Umbraco.ElementPicker"
editor-ui = "Umb.PropertyEditorUi.ElementPicker"
config = { allowedContentTypes = "${QUOTE_KEY},c2e3d4f5-0000-4b22-8d33-4f5a6b7c8d99" }
`,
    'schema/document-types/page.toml': `[document-type]
alias = "page"
name = "Page"
allow-at-root = true

[[property]]
alias = "anyHeroes"
name = "Any"
type = "anyHero"

[[property]]
alias = "quoteHeroes"
name = "Quotes"
type = "quoteHero"

[[property]]
alias = "eitherHeroes"
name = "Either"
type = "eitherHero"
`,
  }

  test('narrows to the element types the picker allows, and stays a list', () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'element-gen-'))
    dirs.push(root)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    const types = generateTypes(loadSchemaDirectory(join(root, 'schema')).set)

    // Nothing configured: any element, so no narrowing is possible.
    expect(types).toContain('"anyHeroes"?: Array<PublishedElement>')
    // One allowed type: its properties are typed through TypedElement.
    expect(types).toContain('"quoteHeroes"?: Array<TypedElement<Quote>>')
    // Two: a union inside Array<>, never `A | B[]`, which would bind as `A | (B[])`.
    expect(types).toContain('"eitherHeroes"?: Array<TypedElement<Quote> | TypedElement<Aside>>')
    expect(types).not.toContain('TypedElement<Aside>[]')
  })
})

describe('an element type in a schema file', () => {
  test('is refused when it declares what only a routed type has', () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'element-validate-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    // Every one of these belongs to a type with a URL. Silently ignoring them
    // would leave the file saying one thing and the editor another.
    writeFileSync(
      join(root, 'schema', 'document-types', 'bad.toml'),
      `[document-type]
key = "9a1b2c3d-0000-4e55-8f66-7a8b9c0d1e22"
alias = "badElement"
name = "Bad Element"
is-element = true
allow-at-root = true
allow-children = ["badElement"]
components = ["badElement"]
default-component = "badElement"
`,
    )
    const problems = validateSchemaSet(loadSchemaDirectory(join(root, 'schema')).set)
    const paths = problems.map((p) => p.path)
    expect(paths).toContain('document-type.components')
    expect(paths).toContain('document-type.default-component')
    expect(paths).toContain('document-type.allow-at-root')
    expect(paths).toContain('document-type.allow-children')
    // Each says why, and points at allow-in-library where that is the answer.
    expect(problems.map((p) => p.message).join('\n')).toContain('never routed')
    expect(problems.map((p) => p.message).join('\n')).toContain('allow-in-library')
  })

  test('is accepted when it declares only what an element has', () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'element-validate-ok-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'document-types', 'quote.toml'), QUOTE_TOML)
    expect(validateSchemaSet(loadSchemaDirectory(join(root, 'schema')).set)).toEqual([])
  })
})
