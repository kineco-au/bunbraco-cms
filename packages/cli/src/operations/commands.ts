/**
 * The commands an operator runs against an environment, as functions: they take
 * options and return what happened, and never print or exit. The `bunbraco`
 * binary renders their results for a terminal; anything else that runs them —
 * a platform's own tooling — gets the same results as data. One implementation,
 * so the two can never disagree about what an import or an upgrade does.
 */
import { ObjectTypes } from '@bunbraco/core'
import {
  bunbracoPlan,
  connect,
  type Db,
  describeRefFailure,
  type NodeRow,
  pauseWrites,
  planUpgrade,
  readWritesPaused,
  recordInLedger,
  resolveNodeRef,
  resumeWrites,
  type WritesPaused,
  writeReport,
} from '@bunbraco/data'
import { loadSchemaDirectory, loadValueMigrations, runFix, runUpgrade } from '@bunbraco/schema'
import {
  type BackupResult,
  type BunbracoConfig,
  backupBefore,
  bootstrapDatabase,
  checkSchemaDirectory,
  installDatabase,
  mediaStoreFor,
  placeBlobs,
  readBlobs,
  syncOptionsFor,
  templateAliasesIn,
} from '@bunbraco/server'
import {
  type CheckOptions,
  type ContentSet,
  checkBundle,
  exportBundle,
  importBundle,
  loadBundle,
  loadResolutions,
  type Resolution,
  type TransferCheck,
  writeBundle,
} from '@bunbraco/transfer'

export {
  isResolution,
  RESOLUTIONS,
  type Resolution,
  type TransferCheck,
} from '@bunbraco/transfer'
export type { BackupResult, WritesPaused }

/** The trees a content selector or placement may name. */
export const CONTENT_OBJECT_TYPES = [ObjectTypes.Document, ObjectTypes.Media, ObjectTypes.Element]

/** A refusal the caller should read: nothing was written. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message)
  }
}

export interface BundleSummary {
  id: string
  from: string
  schemaVersion: string
  schemaRevision: string
  snapshot: string
  nodes: number
  blobsCarried: number
  blobBytes: number
}

function summarise(set: ContentSet): BundleSummary {
  const carried = set.manifest.blobs.filter((blob) => blob.included)
  return {
    id: set.manifest.id,
    from: set.manifest.provenance.siteName || '',
    schemaVersion: set.manifest.provenance.schemaVersion,
    schemaRevision: set.manifest.provenance.schemaRevision,
    snapshot: set.manifest.snapshot,
    nodes: set.nodes.length,
    blobsCarried: carried.length,
    blobBytes: carried.reduce((total, blob) => total + (blob.size ?? 0), 0),
  }
}

/** Reads a bundle whole, or refuses: a half-copied bundle must never be checked as though complete. */
export function readBundle(dir: string): {
  set: ContentSet
  blobs: ReadonlyMap<string, string>
} {
  const loaded = loadBundle(dir)
  const problems = loaded.problems.map((problem) => `${problem.file}: ${problem.message}`)
  if (!loaded.set || problems.length > 0)
    throw new CommandError(
      'The bundle is incomplete or damaged; nothing was read from it.',
      problems,
    )
  return { set: loaded.set, blobs: loaded.blobs }
}

export interface TransferInput {
  /** The bundle's directory on this machine. */
  dir: string
  /** Where the bundle's roots go: a path or a key. */
  under?: string
  /** A decision per node key, on top of any the bundle carries. */
  resolutions?: Record<string, Resolution>
  resolveAll?: Resolution
  allowMissingBlobs?: boolean
}

/** The options `check` and `import` share: saved decisions, then the caller's, then placement. */
export async function transferOptions(
  db: Db,
  config: BunbracoConfig,
  set: ContentSet,
  input: TransferInput,
): Promise<{ options: CheckOptions; under: NodeRow | undefined; problems: string[] }> {
  const saved = loadResolutions(input.dir, set.manifest.id)
  const resolutions = { ...(saved.file?.byNode ?? {}), ...(input.resolutions ?? {}) }
  const resolveAll = input.resolveAll ?? saved.file?.all ?? undefined
  const underRef = input.under ?? saved.file?.under ?? undefined
  let under: NodeRow | undefined
  if (underRef) {
    const resolved = await resolveNodeRef(db, CONTENT_OBJECT_TYPES, underRef)
    if (!resolved.ok) throw new CommandError(describeRefFailure(underRef, resolved))
    under = resolved.node
  }
  // Whether this environment has a media file is a question only its store can
  // answer; without it `missing-blob` is a finding the check could never raise.
  const store = await mediaStoreFor(config)
  return {
    options: {
      under,
      resolutions,
      resolveAll,
      templateAliases: templateAliasesIn(config.viewsDir),
      allowMissingBlobs: input.allowMissingBlobs ?? false,
      hasBlob: async (key: string) => Boolean(await store.get(key)),
      backOfficePath: config.backOfficePath,
    },
    under,
    problems: saved.problems,
  }
}

export interface ContentCheckResult {
  bundle: BundleSummary
  under: string | null
  check: TransferCheck
  /** Nothing outstanding: the bundle would import cleanly. */
  clean: boolean
  /** The decisions this check ran with — the bundle's saved ones under the caller's. */
  decisions: { all: Resolution | null; byNode: Record<string, Resolution> }
  problems: string[]
}

/** Read-only: what importing a bundle here would do. Its findings go to the Changes dashboard. */
export async function contentCheck(
  config: BunbracoConfig,
  input: TransferInput,
): Promise<ContentCheckResult> {
  const { set } = readBundle(input.dir)
  const { db } = await bootstrapDatabase(config)
  try {
    const prepared = await transferOptions(db, config, set, input)
    const check = await checkBundle(db, set, prepared.options)
    // Under this bundle's own scope, so two bundles in flight do not resolve each other's.
    await writeReport(db, check.findings, { source: 'transfer', scope: set.manifest.id })
    return {
      bundle: summarise(set),
      under: prepared.under ? (prepared.under.text ?? prepared.under.key) : null,
      check,
      clean: check.outstanding.length === 0,
      decisions: {
        all: prepared.options.resolveAll ?? null,
        byNode: prepared.options.resolutions ?? {},
      },
      problems: prepared.problems,
    }
  } finally {
    await db.close()
  }
}

export interface ContentImportInput extends TransferInput {
  publish?: boolean
  label?: string
  /** Postgres: the caller has taken a backup itself. */
  backupTaken?: boolean
}

export interface ContentImportResult {
  bundle: BundleSummary
  backup: BackupResult
  /** Undefined when the import was refused; then nothing was written. */
  runId: string | undefined
  check: TransferCheck
  blobs: { placed: number; bytes: number } | null
  published: number
  publishFailures: { key: string; reason: string }[]
  problems: string[]
}

/** Re-check, back up, then apply in one transaction and record the run. */
export async function contentImport(
  config: BunbracoConfig,
  input: ContentImportInput,
): Promise<ContentImportResult> {
  const { set, blobs } = readBundle(input.dir)
  // The coarse layer, under the fine-grained revert: in-place conversion is not
  // reversible by itself, so the same rule as `upgrade` applies here.
  const backup = await backupBefore(config, {
    reason: 'content-import',
    backupTaken: input.backupTaken,
  })
  const { db } = await bootstrapDatabase(config)
  try {
    const prepared = await transferOptions(db, config, set, input)
    const started = performance.now()
    const result = await importBundle(db, set, {
      ...prepared.options,
      publish: input.publish ?? false,
      nodeId: config.nodeId,
      label: input.label,
    })
    await writeReport(db, result.check.findings, { source: 'transfer', scope: set.manifest.id })
    const outcome: ContentImportResult = {
      bundle: summarise(set),
      backup,
      runId: result.runId,
      check: result.check,
      blobs: null,
      published: result.published.length,
      publishFailures: result.publishFailures,
      problems: prepared.problems,
    }
    if (!result.runId) return outcome
    if (blobs.size > 0) outcome.blobs = await placeBlobs(await mediaStoreFor(config), blobs)
    await recordInLedger(db, {
      name: `content import ${set.manifest.id}`,
      kind: 'transfer',
      durationMs: Math.round(performance.now() - started),
      appliedBy: config.nodeId,
      note: `run ${result.runId}`,
    })
    return outcome
  } finally {
    await db.close()
  }
}

export interface ContentExportInput {
  /** Paths or keys of the subtrees to export. */
  roots: string[]
  only?: boolean
  drafts?: boolean
  withBlobs?: boolean
  withBlueprints?: boolean
}

export interface ContentExportResult {
  bundleId: string
  snapshot: string
  counts: Record<string, number>
  expected: { key: string; name: string; why: string }[]
  /** The bundle's files, for the caller to write wherever it is going. */
  files: { path: string; bytes?: Uint8Array; text?: string }[]
  blobs: { carried: number; bytes: number; missing: string[]; notCarried: number }
}

/** Writes nothing: returns the bundle's files for the caller to place. */
export async function contentExport(
  config: BunbracoConfig,
  input: ContentExportInput,
): Promise<ContentExportResult> {
  if (input.roots.length === 0) throw new CommandError('An export needs at least one root.')
  const { db } = await bootstrapDatabase(config)
  try {
    // A path is resolved against the tree it is exported from, and the key is
    // what lands in the bundle, so the artifact is identity-stable either way.
    const roots: NodeRow[] = []
    for (const ref of input.roots) {
      const resolved = await resolveNodeRef(db, CONTENT_OBJECT_TYPES, ref)
      if (!resolved.ok) throw new CommandError(describeRefFailure(ref, resolved))
      roots.push(resolved.node)
    }
    const { set, blobKeys } = await exportBundle(db, {
      roots,
      asGiven: input.roots,
      descendants: !input.only,
      snapshot: input.drafts ? 'drafts' : 'published',
      blueprints: input.withBlueprints ?? false,
      withBlobs: input.withBlobs ?? false,
      siteName: config.siteName,
      nodeId: config.nodeId,
    })
    // The bytes are read here rather than in the exporter: where media lives is
    // the store's business, and `@bunbraco/transfer` knows nothing about it.
    let carried = new Map<string, Uint8Array>()
    let missing: string[] = []
    if (input.withBlobs && blobKeys.length > 0) {
      const read = await readBlobs(await mediaStoreFor(config), blobKeys)
      carried = read.bytes
      missing = read.missing
    }
    return {
      bundleId: set.manifest.id,
      snapshot: set.manifest.snapshot,
      counts: { ...set.manifest.counts },
      expected: set.manifest.dependencies.expected.map((e) => ({
        key: e.key,
        name: e.name,
        why: e.why,
      })),
      files: writeBundle(set, carried),
      blobs: {
        carried: carried.size,
        bytes: [...carried.values()].reduce((total, file) => total + file.length, 0),
        missing,
        notCarried: input.withBlobs ? 0 : blobKeys.length,
      },
    }
  } finally {
    await db.close()
  }
}

async function upgradeContext(config: BunbracoConfig, set: Record<string, unknown>) {
  const db = await connect({ file: config.sqliteFile })
  const node = { nodeId: config.nodeId, revision: config.schemaRevision }
  const loaded = () => loadSchemaDirectory(config.schemaDir)
  const syncNode = () => ({ ...node, version: loaded().set.version })
  const checkOptions = async () => ({
    ...syncOptionsFor(config),
    set,
    migrations: await loadValueMigrations(config.schemaDir),
    backOfficePath: config.backOfficePath,
  })
  return { db, node, loaded, syncNode, checkOptions }
}

export interface UpgradePlanResult {
  steps: {
    name: string
    kind: string
    release: string | null
    statements: string[]
    unplannable: string | null
  }[]
  site: { checked: boolean; action: string | null; classification: string | null }
}

/** The DDL every pending framework step would run, and what the site's schema would do. Writes nothing. */
export async function upgradePlan(config: BunbracoConfig): Promise<UpgradePlanResult> {
  const { db, node } = await upgradeContext(config, {})
  try {
    const steps = await planUpgrade(db, bunbracoPlan)
    const check = await checkSchemaDirectory(db, config, node)
    return {
      steps: steps.map((step) => ({
        name: step.name,
        kind: step.kind,
        release: step.release ?? null,
        statements: (step.statements ?? []).map((sql) => sql.replace(/\s+/g, ' ').trim()),
        unplannable: step.unplannable ?? null,
      })),
      site: {
        checked: check.siteChecked,
        action: check.siteChecked ? check.sync.action : null,
        classification: check.siteChecked ? check.classification : null,
      },
    }
  } finally {
    await db.close()
  }
}

/** The pre-upgrade report. Its findings go to the Changes dashboard once the site is checkable. */
export async function upgradeCheck(
  config: BunbracoConfig,
  input: { set?: Record<string, unknown> } = {},
) {
  const { db, node } = await upgradeContext(config, input.set ?? {})
  try {
    const report = await checkSchemaDirectory(db, config, node, { set: input.set ?? {} })
    if (report.siteChecked) await writeReport(db, report.findings, { source: 'upgrade' })
    return {
      siteChecked: report.siteChecked,
      classification: report.classification,
      findings: report.findings,
      outstanding: report.outstanding,
      blocking: report.outstanding.some((finding) => finding.kind === 'blocking'),
    }
  } finally {
    await db.close()
  }
}

/** Back up, then apply the additive part of an upgrade and every conversion, early. */
export async function upgradeFix(
  config: BunbracoConfig,
  input: { set?: Record<string, unknown>; backupTaken?: boolean } = {},
) {
  const backup = await backupBefore(config, { reason: 'fix', backupTaken: input.backupTaken })
  const { db, loaded, syncNode, checkOptions } = await upgradeContext(config, input.set ?? {})
  try {
    await installDatabase(db, config)
    const fix = await runFix(db, loaded(), syncNode(), {
      ...(await checkOptions()),
      by: config.nodeId,
    })
    return {
      backup,
      sync: { action: fix.sync.action, deferred: fix.sync.deferred },
      applied: fix.applied,
      skipped: fix.skipped,
      classification: fix.check.classification,
      findings: fix.check.findings,
      outstanding: fix.check.outstanding,
    }
  } finally {
    await db.close()
  }
}

export type UpgradeRunResult =
  | {
      action: 'refused'
      backup: BackupResult
      reasons: { kind: string; message: string; link: string | null }[]
    }
  | { action: 'nothing'; backup: BackupResult }
  | {
      action: 'upgraded'
      backup: BackupResult
      frameworkApplied: string[]
      schema: { action: string; version: string | null; revision: string | null } | null
    }

/** Re-check, back up, apply framework steps, cut over, ledger. */
export async function upgradeRun(
  config: BunbracoConfig,
  input: { force?: string; set?: Record<string, unknown>; backupTaken?: boolean } = {},
): Promise<UpgradeRunResult> {
  const backup = await backupBefore(config, { reason: 'upgrade', backupTaken: input.backupTaken })
  const { db, loaded, syncNode, checkOptions } = await upgradeContext(config, input.set ?? {})
  try {
    await installDatabase(db, config)
    const result = await runUpgrade(db, loaded(), syncNode(), {
      ...(await checkOptions()),
      by: config.nodeId,
      policy: config.upgradePolicy,
      force: input.force,
    })
    if (result.action === 'refused')
      return {
        action: 'refused',
        backup,
        reasons: result.reasons.map((f) => ({ kind: f.kind, message: f.message, link: f.link })),
      }
    if (result.action === 'nothing') return { action: 'nothing', backup }
    return {
      action: 'upgraded',
      backup,
      frameworkApplied: result.frameworkApplied,
      schema: result.sync
        ? {
            action: result.sync.action,
            version: result.sync.state?.version ?? null,
            revision: result.sync.state?.revision ?? null,
          }
        : null,
    }
  } finally {
    await db.close()
  }
}

/** Takes the backup a write would take first: a copy of SQLite, or `BUNBRACO_PG_DUMP` on Postgres. */
export async function backup(
  config: BunbracoConfig,
  input: { reason?: string; backupTaken?: boolean } = {},
): Promise<BackupResult> {
  return backupBefore(config, {
    reason: input.reason ?? 'backup',
    backupTaken: input.backupTaken,
  })
}

async function withDatabase<T>(config: BunbracoConfig, use: (db: Db) => Promise<T>): Promise<T> {
  const db = await connect({ file: config.sqliteFile })
  try {
    return await use(db)
  } finally {
    await db.close()
  }
}

/** Refuses every editor's save, on every node, until resumed; readers are unaffected. */
export function pauseEditing(
  config: BunbracoConfig,
  input: { reason?: string; by?: string } = {},
): Promise<WritesPaused> {
  return withDatabase(config, (db) =>
    pauseWrites(db, { reason: input.reason ?? '', by: input.by ?? config.nodeId }),
  )
}

export function resumeEditing(config: BunbracoConfig): Promise<void> {
  return withDatabase(config, resumeWrites)
}

/** Whether editing is paused, by whom and why; undefined when it is not. */
export function editingPaused(config: BunbracoConfig): Promise<WritesPaused | undefined> {
  return withDatabase(config, readWritesPaused)
}
