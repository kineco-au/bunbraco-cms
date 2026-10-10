/**
 * WP-6.3: structured values as templates receive them — pickers yield the
 * content they point at, link pickers yield resolved links, and block editors
 * yield elements with the same `value()` API as a page.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyFromReference } from '@bunbraco/core'
import { ComponentRepository, ContentTypeRepository } from '@bunbraco/data'
import { type BlockGridItem, convertValue, PublishedElement } from '@bunbraco/render'
import { generateTypes, loadSchemaDirectory } from '@bunbraco/schema'
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

const FEATURE = '5b1c9c1e-0d4b-4c35-9d0c-6f2a1e2b3c4d'

const files: Record<string, string> = {
  'schema/schema.toml': '[schema]\nversion = "1.0.0"\n',
  'schema/document-types/feature.toml': `[document-type]
key = "${FEATURE}"
alias = "feature"
name = "Feature"
is-element = true

[[property]]
alias = "headline"
name = "Headline"
type = "textstring"

[[property]]
alias = "target"
name = "Target"
type = "contentPicker"
`,
  'schema/data-types/feature-blocks.toml': `[data-type]
alias = "featureBlocks"
name = "Feature blocks"
editor = "Umbraco.BlockList"
editor-ui = "Umb.PropertyEditorUi.BlockList"

[[data-type.config.blocks]]
contentElementTypeKey = "${FEATURE}"
`,
  'schema/data-types/feature-grid.toml': `[data-type]
alias = "featureGrid"
name = "Feature grid"
editor = "Umbraco.BlockGrid"
editor-ui = "Umb.PropertyEditorUi.BlockGrid"

[[data-type.config.blocks]]
contentElementTypeKey = "${FEATURE}"
allowAtRoot = true
`,
  'schema/data-types/link-list.toml': `[data-type]
alias = "linkList"
name = "Link list"
editor = "Umbraco.MultiUrlPicker"
editor-ui = "Umb.PropertyEditorUi.MultiUrlPicker"
`,
  'schema/data-types/related-pages.toml': `[data-type]
alias = "relatedPages"
name = "Related pages"
editor = "Umbraco.MultiNodeTreePicker"
editor-ui = "Umb.PropertyEditorUi.ContentPicker"
`,
  'schema/document-types/page.toml': `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "pick"
name = "Pick"
type = "contentPicker"

[[property]]
alias = "related"
name = "Related"
type = "relatedPages"

[[property]]
alias = "links"
name = "Links"
type = "linkList"

[[property]]
alias = "blocks"
name = "Blocks"
type = "featureBlocks"

[[property]]
alias = "grid"
name = "Grid"
type = "featureGrid"
`,
  'components/page.tsx': `export default function Page({ model }) {
  const pick = model.value('pick')
  return (
    <main>
      <p class="pick">{pick ? pick.name + ' at ' + pick.url : 'none'}</p>
      <ul class="related">{model.value('related').map((p) => <li>{p.name}</li>)}</ul>
      <ul class="links">{model.value('links').map((l) => <li><a href={l.url} target={l.target ?? undefined}>{l.name}</a></li>)}</ul>
      {model.value('blocks').map((b) => (
        <section class="block">{b.content.text('headline')} → {b.content.value('target')?.name}</section>
      ))}
      {model.value('grid').map((b) => (
        <div class="cell" data-span={b.columnSpan} data-type={b.content.contentType.alias}>
          {b.content.text('headline')}
          {b.areas.map((a) => a.items.map((n) => <span class="nested">{n.content.text('headline')}</span>))}
        </div>
      ))}
    </main>
  )
}
`,
}

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'converters-'))
  dirs.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const create = async (
    name: string,
    values: Record<string, unknown> = {},
    parent: string | null = null,
  ) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: parent ? { id: parent } : null,
      values: Object.entries(values).map(([alias, value]) => ({
        alias,
        culture: null,
        segment: null,
        value,
      })),
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    const key = response.headers.get('umb-generated-resource') as string
    return key
  }
  const publish = (key: string) => h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
  return { h, create, publish }
}

const block = (
  layoutAlias: string,
  items: Array<{ headline: string; target?: string; columnSpan?: number }>,
) => {
  const content = items.map((item) => ({ key: crypto.randomUUID(), ...item }))
  return {
    layout: {
      [layoutAlias]: content.map((c) => ({
        contentKey: c.key,
        settingsKey: null,
        ...(c.columnSpan ? { columnSpan: c.columnSpan, rowSpan: 1, areas: [] } : {}),
      })),
    },
    contentData: content.map((c) => ({
      key: c.key,
      contentTypeKey: FEATURE,
      values: [
        {
          alias: 'headline',
          value: c.headline,
          editorAlias: 'Umbraco.TextBox',
          culture: null,
          segment: null,
        },
        ...(c.target
          ? [
              {
                alias: 'target',
                value: c.target,
                editorAlias: 'Umbraco.ContentPicker',
                culture: null,
                segment: null,
              },
            ]
          : []),
      ],
    })),
    settingsData: [],
    expose: content.map((c) => ({ contentKey: c.key, culture: null, segment: null })),
  }
}

/** A full-width grid block holding one half-width block in an area. */
const gridWithArea = (outer: string, inner: string) => {
  const value = block('Umbraco.BlockGrid', [
    { headline: outer, columnSpan: 12 },
    { headline: inner, columnSpan: 6 },
  ])
  const [row, cell] = value.layout['Umbraco.BlockGrid'] as Array<Record<string, unknown>>
  return {
    ...value,
    layout: {
      'Umbraco.BlockGrid': [{ ...row, areas: [{ key: crypto.randomUUID(), items: [cell] }] }],
    },
  }
}

describe('value converters', () => {
  test('references parse from udis and bare keys', () => {
    expect(keyFromReference('umb://document/2ef0a1b2c3d44e5f8a9b0c1d2e3f4a5b')).toBe(
      '2ef0a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b',
    )
    expect(keyFromReference('2EF0A1B2-C3D4-4E5F-8A9B-0C1D2E3F4A5B')).toBe(
      '2ef0a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b',
    )
    expect(keyFromReference('nope')).toBeUndefined()
  })

  test('without a context, pickers resolve to nothing and blocks still read', () => {
    expect(
      convertValue('Umbraco.ContentPicker', 'umb://document/2ef0a1b2c3d44e5f8a9b0c1d2e3f4a5b'),
    ).toBeNull()
    const items = convertValue(
      'Umbraco.BlockList',
      block('Umbraco.BlockList', [{ headline: 'Hi' }]),
    ) as Array<{
      content: PublishedElement
    }>
    expect(items[0]?.content).toBeInstanceOf(PublishedElement)
    expect(items[0]?.content.text('headline')).toBe('Hi')
    expect(convertValue('Umbraco.TextBox', 'plain')).toBe('plain')
  })

  test('a block names its element type when the context knows it', () => {
    const value = gridWithArea('Row', 'Cell')
    const context = {
      content: () => undefined,
      urlOf: () => '',
      contentTypeAlias: (key: string) => (key === FEATURE ? 'feature' : undefined),
    }
    const [row] = convertValue('Umbraco.BlockGrid', value, context) as BlockGridItem[]
    expect(row?.content.contentType).toEqual({ key: FEATURE, alias: 'feature' })
    expect(row?.columnSpan).toBe(12)
    const nested = row?.areas[0]?.items[0]
    expect(nested?.content.text('headline')).toBe('Cell')
    expect(nested?.content.contentType.alias).toBe('feature')
    expect(nested?.columnSpan).toBe(6)

    // Without one, the key is still there to go on
    const [bare] = convertValue('Umbraco.BlockGrid', value) as BlockGridItem[]
    expect(bare?.content.contentType).toEqual({ key: FEATURE, alias: null })
  })

  test('a page renders its pickers, links, block list and block grid', async () => {
    const { h, create, publish } = await site()
    const home = await create('Home')
    const about = await create('About', {}, home)
    const team = await create('Team', {}, home)
    for (const key of [home, about, team]) await publish(key)

    const blog = await create(
      'Blog',
      {
        pick: `umb://document/${about.replaceAll('-', '')}`,
        related: `umb://document/${team.replaceAll('-', '')},umb://document/${crypto.randomUUID().replaceAll('-', '')},umb://document/${about.replaceAll('-', '')}`,
        links: [
          {
            name: 'Our team',
            type: 'document',
            unique: team,
            target: '_blank',
            queryString: '?tab=1',
          },
          { name: 'Umbraco', type: 'external', url: 'https://umbraco.com', target: null },
          { name: 'Gone', type: 'document', unique: crypto.randomUUID() },
          // An external URL is typed by an editor and lands in an href, where
          // escaping does nothing about the scheme.
          { name: 'Hostile', type: 'external', url: 'javascript:alert(1)', target: null },
          { name: 'Mail', type: 'external', url: 'mailto:hello@example.com', target: null },
          { name: 'Relative', type: 'external', url: '/about', target: null },
        ],
        blocks: block('Umbraco.BlockList', [
          { headline: 'First', target: `umb://document/${team.replaceAll('-', '')}` },
          { headline: 'Second' },
        ]),
        grid: gridWithArea('Wide', 'Inside'),
      },
      home,
    )
    await publish(blog)

    const html = await (await h.call('/blog')).text()
    expect(html).toContain('<p class="pick">About at /about</p>')
    // Missing references are dropped; order is kept
    expect(html).toContain('<ul class="related"><li>Team</li><li>About</li></ul>')
    expect(html).toContain('<a href="/team?tab=1" target="_blank">Our team</a>')
    expect(html).toContain('<a href="https://umbraco.com">Umbraco</a>')
    expect(html).not.toContain('Gone')
    // The name still renders; the scheme does not survive to be clicked.
    expect(html).toContain('<a href="">Hostile</a>')
    expect(html).not.toContain('javascript:alert')
    expect(html).toContain('<a href="mailto:hello@example.com">Mail</a>')
    expect(html).toContain('<a href="/about">Relative</a>')
    expect(html).toContain('<section class="block">First → Team</section>')
    expect(html).toContain('<section class="block">Second → </section>')
    // A block knows its element type by alias, and a grid's areas render their own blocks
    expect(html).toContain(
      '<div class="cell" data-span="12" data-type="feature">Wide<span class="nested">Inside</span></div>',
    )

    // The editor gets back exactly what it saved
    const saved = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${blog}`,
    )
    const blocks = saved.values.find((v) => v.alias === 'blocks')?.value as {
      contentData: unknown[]
    }
    expect(blocks.contentData).toHaveLength(2)
  })

  test('`bunbraco generate` types pickers, links and block elements', () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'converters-gen-'))
    dirs.push(root)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    const types = generateTypes(loadSchemaDirectory(join(root, 'schema')).set)
    expect(types).toContain("from 'bunbraco'")
    expect(types).toContain('"pick"?: PublishedContent | null')
    expect(types).toContain('"related"?: PublishedContent[]')
    expect(types).toContain('"links"?: Link[]')
    expect(types).toContain(
      '"blocks"?: Array<BlockItem & { content: TypedElement<Feature>; settings: PublishedElement | null }>',
    )
    expect(types).toContain('"grid"?: Array<BlockGridItem & { content: TypedElement<Feature> }>')
    // The element type the blocks use is typed too
    expect(types).toContain('export interface Feature {')
    expect(types).toContain('"target"?: PublishedContent | null')
  })
})
