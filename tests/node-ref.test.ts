/**
 * `--root` on export and `--under` on check and import both name a node, by
 * uuid or by a path through the tree. One resolver serves all three so they
 * cannot drift, and these are its rules.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ObjectTypes } from '@bunbraco/core'
import {
  ContentTypeRepository,
  DocumentRepository,
  describeRefFailure,
  type NodeRow,
  resolveNodeRef,
} from '@bunbraco/data'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const DOCUMENTS = [ObjectTypes.Document]

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
`

const VIEW = `export default function Page({ model }) {
  return <main>{model.text('title')}</main>
}
`

/** A site whose only document type nests under itself, so paths have depth. */
export function pageSite(): { schemaDir: string; componentsDir: string; root: string } {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-ref-'))
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  return { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components'), root }
}

describe(`naming a node (${dialectUnderTest})`, () => {
  let h: Harness
  let dir: string
  let root: string
  let child: string
  const keys = new Map<string, string>()

  const make = async (name: string, parent: string | null): Promise<string> => {
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: null,
      parent: parent ? { id: parent } : null,
      values: [],
      variants: [{ culture: null, segment: null, name }],
    })
    expect(created.status, `creating ${name}`).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    keys.set(name, key)
    return key
  }

  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const site = pageSite()
    dir = site.root
    h = await signedInServer({
      config: { schemaDir: site.schemaDir, componentsDir: site.componentsDir },
    })
    root = await make('Campaigns', null)
    child = await make('Autumn 2026', root)
    // Two siblings of one name, to prove ambiguity is refused rather than guessed.
    const twins = await make('Twins', null)
    await make('Same', twins)
    await make('Same', twins)
    // A branch with a trashed child, so the bin can be shown to be excluded.
    const retired = await make('Retired', null)
    const gone = await make('Gone', retired)
    expect((await h.put(`${V1}/document/${gone}/move-to-recycle-bin`, {})).status).toBe(200)
  })

  afterAll(async () => {
    await h?.db.close().catch(() => {})
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('resolves a uuid', async () => {
    const resolved = await resolveNodeRef(h.server.db, DOCUMENTS, root)
    expect(resolved.ok && resolved.node.key).toBe(root)
  })

  test('resolves a path, with the leading slash optional and case ignored', async () => {
    for (const ref of [
      '/Campaigns/Autumn 2026',
      'Campaigns/Autumn 2026',
      '/campaigns/AUTUMN 2026',
    ]) {
      const resolved = await resolveNodeRef(h.server.db, DOCUMENTS, ref)
      expect(resolved.ok && resolved.node.key, ref).toBe(child)
    }
  })

  test('never reads a uuid-shaped argument as a path', async () => {
    // Otherwise a key that happened to match a node name would be ambiguous.
    const missing = '00000000-0000-4000-8000-000000000000'
    const resolved = await resolveNodeRef(h.server.db, DOCUMENTS, missing)
    expect(resolved.ok).toBe(false)
    expect(describeRefFailure(missing, resolved)).toContain('no node with that key')
  })

  test('names what was there when a path segment matches nothing', async () => {
    const resolved = await resolveNodeRef(h.server.db, DOCUMENTS, '/Campaigns/Winter')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe('not-found')
    expect(resolved.at).toBe('Winter')
    expect(resolved.candidates).toContain('Autumn 2026')
    expect(describeRefFailure('/Campaigns/Winter', resolved)).toContain('"Autumn 2026"')
  })

  test('refuses an ambiguous path with the keys that would tell them apart', async () => {
    const resolved = await resolveNodeRef(h.server.db, DOCUMENTS, '/Twins/Same')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe('ambiguous')
    expect(resolved.candidates).toHaveLength(2)
    expect(describeRefFailure('/Twins/Same', resolved)).toContain('more than one node')
  })

  test('does not resolve a trashed node by path, so a bundle cannot be rooted in the bin', async () => {
    expect((await resolveNodeRef(h.server.db, DOCUMENTS, '/Retired/Gone')).ok).toBe(false)
    // By key it is still findable: the bin is a place in the tree, not a deletion.
    expect((await resolveNodeRef(h.server.db, DOCUMENTS, keys.get('Gone') as string)).ok).toBe(true)
  })

  test('an empty reference resolves to nothing rather than the tree root', async () => {
    for (const ref of ['', '/', '   ']) {
      expect((await resolveNodeRef(h.server.db, DOCUMENTS, ref)).ok, ref).toBe(false)
    }
  })

  test('only looks at the object types it was given', async () => {
    // A document path must not resolve through the media tree.
    expect((await resolveNodeRef(h.server.db, [ObjectTypes.Media], '/Campaigns')).ok).toBe(false)
  })

  test('descendants come back parents first, and exclude the trashed', async () => {
    const nodes = new DocumentRepository(h.server.db).nodes
    const twins = (await nodes.byKey(keys.get('Twins') as string)) as NodeRow
    const under = await nodes.descendants(twins, DOCUMENTS)
    expect(under.map((n) => n.text)).toEqual(['Same', 'Same'])
    for (const row of under) expect(row.level).toBeGreaterThan(twins.level)

    // 'Gone' is in the bin, so the branch it was in reports no descendants.
    const retired = (await nodes.byKey(keys.get('Retired') as string)) as NodeRow
    expect(await nodes.descendants(retired, DOCUMENTS)).toEqual([])
  })
})
