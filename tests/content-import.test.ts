/**
 * `content import`: applying a bundle.
 *
 * The cases that matter are the ones where getting it wrong is quiet — the
 * overlay (a bundle that omits a property must not clear it), idempotence, and
 * atomicity. The rest is ordinary CRUD through the repository.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@bunbraco/core'
import {
  ContentTypeRepository,
  DocumentRepository,
  type NodeRow,
  TransferRunRepository,
} from '@bunbraco/data'
import { type BundleNode, type ContentSet, exportBundle, importBundle } from '@bunbraco/transfer'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const PAGE_TOML = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
templates = ["page"]
default-template = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"

[[property]]
alias = "summary"
name = "Summary"
type = "textarea"

[[property]]
alias = "related"
name = "Related"
type = "contentPicker"
`

const VIEW = `export default function Page({ model }) {
  return <main>{model.text('title')}</main>
}
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

async function site(): Promise<{ h: Harness; typeKey: string }> {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-import-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'Views', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), viewsDir: join(root, 'Views') },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  return { h, typeKey }
}

const make = async (
  h: Harness,
  typeKey: string,
  name: string,
  parent: string | null,
  values: unknown[] = [],
) => {
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

const nodeOf = async (h: Harness, key: string) =>
  (await new DocumentRepository(h.server.db).nodes.byKey(key)) as NodeRow

const exportFrom = async (h: Harness, roots: NodeRow[], drafts = false): Promise<ContentSet> =>
  (
    await exportBundle(h.server.db, {
      roots,
      asGiven: roots.map((r) => r.key),
      descendants: true,
      snapshot: drafts ? 'drafts' : 'published',
      blueprints: false,
      withBlobs: false,
      siteName: 'Source',
      nodeId: 'source',
    })
  ).set

const readValue = async (h: Harness, key: string, alias: string) => {
  const docs = new DocumentRepository(h.server.db, {
    nodeState: { version: '1.0.0', revision: '0' },
  })
  const doc = await docs.byKey(key)
  return doc?.values.find((v) => v.alias === alias)?.value
}

describe(`importing a bundle (${dialectUnderTest})`, () => {
  test('creates what is not here, as a draft, and records the run', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Campaigns', null, [
      { alias: 'title', culture: null, segment: null, value: 'Campaigns' },
    ])
    const child = await make(source.h, source.typeKey, 'Offer A', root, [
      { alias: 'title', culture: null, segment: null, value: 'Offer A' },
    ])
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)

    // A second site, with the same schema and no content.
    const target = await site()
    const result = await importBundle(target.h.server.db, bundle, { nodeId: 'target' })
    expect(result.runId).toBeDefined()
    expect(result.check.counts.create).toBe(2)

    expect(await readValue(target.h, child, 'title')).toBe('Offer A')
    const imported = await new DocumentRepository(target.h.server.db).byKey(child)
    // Drafts: nothing is live until somebody says so.
    expect(imported?.published).toBe(false)

    const runs = new TransferRunRepository(target.h.server.db)
    const run = await runs.byId(result.runId as string)
    expect(run).toMatchObject({ direction: 'import', status: 'applied', appliedBy: 'target' })
    const changes = await runs.changes(result.runId as string)
    expect(changes).toHaveLength(2)
    // Created nodes have no "before", which is how revert knows to recycle them.
    for (const change of changes) {
      expect(change.action).toBe('create')
      expect(change.beforeEventId).toBeNull()
      expect(change.eventId).not.toBeNull()
    }
  })

  test('a bundle that omits a property does not clear it', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    // The quiet failure this whole design guards against: `#appendValues`
    // clears anything current that is absent from what it is given, so a
    // partial bundle imported as-is would empty fields nobody was looking at.
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Page', null, [
      { alias: 'title', culture: null, segment: null, value: 'Local title' },
      { alias: 'summary', culture: null, segment: null, value: 'Local summary' },
    ])

    const partial: ContentSet = {
      manifest: (await exportFrom(target.h, [await nodeOf(target.h, key)], true)).manifest,
      nodes: [
        {
          key,
          kind: 'document',
          contentType: { key: target.typeKey, alias: 'page' },
          parent: null,
          sortOrder: 0,
          template: null,
          variants: [{ culture: null, segment: null, name: 'Page', published: false }],
          values: [
            {
              property: 'title',
              culture: null,
              segment: null,
              editor: 'Umbraco.TextBox',
              value: 'From the bundle',
            },
          ],
        } satisfies BundleNode,
      ],
    }

    const result = await importBundle(target.h.server.db, partial, {
      resolveAll: 'take-bundle',
    })
    expect(result.runId).toBeDefined()
    expect(await readValue(target.h, key, 'title')).toBe('From the bundle')
    expect(await readValue(target.h, key, 'summary')).toBe('Local summary')
  })

  test('importing the same bundle twice changes nothing the second time', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Once', null, [
      { alias: 'title', culture: null, segment: null, value: 'Once' },
    ])
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)

    const target = await site()
    const first = await importBundle(target.h.server.db, bundle)
    expect(first.check.counts.create).toBe(1)
    const second = await importBundle(target.h.server.db, bundle)
    // Values are append-only and the repository appends only differences, so a
    // re-import has nothing to do and nothing to decide.
    expect(second.check.counts).toMatchObject({ create: 0, update: 0, unchanged: 1 })
    expect(second.check.outstanding).toEqual([])
  })

  test('refuses outright while anything is outstanding, writing nothing', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Page', null, [
      { alias: 'title', culture: null, segment: null, value: 'Local' },
    ])
    const bundle = await exportFrom(target.h, [await nodeOf(target.h, key)], true)
    const conflicting: ContentSet = {
      manifest: bundle.manifest,
      nodes: bundle.nodes.map((n) => ({
        ...n,
        values: n.values.map((v) => ({ ...v, value: 'Changed elsewhere' })),
      })),
    }
    const refused = await importBundle(target.h.server.db, conflicting)
    expect(refused.runId).toBeUndefined()
    expect(refused.check.outstanding.map((f) => f.code)).toEqual(['local-edit'])
    // Nothing was written, so the value still stands.
    expect(await readValue(target.h, key, 'title')).toBe('Local')
    expect(await new TransferRunRepository(target.h.server.db).recent()).toEqual([])
  })

  test('a resolution of keep-local leaves the node exactly as it was', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Page', null, [
      { alias: 'title', culture: null, segment: null, value: 'Local' },
    ])
    const bundle = await exportFrom(target.h, [await nodeOf(target.h, key)], true)
    const conflicting: ContentSet = {
      manifest: bundle.manifest,
      nodes: bundle.nodes.map((n) => ({
        ...n,
        values: n.values.map((v) => ({ ...v, value: 'Changed elsewhere' })),
      })),
    }
    const result = await importBundle(target.h.server.db, conflicting, {
      resolutions: { [key]: 'keep-local' },
    })
    expect(result.runId).toBeDefined()
    expect(await readValue(target.h, key, 'title')).toBe('Local')
  })

  test('cyclic references need no ordering: both pages exist before any value is written', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const a = await make(source.h, source.typeKey, 'A', null)
    const b = await make(source.h, source.typeKey, 'B', null)
    // A points at B and B points at A: no order exists that satisfies both in
    // one pass, which is why the import creates every node first.
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      expect(
        (
          await source.h.put(`${V1}/document/${from}`, {
            documentType: { id: source.typeKey },
            template: null,
            values: [
              {
                alias: 'related',
                culture: null,
                segment: null,
                value: `umb://document/${to.replaceAll('-', '')}`,
              },
            ],
            variants: [{ culture: null, segment: null, name: from === a ? 'A' : 'B' }],
          })
        ).status,
      ).toBe(200)
    }
    const bundle = await exportFrom(
      source.h,
      [await nodeOf(source.h, a), await nodeOf(source.h, b)],
      true,
    )

    const target = await site()
    const result = await importBundle(target.h.server.db, bundle)
    expect(result.runId).toBeDefined()
    expect(String(await readValue(target.h, a, 'related'))).toContain(b.replaceAll('-', ''))
    expect(String(await readValue(target.h, b, 'related'))).toContain(a.replaceAll('-', ''))
  })

  test('--publish publishes what was live at the source, parents first', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Campaigns', null, [
      { alias: 'title', culture: null, segment: null, value: 'Campaigns' },
    ])
    expect(
      (await source.h.put(`${V1}/document/${root}/publish`, { publishSchedules: [] })).status,
    ).toBe(200)
    const live = await make(source.h, source.typeKey, 'Live', root, [
      { alias: 'title', culture: null, segment: null, value: 'Live' },
    ])
    expect(
      (await source.h.put(`${V1}/document/${live}/publish`, { publishSchedules: [] })).status,
    ).toBe(200)
    const draft = await make(source.h, source.typeKey, 'Draft', root, [
      { alias: 'title', culture: null, segment: null, value: 'Draft' },
    ])
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)])

    const target = await site()
    const result = await importBundle(target.h.server.db, bundle, { publish: true })
    expect(result.publishFailures).toEqual([])
    // The parent had to go live first or the child's publish would be refused.
    expect(result.published).toEqual([root, live])
    const docs = new DocumentRepository(target.h.server.db)
    expect((await docs.byKey(live))?.published).toBe(true)
    // What was only a draft at the source stays a draft here.
    expect((await docs.byKey(draft))?.published).toBe(false)
  })

  test('a run is listed, newest first, with what it touched', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'One', null)
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)
    const target = await site()
    await importBundle(target.h.server.db, bundle, { label: 'first' })
    const runs = await new TransferRunRepository(target.h.server.db).recent()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ bundleLabel: 'first', nodeCount: 1, direction: 'import' })
    expect(runs[0]?.finishedAt).toBeInstanceOf(Date)
  })

  test('a node whose type the manifest never declared is refused, not quietly dropped', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Real', null)
    const bundle = await exportFrom(target.h, [await nodeOf(target.h, key)], true)
    // The manifest still lists only `page`, so nothing above this node's own
    // entry says the type is needed — the shape a hand-edited bundle takes.
    const inconsistent: ContentSet = {
      manifest: bundle.manifest,
      nodes: [
        {
          ...(bundle.nodes[0] as BundleNode),
          key: crypto.randomUUID(),
          contentType: { key: crypto.randomUUID(), alias: 'neverHeardOf' },
          // A name of its own, so the only thing wrong with it is the type.
          variants: [{ culture: null, segment: null, name: 'Undeclared', published: false }],
        },
      ],
    }
    const result = await importBundle(target.h.server.db, inconsistent)
    expect(result.runId).toBeUndefined()
    expect(result.check.outstanding.map((f) => f.code)).toEqual(['missing-content-type'])
    expect(result.check.outstanding[0]?.message).toContain('never declared')
  })

  test('joins an enclosing transaction, so a later failure leaves nothing behind', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Doomed', null, [
      { alias: 'title', culture: null, segment: null, value: 'Doomed' },
    ])
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)

    const target = await site()
    const db = target.h.server.db
    // The import takes one transaction for the run, and both dialects join an
    // enclosing one — so an import inside a transaction that then fails is
    // undone whole, which is what "it cannot half-land" rests on.
    await expect(
      db.transaction(async (tx) => {
        const result = await importBundle(tx, bundle)
        expect(result.runId).toBeDefined()
        throw new Error('something later went wrong')
      }),
    ).rejects.toThrow('something later went wrong')

    expect(await new DocumentRepository(db).byKey(root)).toBeUndefined()
    expect(await new TransferRunRepository(db).recent()).toEqual([])
  })

  test('a node the bundle says to skip is neither written nor recorded as changed', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Keep', null, [
      { alias: 'title', culture: null, segment: null, value: 'Keep' },
    ])
    const skipped = await make(source.h, source.typeKey, 'Leave', root, [
      { alias: 'title', culture: null, segment: null, value: 'Leave' },
    ])
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)

    const target = await site()
    const result = await importBundle(target.h.server.db, bundle, {
      resolutions: { [skipped]: 'skip' },
    })
    expect(result.runId).toBeDefined()
    expect(await new DocumentRepository(target.h.server.db).byKey(skipped)).toBeUndefined()
    const changes = await new TransferRunRepository(target.h.server.db).changes(
      result.runId as string,
    )
    expect(changes.map((c) => c.nodeKey)).toEqual([root])
  })

  test('the order siblings sit in travels, and what was already here keeps its place', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Home', null)
    const first = await make(source.h, source.typeKey, 'First', root)
    const second = await make(source.h, source.typeKey, 'Second', root)
    const third = await make(source.h, source.typeKey, 'Third', root)
    // An editor's order, which is not the order they were created in — so the
    // assertion below cannot pass by accident.
    // A repository with no state reads and writes at the install baseline, which
    // the database is past: the site's own state is what a tool uses.
    const sorter = new DocumentRepository(source.h.server.db, {
      nodeState: { version: '1.0.0', revision: '0' },
    })
    expect(
      await sorter.sort(root, [
        { key: third, sortOrder: 0 },
        { key: first, sortOrder: 1 },
        { key: second, sortOrder: 2 },
      ]),
    ).toBe('sorted')
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)

    const target = await site()
    // A sibling of the incoming root that was here first.
    const local = await make(target.h, target.typeKey, 'Already here', null)
    const result = await importBundle(target.h.server.db, bundle, { nodeId: 'target' })
    expect(result.runId).toBeDefined()

    const docs = new DocumentRepository(target.h.server.db)
    const children = async (parent: string | null) => (await docs.children(parent, 0, 50)).items
    expect((await children(root)).map((item) => item.text)).toEqual(['Third', 'First', 'Second'])
    // Imported content is appended, not interleaved: the local root stays put.
    const roots = await children(null)
    expect(roots.map((item) => item.text)).toEqual(['Already here', 'Home'])
    expect(roots[0]?.key).toBe(local)
  })

  test('media travels, although its type lives outside the document types', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const upload = crypto.randomUUID()
    const form = new FormData()
    form.set('Id', upload)
    form.set('File', new File([new Uint8Array([1, 2, 3, 4])], 'photo.png'))
    expect(
      (await source.h.call(`${V1}/temporary-file`, { method: 'POST', body: form })).status,
    ).toBe(201)
    const created = await source.h.post(`${V1}/media`, {
      mediaType: { id: SYSTEM_MEDIA_TYPE_KEYS.Image },
      parent: null,
      values: [
        {
          alias: 'umbracoFile',
          culture: null,
          segment: null,
          value: { src: '', temporaryFileId: upload, crops: [], focalPoint: null },
        },
      ],
      variants: [{ culture: null, segment: null, name: 'Photo' }],
    })
    expect(created.status).toBe(201)
    const photo = created.headers.get('umb-generated-resource') as string
    const page = await make(source.h, source.typeKey, 'Page', null)

    const bundle = await exportFrom(
      source.h,
      [await nodeOf(source.h, page), await nodeOf(source.h, photo)],
      true,
    )
    expect(bundle.manifest.counts.media).toBe(1)

    // A media type is a different object type, so a check resolving content
    // types only among document types refused this outright.
    const target = await site()
    const result = await importBundle(target.h.server.db, bundle, { nodeId: 'target' })
    expect(result.check.findings.filter((f) => f.kind === 'blocking')).toEqual([])
    expect(result.runId).toBeDefined()

    const media = new DocumentRepository(target.h.server.db, {
      kind: 'media',
      nodeState: { version: '1.0.0', revision: '0' },
    })
    const landed = await media.byKey(photo)
    expect(landed?.variants[0]?.name).toBe('Photo')
    const file = landed?.values.find((v) => v.alias === 'umbracoFile')?.value as
      | { src: string }
      | undefined
    expect(file?.src).toContain('photo.png')
  })
})
