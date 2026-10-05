/**
 * `content export`: what a bundle carries out of a site.
 *
 * The snapshot rule is the load-bearing decision — a bundle holds what the
 * source site *serves*, not what an editor happens to have half-written — so
 * most of this is about which values travel and which do not.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, DocumentRepository, type NodeRow } from '@bunbraco/data'
import { exportBundle } from '@bunbraco/transfer'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const PAGE_TOML = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"

[[property]]
alias = "related"
name = "Related"
type = "contentPicker"
`

const VIEW = `export default function Page({ model }) {
  return <main>{model.text('title')}</main>
}
`

function pageSite() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-export-'))
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  return { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components'), root }
}

const options = (roots: NodeRow[], overrides: Record<string, unknown> = {}) => ({
  roots,
  asGiven: roots.map((r) => r.key),
  descendants: true,
  snapshot: 'published' as const,
  blueprints: false,
  withBlobs: false,
  siteName: 'Test',
  nodeId: 'test',
  ...overrides,
})

describe(`exporting a bundle (${dialectUnderTest})`, () => {
  let h: Harness
  let dir: string
  let typeKey: string
  let campaigns: NodeRow
  let landing: string
  let draft: string

  const make = async (name: string, parent: string | null, values: unknown[] = []) => {
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: null,
      parent: parent ? { id: parent } : null,
      values,
      variants: [{ culture: null, segment: null, name }],
    })
    expect(created.status, `creating ${name}`).toBe(201)
    return created.headers.get('umb-generated-resource') as string
  }

  const nodeOf = async (key: string) =>
    (await new DocumentRepository(h.server.db).nodes.byKey(key)) as NodeRow

  const titleOf = (
    nodes: Array<{ key: string; values: Array<{ property: string; value: unknown }> }>,
    key: string,
  ) => nodes.find((n) => n.key === key)?.values.find((v) => v.property === 'title')?.value

  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const site = pageSite()
    dir = site.root
    h = await signedInServer({
      config: { schemaDir: site.schemaDir, componentsDir: site.componentsDir },
    })
    typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
    const root = await make('Campaigns', null, [
      { alias: 'title', culture: null, segment: null, value: 'Campaigns' },
    ])
    campaigns = await nodeOf(root)
    // The parent must be live before a child can be: an unpublished ancestor
    // would leave a published descendant unreachable, so publish refuses it.
    expect((await h.put(`${V1}/document/${root}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    landing = await make('Landing', root, [
      { alias: 'title', culture: null, segment: null, value: 'Published title' },
    ])
    expect(
      (await h.put(`${V1}/document/${landing}/publish`, { publishSchedules: [] })).status,
    ).toBe(200)
    draft = await make('Draft', root, [
      { alias: 'title', culture: null, segment: null, value: 'Only ever a draft' },
    ])
  })

  afterAll(async () => {
    await h?.db.close().catch(() => {})
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('carries the subtree, parents before children, with keys and aliases only', async () => {
    const { set } = await exportBundle(h.server.db, options([campaigns]))
    expect(set.nodes.map((n) => n.variants[0]?.name)).toEqual(['Campaigns', 'Landing', 'Draft'])
    expect(set.manifest.counts).toEqual({ document: 3 })
    const page = set.nodes.find((n) => n.key === landing)
    expect(page?.contentType.alias).toBe('page')
    expect(page?.parent).toBe(campaigns.key)
    // No integer id anywhere: they differ between environments and keys do not.
    expect(JSON.stringify(set)).not.toContain(`"id":${campaigns.id}`)
  })

  test('--only takes the named node without its descendants', async () => {
    const { set } = await exportBundle(h.server.db, options([campaigns], { descendants: false }))
    expect(set.nodes.map((n) => n.variants[0]?.name)).toEqual(['Campaigns'])
  })

  test('carries published values by default, and the draft with --drafts', async () => {
    // Edit without publishing: the site still serves the old title.
    expect(
      (
        await h.put(`${V1}/document/${landing}`, {
          documentType: { id: typeKey },
          template: null,
          values: [{ alias: 'title', culture: null, segment: null, value: 'Unpublished edit' }],
          variants: [{ culture: null, segment: null, name: 'Landing' }],
        })
      ).status,
    ).toBe(200)

    const published = await exportBundle(h.server.db, options([campaigns]))
    expect(titleOf(published.set.nodes, landing)).toBe('Published title')

    const drafts = await exportBundle(h.server.db, options([campaigns], { snapshot: 'drafts' }))
    expect(titleOf(drafts.set.nodes, landing)).toBe('Unpublished edit')
  })

  test('falls back to the draft for a node that was never published, and says so', async () => {
    const { set } = await exportBundle(h.server.db, options([campaigns]))
    const never = set.nodes.find((n) => n.key === draft)
    // 'Draft' has no published snapshot, so its draft travels…
    expect(never?.values.find((v) => v.property === 'title')?.value).toBe('Only ever a draft')
    // …and the bundle records that it was not live, so an import does not publish it.
    expect(never?.variants[0]?.published).toBe(false)
    expect(set.nodes.find((n) => n.key === landing)?.variants[0]?.published).toBe(true)
  })

  test('records the content types and languages the destination must have', async () => {
    const { set } = await exportBundle(h.server.db, options([campaigns]))
    expect(set.manifest.dependencies.schema.contentTypes.map((t) => t.alias)).toEqual(['page'])
    // The type key travels too: keys are stable across environments, aliases readable.
    expect(set.manifest.dependencies.schema.contentTypes[0]?.key).toBe(typeKey)
  })

  test('records provenance without gating on it', async () => {
    const { set } = await exportBundle(h.server.db, options([campaigns]))
    // Development runs at revision 0, so a revision can never be a gate.
    expect(set.manifest.provenance.schemaRevision).toBeDefined()
    expect(set.manifest.provenance.siteName).toBe('Test')
    expect(set.manifest.selector.roots).toEqual([campaigns.key])
    expect(set.manifest.snapshot).toBe('published')
  })

  test('the parent of a root node is an expected dependency, not a carried one', async () => {
    const page = await nodeOf(landing)
    const { set } = await exportBundle(h.server.db, options([page]))
    expect(set.manifest.dependencies.carried).toEqual([landing])
    expect(set.manifest.dependencies.expected.map((e) => [e.key, e.why])).toEqual([
      [campaigns.key, 'parent of Landing'],
    ])
  })

  test('a picked node outside the selection becomes an expected dependency', async () => {
    const outside = await make('Elsewhere', null)
    const picker = await make('Picker', null, [
      {
        alias: 'related',
        culture: null,
        segment: null,
        value: `umb://document/${outside.replaceAll('-', '')}`,
      },
    ])
    const { set } = await exportBundle(h.server.db, options([await nodeOf(picker)]))
    expect(set.manifest.dependencies.expected.map((e) => e.key)).toContain(outside)
    const value = set.nodes[0]?.values.find((v) => v.property === 'related')
    expect(value?.references).toEqual([outside])
  })

  test('a selection with nothing in it produces an empty bundle rather than throwing', async () => {
    const { set } = await exportBundle(h.server.db, options([]))
    expect(set.nodes).toEqual([])
    expect(set.manifest.counts).toEqual({})
  })
})

describe(`what a bundle must never carry (${dialectUnderTest})`, () => {
  test('no environment-scoped or personal state travels', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const site = pageSite()
    const h = await signedInServer({
      config: { schemaDir: site.schemaDir, componentsDir: site.componentsDir },
    })
    try {
      const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
      const created = await h.post(`${V1}/document`, {
        documentType: { id: typeKey },
        template: null,
        parent: null,
        values: [],
        variants: [{ culture: null, segment: null, name: 'Root' }],
      })
      const key = created.headers.get('umb-generated-resource') as string
      const node = (await new DocumentRepository(h.server.db).nodes.byKey(key)) as NodeRow
      const { set } = await exportBundle(h.server.db, options([node]))
      const text = JSON.stringify(set)

      // A bundle is a file that gets copied about and committed. None of this
      // belongs in one: some of it is personal, and the rest is true of exactly
      // one environment.
      expect(text).not.toContain('admin@bunbraco.local')
      for (const marker of [
        'schema_state',
        'migration_history',
        'cache_instruction',
        'auth_token',
        'user_login_session',
        'public_access',
        'redirect_url',
        'log_viewer_query',
      ])
        expect(text, marker).not.toContain(marker)
      // Members are not a kind the exporter knows how to select.
      for (const kind of ['member', 'user'])
        expect(set.nodes.some((n) => (n.kind as string) === kind)).toBe(false)
    } finally {
      await h.db.close()
      rmSync(site.root, { recursive: true, force: true })
    }
  })
})
