/**
 * The commands an operator runs against an environment, as functions: they take
 * options and return what happened, and never print or exit. The `crombolo`
 * binary renders their results for a terminal; anything else that runs them —
 * a platform's own tooling — gets the same results as data. One implementation,
 * so the two can never disagree about what an import or an upgrade does.
 */
import { userInfo } from 'node:os'
import { ROOT_ACCESS } from '@crombolo/core'
import {
  type AuditCategory,
  bundleStateKey,
  bundleTablesIn,
  connect,
  cromboloPlan,
  type Db,
  describeRefFailure,
  type NodeRow,
  type PlannedStep,
  pauseWrites,
  pendingMigrations,
  planUpgrade,
  purgeBundleTables,
  readWritesPaused,
  resolveNodeRef,
  resumeWrites,
  type WritesPaused,
  writeReport,
} from '@crombolo/data'
import { loadSchemaDirectory, loadValueMigrations, runFix, runUpgrade } from '@crombolo/schema'
import {
  type BackupResult,
  type BundleChain,
  BundleConfigurationError,
  backupBefore,
  bootSchema,
  bootstrapDatabase,
  bundleChainsFor,
  CONTENT_OBJECT_TYPES,
  CommandError,
  type ContentCheckResult,
  type ContentImportInput,
  type ContentImportResult,
  type CromboloConfig,
  checkBundleContent,
  checkSchemaDirectory,
  createFileIntake,
  createMediaPort,
  installBundleContent,
  installDatabase,
  MediaFileStore,
  mediaStoreFor,
  pendingBundleSteps,
  planBundleUpgrades,
  readBlobs,
  readBundle,
  recordAudit,
  syncOptionsFor,
  type TransferInput,
  VERSION,
} from '@crombolo/server'
import {
  bundleIdFor,
  exportBundle,
  isPackageName,
  packageNameFor,
  writeBundle,
  writeBundlePackage,
} from '@crombolo/transfer'

// The installer lives in the server, so the backoffice can run it too; these
// are exported for the same reason the commands are: tooling that applies a
// bundle without a terminal needs the plan and the refusals as well.
export {
  applySections,
  type BundleSummary,
  type CarriedSections,
  CONTENT_OBJECT_TYPES,
  CommandError,
  type ContentCheckResult,
  type ContentImportInput,
  type ContentImportResult,
  carriedSections,
  carriesSections,
  type FileAction,
  planSections,
  promoteBackups,
  type ResolvedBundle,
  type RestoredFiles,
  RUN_BACKUP_DIR,
  readBundle,
  replacementsNeedingPermission,
  restoreSectionFiles,
  type SectionFile,
  type SectionOptions,
  type SectionPlan,
  type SectionResult,
  stageBackups,
  type TransferInput,
  transferOptions,
} from '@crombolo/server'
export {
  isResolution,
  RESOLUTIONS,
  type Resolution,
  type TransferCheck,
} from '@crombolo/transfer'
export type { BackupResult, WritesPaused }

/** Read-only: what installing a bundle here would do. Its findings go to the Changes dashboard. */
export async function contentCheck(
  config: CromboloConfig,
  input: TransferInput,
): Promise<ContentCheckResult> {
  const { db } = await bootstrapDatabase(config)
  try {
    return await checkBundleContent(db, config, input)
  } finally {
    await db.close()
  }
}

/** Back up, re-check, then apply in one transaction and record the run. */
export async function contentImport(
  config: CromboloConfig,
  input: ContentImportInput,
): Promise<ContentImportResult> {
  // Read before anything is opened or backed up, so a bundle that is not one is
  // refused before a backup is taken on its behalf.
  readBundle(input.bundle, config.siteDir)
  const { db } = await bootstrapDatabase(config)
  try {
    return await installBundleContent(db, config, input)
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
  /**
   * The private package the export is written as. The name defaults to one
   * derived from the bundle's id, the version to `1.0.0`.
   */
  package?: { name?: string; version?: string }
}

export interface ContentExportResult {
  bundleId: string
  /** The package the files make up. */
  package: { name: string; version: string }
  snapshot: string
  counts: Record<string, number>
  expected: { key: string; name: string; why: string }[]
  /** The package's files — `package.json` and the payload under `content/` — for the caller to place. */
  files: { path: string; bytes?: Uint8Array; text?: string }[]
  blobs: { carried: number; bytes: number; missing: string[]; notCarried: number }
}

/**
 * Writes nothing: returns the export as a private package's files, for the
 * caller to place. An environment's export is a bundle like any other, but one
 * applied from its directory and never published or depended on.
 */
export async function contentExport(
  config: CromboloConfig,
  input: ContentExportInput,
): Promise<ContentExportResult> {
  if (input.roots.length === 0) throw new CommandError('An export needs at least one root.')
  const requested = input.package?.name
  if (requested !== undefined && !isPackageName(requested))
    throw new CommandError(`"${requested}" is not a package name npm accepts.`)
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
    // the store's business, and `@crombolo/transfer` knows nothing about it.
    let carried = new Map<string, Uint8Array>()
    let missing: string[] = []
    if (input.withBlobs && blobKeys.length > 0) {
      const read = await readBlobs(await mediaStoreFor(config), blobKeys)
      carried = read.bytes
      missing = read.missing
    }
    const pkg = {
      name: requested ?? packageNameFor(`export-${set.manifest.id}`),
      version: input.package?.version ?? '1.0.0',
    }
    return {
      bundleId: set.manifest.id,
      package: pkg,
      snapshot: set.manifest.snapshot,
      counts: { ...set.manifest.counts },
      expected: set.manifest.dependencies.expected.map((e) => ({
        key: e.key,
        name: e.name,
        why: e.why,
      })),
      files: writeBundlePackage(writeBundle(set, carried), {
        ...pkg,
        id: bundleIdFor(pkg.name.replace(/^@[^/]+\//, '')),
        label: `Content from ${config.siteName}`,
        private: true,
        peerRange: `^${VERSION}`,
      }),
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

/** The wired bundles' chains, checked as boot checks them, or a refusal naming every problem. */
function chainsFor(config: CromboloConfig): BundleChain[] {
  try {
    return bundleChainsFor(config)
  } catch (error) {
    if (error instanceof BundleConfigurationError)
      throw new CommandError('The configured bundles cannot be used.', error.problems)
    throw error
  }
}

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim()

async function upgradeContext(config: CromboloConfig, set: Record<string, unknown>) {
  const chains = chainsFor(config)
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
  return { db, node, loaded, syncNode, checkOptions, chains }
}

export interface PlannedStepResult {
  name: string
  kind: string
  release: string | null
  statements: string[]
  unplannable: string | null
}

export interface UpgradePlanResult {
  steps: PlannedStepResult[]
  /** Each wired bundle that owns tables, with the steps it would run after core's. */
  bundles: { id: string; name: string; steps: PlannedStepResult[] }[]
  site: { checked: boolean; action: string | null; classification: string | null }
}

const plannedStep = (step: PlannedStep): PlannedStepResult => ({
  name: step.name,
  kind: step.kind,
  release: step.release ?? null,
  statements: (step.statements ?? []).map(flat),
  unplannable: step.unplannable ?? null,
})

/** The DDL every pending framework step would run, and what the site's schema would do. Writes nothing. */
export async function upgradePlan(config: CromboloConfig): Promise<UpgradePlanResult> {
  const { db, node, chains } = await upgradeContext(config, {})
  try {
    const steps = await planUpgrade(db, cromboloPlan)
    const bundles = await planBundleUpgrades(db, chains)
    const check = await checkSchemaDirectory(db, config, node)
    return {
      steps: steps.map(plannedStep),
      bundles: bundles.map((bundle) => ({
        id: bundle.id,
        name: bundle.name,
        steps: bundle.steps.map(plannedStep),
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
  config: CromboloConfig,
  input: { set?: Record<string, unknown> } = {},
) {
  const { db, node, chains } = await upgradeContext(config, input.set ?? {})
  try {
    const report = await checkSchemaDirectory(db, config, node, { set: input.set ?? {} })
    if (report.siteChecked) await writeReport(db, report.findings, { source: 'upgrade' })
    const bundles = await pendingBundleSteps(db, chains)
    return {
      bundles: bundles.map((bundle) => ({
        id: bundle.id,
        name: bundle.name,
        pending: bundle.pending.map((step) => ({ name: step.name, kind: step.kind ?? 'expand' })),
      })),
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
  config: CromboloConfig,
  input: { set?: Record<string, unknown>; backupTaken?: boolean } = {},
) {
  const backup = await backupBefore(config, { reason: 'fix', backupTaken: input.backupTaken })
  const { db, loaded, syncNode, checkOptions, chains } = await upgradeContext(
    config,
    input.set ?? {},
  )
  try {
    await installDatabase(db, config, chains)
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
      /** Each bundle's steps that ran, after core's. */
      bundlesApplied: { id: string; applied: string[] }[]
      schema: { action: string; version: string | null; revision: string | null } | null
    }

/** Re-check, back up, apply framework steps, cut over, ledger. */
export async function upgradeRun(
  config: CromboloConfig,
  input: { force?: string; set?: Record<string, unknown>; backupTaken?: boolean } = {},
): Promise<UpgradeRunResult> {
  const backup = await backupBefore(config, { reason: 'upgrade', backupTaken: input.backupTaken })
  const { db, loaded, syncNode, checkOptions, chains } = await upgradeContext(
    config,
    input.set ?? {},
  )
  try {
    // Read before anything runs: `installDatabase` applies core's steps and then
    // each bundle's, so this is what the upgrade itself applied.
    const corePending = (await pendingMigrations(db, cromboloPlan)).map((step) => step.name)
    const bundlesPending = await pendingBundleSteps(db, chains)
    await installDatabase(db, config, chains)
    const bundlesApplied = bundlesPending
      .filter((bundle) => bundle.pending.length > 0)
      .map((bundle) => ({ id: bundle.id, applied: bundle.pending.map((step) => step.name) }))
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
    const frameworkApplied = [...corePending, ...result.frameworkApplied]
    if (result.action === 'nothing' && frameworkApplied.length === 0 && bundlesApplied.length === 0)
      return { action: 'nothing', backup }
    return {
      action: 'upgraded',
      backup,
      frameworkApplied,
      bundlesApplied,
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

export interface MediaAddInput {
  /** Where the file already is, in this environment's own media store. */
  key: string
  /** What the item is called. Defaults to the file name in `key`. */
  name?: string
  /** The folder to put it in, by node key. The media root when absent. */
  parent?: string
}

export interface MediaAddResult {
  /** The new media item's node key. */
  key: string
  name: string
  /** The media type it was created as, chosen from the file's extension. */
  mediaType: string
}

/**
 * Registers a file that is already in the store as a media item, so it appears
 * in the Media section and can be used in content.
 *
 * For a host offering an upload without opening the backoffice. The caller puts
 * the bytes in the store — a presigned upload, typically — and names the key
 * here, so a large file never travels through whatever asked for this. The
 * media type is chosen from the extension the same way the backoffice chooses
 * it, and the file is placed by the CMS in its own layout rather than by the
 * caller, which is what keeps the store free of files nothing knows about.
 */
export async function mediaAdd(
  config: CromboloConfig,
  input: MediaAddInput,
): Promise<MediaAddResult> {
  const name = (input.name ?? input.key.split('/').at(-1) ?? '').trim()
  if (!name) throw new CommandError('A media item needs a name.')

  const store = await mediaStoreFor(config)
  const found = await store.get(input.key)
  if (!found) throw new CommandError(`There is nothing at '${input.key}' in the store.`)

  const files = new MediaFileStore(store)
  const { db } = await bootstrapDatabase(config)
  // The schema the site is actually on. Without it the port falls back to the
  // baseline state and the write gate refuses every write, because a server at
  // an older schema than its database must not write to it.
  const schema = await bootSchema(db, { ...config, syncSchemaAtBoot: false })
  const port = createMediaPort(db, files, {
    nodeState: schema.nodeState,
    nodeId: schema.nodeId,
    valueIntake: createFileIntake(files),
  })

  // The same choice the backoffice makes: a type whose file property allows
  // this extension, falling back to one that allows anything at all.
  const extension = name.includes('.') ? (name.split('.').at(-1) as string) : ''
  const types = await port.typesForExtension(extension)
  const type = types.find((candidate) => candidate.matched) ?? types[0]
  if (!type)
    throw new CommandError(
      `No media type in this site accepts a '${extension}' file, so it cannot be added.`,
    )

  // Through the temporary-file path, so the CMS places the file and records the
  // value exactly as it would for an upload made in the backoffice.
  const temporaryId = crypto.randomUUID()
  // A fresh Uint8Array from the store, handed over as a blob part. `bytes()` is
  // typed over ArrayBufferLike, which a File constructor will not take.
  const bytes = await found.bytes()
  await files.saveTemporary(
    temporaryId,
    new File([new Blob([bytes as BlobPart], { type: found.contentType })], name),
  )

  const created = await port.create(
    {
      key: crypto.randomUUID(),
      contentTypeKey: type.key,
      componentKey: null,
      parentKey: input.parent ?? null,
      values: [
        {
          alias: 'umbracoFile',
          culture: null,
          segment: null,
          value: { temporaryFileId: temporaryId },
        },
      ],
      variants: [{ culture: null, segment: null, name }],
    },
    // The platform acting as itself: no user account, every permission, so the
    // item is created rather than refused for an actor the site has never seen.
    // `create` resolves a user id from the key and simply finds none.
    {
      id: '',
      userName: 'operations',
      name: 'operations',
      email: '',
      isAdmin: true,
      languageIsoCode: undefined,
      avatarUrls: [],
      allowedSections: [],
      permissions: [],
      groupKeys: [],
      hasAccessToAllLanguages: true,
      languages: [],
      startNodes: { document: ROOT_ACCESS, media: ROOT_ACCESS, element: ROOT_ACCESS },
      groups: [],
    },
  )
  if (!created.ok) {
    // Nothing was registered, so the staged copy is litter.
    await files.deleteTemporary(temporaryId)
    throw new CommandError(
      `The media item could not be created: ${created.reason}.`,
      (created.errors ?? []).map((error) => `${error.alias}: ${error.messages.join('; ')}`),
    )
  }
  return { key: created.key, name, mediaType: type.name }
}

/** Takes the backup a write would take first: a copy of SQLite, or `CROMBOLO_PG_DUMP` on Postgres. */
export async function backup(
  config: CromboloConfig,
  input: { reason?: string; backupTaken?: boolean } = {},
): Promise<BackupResult> {
  return backupBefore(config, {
    reason: input.reason ?? 'backup',
    backupTaken: input.backupTaken,
  })
}

export interface CommandAudit {
  category: AuditCategory
  action: string
  /** The command as typed, without its arguments, which can hold a password. */
  command: string
  entityType?: string
  entityKey?: string
}

/**
 * Records a command that changed this environment, in the audit log, as the
 * account that ran it — `CROMBOLO_ACTOR` when a pipeline names who it runs for.
 * Never fails the command: what it records has already happened.
 */
export async function recordCommand(config: CromboloConfig, entry: CommandAudit): Promise<void> {
  let actor = Bun.env.CROMBOLO_ACTOR
  try {
    actor ??= userInfo().username
  } catch {
    actor ??= undefined
  }
  try {
    await withDatabase(config, (db) =>
      recordAudit(db, {
        category: entry.category,
        action: entry.action,
        source: 'cli',
        userName: actor ?? null,
        entityType: entry.entityType ?? null,
        entityKey: entry.entityKey ?? null,
        detail: entry.command,
      }),
    )
  } catch {
    // No database to write to, or one without the log yet: the command still happened.
  }
}

async function withDatabase<T>(config: CromboloConfig, use: (db: Db) => Promise<T>): Promise<T> {
  const db = await connect({ file: config.sqliteFile })
  try {
    return await use(db)
  } finally {
    await db.close()
  }
}

/** Refuses every editor's save, on every node, until resumed; readers are unaffected. */
export function pauseEditing(
  config: CromboloConfig,
  input: { reason?: string; by?: string } = {},
): Promise<WritesPaused> {
  return withDatabase(config, (db) =>
    pauseWrites(db, { reason: input.reason ?? '', by: input.by ?? config.nodeId }),
  )
}

export function resumeEditing(config: CromboloConfig): Promise<void> {
  return withDatabase(config, resumeWrites)
}

/** Whether editing is paused, by whom and why; undefined when it is not. */
export function editingPaused(config: CromboloConfig): Promise<WritesPaused | undefined> {
  return withDatabase(config, readWritesPaused)
}

export interface BundlePurgePlan {
  id: string
  /** The tables that would be dropped, as the database names them. */
  tables: string[]
}

/** Refuses a purge of a bundle the site still wires: its code would recreate what was dropped. */
function refuseWired(config: CromboloConfig, id: string): void {
  if (config.bundles.some((bundle) => bundle.id === id))
    throw new CommandError(
      `The bundle "${id}" is still wired in crombolo.config.ts. Take it out of \`bundles\` and deploy that first.`,
    )
}

/** Read-only: what purging a bundle would drop. */
export async function bundlePurgePlan(
  config: CromboloConfig,
  id: string,
): Promise<BundlePurgePlan> {
  refuseWired(config, id)
  const db = await connect({ file: config.sqliteFile })
  try {
    return { id, tables: await bundleTablesIn(db, id) }
  } finally {
    await db.close()
  }
}

/**
 * Backs up, then drops every table under the bundle's prefix and forgets its
 * state, ledgered as a `purge` against the bundle.
 */
export async function bundlePurge(
  config: CromboloConfig,
  id: string,
  input: { backupTaken?: boolean } = {},
): Promise<{ backup: BackupResult; dropped: string[] }> {
  refuseWired(config, id)
  const backup = await backupBefore(config, { reason: 'purge', backupTaken: input.backupTaken })
  const db = await connect({ file: config.sqliteFile })
  try {
    const dropped = await purgeBundleTables(db, id, {
      by: config.nodeId,
      stateKey: bundleStateKey(id),
    })
    return { backup, dropped }
  } finally {
    await db.close()
  }
}
