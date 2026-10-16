/**
 * Bundle → database.
 *
 * Four properties the implementation is shaped around, in order of how badly
 * getting them wrong would hurt:
 *
 * 1. **Everything goes through `DocumentRepository`.** `is_current` is
 *    maintained on insert by the repository's own write path; a writer reaching
 *    into `property_value` would corrupt the flag that every hot-path read
 *    depends on.
 * 2. **Values are an overlay, never a replacement.** `#appendValues` treats what
 *    it is given as the complete set and *clears* anything current that is
 *    absent from it. So the values handed to `update` are this node's current
 *    values with the bundle's laid over them — otherwise an import silently
 *    empties every property the bundle does not carry.
 * 3. **One lock and one transaction for the whole run**, so a failure anywhere
 *    leaves nothing behind. `inTreeLock` on the repositories is what makes that
 *    possible without deadlocking on re-entry.
 * 4. **Two passes.** Every node is created before any value is written, so a
 *    page that links to a page that links back needs no ordering cleverness.
 *
 * Sibling order needs no handling of its own: nodes are created in the bundle's
 * own order within a parent, and `nodes.create` appends, so new siblings land
 * in bundle order after whatever was already there. The bundle's `sortOrder` is
 * therefore not replayed — appending is the only sane answer when the
 * destination already has children, and it is what this gives.
 *
 * Idempotence falls out of (2): the repository appends only what differs, so
 * importing the same bundle twice writes no values the second time.
 */
import type { DocumentValue } from '@crombolo/core'
import {
  appendCacheInstruction,
  ComponentRepository,
  type ContentKind,
  ContentTypeRepository,
  currentSchemaState,
  type Db,
  DocumentRepository,
  insideTransaction,
  Locks,
  PublicAccessRepository,
  PublishBlockedError,
  RedirectRepository,
  type TransferAction,
  TransferRunRepository,
} from '@crombolo/data'
import {
  type CheckOptions,
  checkBundle,
  type NodePlan,
  propertyHandle,
  type TransferCheck,
} from './check.ts'
import type { BundleKind, BundleNode, ContentSet } from './model.ts'
import { type AppliedPerson, applyPeople } from './people-apply.ts'

const CONTENT_KIND: Record<BundleKind, ContentKind> = {
  document: 'document',
  media: 'media',
  element: 'element',
  blueprint: 'blueprint',
}

export interface ImportOptions extends CheckOptions {
  /** Publish what the bundle says was live at the source. Without it, everything lands as a draft. */
  publish?: boolean
  /** Recorded as who applied the run. */
  nodeId?: string
  /** A human label for the run listing. */
  label?: string | undefined
  /** The npm package the bundle arrived in, recorded on the run. */
  package?: { name: string; version: string } | undefined
  /**
   * A node's values become exactly the bundle's, rather than the bundle's laid
   * over what is here: a whole-site replace (story 105).
   */
  exact?: boolean
}

export interface ImportResult {
  /** Undefined when the run was refused: nothing was written. */
  runId: string | undefined
  check: TransferCheck
  applied: NodePlan[]
  /** Nodes published, by key. */
  published: string[]
  /** Set when `--publish` was asked for and a business rule refused one. */
  publishFailures: Array<{ key: string; reason: string }>
  /** Members, users and groups created or updated. */
  people: AppliedPerson[]
  /** Protected pages, schedules and redirects written. */
  rules: { access: number; schedules: number; redirects: number }
}

/** Parents before children, for whatever the bundle carries. */
function inTreeOrder(nodes: readonly BundleNode[]): BundleNode[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const done = new Set<string>()
  const ordered: BundleNode[] = []
  const visit = (node: BundleNode, seen: Set<string>): void => {
    if (done.has(node.key) || seen.has(node.key)) return
    seen.add(node.key)
    const parent = node.parent ? byKey.get(node.parent) : undefined
    if (parent) visit(parent, seen)
    if (done.has(node.key)) return
    done.add(node.key)
    ordered.push(node)
  }
  for (const node of nodes) visit(node, new Set())
  return ordered
}

/** The bundle's values laid over what is here, keyed as the database keys them. */
function overlay(current: readonly DocumentValue[], node: BundleNode): DocumentValue[] {
  const at = (v: { culture: string | null; segment: string | null }, alias: string) =>
    `${alias}|${v.culture ?? ''}|${v.segment ?? ''}`
  const merged = new Map<string, DocumentValue>()
  for (const value of current) merged.set(at(value, value.alias), value)
  for (const value of node.values)
    merged.set(at(value, value.property), {
      alias: value.property,
      culture: value.culture,
      segment: value.segment,
      value: value.value,
    })
  return [...merged.values()]
}

export async function importBundle(
  db: Db,
  set: ContentSet,
  options: ImportOptions = {},
): Promise<ImportResult> {
  return db.locks.withLock(Locks.ContentTree, async () =>
    db.transaction((tx) => applyBundle(tx, set, options)),
  )
}

/** Thrown to roll a rehearsal back, carrying what the run would have done. */
class Rehearsed extends Error {
  constructor(readonly result: ImportResult) {
    super('A rehearsal is always rolled back.')
  }
}

/**
 * Which pages `--publish` would refuse, and why, found by doing the import and
 * rolling it back: the rules and their wording are the import's own. Media
 * files are not placed, since that happens outside the database. Undefined
 * while the check has something outstanding, because the import would stop
 * there and publish nothing.
 */
export async function rehearsePublish(
  db: Db,
  set: ContentSet,
  options: ImportOptions = {},
): Promise<Array<{ key: string; reason: string }> | undefined> {
  // Inside an enclosing transaction this one would join it, and catching the
  // throw would leave every write in place. A rehearsal must be its own.
  if (insideTransaction()) throw new Error('A rehearsal cannot run inside another transaction.')
  try {
    await db.locks.withLock(Locks.ContentTree, () =>
      db.transaction(async (tx) => {
        throw new Rehearsed(await applyBundle(tx, set, { ...options, publish: true }))
      }),
    )
  } catch (error) {
    if (!(error instanceof Rehearsed)) throw error
    return error.result.runId ? error.result.publishFailures : undefined
  }
  return undefined
}

async function applyBundle(tx: Db, set: ContentSet, options: ImportOptions): Promise<ImportResult> {
  {
    // The check runs again inside the lock, over the tree as it is now, so a
    // decision made against a stale read cannot slip through. Same discipline
    // `upgrade` uses before it cuts over.
    const check = await checkBundle(tx, set, options)
    if (check.outstanding.length > 0)
      return {
        runId: undefined,
        check,
        applied: [],
        published: [],
        publishFailures: [],
        people: [],
        rules: { access: 0, schedules: 0, redirects: 0 },
      }

    const state = await currentSchemaState(tx)
    const nodeState = { version: state.version, revision: state.revision }
    const runs = new TransferRunRepository(tx)
    const types = new ContentTypeRepository(tx)
    // A media node's type is a different object type, invisible to a
    // repository reading content types. See the same pairing in `check.ts`.
    const mediaTypes = new ContentTypeRepository(tx, { kind: 'media' })
    const typesFor = (kind: BundleKind): ContentTypeRepository =>
      CONTENT_KIND[kind] === 'media' ? mediaTypes : types
    const templates = new ComponentRepository(tx)

    const repos = new Map<ContentKind, DocumentRepository>()
    const repoFor = (kind: BundleKind): DocumentRepository => {
      const contentKind = CONTENT_KIND[kind]
      const existing = repos.get(contentKind)
      if (existing) return existing
      const repo = new DocumentRepository(tx, {
        kind: contentKind,
        nodeState,
        nodeId: options.nodeId,
        // One lock for the run, taken above.
        inTreeLock: true,
      })
      repos.set(contentKind, repo)
      return repo
    }

    const runId = crypto.randomUUID()
    await runs.start({
      id: runId,
      bundleId: set.manifest.id,
      bundleLabel: options.label ?? null,
      packageName: options.package?.name ?? null,
      packageVersion: options.package?.version ?? null,
      direction: 'import',
      revertsRunId: null,
      schemaStateId: state.id,
      startedAt: new Date(),
      appliedBy: options.nodeId ?? null,
      nodeCount: 0,
    })

    const planByKey = new Map(check.plan.map((p) => [p.key, p]))
    const ordered = inTreeOrder(set.nodes).filter(
      (node) => planByKey.get(node.key)?.action !== 'skip',
    )

    // What each node was before this run, read before anything is written:
    // the two numbers a revert needs to put the site back.
    const before = new Map<string, { head: number | undefined; published: number | undefined }>()
    for (const node of ordered) {
      const markers = await repoFor(node.kind).eventMarkers(node.key)
      if (markers) before.set(node.key, markers)
    }

    // Pass one: every node exists, with its name, and nothing else. A value
    // written in pass two can therefore refer to any node in the bundle.
    const created = new Set<string>()
    /** Where each created node actually landed, which the sort below groups by. */
    const landedUnder = new Map<string, string | null>()
    for (const node of ordered) {
      if (before.has(node.key)) continue
      const repo = repoFor(node.kind)
      const forKind = typesFor(node.kind)
      const type =
        (node.contentType.key ? await forKind.byKey(node.contentType.key) : undefined) ??
        (await forKind.byAlias(node.contentType.alias))
      // The check raises `missing-content-type` for this and refuses the run,
      // so reaching here means the two disagree. Throwing rolls the whole
      // transaction back; skipping the node would import part of the bundle
      // and report success.
      if (!type)
        throw new Error(
          `No content type "${node.contentType.alias}" for "${node.key}", which the check should have refused.`,
        )
      const parentKey =
        node.parent && !created.has(node.parent) && !before.has(node.parent)
          ? (options.under?.key ?? null)
          : (node.parent ?? options.under?.key ?? null)
      await repo.create({
        key: node.key,
        contentTypeKey: type.key,
        componentKey: node.template
          ? ((await templates.byAlias(node.template))?.key ?? null)
          : null,
        parentKey,
        values: [],
        variants: node.variants.map((v) => ({
          culture: v.culture,
          segment: v.segment,
          name: v.name,
        })),
      })
      created.add(node.key)
      landedUnder.set(node.key, parentKey)
    }

    // The order a bundle's nodes sit in among their siblings travels with it.
    // Without this they keep the order the run happened to create them in,
    // which is a hash order, not an editor's — a site's navigation arrives
    // shuffled. Only the nodes this run created are placed, and only into the
    // slots they already occupy, so siblings that were here keep theirs.
    const newByParent = new Map<string | null, BundleNode[]>()
    for (const node of ordered) {
      if (!created.has(node.key) || node.kind !== 'document') continue
      const parent = landedUnder.get(node.key) ?? null
      const group = newByParent.get(parent)
      if (group) group.push(node)
      else newByParent.set(parent, [node])
    }
    for (const [parent, group] of newByParent) {
      if (group.length < 2) continue
      const documents = repoFor('document')
      const rows = await documents.nodes.byKeys(group.map((n) => n.key))
      const slots = rows.map((row) => row.sortOrder).sort((a, b) => a - b)
      const wanted = [...group].sort((a, b) => a.sortOrder - b.sortOrder)
      await documents.sort(
        parent,
        wanted.flatMap((node, index) => {
          const sortOrder = slots[index]
          return sortOrder === undefined ? [] : [{ key: node.key, sortOrder }]
        }),
      )
    }

    // Pass two: the values, overlaid onto whatever is here.
    const applied: NodePlan[] = []
    for (const node of ordered) {
      const plan = planByKey.get(node.key)
      const kept = new Set(plan?.keepLocal ?? [])
      // Every difference answered keep-local: nothing of the bundle's to write.
      if (plan?.action === 'unchanged' && kept.size > 0) {
        applied.push(plan)
        continue
      }
      const repo = repoFor(node.kind)
      const current = await repo.byKey(node.key)
      if (!current) continue
      // The values kept here are left out of the overlay, so they stay as they
      // are; the rest are the bundle's. One update, so one new version.
      const taken =
        kept.size > 0
          ? {
              ...node,
              values: node.values.filter(
                (value) => !kept.has(propertyHandle(value.property, value.culture)),
              ),
            }
          : node
      // A node answered keep-local as a whole keeps its names too.
      const keepNames = plan?.resolution === 'keep-local'
      await repo.update({
        key: node.key,
        contentTypeKey: current.contentTypeKey,
        componentKey: node.template
          ? ((await templates.byAlias(node.template))?.key ?? current.componentKey)
          : current.componentKey,
        parentKey: current.parentKey,
        values: overlay(options.exact ? [] : current.values, taken),
        variants: keepNames
          ? current.variants.map((v) => ({
              culture: v.culture,
              segment: v.segment,
              name: v.name,
            }))
          : node.variants.map((v) => ({
              culture: v.culture,
              segment: v.segment,
              name: v.name,
            })),
      })
      if (plan) applied.push(plan)
    }

    // People before the rules that name them, and after the content their
    // values may refer to.
    const people =
      set.people && check.people
        ? await applyPeople(tx, set.people, check.people.plan, {
            id: runId,
            runs,
            nodeState,
            nodeId: options.nodeId,
          })
        : []

    // The rules a node carries, once every node they name exists.
    const rules = { access: 0, schedules: 0, redirects: 0 }
    const access = new PublicAccessRepository(tx)
    const redirects = new RedirectRepository(tx)
    const nodesHere = repoFor('document').nodes
    for (const node of ordered) {
      if (node.access) {
        const saved = await access.save({
          nodeKey: node.key,
          loginNodeKey: node.access.loginNode,
          errorNodeKey: node.access.errorNode,
          memberGroupNames: node.access.memberGroups,
          memberUserNames: node.access.memberUserNames ?? [],
        })
        if (saved) rules.access += 1
      }
      if (node.schedule && node.schedule.length > 0 && node.kind === 'document') {
        const byCulture = new Map<
          string | null,
          { publishTime: Date | null; unpublishTime: Date | null }
        >()
        for (const entry of node.schedule) {
          const at = byCulture.get(entry.culture) ?? { publishTime: null, unpublishTime: null }
          if (entry.action === 'publish') at.publishTime = new Date(entry.date)
          else at.unpublishTime = new Date(entry.date)
          byCulture.set(entry.culture, at)
        }
        await repoFor('document').setSchedule(
          node.key,
          [...byCulture].map(([culture, times]) => ({ culture, ...times })),
        )
        rules.schedules += node.schedule.length
      }
      for (const redirect of node.redirects ?? []) {
        const root = redirect.root && (await nodesHere.byKey(redirect.root)) ? redirect.root : null
        await redirects.save({
          source: 'tracked',
          matchKind: 'exact',
          pattern: redirect.path,
          rootKey: root,
          culture: redirect.culture,
          targetKind: 'document',
          target: node.key,
          statusCode: 301,
          sortOrder: 0,
        })
        rules.redirects += 1
      }
    }

    // Publishing is last, and parents first: an unpublished ancestor makes a
    // published descendant unreachable, so the repository refuses it.
    const published: string[] = []
    const publishFailures: Array<{ key: string; reason: string }> = []
    if (options.publish) {
      for (const node of ordered) {
        const live = node.variants.filter((v) => v.published)
        if (live.length === 0 || node.kind === 'media') continue
        const cultures = live.map((v) => v.culture).filter((c): c is string => c !== null)
        try {
          await repoFor(node.kind).publish(node.key, cultures.length > 0 ? cultures : null)
          published.push(node.key)
        } catch (error) {
          if (!(error instanceof PublishBlockedError)) throw error
          publishFailures.push({ key: node.key, reason: error.message })
        }
      }
    }

    for (const node of ordered) {
      const markers = await repoFor(node.kind).eventMarkers(node.key)
      const was = before.get(node.key)
      const action: TransferAction = !was
        ? 'create'
        : (planByKey.get(node.key)?.action ?? 'unchanged')
      await runs.record({
        runId,
        nodeKey: node.key,
        kind: node.kind,
        action,
        beforeEventId: was?.head ?? null,
        beforePublishedEventId: was?.published ?? null,
        eventId: markers?.head ?? null,
      })
    }
    await runs.finish(runId, ordered.length + people.length)

    // Other nodes drop their published cache; this one already has.
    await appendCacheInstruction(tx, {
      kind: 'content',
      payload: { bundle: set.manifest.id },
      by: options.nodeId,
    })

    return { runId, check, applied, published, publishFailures, people, rules }
  }
}
