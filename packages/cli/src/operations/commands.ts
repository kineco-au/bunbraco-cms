/**
 * The commands an operator runs against an environment, as functions: they take
 * options and return what happened, and never print or exit. The `bunbraco`
 * binary renders their results for a terminal; anything else that runs them —
 * a platform's own tooling — gets the same results as data. One implementation,
 * so the two can never disagree about what an import or an upgrade does.
 */
import { ObjectTypes, ROOT_ACCESS } from '@bunbraco/core'
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
  bootSchema,
  bootstrapDatabase,
  checkSchemaDirectory,
  componentAliasesIn,
  createFileIntake,
  createMediaPort,
  installDatabase,
  MediaFileStore,
  mediaStoreFor,
  placeBlobs,
  readBlobs,
  syncOptionsFor,
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
import {
  applySections,
  type CarriedSections,
  carriedSections,
  carriesSections,
  planSections,
  promoteBackups,
  replacementsNeedingPermission,
  type SectionFile,
  type SectionOptions,
  type SectionPlan,
  type SectionResult,
  stageBackups,
} from './sections.ts'

export {
  isResolution,
  RESOLUTIONS,
  type Resolution,
  type TransferCheck,
} from '@bunbraco/transfer'
// The section half of an install, exported for the same reason the commands
// are: tooling that applies a bundle without a terminal needs the plan too.
export {
  applySections,
  type CarriedSections,
  carriedSections,
  carriesSections,
  type FileAction,
  planSections,
  promoteBackups,
  type RestoredFiles,
  RUN_BACKUP_DIR,
  replacementsNeedingPermission,
  restoreSectionFiles,
  type SectionFile,
  type SectionOptions,
  type SectionPlan,
  type SectionResult,
  stageBackups,
} from './sections.ts'
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

/**
 * The check an install that never reached the content reports.
 *
 * Nothing was examined, so nothing is outstanding: the refusal is in
 * `problems`, and a caller reading `outstanding.length` must not be told there
 * were content findings when there were none.
 */
const emptyCheck = (bundleId = ''): TransferCheck => ({
  bundleId,
  findings: [],
  outstanding: [],
  plan: [],
  counts: { create: 0, update: 0, unchanged: 0, skip: 0 },
})

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
  /** The sections it carries beyond its content; empty for a content-only bundle. */
  carried: CarriedSections
} {
  const loaded = loadBundle(dir)
  const problems = loaded.problems.map((problem) => `${problem.file}: ${problem.message}`)
  if (!loaded.set || problems.length > 0)
    throw new CommandError(
      'The bundle is incomplete or damaged; nothing was read from it.',
      problems,
    )
  return { set: loaded.set, blobs: loaded.blobs, carried: carriedSections(loaded) }
}

export interface TransferInput extends SectionOptions {
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
      componentAliases: componentAliasesIn(config.componentsDir),
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
  /** What the carried sections would do here; undefined for a content-only bundle. */
  sections: SectionPlan | undefined
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
  const { set, carried } = readBundle(input.dir)
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
      sections: carriesSections(carried)
        ? await planSections(db, config, carried, input)
        : undefined,
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
  /**
   * What the carried sections did, when the bundle carried any.
   *
   * Applied before the content and outside the content run's ledger entry: the
   * files are now in `schema/` and the views directory, where the repository
   * owns them — so a revert takes the content back and git takes the files.
   */
  sections: SectionResult | undefined
  /** Where the originals of any replaced files were kept, for a revert. */
  replacedFilesKept?: string | undefined
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
  const { set, blobs, carried } = readBundle(input.dir)
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

    /**
     * Structure first, but planned before anything is written.
     *
     * The order is forced: content naming a type this bundle brings cannot pass
     * a check until that type exists, so the schema has to land before the
     * content is checked. Which means a blocking schema change has to be caught
     * *before* the first file is written — otherwise a refused install leaves a
     * half-applied site behind. `planSections` answers that from an overlay
     * copy, so the site is untouched until it is known the schema can apply.
     */
    const plan = carriesSections(carried)
      ? await planSections(db, config, carried, input)
      : undefined
    const refuse = (problems: string[]): ContentImportResult => ({
      bundle: summarise(set),
      backup,
      runId: undefined,
      check: emptyCheck(set.manifest.id),
      blobs: null,
      published: 0,
      publishFailures: [],
      problems,
      sections: undefined,
    })

    if (plan?.schema?.classification === 'breaking')
      return refuse([
        'the schema this bundle carries cannot be applied here without data work',
        ...plan.schema.findings,
      ])

    /**
     * A file this site already has is not replaced without being asked.
     *
     * Every section is editable in the backoffice — a stylesheet, a template, a
     * document type — so an overwrite destroys somebody's work, and the site
     * may have no git to recover it from. Refused by name, like any other
     * finding a person has to answer.
     */
    const needingPermission = plan ? replacementsNeedingPermission(plan, input) : []
    if (needingPermission.length > 0)
      return refuse([
        `${needingPermission.length} file(s) here would be replaced; pass --replace-files to allow it`,
        ...needingPermission.map((file: SectionFile) => file.path),
      ])

    // Staged whenever something *will* be replaced — which is decided by the
    // plan, not by the permission check: by this point permission has been
    // given, so the files needing it are exactly the ones to back up.
    const willReplace = (plan?.files ?? []).some((file) => file.action === 'overwrite')
    const staging = plan && willReplace ? stageBackups(config) : undefined
    const sections = plan
      ? await applySections(db, config, carried, { ...input, backupDir: staging })
      : undefined
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
      sections,
    }
    if (!result.runId) return outcome
    // The backups become the run's, so `content revert` can find them.
    if (staging) outcome.replacedFilesKept = promoteBackups(config, staging, result.runId)
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
  config: BunbracoConfig,
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
