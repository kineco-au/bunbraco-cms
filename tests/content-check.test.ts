/**
 * `content check`: the dry run that has to happen before an import.
 *
 * Every finding code, and the two rules the whole thing rests on — a blocking
 * finding means the destination cannot honour the bundle as it stands, and a
 * person finding waits for a decision rather than guessing one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, DocumentRepository, type NodeRow } from '@bunbraco/data'
import {
  type BundleNode,
  type ContentSet,
  checkBundle,
  exportBundle,
  loadResolutions,
  resolutionsFor,
  writeResolutions,
} from '@bunbraco/transfer'
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
alias = "related"
name = "Related"
type = "contentPicker"
`

const VIEW = `export default function Page({ model }) {
  return <main>{model.text('title')}</main>
}
`

function pageSite() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-check-'))
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'Views', 'page.tsx'), VIEW)
  return { schemaDir: join(root, 'schema'), viewsDir: join(root, 'Views'), root }
}

const codes = (findings: Array<{ code: string }>) => findings.map((f) => f.code)

describe(`checking a bundle (${dialectUnderTest})`, () => {
  let h: Harness
  let dir: string
  let typeKey: string
  let campaigns: NodeRow
  let landing: string
  /** A bundle of the whole subtree, exported from this very site. */
  let own: ContentSet

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

  /** The exported bundle with one node altered, to stage a particular conflict. */
  const withNode = (mutate: (node: BundleNode) => BundleNode, key = landing): ContentSet => ({
    manifest: own.manifest,
    nodes: own.nodes.map((n) => (n.key === key ? mutate(structuredClone(n)) : n)),
  })

  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const site = pageSite()
    dir = site.root
    h = await signedInServer({ config: { schemaDir: site.schemaDir, viewsDir: site.viewsDir } })
    typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
    const root = await make('Campaigns', null, [
      { alias: 'title', culture: null, segment: null, value: 'Campaigns' },
    ])
    campaigns = await nodeOf(root)
    landing = await make('Landing', root, [
      { alias: 'title', culture: null, segment: null, value: 'Autumn' },
    ])
    own = (
      await exportBundle(h.server.db, {
        roots: [campaigns],
        asGiven: [campaigns.key],
        descendants: true,
        snapshot: 'published',
        blueprints: false,
        withBlobs: false,
        siteName: 'Test',
        nodeId: 'test',
      })
    ).set
  })

  afterAll(async () => {
    await h?.db.close().catch(() => {})
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('a bundle exported from here imports back cleanly and changes nothing', async () => {
    // The identity case. Values are append-only and the check compares them, so
    // re-importing what is already here must be a no-op with nothing to decide.
    const check = await checkBundle(h.server.db, own)
    expect(check.outstanding).toEqual([])
    expect(check.counts).toEqual({ create: 0, update: 0, unchanged: 2, skip: 0 })
  })

  test('a node that is not here yet is a new node, and arrives as a draft', async () => {
    const fresh = { ...own, nodes: own.nodes.map((n) => ({ ...n, key: crypto.randomUUID() })) }
    const check = await checkBundle(h.server.db, fresh)
    expect(codes(check.findings).filter((c) => c === 'new-node')).toHaveLength(2)
    expect(check.counts.create).toBe(2)
    // Both are 'auto': creating content nobody has is not a decision.
    expect(check.outstanding.filter((f) => f.code === 'new-node')).toEqual([])
    expect(check.findings.find((f) => f.code === 'new-node')?.message).toContain('draft')
  })

  test('a node that differs needs a person, and names what would change', async () => {
    const changed = withNode((node) => ({
      ...node,
      values: node.values.map((v) => (v.property === 'title' ? { ...v, value: 'Different' } : v)),
    }))
    const check = await checkBundle(h.server.db, changed)
    const conflict = check.findings.find((f) => f.code === 'local-edit')
    expect(conflict?.kind).toBe('person')
    expect(conflict?.message).toContain('would replace title')
    expect(conflict?.link).toBeNull()
    expect(check.counts.update).toBe(1)
    expect(check.outstanding.map((f) => f.code)).toEqual(['local-edit'])
  })

  test('a resolution answers it, and each choice changes the plan', async () => {
    const changed = withNode((node) => ({
      ...node,
      values: node.values.map((v) => (v.property === 'title' ? { ...v, value: 'Different' } : v)),
    }))
    for (const [resolution, action] of [
      ['take-bundle', 'update'],
      ['keep-local', 'unchanged'],
      ['skip', 'skip'],
    ] as const) {
      const check = await checkBundle(h.server.db, changed, {
        resolutions: { [landing]: resolution },
      })
      expect(check.outstanding, resolution).toEqual([])
      expect(check.plan.find((p) => p.key === landing)?.action, resolution).toBe(action)
    }
  })

  test('--resolve-all answers every one at once', async () => {
    const changed: ContentSet = {
      manifest: own.manifest,
      nodes: own.nodes.map((n) => ({
        ...n,
        values: n.values.map((v) => ({ ...v, value: 'all different' })),
      })),
    }
    expect((await checkBundle(h.server.db, changed)).outstanding).toHaveLength(2)
    const answered = await checkBundle(h.server.db, changed, { resolveAll: 'take-bundle' })
    expect(answered.outstanding).toEqual([])
    expect(answered.counts.update).toBe(2)
  })

  test('a content type the destination has not got is blocking', async () => {
    const elsewhere: ContentSet = {
      manifest: {
        ...own.manifest,
        dependencies: {
          ...own.manifest.dependencies,
          schema: {
            ...own.manifest.dependencies.schema,
            contentTypes: [{ key: crypto.randomUUID(), alias: 'newsArticle' }],
          },
        },
      },
      nodes: own.nodes.map((n) => ({
        ...n,
        key: crypto.randomUUID(),
        contentType: { key: crypto.randomUUID(), alias: 'newsArticle' },
      })),
    }
    const check = await checkBundle(h.server.db, elsewhere)
    const blocking = check.findings.find((f) => f.code === 'missing-content-type')
    expect(blocking?.kind).toBe('blocking')
    expect(blocking?.message).toContain('deploy schema/')
    expect(resolutionsFor('missing-content-type')[0]).toContain('deploy schema/')
  })

  test('a culture the destination has no language for is blocking', async () => {
    const translated = withNode((node) => ({
      ...node,
      key: crypto.randomUUID(),
      variants: [{ culture: 'fr-FR', segment: null, name: 'Atterrissage', published: false }],
    }))
    const check = await checkBundle(h.server.db, translated)
    expect(codes(check.findings)).toContain('language-missing')
    expect(check.findings.find((f) => f.code === 'language-missing')?.kind).toBe('blocking')
  })

  test('a missing parent is blocking, and --under answers it', async () => {
    // A bundle of the child alone expects its parent to be here already.
    const page = await nodeOf(landing)
    const alone = (
      await exportBundle(h.server.db, {
        roots: [page],
        asGiven: [page.key],
        descendants: false,
        snapshot: 'published',
        blueprints: false,
        withBlobs: false,
        siteName: 'Test',
        nodeId: 'test',
      })
    ).set
    // Pretend the parent is not here: a key nothing will resolve to.
    const orphan: ContentSet = {
      manifest: {
        ...alone.manifest,
        dependencies: {
          ...alone.manifest.dependencies,
          expected: [
            {
              key: '00000000-0000-4000-8000-000000000000',
              objectType: '',
              name: 'Campaigns',
              why: 'parent of Landing',
            },
          ],
        },
      },
      nodes: alone.nodes.map((n) => ({ ...n, parent: '00000000-0000-4000-8000-000000000000' })),
    }
    const check = await checkBundle(h.server.db, orphan)
    expect(check.findings.find((f) => f.code === 'missing-parent')?.kind).toBe('blocking')
    expect(resolutionsFor('missing-parent').join(' ')).toContain('--under')

    // Placing it somewhere that does exist settles it.
    const placed = await checkBundle(h.server.db, orphan, { under: campaigns })
    expect(codes(placed.findings)).not.toContain('missing-parent')
  })

  test('a changed property editor is blocking, and a retired property is automatic', async () => {
    const odd = withNode((node) => ({
      ...node,
      key: crypto.randomUUID(),
      values: [
        { property: 'title', culture: null, segment: null, editor: 'Umbraco.Nonsense', value: 'x' },
        { property: 'gone', culture: null, segment: null, editor: 'Umbraco.TextBox', value: 'y' },
      ],
    }))
    const check = await checkBundle(h.server.db, odd)
    expect(check.findings.find((f) => f.code === 'editor-mismatch')?.kind).toBe('blocking')
    const retired = check.findings.find((f) => f.code === 'missing-property')
    expect(retired?.kind).toBe('auto')
    expect(retired?.message).toContain('not imported')
  })

  test('a node in the recycle bin here is blocking rather than silently revived', async () => {
    const doomed = await make('Doomed', campaigns.key)
    const node = await nodeOf(doomed)
    const bundle = (
      await exportBundle(h.server.db, {
        roots: [node],
        asGiven: [node.key],
        descendants: false,
        snapshot: 'published',
        blueprints: false,
        withBlobs: false,
        siteName: 'Test',
        nodeId: 'test',
      })
    ).set
    expect((await h.put(`${V1}/document/${doomed}/move-to-recycle-bin`, {})).status).toBe(200)
    const check = await checkBundle(h.server.db, bundle)
    const trashed = check.findings.find((f) => f.code === 'local-trashed')
    expect(trashed?.kind).toBe('blocking')
    expect(check.plan.find((p) => p.key === doomed)?.action).toBe('skip')
  })

  test('a sibling of the same name is a URL clash a person decides about', async () => {
    const twin = withNode((node) => ({
      ...node,
      key: crypto.randomUUID(),
      parent: campaigns.key,
      variants: [{ culture: null, segment: null, name: 'Landing', published: false }],
    }))
    const check = await checkBundle(h.server.db, twin)
    expect(check.findings.find((f) => f.code === 'name-collision')?.kind).toBe('person')
  })

  test('a template with no view here is automatic, not a blocker', async () => {
    const templated = withNode((node) => ({
      ...node,
      key: crypto.randomUUID(),
      template: 'absent',
    }))
    const check = await checkBundle(h.server.db, templated, {
      templateAliases: new Set(['page']),
    })
    const missing = check.findings.find((f) => f.code === 'missing-template')
    expect(missing?.kind).toBe('auto')
    expect(missing?.message).toContain('Views/absent.tsx')
    // With the view present, nothing is reported.
    const fine = await checkBundle(h.server.db, own, { templateAliases: new Set(['page']) })
    expect(codes(fine.findings)).not.toContain('missing-template')
  })

  test('media whose file is absent needs a person, unless it is allowed', async () => {
    const withMedia: ContentSet = {
      manifest: {
        ...own.manifest,
        blobs: [{ key: 'ab12cd34/hero.jpg', node: landing, etag: null, size: 1, included: false }],
      },
      nodes: own.nodes.map((n) => (n.key === landing ? { ...n, kind: 'media' as const } : n)),
    }
    const hasBlob = async () => false
    const check = await checkBundle(h.server.db, withMedia, { hasBlob })
    expect(check.findings.find((f) => f.code === 'missing-blob')?.kind).toBe('person')
    const allowed = await checkBundle(h.server.db, withMedia, {
      hasBlob,
      allowMissingBlobs: true,
    })
    expect(codes(allowed.findings)).not.toContain('missing-blob')
  })

  test('every finding it raises can say what to do about it', async () => {
    // A finding a person is expected to act on but which suggests nothing is a
    // dead end, so the two lists are kept in step by construction.
    const raised = [
      'local-edit',
      'missing-parent',
      'missing-dependency',
      'missing-content-type',
      'language-missing',
      'editor-mismatch',
      'local-trashed',
      'missing-blob',
      'unresolved-reference',
      'name-collision',
      'missing-template',
    ]
    for (const code of raised) expect(resolutionsFor(code).length, code).toBeGreaterThan(0)
  })
})

describe('resolutions.json', () => {
  test('round trips, and sorts so a commit diff is readable', () => {
    const text = writeResolutions({
      bundleId: 'b1',
      under: null,
      all: null,
      byNode: { zzz: 'skip', aaa: 'take-bundle' },
    })
    expect(Object.keys(JSON.parse(text).byNode)).toEqual(['aaa', 'zzz'])
  })

  test('answers to a different bundle are ignored rather than applied', () => {
    const dir = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-res-'))
    try {
      writeFileSync(
        join(dir, 'resolutions.json'),
        writeResolutions({ bundleId: 'other', under: null, all: null, byNode: { a: 'skip' } }),
      )
      const loaded = loadResolutions(dir, 'mine')
      expect(loaded.file).toBeUndefined()
      expect(loaded.problems[0]).toContain('answers bundle other')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a resolution that is not one of the three is reported, not guessed', () => {
    const dir = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-res-'))
    try {
      writeFileSync(
        join(dir, 'resolutions.json'),
        JSON.stringify({ bundleId: 'mine', byNode: { a: 'whatever' } }),
      )
      const loaded = loadResolutions(dir, 'mine')
      expect(loaded.file?.byNode).toEqual({})
      expect(loaded.problems[0]).toContain('no usable resolution')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a bundle with no resolutions file is not a problem', () => {
    const loaded = loadResolutions(join('output', 'no-such-dir'), 'mine')
    expect(loaded.file).toBeUndefined()
    expect(loaded.problems).toEqual([])
  })
})
