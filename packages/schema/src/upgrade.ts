/**
 * `check --fix` and `upgrade`. The fix writes early, under a prepared state no
 * live node reads as-of; the upgrade writes no content at all — it re-checks,
 * runs the framework's steps, and cuts over. docs/10, Part 2 and Part 3.
 */
import {
  bunbracoPlan,
  ContentTypeRepository,
  compareStates,
  currentSchemaState,
  type Db,
  DocumentRepository,
  type Finding,
  Locks,
  latestPreparedState,
  type MigratedValue,
  migrate,
  readLedger,
  recordInLedger,
  writeReport,
} from '@bunbraco/data'
import {
  affectedProperties,
  type CheckOptions,
  type CheckReport,
  conversionLedgerName,
  runCheck,
  typeNodeIdsCarrying,
} from './check.ts'
import type { LoadedSchema } from './load.ts'
import { allProperties } from './model.ts'
import { type SyncNode, type SyncReport, syncSchema } from './sync.ts'
import { findConverter, outputsOf } from './value-migrations.ts'

export interface FixOptions extends CheckOptions {
  /** Recorded in the ledger. */
  by: string
}

export interface FixReport {
  sync: SyncReport
  stateId: number | undefined
  /** What was written: 'default:type.prop', 'set:type.prop', a migration id, a conversion name. */
  applied: string[]
  /** Values a converter or migration threw on; they stay findings. */
  skipped: number
  check: CheckReport
  runId: string
}

/** Applies everything additive and every conversion now, under a prepared state. */
export async function runFix(
  db: Db,
  loaded: LoadedSchema,
  node: SyncNode,
  options: FixOptions,
): Promise<FixReport> {
  // Expand steps first: the site part of the check needs the framework's tables.
  await migrate(db, bunbracoPlan, { by: options.by })
  const before = await runCheck(db, loaded, node, options)
  const blocking = before.findings.filter((f) => f.kind === 'blocking')
  if (blocking.length > 0) {
    const runId = await writeReport(db, before.findings, { source: 'upgrade' })
    return { sync: before.sync, stateId: undefined, applied: [], skipped: 0, check: before, runId }
  }

  const sync = await syncSchema(db, loaded, node, { ...options, status: 'prepared' })
  const stateId = sync.state?.id
  const applied: string[] = []
  let skipped = 0
  if (sync.action === 'refused' || stateId === undefined) {
    const runId = await writeReport(db, before.findings, { source: 'upgrade' })
    return { sync, stateId, applied, skipped, check: before, runId }
  }

  const docs = new DocumentRepository(db)
  const types = new ContentTypeRepository(db)
  const ledgered = new Set(
    (await readLedger(db)).filter((r) => r.kind === 'value').map((r) => r.name),
  )
  const set = options.set ?? {}

  for (const affected of await affectedProperties(db, loaded)) {
    const { type: t, property: p, typeAggregate } = affected
    const carriers = await typeNodeIdsCarrying(db, typeAggregate.key)
    const documents = await docs.documentsOfTypes(carriers)

    // ---- defaults and --set fill what is missing
    const fill = set[`${t.alias}.${p.alias}`] ?? p.default
    if (affected.newlyMandatory && fill !== undefined) {
      let filled = 0
      for (const doc of documents) {
        const values = await docs.currentValuesByAlias(doc.nodeId, [p.alias])
        const has = values.some((v) => v.value !== null && v.value !== undefined && v.value !== '')
        if (has) continue
        await docs.appendUnderState(
          doc.key,
          [{ alias: p.alias, culture: null, segment: null, value: fill }],
          {
            schemaStateId: stateId,
          },
        )
        filled += 1
      }
      if (filled > 0)
        applied.push(
          `${set[`${t.alias}.${p.alias}`] !== undefined ? 'set' : 'default'}:${t.alias}.${p.alias}`,
        )
    }

    // ---- editor conversions write the new format into the new storage column
    if (affected.editorChange) {
      const { from, to, toStorage } = affected.editorChange
      const name = conversionLedgerName(t.alias, p.alias, from, to)
      const converter = findConverter(from, to)
      if (!converter) continue
      const started = performance.now()
      let converted = 0
      for (const doc of documents) {
        for (const v of await docs.currentValuesByAlias(doc.nodeId, [p.alias])) {
          if (v.value === null || v.value === undefined) continue
          if (ledgered.has(name) && v.schemaStateId >= stateId) continue
          try {
            const value = converter.convert(v.value, {
              documentKey: doc.key,
              culture: v.culture,
              segment: v.segment,
            })
            await docs.appendUnderState(
              doc.key,
              [
                {
                  alias: p.alias,
                  culture: v.culture,
                  segment: v.segment,
                  value,
                  eventId: v.eventId,
                  storage: toStorage,
                },
              ],
              { schemaStateId: stateId },
            )
            converted += 1
          } catch {
            skipped += 1
          }
        }
      }
      if (!ledgered.has(name)) {
        await recordInLedger(db, {
          name,
          kind: 'value',
          durationMs: Math.round(performance.now() - started),
          appliedBy: options.by,
          note: `${converted} value(s)`,
        })
        ledgered.add(name)
      }
      if (converted > 0) applied.push(name)
    }
  }

  // ---- the site's value migrations
  for (const m of options.migrations ?? []) {
    const fileType = loaded.set.documentTypes.find((t) => t.alias === m.from.type)
    const existing = await types.byAlias(m.from.type, { includeRetired: true })
    if (!fileType || !existing) continue
    if (!m.to.every((x) => allProperties(fileType).some((p) => p.alias === x.property))) continue
    const started = performance.now()
    let converted = 0
    for (const doc of await docs.documentsOfTypes(await typeNodeIdsCarrying(db, existing.key))) {
      for (const v of await docs.currentValuesByAlias(doc.nodeId, [m.from.property])) {
        if (v.value === null || v.value === undefined) continue
        // Already moved once and untouched since: the targets are current.
        if (ledgered.has(m.id)) {
          const targets = await docs.currentValuesByAlias(
            doc.nodeId,
            m.to.map((x) => x.property),
          )
          if (targets.some((tv) => tv.schemaStateId >= stateId && tv.rowId > v.rowId)) continue
        }
        try {
          const outputs = outputsOf(
            m,
            m.convert(v.value, { documentKey: doc.key, culture: v.culture, segment: v.segment }),
          )
          const values: MigratedValue[] = [...outputs].map(([alias, value]) => ({
            alias,
            culture: v.culture,
            segment: v.segment,
            value,
            eventId: v.eventId,
          }))
          await docs.appendUnderState(doc.key, values, { schemaStateId: stateId })
          converted += 1
        } catch {
          skipped += 1
        }
      }
    }
    if (!ledgered.has(m.id)) {
      await recordInLedger(db, {
        name: m.id,
        kind: 'value',
        durationMs: Math.round(performance.now() - started),
        appliedBy: options.by,
        note: `${converted} value(s)`,
      })
      ledgered.add(m.id)
    }
    if (converted > 0) applied.push(m.id)
  }

  const check = await runCheck(db, loaded, node, options)
  const runId = await writeReport(db, check.findings, { source: 'upgrade' })
  return { sync, stateId, applied, skipped, check, runId }
}

export type UpgradePolicy = 'strict' | 'pending-allowed'

export interface UpgradeOptions extends CheckOptions {
  by: string
  policy: UpgradePolicy
  /** Proceed over findings that need a person; recorded with this reason. */
  force?: string
}

export interface UpgradeReport {
  action: 'upgraded' | 'refused' | 'nothing'
  /** Why it refused. */
  reasons: Finding[]
  check: CheckReport
  frameworkApplied: string[]
  sync?: SyncReport
  runId: string
}

/**
 * Refuses over anything outstanding, then: framework steps, the cut-over
 * (or a plain current sync when nothing was prepared early), the ledger.
 * Holds the content-tree lock so no write straddles the cut-over.
 */
export async function runUpgrade(
  db: Db,
  loaded: LoadedSchema,
  node: SyncNode,
  options: UpgradeOptions,
): Promise<UpgradeReport> {
  return db.locks.withLock(Locks.ContentTree, async () => {
    // The framework's steps are expand-only and ledgered, so they run before the
    // check that may still refuse the site's change.
    const framework = await migrate(db, bunbracoPlan, { by: options.by })
    const check = await runCheck(db, loaded, node, options)
    const reasons = check.outstanding.filter((f) => {
      if (f.kind === 'blocking') return true
      if (f.kind === 'auto') return true
      return options.policy === 'strict' && !options.force
    })
    if (reasons.length > 0) {
      const runId = await writeReport(db, check.findings, { source: 'upgrade' })
      return { action: 'refused', reasons, check, frameworkApplied: framework.applied, runId }
    }
    const current = await currentSchemaState(db)
    const prepared = await latestPreparedState(db)
    const cutOverPending =
      prepared !== undefined && prepared.id > current.id && compareStates(prepared, node) === 0
    const nothingToDo =
      framework.applied.length === 0 &&
      !cutOverPending &&
      (check.sync.action === 'skipped-same' || check.sync.action === 'skipped-older')
    if (nothingToDo) {
      const runId = await writeReport(db, check.findings, { source: 'upgrade' })
      return { action: 'nothing', reasons: [], check, frameworkApplied: [], runId }
    }

    const started = performance.now()
    const sync = await syncSchema(db, loaded, node, { ...options, status: 'current' })
    await recordInLedger(db, {
      name: `upgrade ${loaded.set.version}+${node.revision}`,
      kind: 'upgrade',
      durationMs: Math.round(performance.now() - started),
      appliedBy: options.by,
      note: options.force ? `forced: ${options.force}` : sync.action,
    })
    const after = await runCheck(db, loaded, node, options)
    const runId = await writeReport(db, after.findings, { source: 'upgrade' })
    return {
      action: 'upgraded',
      reasons: [],
      check: after,
      frameworkApplied: framework.applied,
      sync,
      runId,
    }
  })
}
