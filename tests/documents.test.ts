/**
 * Phase 4: the vertical slice.
 *
 * create page → edit → save draft → publish → render at its URL → roll back.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComponentRepository, ContentTypeRepository, DocumentRepository } from '@bunbraco/data'
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

const VIEW = `export default function HomePage({ model }) {
  return (
    <main>
      <h1>{model.text('title')}</h1>
      <p class="body">{model.text('bodyText')}</p>
      <span class="name">{model.name}</span>
    </main>
  )
}
`

const LAYOUT_VIEW = `export default function Layout({ children, model }) {
  return (
    <html lang="en">
      <body data-page={model.name}>{children}</body>
    </html>
  )
}
`

const CHILD_VIEW = `export const layout = 'siteLayout'

export default function ChildPage({ model, nav }) {
  return <article data-parent={nav.parent(model)?.name ?? 'none'}>{model.text('title')}</article>
}
`

const HOME_PAGE_TOML = `[document-type]
alias = "homePage"
name = "Home Page"
icon = "icon-home"
allow-at-root = true
allow-children = ["homePage"]
components = ["homePage"]
default-component = "homePage"

[[property]]
alias = "title"
name = "Title"
type = "textstring"

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"
`

/**
 * A signed-in server whose only document type comes from `schema/*.toml`, with
 * its view on disk before boot so the template reference validates.
 */
async function scaffold(options: { view?: string; toml?: string } = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-docs-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(
    join(root, 'schema', 'document-types', 'home-page.toml'),
    options.toml ?? HOME_PAGE_TOML,
  )
  writeFileSync(join(root, 'components', 'homePage.tsx'), options.view ?? VIEW)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('homePage'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('homePage'))
    ?.key as string
  return { h, typeKey, componentKey }
}

async function createPage(
  h: Harness,
  typeKey: string,
  componentKey: string,
  name: string,
  values: Array<{ alias: string; value: unknown }> = [],
  parentKey: string | null = null,
) {
  const response = await h.post(`${V1}/document`, {
    documentType: { id: typeKey },
    template: { id: componentKey },
    parent: parentKey ? { id: parentKey } : null,
    values: values.map((value) => ({ culture: null, segment: null, ...value })),
    variants: [{ culture: null, segment: null, name }],
  })
  if (response.status !== 201)
    throw new Error(`create failed ${response.status}: ${await response.text()}`)
  return response.headers.get('umb-generated-resource') as string
}

describe('documents', () => {
  test('creates one and reads its values back', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'Welcome' },
      { alias: 'bodyText', value: 'Hello world' },
    ])

    const document = await h.json<{
      id: string
      isTrashed: boolean
      documentType: { id: string }
      template: { id: string } | null
      values: Array<{ alias: string; value: unknown; editorAlias: string }>
      variants: Array<{ name: string; state: string; culture: string | null }>
    }>(`${V1}/document/${key}`)

    expect(document.id).toBe(key)
    expect(document.isTrashed).toBe(false)
    expect(document.documentType.id).toBe(typeKey)
    expect(document.template?.id).toBe(componentKey)

    const values = Object.fromEntries(document.values.map((v) => [v.alias, v.value]))
    expect(values.title).toBe('Welcome')
    expect(values.bodyText).toBe('Hello world')
    // The editor needs to know which editor produced each value.
    expect(document.values.find((v) => v.alias === 'title')?.editorAlias).toBe('Umbraco.TextBox')

    expect(document.variants).toHaveLength(1)
    expect(document.variants[0]?.name).toBe('Home')
    expect(document.variants[0]?.culture).toBeNull()
    expect(document.variants[0]?.state).toBe('Draft')
  })

  test('saving a draft records a version, and only for what changed', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'First' },
    ])

    const before = await h.json<{ total: number }>(
      `${V1}/document-version?documentId=${key}&skip=0&take=100`,
    )
    expect(before.total).toBe(1)

    await h.put(`${V1}/document/${key}`, {
      template: { id: componentKey },
      values: [{ culture: null, segment: null, alias: 'title', value: 'Second' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })

    const after = await h.json<{ total: number }>(
      `${V1}/document-version?documentId=${key}&skip=0&take=100`,
    )
    // Values are append-only: every save is a recoverable version. Umbraco
    // updates its draft in place and only versions on publish.
    expect(after.total).toBe(2)

    const document = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${key}`,
    )
    expect(document.values.find((v) => v.alias === 'title')?.value).toBe('Second')
  })

  test('publishing freezes the draft and forks a new one', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'Live' },
    ])

    const publish = await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    expect(publish.status).toBe(200)

    const versions = await h.json<{
      total: number
      items: Array<{ isCurrentDraftVersion: boolean; isCurrentPublishedVersion: boolean }>
    }>(`${V1}/document-version?documentId=${key}&skip=0&take=100`)
    // Publish = freeze the draft as published, then fork a new draft.
    expect(versions.total).toBe(2)
    expect(versions.items.filter((v) => v.isCurrentDraftVersion)).toHaveLength(1)
    expect(versions.items.filter((v) => v.isCurrentPublishedVersion)).toHaveLength(1)

    const document = await h.json<{
      variants: Array<{ state: string; publishDate: string | null }>
    }>(`${V1}/document/${key}`)
    expect(document.variants[0]?.state).toBe('Published')
    expect(document.variants[0]?.publishDate).toBeTruthy()
  })

  test('editing after publishing marks pending changes', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'Live' },
    ])
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })

    await h.put(`${V1}/document/${key}`, {
      template: { id: componentKey },
      values: [{ culture: null, segment: null, alias: 'title', value: 'Edited' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })

    const document = await h.json<{ variants: Array<{ state: string }> }>(`${V1}/document/${key}`)
    expect(document.variants[0]?.state).toBe('PublishedPendingChanges')
  })

  test('refuses to publish below an unpublished ancestor', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const parent = await createPage(h, typeKey, componentKey, 'Parent')
    const child = await createPage(h, typeKey, componentKey, 'Child', [], parent)

    const response = await h.put(`${V1}/document/${child}/publish`, { publishSchedules: [] })
    // Publishing under an unpublished parent would create an unreachable route.
    expect(response.status).toBe(400)
    const problem = await response.json()
    expect(problem.type).toBe('Error')
    expect(problem.detail).toContain('ancestor')
  })

  test('appears in the tree with its parent', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const parent = await createPage(h, typeKey, componentKey, 'Parent')
    await createPage(h, typeKey, componentKey, 'Child', [], parent)

    const roots = await h.json<{
      total: number
      items: Array<{ variants: Array<{ name: string }>; hasChildren: boolean }>
    }>(`${V1}/tree/document/root?skip=0&take=100`)
    expect(roots.items.map((i) => i.variants[0]?.name)).toEqual(['Parent'])
    expect(roots.items[0]?.hasChildren).toBe(true)

    const children = await h.json<{
      items: Array<{ variants: Array<{ name: string }>; parent: { id: string } | null }>
    }>(`${V1}/tree/document/children?parentId=${parent}&skip=0&take=100`)
    expect(children.items.map((i) => i.variants[0]?.name)).toEqual(['Child'])
    expect(children.items[0]?.parent?.id).toBe(parent)
  })

  test('moves to the recycle bin and unpublishes on the way', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home')
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })

    expect(
      (await h.call(`${V1}/document/${key}/move-to-recycle-bin`, { method: 'PUT' })).status,
    ).toBe(200)

    const document = await h.json<{ isTrashed: boolean; variants: Array<{ state: string }> }>(
      `${V1}/document/${key}`,
    )
    expect(document.isTrashed).toBe(true)
    expect(document.variants[0]?.state).toBe('Trashed')
    // A trashed page must not remain reachable on the site.
    expect((await h.call('/')).status).toBe(404)
  })

  test('deletes one outright', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home')
    expect((await h.del(`${V1}/document/${key}`)).status).toBe(200)
    expect((await h.call(`${V1}/document/${key}`)).status).toBe(404)
  })
})

describe('what would stop a publish', () => {
  /** The same three rules `publish` enforces, asked before anything is written. */
  const blockersFor = async (h: Harness, key: string, selection: ReadonlySet<number> = new Set()) =>
    new DocumentRepository(h.server.db, {
      nodeState: { version: '1.0.0', revision: '0' },
    }).publishBlockers(key, null, selection)

  test('nothing, for a page that can go live', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home')
    expect(await blockersFor(h, key)).toEqual([])
  })

  test('an unpublished ancestor, unless the same run is publishing it', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const root = await createPage(h, typeKey, componentKey, 'Home')
    const child = await createPage(h, typeKey, componentKey, 'About', [], root)
    expect(await blockersFor(h, child)).toEqual(['an ancestor is not published'])

    // A caller publishing the branch parents-first is not blocked by its own
    // work: without this, publishing a tree reports every child as refused.
    const docs = new DocumentRepository(h.server.db, {
      nodeState: { version: '1.0.0', revision: '0' },
    })
    const rootNode = await docs.nodes.byKey(root)
    expect(await blockersFor(h, child, new Set([rootNode?.id as number]))).toEqual([])

    // And once it really is published, neither is anybody else.
    expect((await h.put(`${V1}/document/${root}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    expect(await blockersFor(h, child)).toEqual([])
  })

  test('an empty mandatory property, named', async () => {
    const { h, typeKey, componentKey } = await scaffold({ toml: STRICT_TOML })
    const key = await createPage(h, typeKey, componentKey, 'Home')
    const blockers = await blockersFor(h, key)
    expect(blockers).toHaveLength(1)
    // The message `publish` itself would have thrown, so the reason somebody
    // reads is the same whichever way they met it.
    expect(blockers[0]).toContain('Title')
  })

  test('and a document that is not there at all', async () => {
    const { h } = await scaffold()
    expect(await blockersFor(h, crypto.randomUUID())).toEqual(['there is no such document here'])
  })
})

describe('versioning and rollback', () => {
  test('restores an old version into the draft without rewriting history', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'Original' },
    ])
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })

    await h.put(`${V1}/document/${key}`, {
      template: { id: componentKey },
      values: [{ culture: null, segment: null, alias: 'title', value: 'Changed' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    const changed = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${key}`,
    )
    expect(changed.values.find((v) => v.alias === 'title')?.value).toBe('Changed')

    const versions = await h.json<{
      items: Array<{ id: string; isCurrentPublishedVersion: boolean }>
    }>(`${V1}/document-version?documentId=${key}&skip=0&take=100`)
    const publishedVersion = versions.items.find((v) => v.isCurrentPublishedVersion)
    expect(publishedVersion).toBeDefined()

    const rollback = await h.call(`${V1}/document-version/${publishedVersion?.id}/rollback`, {
      method: 'POST',
    })
    expect(rollback.status).toBe(200)

    const rolledBack = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${key}`,
    )
    expect(rolledBack.values.find((v) => v.alias === 'title')?.value).toBe('Original')

    // Rollback appends the old values under a new event: create, publish, save,
    // rollback are four events and none is rewritten.
    const after = await h.json<{ total: number }>(
      `${V1}/document-version?documentId=${key}&skip=0&take=100`,
    )
    expect(after.total).toBe(4)
  })

  test('pins a version against cleanup', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home')
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })

    const versions = await h.json<{ items: Array<{ id: string; preventCleanup: boolean }> }>(
      `${V1}/document-version?documentId=${key}&skip=0&take=100`,
    )
    const target = versions.items[0]?.id as string
    expect(
      (
        await h.call(`${V1}/document-version/${target}/prevent-cleanup?preventCleanup=true`, {
          method: 'PUT',
        })
      ).status,
    ).toBe(200)

    const after = await h.json<{ items: Array<{ id: string; preventCleanup: boolean }> }>(
      `${V1}/document-version?documentId=${key}&skip=0&take=100`,
    )
    expect(after.items.find((v) => v.id === target)?.preventCleanup).toBe(true)
  })
})

describe('rendering', () => {
  test('renders a published page at its URL', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'Welcome home' },
      { alias: 'bodyText', value: 'Body copy' },
    ])

    // Unpublished content is not reachable.
    expect((await h.call('/')).status).toBe(404)

    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })

    const response = await h.call('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('<h1>Welcome home</h1>')
    expect(html).toContain('<p class="body">Body copy</p>')
    expect(html).toContain('<span class="name">Home</span>')
  })

  test('escapes property values', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: '<script>alert(1)</script>' },
    ])
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })

    const html = await (await h.call('/')).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('setInnerHTML emits markup verbatim only when told to, and escapes otherwise', async () => {
    const { h, typeKey, componentKey } = await scaffold({
      view: `export default function HomePage({ model }) {
  return (
    <main>
      <div class="raw" setInnerHTML={{ __html: model.text('bodyText'), dangerously: true }} />
      <div class="safe" setInnerHTML={{ __html: model.text('bodyText') }} />
      <div class="off" setInnerHTML={{ __html: model.text('bodyText'), dangerously: false }} />
    </main>
  )
}
`,
    })
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'Home' },
      { alias: 'bodyText', value: '<em>hi</em><script>alert(1)</script>' },
    ])
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    const html = await (await h.call('/')).text()

    // Asked for verbatim, it is verbatim — script tag and all. That is the point of
    // the flag: the template said so.
    expect(html).toContain('<div class="raw"><em>hi</em><script>alert(1)</script></div>')
    // Without the flag, and with it explicitly off, the markup is escaped. React's
    // `dangerouslySetInnerHTML` has no such setting: it is always verbatim.
    for (const cls of ['safe', 'off'])
      expect(html).toContain(
        `<div class="${cls}">&lt;em&gt;hi&lt;/em&gt;&lt;script&gt;alert(1)&lt;/script&gt;</div>`,
      )
    // The attribute itself never reaches the markup.
    expect(html).not.toContain('setInnerHTML=')
    expect(html).not.toContain('__html')
  })

  test('rich text round-trips as the object the editor sends, and renders as its markup', async () => {
    const { h, typeKey, componentKey } = await scaffold({
      toml: HOME_PAGE_TOML.replace('type = "textarea"', 'type = "richtext"'),
      view: `export default function HomePage({ model }) {
  return <main>{model.html('bodyText')}</main>
}
`,
    })
    const rte = {
      markup: '<p><strong>Rich</strong> body</p>',
      blocks: { layout: {}, contentData: [], settingsData: [], expose: [] },
    }
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'bodyText', value: rte },
    ])
    const read = async () =>
      (
        await h.json<{ values: Array<{ alias: string; value: unknown }> }>(`${V1}/document/${key}`)
      ).values.find((v) => v.alias === 'bodyText')?.value
    expect(await read()).toEqual(rte)

    // Saving what was read back leaves it intact
    await h.put(`${V1}/document/${key}`, {
      template: { id: componentKey },
      values: [{ culture: null, segment: null, alias: 'bodyText', value: await read() }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    expect(await read()).toEqual(rte)

    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    expect(await (await h.call('/')).text()).toContain(
      '<main><p><strong>Rich</strong> body</p></main>',
    )
  })

  test('serves the published version, not the draft', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'Published' },
    ])
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })

    await h.put(`${V1}/document/${key}`, {
      template: { id: componentKey },
      values: [{ culture: null, segment: null, alias: 'title', value: 'Draft only' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })

    const html = await (await h.call('/')).text()
    expect(html).toContain('Published')
    expect(html).not.toContain('Draft only')
  })

  test('routes a child below its parent, and applies the layout', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const layout = await h.post(`${V1}/template`, {
      name: 'Site Layout',
      alias: 'siteLayout',
      content: LAYOUT_VIEW,
    })
    expect(layout.status).toBe(201)

    const child = await h.post(`${V1}/template`, {
      name: 'Child Page',
      alias: 'childPage',
      content: CHILD_VIEW,
    })
    const childTemplateKey = child.headers.get('umb-generated-resource') as string

    const parentKey = await createPage(h, typeKey, componentKey, 'Parent', [
      { alias: 'title', value: 'Parent title' },
    ])
    await h.put(`${V1}/document/${parentKey}/publish`, { publishSchedules: [] })

    const childKey = await createPage(
      h,
      typeKey,
      childTemplateKey,
      'Child',
      [{ alias: 'title', value: 'Child title' }],
      parentKey,
    )
    await h.put(`${V1}/document/${childKey}/publish`, { publishSchedules: [] })

    const response = await h.call('/child')
    expect(response.status).toBe(200)
    const html = await response.text()
    // The layout wrapped the page…
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('data-page="Child"')
    // …and navigation resolved the parent.
    expect(html).toContain('data-parent="Parent"')
    expect(html).toContain('Child title')
  })

  test('unpublishing removes the route', async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home')
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    expect((await h.call('/')).status).toBe(200)

    expect((await h.put(`${V1}/document/${key}/unpublish`, {})).status).toBe(200)
    expect((await h.call('/')).status).toBe(404)
  })

  test("URLs follow Umbraco's default: the first root is /, and no root's segment appears below it", async () => {
    const { h, typeKey, componentKey } = await scaffold()
    const publish = (key: string) =>
      h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    const home = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'H' },
    ])
    const about = await createPage(h, typeKey, componentKey, 'About Us', [], home)
    const other = await createPage(h, typeKey, componentKey, 'Other Site')
    const clash = await createPage(h, typeKey, componentKey, 'About Us', [], other)
    for (const key of [home, about, other, clash]) await publish(key)

    const urlOf = async (key: string) =>
      (
        await h.json<Array<{ urlInfos: Array<{ url: string }> }>>(`${V1}/document/urls?id=${key}`)
      )[0]?.urlInfos[0]?.url
    expect(await urlOf(home)).toBe('/')
    // The segment is slugified from the name
    expect(await urlOf(about)).toBe('/about-us')
    expect(await urlOf(other)).toBe('/other-site')
    expect(await urlOf(clash)).toBe('/about-us')
    // A clash goes to the first root's page, as Umbraco resolves it
    expect(await (await h.call('/')).text()).toContain('<h1>H</h1>')
    expect(await (await h.call('/about-us')).text()).toContain('<span class="name">About Us</span>')
    expect((await h.call('/home')).status).toBe(404)
    expect((await h.call('/other-site/about-us')).status).toBe(404)
  })

  test('a page with no template is not rendered', async () => {
    const { h, typeKey } = await scaffold()
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: null,
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Templateless' }],
    })
    const key = response.headers.get('umb-generated-resource') as string
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    expect((await h.call('/')).status).toBe(404)
  })
})

/**
 * WP-6.1: what the real document workspace calls that the Phase 4 slice did
 * not — configuration, validate, save-and-publish, the published read, the
 * tree's ancestors/siblings/search, and the recycle bin it always renders.
 */
const STRICT_TOML = `[document-type]
alias = "homePage"
name = "Home Page"
icon = "icon-home"
allow-at-root = true
allow-children = ["homePage"]
components = ["homePage"]
default-component = "homePage"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
mandatory = true
mandatory-message = "A title, please"

[[property]]
alias = "slug"
name = "Slug"
type = "textstring"
regex = "^[a-z-]+$"
regex-message = "lowercase and dashes only"

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"
`

async function strictScaffold() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-docs-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'home-page.toml'), STRICT_TOML)
  writeFileSync(join(root, 'components', 'homePage.tsx'), VIEW)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('homePage'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('homePage'))
    ?.key as string
  return { h, typeKey, componentKey }
}

function body(
  typeKey: string,
  componentKey: string | null,
  name: string,
  values: Record<string, unknown>,
  parentKey: string | null = null,
) {
  return {
    documentType: { id: typeKey },
    template: componentKey ? { id: componentKey } : null,
    parent: parentKey ? { id: parentKey } : null,
    values: Object.entries(values).map(([alias, value]) => ({
      alias,
      culture: null,
      segment: null,
      value,
    })),
    variants: [{ culture: null, segment: null, name }],
  }
}

describe('WP-6.1 document workspace', () => {
  test('configuration answers', async () => {
    const { h } = await strictScaffold()
    expect(await h.json<Record<string, boolean>>(`${V1}/document/configuration`)).toEqual({
      disableDeleteWhenReferenced: false,
      disableUnpublishWhenReferenced: false,
      allowEditInvariantFromNonDefault: false,
      allowNonExistingSegmentsCreation: false,
    })
  })

  test('validate names the exact field, by index when sent and by filter when not', async () => {
    const { h, typeKey, componentKey } = await strictScaffold()
    // Sent but empty, and a pattern miss
    const sent = await h.post(
      `${V1}/document/validate`,
      body(typeKey, componentKey, 'Home', { title: '', slug: 'Not Valid' }),
    )
    expect(sent.status).toBe(400)
    const problem = await sent.json()
    expect(problem.title).toBe('Validation failed')
    expect(problem.errors).toEqual({
      '$.values[0].value': ['A title, please'],
      '$.values[1].value': ['lowercase and dashes only'],
    })
    // Not sent at all
    const missing = await h.post(
      `${V1}/document/validate`,
      body(typeKey, componentKey, 'Home', { bodyText: 'x' }),
    )
    expect((await missing.json()).errors).toEqual({
      "$.values[?(@.alias == 'title' && @.culture == null && @.segment == null)].value": [
        'A title, please',
      ],
    })
    // Valid
    expect(
      (
        await h.post(
          `${V1}/document/validate`,
          body(typeKey, componentKey, 'Home', { title: 'Hi', slug: 'hi' }),
        )
      ).status,
    ).toBe(200)

    // The update form validates an existing document
    const key = await createPage(h, typeKey, componentKey, 'Draft', [
      { alias: 'title', value: 'T' },
    ])
    const update = await h.put(`${V1}.1/document/${key}/validate`, {
      ...body(typeKey, componentKey, 'Draft', { title: '' }),
      cultures: null,
    })
    expect(update.status).toBe(400)
    expect(
      (
        await h.put(
          `${V1}/document/${crypto.randomUUID()}/validate`,
          body(typeKey, componentKey, 'x', {}),
        )
      ).status,
    ).toBe(404)
  })

  test('create-and-publish refuses with the same errors and creates nothing; then creates, publishes and renders', async () => {
    const { h, typeKey, componentKey } = await strictScaffold()
    const refused = await h.post(`${V1}/document/create-and-publish`, {
      ...body(typeKey, componentKey, 'Home', { title: '' }),
      culturesToPublish: [],
    })
    expect(refused.status).toBe(400)
    expect(Object.keys((await refused.json()).errors)).toEqual(['$.values[0].value'])
    expect((await h.json<{ total: number }>(`${V1}/tree/document/root?skip=0&take=10`)).total).toBe(
      0,
    )

    const ok = await h.post(`${V1}/document/create-and-publish`, {
      ...body(typeKey, componentKey, 'Home', { title: 'Welcome', slug: 'home' }),
      culturesToPublish: [],
    })
    expect(ok.status).toBe(201)
    // The client shows its own "published" toast; Umbraco adds no notification of its own
    expect(ok.headers.get('umb-notifications')).toBeNull()
    const key = ok.headers.get('umb-generated-resource') as string
    const doc = await h.json<{ variants: Array<{ state: string }> }>(`${V1}/document/${key}`)
    expect(doc.variants[0]?.state).toBe('Published')
    expect(await (await h.call('/')).text()).toContain('Welcome')
  })

  test('update-and-publish, and the published read shows the published values, not the draft', async () => {
    const { h, typeKey, componentKey } = await strictScaffold()
    const key = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'v1' },
    ])
    expect((await h.call(`${V1}/document/${key}/published`)).status).toBe(404)
    const published = await h.put(`${V1}/document/${key}/update-and-publish`, {
      ...body(typeKey, componentKey, 'Home', { title: 'v1', slug: 'home' }),
      culturesToPublish: [],
    })
    expect(published.status).toBe(200)
    // A draft edit on top
    await h.put(
      `${V1}/document/${key}`,
      body(typeKey, componentKey, 'Home', { title: 'v2 draft', slug: 'home' }),
    )
    const draft = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${key}`,
    )
    const live = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${key}/published`,
    )
    expect(draft.values.find((v) => v.alias === 'title')?.value).toBe('v2 draft')
    expect(live.values.find((v) => v.alias === 'title')?.value).toBe('v1')
    // …and update-and-publish refuses a bad pattern without publishing the draft
    const bad = await h.put(`${V1}/document/${key}/update-and-publish`, {
      ...body(typeKey, componentKey, 'Home', { title: 'v3', slug: 'NOPE' }),
      culturesToPublish: [],
    })
    expect(bad.status).toBe(400)
    expect(
      (
        await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
          `${V1}/document/${key}/published`,
        )
      ).values.find((v) => v.alias === 'title')?.value,
    ).toBe('v1')
    expect(
      (
        await h.put(`${V1}/document/${crypto.randomUUID()}/update-and-publish`, {
          ...body(typeKey, componentKey, 'x', { title: 't' }),
          culturesToPublish: [],
        })
      ).status,
    ).toBe(404)
  })

  test('the tree: rich items, ancestors, siblings, search', async () => {
    const { h, typeKey, componentKey } = await strictScaffold()
    const home = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'H' },
    ])
    const children: string[] = []
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta'])
      children.push(
        await createPage(h, typeKey, componentKey, name, [{ alias: 'title', value: name }], home),
      )
    const grand = await createPage(
      h,
      typeKey,
      componentKey,
      'Grandchild',
      [{ alias: 'title', value: 'g' }],
      children[1] as string,
    )

    const root = await h.json<{ items: Array<Record<string, unknown>> }>(
      `${V1}/tree/document/root?skip=0&take=10`,
    )
    expect(root.items[0]).toMatchObject({
      id: home,
      hasChildren: true,
      isTrashed: false,
      ancestors: [],
      documentType: { id: typeKey, icon: 'icon-home' },
      variants: [{ name: 'Home', culture: null, state: 'Draft' }],
    })
    const ancestors = await h.json<Array<{ id: string; ancestors: Array<{ id: string }> }>>(
      `${V1}/tree/document/ancestors?descendantId=${grand}`,
    )
    expect(ancestors.map((a) => a.id)).toEqual([home, children[1] as string])
    expect(ancestors[1]?.ancestors).toEqual([{ id: home }])

    const siblings = await h.json<{
      totalBefore: number
      totalAfter: number
      items: Array<{ id: string }>
    }>(`${V1}/tree/document/siblings?target=${children[2] as string}&before=1&after=5`)
    expect(siblings.items.map((i) => i.id)).toEqual([
      children[1] as string,
      children[2] as string,
      children[3] as string,
    ])
    expect(siblings).toMatchObject({ totalBefore: 1, totalAfter: 0 })

    const search = await h.json<{
      total: number
      items: Array<{ id: string; variants: Array<{ name: string }> }>
    }>(`${V1}/item/document/search?query=ta&skip=0&take=10`)
    expect(search.items.map((i) => i.variants[0]?.name).sort()).toEqual(['Beta', 'Delta'])
    const under = await h.json<{ total: number }>(
      `${V1}/item/document/search?query=a&parentId=${children[1] as string}&skip=0&take=10`,
    )
    expect(under.total).toBe(1)
  })

  test("the Info tab: the audit log from the page's versions, and empty references and redirects", async () => {
    const { h, typeKey, componentKey } = await strictScaffold()
    const me = (await h.json<{ id: string }>(`${V1}/user/current`)).id
    const home = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'H' },
    ])
    await h.put(`${V1}/document/${home}/publish`, { publishSchedules: [] })

    type Log = {
      total: number
      items: Array<{ user: { id: string }; logType: string; timestamp: string }>
    }
    const log = await h.json<Log>(`${V1}/document/${home}/audit-log?skip=0&take=10`)
    expect(log.total).toBe(2)
    expect(log.items.map((i) => i.logType)).toEqual(['Publish', 'Save'])
    // The version records who made it
    expect(log.items.map((i) => i.user.id)).toEqual([me, me])
    // …whose name the history resolves; unknown keys are skipped
    expect(await h.json<unknown>(`${V1}/item/user?id=${me}&id=${crypto.randomUUID()}`)).toEqual([
      { id: me, name: expect.any(String), avatarUrls: [], kind: 'Default', flags: [] },
    ])
    const oldestFirst = await h.json<Log>(
      `${V1}/document/${home}/audit-log?orderDirection=Ascending&skip=0&take=1`,
    )
    expect(oldestFirst).toMatchObject({ total: 2, items: [{ logType: 'Save' }] })
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(
      (await h.json<Log>(`${V1}/document/${home}/audit-log?sinceDate=${future}&skip=0&take=10`))
        .total,
    ).toBe(0)

    expect(await h.json<unknown>(`${V1}/document/${home}/referenced-by?skip=0&take=10`)).toEqual({
      total: 0,
      items: [],
    })
    for (const path of [
      `document/${home}/referenced-descendants`,
      `document/are-referenced?id=${home}&`,
    ])
      expect(
        await h.json<unknown>(`${V1}/${path}${path.endsWith('&') ? '' : '?'}skip=0&take=10`),
      ).toEqual({ total: 0, items: [] })
    expect(await h.json<unknown>(`${V1}/redirect-management/${home}?skip=0&take=10`)).toEqual({
      total: 0,
      items: [],
    })
    // Tracking is on by default, as in Umbraco; `tests/redirects.test.ts` covers
    // what it then records.
    expect(await h.json<unknown>(`${V1}/redirect-management/status`)).toEqual({
      status: 'Enabled',
      userIsAdmin: true,
    })
  })

  test("the create dialog under a page reads its type's allowed children, not the root set", async () => {
    const { h, typeKey, componentKey } = await strictScaffold()
    // A second type allowed under the first but not at the root — the shape a site
    // has: one landing type at the root, content types only beneath it.
    const child = await h.post(`${V1}/document-type`, {
      alias: 'childPage',
      name: 'Child Page',
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
      containers: [],
      properties: [],
      allowedDocumentTypes: [],
      compositions: [],
      allowedTemplates: [],
      defaultTemplate: null,
      parent: null,
    })
    expect(child.status).toBe(201)
    const childKey = child.headers.get('umb-generated-resource') as string

    // Allow it under the landing type.
    const parent = await h.json<Record<string, unknown>>(`${V1}/document-type/${typeKey}`)
    expect(
      (
        await h.put(`${V1}/document-type/${typeKey}`, {
          ...parent,
          allowedDocumentTypes: [{ documentType: { id: childKey }, sortOrder: 0 }],
        })
      ).status,
    ).toBe(200)

    const home = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'H' },
    ])

    // The chain the dialog walks: the item gives the parent's type, and that type's
    // allowed children are what it offers. The root list is deliberately different —
    // Child Page is not allowed there, so a dialog falling back to it shows nothing.
    const item = await h.json<Array<{ documentType: { id: string } }>>(
      `${V1}/item/document?id=${home}`,
    )
    expect(item[0]?.documentType.id).toBe(typeKey)

    const children = await h.json<{ total: number; items: Array<{ alias: string }> }>(
      `${V1}/document-type/${item[0]?.documentType.id}/allowed-children?parentContentKey=${home}`,
    )
    expect(children.items.map((i) => i.alias)).toEqual(['childPage'])

    const atRoot = await h.json<{ items: Array<{ alias: string }> }>(
      `${V1}/document-type/allowed-at-root?skip=0&take=100`,
    )
    expect(atRoot.items.map((i) => i.alias)).not.toContain('childPage')
  })

  test('document items carry their type and state, which the create dialog needs for allowed children', async () => {
    const { h, typeKey, componentKey } = await strictScaffold()
    const home = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'H' },
    ])
    type Item = {
      id: string
      parent: { id: string } | null
      documentType: { id: string; icon: string }
      variants: Array<{ name: string; state: string }>
    }
    const before = await h.json<Item[]>(`${V1}/item/document?id=${home}&id=${crypto.randomUUID()}`)
    expect(before).toEqual([
      expect.objectContaining({
        id: home,
        parent: null,
        documentType: expect.objectContaining({ id: typeKey, icon: 'icon-home' }),
        variants: [expect.objectContaining({ name: 'Home', state: 'Draft' })],
      }),
    ])
    await h.put(`${V1}/document/${home}/publish`, { publishSchedules: [] })
    const after = await h.json<Item[]>(`${V1}/item/document?id=${home}`)
    expect(after[0]?.variants[0]?.state).toBe('Published')
  })

  test('the recycle bin lists what was trashed, with its branch below and its original parent', async () => {
    const { h, typeKey, componentKey } = await strictScaffold()
    const home = await createPage(h, typeKey, componentKey, 'Home', [
      { alias: 'title', value: 'H' },
    ])
    const child = await createPage(
      h,
      typeKey,
      componentKey,
      'Child',
      [{ alias: 'title', value: 'c' }],
      home,
    )
    const grand = await createPage(
      h,
      typeKey,
      componentKey,
      'Grand',
      [{ alias: 'title', value: 'g' }],
      child,
    )
    const empty = await h.json<{ total: number; items: unknown[] }>(
      `${V1}/recycle-bin/document/root?skip=0&take=10`,
    )
    expect(empty).toEqual({ total: 0, items: [] })

    expect((await h.put(`${V1}/document/${child}/move-to-recycle-bin`, {})).status).toBe(200)
    const bin = await h.json<{
      total: number
      items: Array<{ id: string; hasChildren: boolean; parent: unknown }>
    }>(`${V1}/recycle-bin/document/root?skip=0&take=10`)
    expect(bin.items.map((i) => i.id)).toEqual([child])
    expect(bin.items[0]?.hasChildren).toBe(true)
    const below = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/recycle-bin/document/children?parentId=${child}&skip=0&take=10`,
    )
    expect(below.items.map((i) => i.id)).toEqual([grand])
    // Siblings within the bin: the other trashed top-level document
    const sibling = await createPage(h, typeKey, componentKey, 'Loner', [
      { alias: 'title', value: 'l' },
    ])
    await h.put(`${V1}/document/${sibling}/move-to-recycle-bin`, {})
    const window = await h.json<{
      items: Array<{ id: string }>
      totalBefore: number
      totalAfter: number
    }>(`${V1}/recycle-bin/document/siblings?target=${child}&before=5&after=5`)
    expect(window.items.map((i) => i.id).sort()).toEqual([child, sibling].sort())

    expect(
      await h.json<{ id: string }>(`${V1}/recycle-bin/document/${child}/original-parent`),
    ).toEqual({
      id: home,
    })
    // The live tree no longer shows the branch, and searching the bin finds it
    expect(
      (
        await h.json<{ total: number }>(
          `${V1}/tree/document/children?parentId=${home}&skip=0&take=10`,
        )
      ).total,
    ).toBe(0)
    expect(
      (
        await h.json<{ total: number }>(
          `${V1}/item/document/search?query=child&trashed=true&skip=0&take=10`,
        )
      ).total,
    ).toBe(1)
    // A root document trashed has no original parent
    await h.put(`${V1}/document/${home}/move-to-recycle-bin`, {})
    expect(await h.json<unknown>(`${V1}/recycle-bin/document/${home}/original-parent`)).toBeNull()
  })
})
