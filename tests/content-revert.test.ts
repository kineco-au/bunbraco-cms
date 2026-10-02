/**
 * `content revert`: putting an import back.
 *
 * The promise is "the site serves what it served before", so these are mostly
 * about published state rather than draft values — and about the two things a
 * revert must refuse to do quietly: discard an edit made since, and undo a run
 * that a later one built on.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContentTypeRepository,
  DocumentRepository,
  type NodeRow,
  TransferRunRepository,
} from '@bunbraco/data'
import {
  type ContentSet,
  checkRevert,
  exportBundle,
  importBundle,
  revertRun,
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
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-revert-'))
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
  title?: string,
) => {
  const created = await h.post(`${V1}/document`, {
    documentType: { id: typeKey },
    template: null,
    parent: parent ? { id: parent } : null,
    values: title ? [{ alias: 'title', culture: null, segment: null, value: title }] : [],
    variants: [{ culture: null, segment: null, name }],
  })
  expect(created.status, `creating ${name}`).toBe(201)
  return created.headers.get('umb-generated-resource') as string
}

const publish = async (h: Harness, key: string) =>
  (await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status

const edit = async (h: Harness, typeKey: string, key: string, name: string, title: string) =>
  (
    await h.put(`${V1}/document/${key}`, {
      documentType: { id: typeKey },
      template: null,
      values: [{ alias: 'title', culture: null, segment: null, value: title }],
      variants: [{ culture: null, segment: null, name }],
    })
  ).status

const docs = (h: Harness) =>
  new DocumentRepository(h.server.db, { nodeState: { version: '1.0.0', revision: '0' } })

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

/** A bundle of one page with a given title, aimed at an existing node. */
const bundleOver = (base: ContentSet, title: string): ContentSet => ({
  manifest: base.manifest,
  nodes: base.nodes.map((n) => ({
    ...n,
    values: n.values.map((v) => (v.property === 'title' ? { ...v, value: title } : v)),
  })),
})

describe(`reverting an import (${dialectUnderTest})`, () => {
  test('recycles what the import created, never deleting it', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Campaigns', null, 'Campaigns')
    await make(source.h, source.typeKey, 'Offer', root, 'Offer')
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)

    const target = await site()
    const imported = await importBundle(target.h.server.db, bundle)
    expect(imported.runId).toBeDefined()

    const result = await revertRun(target.h.server.db, imported.runId as string)
    expect(result.runId).toBeDefined()
    expect(result.recycled).toContain(root)

    // In the bin, not gone: the branch went with it and the root remembers
    // where it came from, so a restore puts it back.
    const node = await nodeOf(target.h, root)
    expect(node.trashed).toBe(true)
    expect(await docs(target.h).originalParent(root)).toBeNull()

    const runs = new TransferRunRepository(target.h.server.db)
    expect((await runs.byId(imported.runId as string))?.status).toBe('reverted')
    expect((await runs.byId(result.runId as string))?.direction).toBe('revert')
  })

  test('restores the values and the published state the site was serving', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Page', null, 'What it served')
    expect(await publish(target.h, key)).toBe(200)

    const base = await exportFrom(target.h, [await nodeOf(target.h, key)])
    const incoming = bundleOver(base, 'From the bundle')
    const imported = await importBundle(target.h.server.db, incoming, {
      resolveAll: 'take-bundle',
      publish: true,
    })
    expect(imported.runId).toBeDefined()
    expect(await docs(target.h).byKeyPublished(key)).toMatchObject({
      values: expect.arrayContaining([expect.objectContaining({ value: 'From the bundle' })]),
    })

    const result = await revertRun(target.h.server.db, imported.runId as string)
    expect(result.runId).toBeDefined()
    // The live site is serving the old value again, not merely holding it as a draft.
    const live = await docs(target.h).byKeyPublished(key)
    expect(live?.values.find((v) => v.alias === 'title')?.value).toBe('What it served')
    expect((await docs(target.h).byKey(key))?.published).toBe(true)
  })

  test('a node that was not published before is not published by the revert', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Draft', null, 'Draft value')
    const base = await exportFrom(target.h, [await nodeOf(target.h, key)], true)
    const imported = await importBundle(target.h.server.db, bundleOver(base, 'Changed'), {
      resolveAll: 'take-bundle',
    })
    await revertRun(target.h.server.db, imported.runId as string)
    // It was a draft before and it is a draft after.
    expect((await docs(target.h).byKey(key))?.published).toBe(false)
  })

  test('refuses to discard an edit made since the import, until asked', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Page', null, 'Original')
    const base = await exportFrom(target.h, [await nodeOf(target.h, key)], true)
    const imported = await importBundle(target.h.server.db, bundleOver(base, 'Imported'), {
      resolveAll: 'take-bundle',
    })
    // An editor gets to it after the import.
    expect(await edit(target.h, target.typeKey, key, 'Page', 'Edited by a person')).toBe(200)

    const refused = await revertRun(target.h.server.db, imported.runId as string)
    expect(refused.runId).toBeUndefined()
    expect(refused.check.outstanding.map((f) => f.code)).toEqual(['edited-since'])
    // Their work is still there, because nothing was written.
    expect(await titleOf(target.h, key)).toBe('Edited by a person')

    // Skipping leaves it alone…
    const skipped = await revertRun(target.h.server.db, imported.runId as string, {
      resolutions: { [key]: 'skip' },
    })
    expect(skipped.runId).toBeDefined()
    expect(await titleOf(target.h, key)).toBe('Edited by a person')
  })

  test('discard goes ahead and reverts over the later edit', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Page', null, 'Original')
    const base = await exportFrom(target.h, [await nodeOf(target.h, key)], true)
    const imported = await importBundle(target.h.server.db, bundleOver(base, 'Imported'), {
      resolveAll: 'take-bundle',
    })
    expect(await edit(target.h, target.typeKey, key, 'Page', 'Edited by a person')).toBe(200)

    const result = await revertRun(target.h.server.db, imported.runId as string, {
      resolveAll: 'discard',
    })
    expect(result.runId).toBeDefined()
    expect(await titleOf(target.h, key)).toBe('Original')
  })

  test('refuses while a later run built on the same content, unless forced', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Page', null, 'Original')
    const base = await exportFrom(target.h, [await nodeOf(target.h, key)], true)
    const first = await importBundle(target.h.server.db, bundleOver(base, 'First'), {
      resolveAll: 'take-bundle',
    })
    const second = await importBundle(target.h.server.db, bundleOver(base, 'Second'), {
      resolveAll: 'take-bundle',
    })
    expect(second.runId).toBeDefined()

    const refused = await revertRun(target.h.server.db, first.runId as string)
    expect(refused.runId).toBeUndefined()
    expect(refused.check.outstanding.map((f) => f.code)).toContain('later-run')

    const forced = await revertRun(target.h.server.db, first.runId as string, {
      force: true,
      resolveAll: 'discard',
    })
    expect(forced.runId).toBeDefined()
  })

  test('a reverted run cannot be reverted twice', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target.h, target.typeKey, 'Page', null, 'Original')
    const base = await exportFrom(target.h, [await nodeOf(target.h, key)], true)
    const imported = await importBundle(target.h.server.db, bundleOver(base, 'Imported'), {
      resolveAll: 'take-bundle',
    })
    expect((await revertRun(target.h.server.db, imported.runId as string)).runId).toBeDefined()
    const again = await revertRun(target.h.server.db, imported.runId as string)
    expect(again.runId).toBeUndefined()
    expect(again.check.outstanding.map((f) => f.code)).toEqual(['run-not-applied'])
  })

  test('the revert is itself a run, and reverting it brings the content back', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Campaigns', null, 'Campaigns')
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)

    const target = await site()
    const imported = await importBundle(target.h.server.db, bundle)
    const reverted = await revertRun(target.h.server.db, imported.runId as string)
    expect((await nodeOf(target.h, root)).trashed).toBe(true)

    // Reverting the revert takes it back out of the bin: the run recorded that
    // it recycled the node, which is more than "restore its values".
    const back = await revertRun(target.h.server.db, reverted.runId as string)
    expect(back.runId).toBeDefined()
    expect((await nodeOf(target.h, root)).trashed).toBe(false)
  })

  test('a run id that does not exist is refused, not ignored', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const check = await checkRevert(target.h.server.db, 'no-such-run')
    expect(check.outstanding.map((f) => f.code)).toEqual(['run-not-applied'])
    expect((await revertRun(target.h.server.db, 'no-such-run')).runId).toBeUndefined()
  })

  test('a node deleted since the import is reported rather than crashing', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const source = await site()
    const root = await make(source.h, source.typeKey, 'Gone', null, 'Gone')
    const bundle = await exportFrom(source.h, [await nodeOf(source.h, root)], true)
    const target = await site()
    const imported = await importBundle(target.h.server.db, bundle)
    // Removed outright, bin and all.
    expect(await docs(target.h).moveToRecycleBin(root)).toBe(true)
    expect(await docs(target.h).delete(root)).toBe(true)

    const result = await revertRun(target.h.server.db, imported.runId as string)
    expect(result.runId).toBeDefined()
    expect(result.check.findings.map((f) => f.code)).toContain('node-gone')
  })
})

async function titleOf(h: Harness, key: string): Promise<unknown> {
  const doc = await docs(h).byKey(key)
  return doc?.values.find((v) => v.alias === 'title')?.value
}
