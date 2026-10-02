/**
 * Putting an import back.
 *
 * This is the existing rollback path driven in bulk. `DocumentRepository.rollback`
 * already appends the values as of a given event under a new event — history is
 * never rewritten — so reverting a run is: for each node it touched, roll back
 * to the event it was at beforehand, then restore the published state it was
 * serving. Nodes the run *created* are unpublished and recycled, never deleted.
 *
 * Because the values are append-only, the revert is itself a run and can be
 * reverted in turn.
 *
 * It has its own dry run for the same reason the import does: somebody may have
 * edited a page after the import, and discarding that without asking would be
 * the worst thing this command could do.
 */
import {
  appendCacheInstruction,
  currentSchemaState,
  type Db,
  DocumentRepository,
  type Finding,
  Locks,
  type NodeRow,
  PublishBlockedError,
  type TransferChange,
  type TransferRun,
  TransferRunRepository,
} from '@bunbraco/data'

/** What to do about a node whose state has moved on since the import. */
export type RevertResolution = 'discard' | 'skip'

export const REVERT_RESOLUTIONS: readonly RevertResolution[] = ['discard', 'skip']

export const isRevertResolution = (value: string): value is RevertResolution =>
  (REVERT_RESOLUTIONS as readonly string[]).includes(value)

export function revertResolutionsFor(code: string): readonly string[] {
  switch (code) {
    case 'edited-since':
      return [
        '--resolve <key>=discard to revert it anyway, losing the later edit',
        '--resolve <key>=skip to leave the node as it is now',
      ]
    case 'children-added':
      return [
        '--resolve <key>=discard to recycle it with the children added since',
        '--resolve <key>=skip to leave the whole branch alone',
      ]
    case 'later-run':
      return ['revert the later run first', '--force to revert this one regardless']
    case 'run-not-applied':
      return ['nothing to do: this run has already been reverted']
    default:
      return []
  }
}

export interface RevertOptions {
  resolutions?: Readonly<Record<string, RevertResolution>>
  resolveAll?: RevertResolution | undefined
  /** Revert even though a later run touched the same nodes. */
  force?: boolean
  nodeId?: string
  backOfficePath?: string
}

export interface RevertPlan {
  key: string
  name: string
  /**
   * `restore` puts values and published state back, `recycle` removes what the
   * run created, and `unrecycle` brings back what a *reverted* run recycled —
   * which is what makes a revert revertible in its own right.
   */
  action: 'restore' | 'recycle' | 'unrecycle' | 'skip' | 'gone'
  resolution: RevertResolution | undefined
}

export interface RevertCheck {
  runId: string
  findings: Finding[]
  outstanding: Finding[]
  plan: RevertPlan[]
}

export interface RevertResult {
  /** The new run, or undefined when the revert was refused. */
  runId: string | undefined
  check: RevertCheck
  restored: string[]
  recycled: string[]
}

const link = (backOfficePath: string | undefined, key: string): string | null =>
  backOfficePath ? `${backOfficePath}/section/content/workspace/document/edit/${key}` : null

export async function checkRevert(
  db: Db,
  runId: string,
  options: RevertOptions = {},
): Promise<RevertCheck> {
  const findings: Finding[] = []
  const plan: RevertPlan[] = []
  const resolutions = options.resolutions ?? {}
  const runs = new TransferRunRepository(db)
  const run = await runs.byId(runId)

  const runFinding = (kind: Finding['kind'], code: string, message: string): Finding => ({
    kind,
    code,
    subjectType: 'bundle',
    subjectKey: runId,
    subjectName: runId,
    propertyAlias: null,
    culture: null,
    message,
    link: null,
  })

  if (!run) {
    findings.push(runFinding('blocking', 'run-not-applied', `there is no run ${runId} here`))
    return { runId, findings, outstanding: findings, plan }
  }
  if (run.status !== 'applied') {
    findings.push(
      runFinding(
        'blocking',
        'run-not-applied',
        `run ${runId} is ${run.status}, so there is nothing to put back`,
      ),
    )
    return { runId, findings, outstanding: findings, plan }
  }

  // Reverting while a later run stands would quietly undo its work too.
  if (!options.force)
    for (const later of await runs.laterRunsTouching(runId))
      findings.push(
        runFinding(
          'blocking',
          'later-run',
          `run ${later} touched the same content afterwards; revert that one first`,
        ),
      )

  const state = await currentSchemaState(db)
  const nodeState = { version: state.version, revision: state.revision }
  const docs = new DocumentRepository(db, { nodeState })

  const changes = await runs.changes(runId)
  const ownKeys = new Set(changes.map((c) => c.nodeKey))

  for (const change of changes) {
    if (change.action === 'skip') continue
    const resolution = resolutions[change.nodeKey] ?? options.resolveAll
    const node = await docs.nodes.byKey(change.nodeKey)
    const name = node?.text ?? change.nodeKey

    if (!node) {
      findings.push({
        kind: 'auto',
        code: 'node-gone',
        subjectType: 'document',
        subjectKey: change.nodeKey,
        subjectName: name,
        propertyAlias: null,
        culture: null,
        message: `${change.nodeKey} is no longer here, so there is nothing to put back`,
        link: null,
      })
      plan.push({ key: change.nodeKey, name, action: 'gone', resolution })
      continue
    }

    if (resolution === 'skip') {
      plan.push({ key: change.nodeKey, name, action: 'skip', resolution })
      continue
    }

    const created = change.action === 'create'
    const repo = repoFor(db, nodeState, change.kind)

    // Somebody saved after the import: reverting discards their work, so it is
    // a decision rather than something to do quietly.
    const markers = await repo.eventMarkers(change.nodeKey)
    const movedOn =
      change.eventId !== null && markers?.head !== undefined && markers.head > change.eventId
    if (movedOn && resolution === undefined)
      findings.push({
        kind: 'person',
        code: 'edited-since',
        subjectType: change.kind === 'media' ? 'media' : 'document',
        subjectKey: change.nodeKey,
        subjectName: name,
        propertyAlias: null,
        culture: null,
        message: `"${name}" has been saved since the import; reverting discards that`,
        link: link(options.backOfficePath, change.nodeKey),
      })

    // A node the run created is going to the recycle bin, and anything added
    // under it since goes with it.
    if (created) {
      // Only what somebody else put there counts. The run's own children are
      // going to the bin anyway, and flagging them would make reverting any
      // multi-node import need a decision for no reason.
      const added = (await repo.nodes.descendants(node, [repo.objectType])).filter(
        (d) => !ownKeys.has(d.key),
      )
      if (added.length > 0 && resolution === undefined)
        findings.push({
          kind: 'person',
          code: 'children-added',
          subjectType: change.kind === 'media' ? 'media' : 'document',
          subjectKey: change.nodeKey,
          subjectName: name,
          propertyAlias: null,
          culture: null,
          message: `"${name}" was created by this run and has ${added.length} node(s) added under it since, which go to the recycle bin with it`,
          link: link(options.backOfficePath, change.nodeKey),
        })
    }

    plan.push({
      key: change.nodeKey,
      name,
      action: created ? 'recycle' : change.action === 'recycle' ? 'unrecycle' : 'restore',
      resolution,
    })
  }

  return {
    runId,
    findings,
    outstanding: findings.filter((f) => f.kind === 'blocking' || f.kind === 'person'),
    plan,
  }
}

function repoFor(
  db: Db,
  nodeState: { version: string; revision: string },
  kind: string,
  inTreeLock = false,
): DocumentRepository {
  return new DocumentRepository(db, {
    kind: kind === 'media' || kind === 'element' || kind === 'blueprint' ? kind : 'document',
    nodeState,
    inTreeLock,
  })
}

export async function revertRun(
  db: Db,
  runId: string,
  options: RevertOptions = {},
): Promise<RevertResult> {
  return db.locks.withLock(Locks.ContentTree, async () =>
    db.transaction(async (tx) => {
      const check = await checkRevert(tx, runId, options)
      if (check.outstanding.length > 0)
        return { runId: undefined, check, restored: [], recycled: [] }

      const runs = new TransferRunRepository(tx)
      const original = (await runs.byId(runId)) as TransferRun
      const changes = await runs.changes(runId)
      const state = await currentSchemaState(tx)
      const nodeState = { version: state.version, revision: state.revision }
      const repo = (kind: string) => repoFor(tx, nodeState, kind, true)

      const newRunId = crypto.randomUUID()
      await runs.start({
        id: newRunId,
        bundleId: original.bundleId,
        bundleLabel: `revert of ${runId}`,
        direction: 'revert',
        revertsRunId: runId,
        schemaStateId: state.id,
        startedAt: new Date(),
        appliedBy: options.nodeId ?? null,
        nodeCount: 0,
      })

      const skipped = new Set(
        check.plan.filter((p) => p.action === 'skip' || p.action === 'gone').map((p) => p.key),
      )
      const todo = changes.filter((c) => c.action !== 'skip' && !skipped.has(c.nodeKey))
      const byKey = new Map<string, NodeRow>()
      for (const change of todo) {
        const node = await repo(change.kind).nodes.byKey(change.nodeKey)
        if (node) byKey.set(change.nodeKey, node)
      }
      /** Shallowest first: publishing needs parents live before children. */
      const inTreeOrder = (list: readonly TransferChange[]) =>
        [...list].sort(
          (a, b) => (byKey.get(a.nodeKey)?.level ?? 0) - (byKey.get(b.nodeKey)?.level ?? 0),
        )

      const restored: string[] = []
      const recycled: string[] = []

      // Where each node stands *now*, before this revert touches it, so the
      // revert records its own "before" and can itself be reverted.
      const before = new Map<string, { head: number | undefined; published: number | undefined }>()
      for (const change of todo) {
        const markers = await repo(change.kind).eventMarkers(change.nodeKey)
        if (markers) before.set(change.nodeKey, markers)
      }

      // What the previous run recycled comes back out of the bin first, so the
      // rollback and publish below have a node in the tree to work on.
      for (const change of inTreeOrder(todo)) {
        if (change.action !== 'recycle') continue
        await repo(change.kind).restore(change.nodeKey, undefined)
        restored.push(change.nodeKey)
      }

      // Values, for everything the run changed rather than created.
      for (const change of todo) {
        if (change.action === 'create' || change.beforeEventId === null) continue
        await repo(change.kind).rollback(String(change.beforeEventId))
        if (!restored.includes(change.nodeKey)) restored.push(change.nodeKey)
      }

      // Then the published state, parents before children: a published node
      // under an unpublished one is unreachable, so the repository refuses it.
      for (const change of inTreeOrder(todo)) {
        if (change.action === 'create' || change.kind === 'media') continue
        const documents = repo(change.kind)
        try {
          if (change.beforePublishedEventId !== null) {
            // It was live before, so put it back in front of visitors. The
            // values are the ones just restored, so what it serves is what it
            // served.
            await documents.publish(change.nodeKey, null)
          } else {
            await documents.unpublish(change.nodeKey, null)
          }
        } catch (error) {
          // An ancestor this same revert is about to recycle can make a publish
          // impossible, and the node is going away regardless.
          if (!(error instanceof PublishBlockedError)) throw error
        }
      }

      // Finally what the run created, shallowest first: the recycle bin takes a
      // whole branch, so a deeper node is already gone by the time we reach it.
      for (const change of inTreeOrder(todo)) {
        if (change.action !== 'create') continue
        const node = await repo(change.kind).nodes.byKey(change.nodeKey)
        if (!node || node.trashed) continue
        await repo(change.kind).moveToRecycleBin(change.nodeKey)
        recycled.push(change.nodeKey)
      }

      for (const change of todo) {
        const markers = await repo(change.kind).eventMarkers(change.nodeKey)
        const was = before.get(change.nodeKey)
        await runs.record({
          runId: newRunId,
          nodeKey: change.nodeKey,
          kind: change.kind,
          // `recycle` tells a revert of *this* run to bring the node back out
          // of the bin, not merely to restore its values.
          action: recycled.includes(change.nodeKey) ? 'recycle' : 'update',
          beforeEventId: was?.head ?? null,
          beforePublishedEventId: was?.published ?? null,
          eventId: markers?.head ?? null,
        })
      }
      await runs.finish(newRunId, todo.length)
      await runs.setStatus(runId, 'reverted')

      await appendCacheInstruction(tx, {
        kind: 'content',
        payload: { revert: runId },
        by: options.nodeId,
      })

      return { runId: newRunId, check, restored, recycled }
    }),
  )
}
