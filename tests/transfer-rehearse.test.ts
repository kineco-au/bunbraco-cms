/**
 * Stories 101 and 102: the dry run names the pages `--publish` would refuse,
 * in the import's own words, and a conflict is answered property by property.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContentTypeRepository,
  DocumentRepository,
  type NodeRow,
  TransferRunRepository,
} from '@crombolo/data'
import { checkBundleContent, VERSION } from '@crombolo/server'
import {
  answerFor,
  type BundleNode,
  type ContentSet,
  checkBundle,
  exportBundle,
  importBundle,
  mergeResolutions,
  nodeResolutionProblems,
  parseResolveFlags,
  rehearsePublish,
  revertRun,
  writeBundle,
  writeBundlePackage,
} from '@crombolo/transfer'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const PAGE_TOML = `[content-type]
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
mandatory = true

[[property]]
alias = "summary"
name = "Summary"
type = "textarea"
`

const ARTICLE_TOML = `[content-type]
alias = "article"
name = "Article"
allow-at-root = true
components = ["page"]
default-component = "page"
varies-by-culture = true

[[property]]
alias = "heading"
name = "Heading"
type = "textstring"
varies-by-culture = true
`

const VIEW = `export default function Page({ model }) {
  return <main>{model.name}</main>
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

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'transfer-rehearse-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'schema', 'content-types', 'article.toml'), ARTICLE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const danish = await h.post(`${V1}/language`, {
    isoCode: 'da-DK',
    name: 'Danish',
    isDefault: false,
    isMandatory: false,
    fallbackIsoCode: null,
  })
  expect(danish.status).toBe(201)
  const types = new ContentTypeRepository(h.server.db)
  const page = (await types.byAlias('page'))?.key as string
  const article = (await types.byAlias('article'))?.key as string
  return { h, root, page, article }
}

type Site = Awaited<ReturnType<typeof site>>

const text = (alias: string, value: string, culture: string | null = null) => ({
  alias,
  culture,
  segment: null,
  value,
})

async function make(
  s: Site,
  name: string,
  parent: string | null,
  values: unknown[],
  options: { type?: string; culture?: string } = {},
): Promise<string> {
  const created = await s.h.post(`${V1}/document`, {
    documentType: { id: options.type ?? s.page },
    template: null,
    parent: parent ? { id: parent } : null,
    values,
    variants: [{ culture: options.culture ?? null, segment: null, name }],
  })
  expect(created.status, `creating ${name}`).toBe(201)
  return created.headers.get('umb-generated-resource') as string
}

const nodeOf = async (s: Site, key: string) =>
  (await new DocumentRepository(s.h.server.db).nodes.byKey(key)) as NodeRow

async function exportFrom(s: Site, keys: string[]): Promise<ContentSet> {
  const roots = await Promise.all(keys.map((key) => nodeOf(s, key)))
  return (
    await exportBundle(s.h.server.db, {
      roots,
      asGiven: keys,
      descendants: true,
      snapshot: 'drafts',
      blueprints: false,
      withBlobs: false,
      siteName: 'Source',
      nodeId: 'source',
    })
  ).set
}

/** Marks each named node live or not at the source, as a published export would. */
const live = (set: ContentSet, states: Record<string, boolean>): ContentSet => ({
  ...set,
  nodes: set.nodes.map((node) =>
    node.key in states
      ? {
          ...node,
          variants: node.variants.map((v) => ({ ...v, published: states[node.key] === true })),
        }
      : node,
  ),
})

const readValue = async (s: Site, key: string, alias: string) =>
  (
    await new DocumentRepository(s.h.server.db, {
      nodeState: { version: '1.0.0', revision: '0' },
    }).byKey(key)
  )?.values.find((v) => v.alias === alias)?.value

/** A bundle with one page of each refusal, and a child whose parent the same run publishes. */
async function refusingBundle() {
  const source = await site()
  const hidden = await make(source, 'Hidden parent', null, [text('title', 'Hidden')])
  const orphan = await make(source, 'Orphan', hidden, [text('title', 'Orphan')])
  const empty = await make(source, 'Empty', null, [text('title', 'Soon gone')])
  const danish = await make(source, 'Kun dansk', null, [text('heading', 'Hej', 'da-DK')], {
    type: source.article,
    culture: 'da-DK',
  })
  const parent = await make(source, 'Live parent', null, [text('title', 'Parent')])
  const child = await make(source, 'Live child', parent, [text('title', 'Child')])
  const exported = await exportFrom(source, [hidden, empty, danish, parent])
  const set = live(exported, {
    [hidden]: false,
    [orphan]: true,
    [empty]: true,
    [danish]: true,
    [parent]: true,
    [child]: true,
  })
  // Closed before the target boots: on Postgres the two share one database,
  // which the target's boot empties, and the source's background work would
  // otherwise be reading while it does.
  await source.h.db.close()
  set.nodes = set.nodes.map((node) =>
    node.key === empty
      ? { ...node, values: node.values.filter((v) => v.property !== 'title') }
      : node,
  )
  return { set, keys: { hidden, orphan, empty, danish, parent, child } }
}

describe(`the dry run predicts publish refusals (${dialectUnderTest})`, () => {
  test('the rehearsal names what the import refuses, word for word, and writes nothing', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { set, keys } = await refusingBundle()
    const target = await site()
    const db = target.h.server.db

    const predicted = await rehearsePublish(db, set)
    expect(predicted?.map((r) => r.key).sort()).toEqual(
      [keys.orphan, keys.empty, keys.danish].sort(),
    )
    const reason = (key: string) => predicted?.find((r) => r.key === key)?.reason
    expect(reason(keys.orphan)).toBe('An ancestor is not published.')
    expect(reason(keys.empty)).toContain('Title')
    expect(reason(keys.danish)).toContain('en-US')
    // Rolled back: no page, no run.
    expect(await new DocumentRepository(db).byKey(keys.orphan)).toBeUndefined()
    expect(await new TransferRunRepository(db).recent()).toEqual([])

    const imported = await importBundle(db, set, { publish: true })
    expect(imported.publishFailures).toEqual(predicted as never)
    // The child's parent goes live earlier in the same run, so it is not refused.
    expect(imported.published).toContain(keys.child)
  })

  test('nothing is predicted while the check has something outstanding', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const target = await site()
    const key = await make(target, 'Page', null, [text('title', 'Local')])
    const exported = await exportFrom(target, [key])
    const conflicting = live(
      {
        ...exported,
        nodes: exported.nodes.map((n) => ({
          ...n,
          values: n.values.map((v) => ({ ...v, value: 'Elsewhere' })),
        })),
      },
      { [key]: true },
    )
    expect(await rehearsePublish(target.h.server.db, conflicting)).toBeUndefined()
  })

  test('a rehearsal refuses to run inside another transaction', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { set } = await refusingBundle()
    const target = await site()
    await expect(target.h.server.db.transaction((tx) => rehearsePublish(tx, set))).rejects.toThrow(
      'cannot run inside another transaction',
    )
  })

  test('the check reports each refusal as a finding when --publish is asked for', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { set, keys } = await refusingBundle()
    const target = await site()
    const dir = join(target.root, 'bundle')
    const info = {
      name: 'rehearsal',
      version: '1.0.0',
      id: 'rehearsal',
      label: 'Rehearsal',
      peerRange: `^${VERSION}`,
    }
    for (const file of writeBundlePackage(writeBundle(set), info)) {
      mkdirSync(join(dir, file.path, '..'), { recursive: true })
      writeFileSync(join(dir, file.path), file.bytes ?? (file.text as string))
    }
    const config = target.h.server.config
    const quiet = await checkBundleContent(target.h.server.db, config, { bundle: dir })
    expect(quiet.publishRefusals).toEqual([])

    const result = await checkBundleContent(target.h.server.db, config, {
      bundle: dir,
      publish: true,
    })
    expect(result.publishRefusals.map((r) => r.key).sort()).toEqual(
      [keys.orphan, keys.empty, keys.danish].sort(),
    )
    const findings = result.check.findings.filter((f) => f.code === 'publish-refused')
    expect(findings.map((f) => f.message)).toContain(
      '"Orphan" would not be published: An ancestor is not published.',
    )
    // A prediction is not a decision: the import is still free to go ahead.
    expect(result.clean).toBe(true)
  })
})

/** A page here and the same page in a bundle that disagrees with both of its properties. */
async function conflicted() {
  const target = await site()
  const key = await make(target, 'Page', null, [
    text('title', 'Local title'),
    text('summary', 'Local summary'),
  ])
  const exported = await exportFrom(target, [key])
  const set: ContentSet = {
    ...exported,
    nodes: exported.nodes.map(
      (n): BundleNode => ({
        ...n,
        values: n.values.map((v) => ({
          ...v,
          value: v.property === 'title' ? 'Bundle title' : 'Bundle summary',
        })),
      }),
    ),
  }
  return { target, key, set }
}

describe(`per-property resolutions (${dialectUnderTest})`, () => {
  test('the dry run asks once per property that differs', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { target, key, set } = await conflicted()
    const check = await checkBundle(target.h.server.db, set)
    expect(check.outstanding.map((f) => [f.code, f.propertyAlias])).toEqual([
      ['local-edit', 'title'],
      ['local-edit', 'summary'],
    ])
    expect(check.outstanding[0]?.message).toBe(
      `"Page" is already here and its title differs from the bundle's`,
    )

    const half = await checkBundle(target.h.server.db, set, {
      resolutions: { [key]: { title: 'keep-local' } },
    })
    expect(half.outstanding.map((f) => f.propertyAlias)).toEqual(['summary'])
  })

  test('a mix of answers writes one version holding each chosen value, and reverts whole', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { target, key, set } = await conflicted()
    const db = target.h.server.db
    const before = await new DocumentRepository(db).eventMarkers(key)

    const result = await importBundle(db, set, {
      resolutions: { [key]: { title: 'keep-local', summary: 'take-bundle' } },
    })
    expect(result.runId).toBeDefined()
    expect(await readValue(target, key, 'title')).toBe('Local title')
    expect(await readValue(target, key, 'summary')).toBe('Bundle summary')
    const changes = await new TransferRunRepository(db).changes(result.runId as string)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ action: 'update', beforeEventId: before?.head })

    const reverted = await revertRun(db, result.runId as string)
    expect(reverted.runId).toBeDefined()
    expect(await readValue(target, key, 'title')).toBe('Local title')
    expect(await readValue(target, key, 'summary')).toBe('Local summary')
  })

  test('a node-level answer covers the properties not named', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { target, key, set } = await conflicted()
    const result = await importBundle(target.h.server.db, set, {
      resolutions: { [key]: { '*': 'take-bundle', title: 'keep-local' } },
    })
    expect(result.check.outstanding).toEqual([])
    expect(await readValue(target, key, 'title')).toBe('Local title')
    expect(await readValue(target, key, 'summary')).toBe('Bundle summary')
  })

  test('keeping every differing property here writes nothing', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const { target, key, set } = await conflicted()
    const db = target.h.server.db
    const before = await new DocumentRepository(db).eventMarkers(key)
    const result = await importBundle(db, set, {
      resolutions: { [key]: { title: 'keep-local', summary: 'keep-local' } },
    })
    expect(result.runId).toBeDefined()
    expect((await new DocumentRepository(db).eventMarkers(key))?.head).toBe(before?.head)
  })
})

describe('resolution answers', () => {
  const key = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

  test('--resolve takes a node or one property, with or without a culture', () => {
    expect(
      parseResolveFlags([
        `${key}=take-bundle`,
        `${key}/title=keep-local`,
        `${key}/heading@da-DK=keep-local`,
      ]),
    ).toEqual({
      byNode: { [key]: { '*': 'take-bundle', title: 'keep-local', 'heading@da-DK': 'keep-local' } },
      problems: [],
    })
  })

  test('--resolve names what it cannot read', () => {
    const { byNode, problems } = parseResolveFlags([
      'nonsense',
      `${key}/=keep-local`,
      `${key}/title=maybe`,
      `${key}/title=skip`,
    ])
    expect(byNode).toEqual({})
    expect(problems).toHaveLength(4)
    expect(problems[0]).toContain('"nonsense"')
  })

  test('only a whole node can be skipped', () => {
    expect(nodeResolutionProblems(key, { '*': 'skip' })).toEqual([])
    expect(nodeResolutionProblems(key, { title: 'skip' })).toHaveLength(1)
  })

  test('the most specific answer wins: culture, then property, then node, then all', () => {
    const answers = { '*': 'skip', title: 'keep-local', 'title@da-DK': 'take-bundle' } as const
    expect(answerFor(answers, 'title', 'da-DK', undefined)).toBe('take-bundle')
    expect(answerFor(answers, 'title', 'en-US', undefined)).toBe('keep-local')
    expect(answerFor(answers, 'summary', null, undefined)).toBe('skip')
    expect(answerFor({}, 'summary', null, 'take-bundle')).toBe('take-bundle')
    expect(answerFor(undefined, 'summary', null, undefined)).toBeUndefined()
  })

  test('answers merge node by node, the later over the earlier', () => {
    expect(
      mergeResolutions(
        { a: { '*': 'keep-local', title: 'keep-local' }, b: { '*': 'skip' } },
        { a: { title: 'take-bundle' } },
      ),
    ).toEqual({ a: { '*': 'keep-local', title: 'take-bundle' }, b: { '*': 'skip' } })
  })
})
