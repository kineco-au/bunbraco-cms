/**
 * Checking and installing a bundle's content half, against a database the
 * caller holds. `docs/bundles.md`, "Installing one".
 *
 * A bundle is an npm package; what it installs is the `bundle.json` payload its
 * `crombolo.content` names. It is found either as a dependency the site
 * declares, by package name, or as a package directory applied in place, which
 * is how an environment's export arrives. A bare payload with no package around
 * it is refused, so there is one kind of bundle and not two.
 *
 * This lives in the server rather than the CLI so the backoffice can install
 * with the connection it already has: the CLI's `content check` and
 * `content import` open a database and call these.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type BundlePackage,
  discoverBundles,
  isDirectory,
  PAYLOAD_MANIFEST,
  peerRangeProblem,
  readBundlePackage,
  readPackageJson,
} from '@crombolo/backoffice-host'
import { ObjectTypes } from '@crombolo/core'
import {
  answersByNode,
  type Db,
  DictionaryRepository,
  describeRefFailure,
  Locks,
  type NodeRow,
  recordInLedger,
  resolveNodeRef,
  TransferAnswerRepository,
  writeReport,
} from '@crombolo/data'
import {
  BUNDLE_SECTIONS,
  type CheckOptions,
  type ContentSet,
  checkBundle,
  type ImportResult,
  importBundle,
  isPackageName,
  loadBundle,
  loadResolutions,
  mergeResolutions,
  type NodeResolutions,
  openBundle,
  type Resolution,
  rehearsePublish,
  SealedFileError,
  type TransferCheck,
  WrongPassphraseError,
  writeResolutions,
} from '@crombolo/transfer'
import { type BackupResult, backupBefore } from './backup.ts'
import {
  type CarriedSections,
  carriedSections,
  carriesSections,
  keepDictionary,
  keptDictionary,
  planSections,
  promoteStaged,
  type RestoredFiles,
  replacementsNeedingPermission,
  restoreSectionFiles,
  type SectionFile,
  type SectionOptions,
  type SectionPlan,
  type SectionResult,
  stageBackups,
  stagedConfig,
  stageSections,
  swappedSections,
  swapSections,
} from './bundle-sections.ts'
import { type CromboloConfig, VERSION } from './config.ts'
import { dictionaryToUdt, importDictionaryUdt, writeDictionaryUdt } from './dictionary-transfer.ts'
import { syncDomainsFile } from './domains.ts'
import { mediaStoreFor, placeBlobs } from './media-files.ts'
import { componentAliasesIn, syncSchemaDirectory } from './schema.ts'
import { publishSchema } from './schema-store.ts'
import {
  carriesAdministrator,
  prunePeople,
  pruneSite,
  type ReplaceMode,
  recordPruned,
  requiresProblems,
} from './site-replace.ts'

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

/** The bundle is encrypted, and the passphrase given does not open it, or none was. */
export class PassphraseError extends CommandError {}

export interface BundleSummary {
  id: string
  from: string
  schemaVersion: string
  schemaRevision: string
  snapshot: string
  nodes: number
  blobsCarried: number
  blobBytes: number
  /** The package the payload came in. */
  package: { name: string; version: string }
}

/** A bundle found and read: its package, and the payload inside it. */
export interface ResolvedBundle {
  package: BundlePackage
  /** Where the `bundle.json` payload is. */
  payloadDir: string
  /** Whether it was found as one of the site's dependencies rather than a directory. */
  dependency: boolean
  /** The package's directory. */
  directory: string
  set: ContentSet
  blobs: ReadonlyMap<string, string>
  /** The sections it carries beyond its content; empty for a content-only bundle. */
  carried: CarriedSections
  /** A carried media file's bytes as exported: opened, when the bundle sealed them. */
  openBlob: (key: string, bytes: Uint8Array) => Uint8Array
}

/** Where a package directory or a dependency's name points, before anything is read. */
function locate(target: string, siteDir: string): { directory: string; dependency: boolean } {
  const path = resolve(target)
  if (isDirectory(path)) return { directory: path, dependency: false }
  if (!isPackageName(target))
    throw new CommandError(`${target} is neither a directory nor a package name.`)
  const declared = discoverBundles(siteDir)
  const found = declared.bundles.find((bundle) => bundle.packageName === target)
  if (found) return { directory: found.directory, dependency: true }
  const broken = declared.problems.find((problem) => problem.packageName === target)
  if (broken)
    throw new CommandError(`${target} is not a valid bundle; nothing was read.`, broken.problems)
  throw new CommandError(
    `${target} is not a bundle this site depends on. Add it with \`bun add ${target}\`, or name a package directory.`,
  )
}

/**
 * The bundle a path or a package name names, read whole, or a refusal: a
 * half-copied bundle must never be checked as though complete.
 */
export function readBundle(target: string, siteDir: string, passphrase?: string): ResolvedBundle {
  const { directory, dependency } = locate(target, siteDir)
  const json = readPackageJson(join(directory, 'package.json'))
  if (!json) {
    if (existsSync(join(directory, PAYLOAD_MANIFEST)))
      throw new CommandError(
        `${target} is a bare ${PAYLOAD_MANIFEST} with no package.json. Every bundle is an npm package: ` +
          `a package.json whose "crombolo" field names the payload directory, with the payload under content/.`,
      )
    throw new CommandError(`${target} has no package.json, so it is not a bundle.`)
  }
  const read = readBundlePackage(directory)
  if (!read.bundle)
    throw new CommandError(
      `${target} is not a valid bundle; nothing was read from it.`,
      read.problems.length > 0 ? read.problems : ['its package.json has no "crombolo" field'],
    )
  const pkg = read.bundle
  if (!pkg.contentDir)
    throw new CommandError(
      `${pkg.packageName} carries no content to install: its manifest names no "content".`,
    )
  const peer = peerRangeProblem(pkg, VERSION)
  if (peer) throw new CommandError(`${pkg.packageName} cannot be installed here: ${peer}.`)

  const loaded = loadBundle(pkg.contentDir)
  const problems = loaded.problems.map((problem) => `${problem.file}: ${problem.message}`)
  if (!loaded.set || problems.length > 0)
    throw new CommandError(
      'The bundle is incomplete or damaged; nothing was read from it.',
      problems,
    )
  // Opened only when given the passphrase: without one the set stays sealed,
  // and the check says what it needs rather than comparing what it cannot read.
  let opened: ReturnType<typeof openBundle> = {
    set: loaded.set,
    people: undefined,
    openBlob: (_key, bytes) => bytes,
  }
  if (passphrase !== undefined && passphrase !== '')
    try {
      opened = openBundle(loaded, passphrase)
    } catch (error) {
      if (error instanceof WrongPassphraseError)
        throw new PassphraseError(
          'The passphrase does not open this bundle; nothing was read from it.',
        )
      if (error instanceof SealedFileError)
        throw new CommandError('The bundle is damaged; nothing was read from it.', [error.message])
      throw error
    }
  return {
    package: pkg,
    payloadDir: pkg.contentDir,
    dependency,
    directory,
    set: opened.set,
    blobs: loaded.blobs,
    carried: carriedSections(loaded),
    openBlob: opened.openBlob,
  }
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

function summarise(bundle: ResolvedBundle): BundleSummary {
  const set = bundle.set
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
    package: { name: bundle.package.packageName, version: bundle.package.version },
  }
}

export interface TransferInput extends SectionOptions {
  /** A package directory on this machine, or the name of a bundle the site depends on. */
  bundle: string
  /** Where the bundle's roots go: a path or a key. */
  under?: string
  /** Decisions by node key, on top of any the bundle carries: `"*"` and per property. */
  resolutions?: Record<string, NodeResolutions>
  resolveAll?: Resolution
  allowMissingBlobs?: boolean
  /** Publish what was live at the source; the check then says which pages would be refused. */
  publish?: boolean
  /** Who asked, recorded on the pending import. */
  by?: string
  /** Opens what the bundle sealed; used for this request only, never stored. */
  passphrase?: string
}

/**
 * The options `check` and `import` share: the bundle's saved decisions, then
 * those given in the backoffice, then the caller's; then placement.
 */
export async function transferOptions(
  db: Db,
  config: CromboloConfig,
  bundle: ResolvedBundle,
  input: Omit<TransferInput, 'bundle'>,
): Promise<{ options: CheckOptions; under: NodeRow | undefined; problems: string[] }> {
  const saved = loadResolutions(bundle.payloadDir, bundle.set.manifest.id)
  const answers = new TransferAnswerRepository(db)
  const given = answersByNode(await answers.answers(bundle.set.manifest.id)) as Record<
    string,
    NodeResolutions
  >
  const pending = await answers.pending(bundle.set.manifest.id)
  const resolutions = mergeResolutions(
    mergeResolutions(saved.file?.byNode ?? {}, given),
    input.resolutions ?? {},
  )
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
      allowMissingBlobs: input.allowMissingBlobs ?? pending?.allowMissingBlobs ?? false,
      hasBlob: async (key: string) => Boolean(await store.get(key)),
      backOfficePath: config.backOfficePath,
    },
    under,
    problems: saved.problems,
  }
}

export interface ContentCheckResult {
  bundle: BundleSummary
  /** Where the payload was read from, which is where saved decisions are written. */
  payloadDir: string
  under: string | null
  check: TransferCheck
  /** What the carried sections would do here; undefined for a content-only bundle. */
  sections: SectionPlan | undefined
  /** Nothing outstanding: the bundle would import cleanly. */
  clean: boolean
  /** With `publish`: the pages the import would not publish, and the reason publish gives. */
  publishRefusals: { key: string; reason: string }[]
  /** The decisions this check ran with — the bundle's saved ones under the caller's. */
  decisions: { all: Resolution | null; byNode: Record<string, NodeResolutions> }
  problems: string[]
}

/** Read-only: what installing a bundle here would do. Its findings go to the Changes dashboard. */
export async function checkBundleContent(
  db: Db,
  config: CromboloConfig,
  input: TransferInput,
): Promise<ContentCheckResult> {
  const bundle = readBundle(input.bundle, config.siteDir, input.passphrase)
  const set = bundle.set
  const prepared = await transferOptions(db, config, bundle, input)
  const check = await checkBundle(db, set, prepared.options)
  await recordPending(db, bundle, input, prepared.options.allowMissingBlobs ?? false)
  // Rehearsed rather than predicted, so the refusals are publish's own, word
  // for word; only once nothing is outstanding, since the import stops there.
  const refusals =
    input.publish && check.outstanding.length === 0
      ? ((await rehearsePublish(db, set, prepared.options)) ?? [])
      : []
  const names = new Map(set.nodes.map((node) => [node.key, node.variants[0]?.name ?? node.key]))
  for (const refusal of refusals)
    check.findings.push({
      kind: 'auto',
      code: 'publish-refused',
      subjectType: 'document',
      subjectKey: refusal.key,
      subjectName: names.get(refusal.key) ?? refusal.key,
      propertyAlias: null,
      culture: null,
      message: `"${names.get(refusal.key) ?? refusal.key}" would not be published: ${refusal.reason}`,
      link: null,
    })
  // Under this bundle's own scope, so two bundles in flight do not resolve each other's.
  await writeReport(db, check.findings, { source: 'transfer', scope: set.manifest.id })
  return {
    bundle: summarise(bundle),
    payloadDir: bundle.payloadDir,
    under: prepared.under ? (prepared.under.text ?? prepared.under.key) : null,
    check,
    sections: carriesSections(bundle.carried)
      ? await planSections(db, config, bundle.carried, input)
      : undefined,
    clean: check.outstanding.length === 0,
    publishRefusals: refusals,
    decisions: {
      all: prepared.options.resolveAll ?? null,
      byNode: { ...(prepared.options.resolutions ?? {}) },
    },
    problems: prepared.problems,
  }
}

export interface ContentImportInput extends TransferInput {
  /**
   * Make the site the file's (story 105). `replace` recycles content and media
   * the file lacks and keeps the site's people; `replace-all` deletes them, and
   * the people the file lacks.
   */
  replace?: ReplaceMode
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

/**
 * What the dashboard needs to run this bundle's import again: where it was
 * found and what it was asked to do. A directory is this server's path.
 */
async function recordPending(
  db: Db,
  bundle: ResolvedBundle,
  input: TransferInput,
  allowMissingBlobs: boolean,
): Promise<void> {
  const manifest = bundle.set.manifest
  await new TransferAnswerRepository(db).recordCheck({
    bundleId: manifest.id,
    label: manifest.label ?? (bundle.package.name || bundle.package.packageName),
    target: bundle.dependency ? bundle.package.packageName : bundle.directory,
    targetKind: bundle.dependency ? 'package' : 'directory',
    under: input.under ?? null,
    publish: input.publish ?? false,
    allowMissingBlobs,
    checkedAt: new Date(),
    checkedBy: input.by ?? null,
  })
}

/**
 * The decisions an import of this bundle would run with — saved, then given
 * in the backoffice — as the `resolutions.json` the CLI's `--save` writes.
 */
export async function pendingResolutionsFile(
  db: Db,
  config: CromboloConfig,
  bundleId: string,
): Promise<string | undefined> {
  const pending = await new TransferAnswerRepository(db).pending(bundleId)
  if (!pending) return undefined
  const bundle = readBundle(pending.target, config.siteDir)
  const saved = loadResolutions(bundle.payloadDir, bundleId)
  const given = answersByNode(await new TransferAnswerRepository(db).answers(bundleId))
  return writeResolutions({
    bundleId,
    under: pending.under ?? saved.file?.under ?? null,
    all: saved.file?.all ?? null,
    byNode: mergeResolutions(saved.file?.byNode ?? {}, given as Record<string, NodeResolutions>),
  })
}

/** Thrown inside the import's transaction to roll everything back, carrying why. */
class InstallRefused extends Error {
  constructor(
    readonly problems: string[],
    readonly result?: ImportResult,
  ) {
    super(problems[0] ?? 'the import was refused')
  }
}

/**
 * Back up, re-check, then apply all or nothing and record the run (story 105).
 *
 * Three phases. **Stage**: every carried section is written into a copy under
 * the run's directory, and the media files are placed under their own keys.
 * **One transaction**: the prune a replace asks for, the schema sync against
 * the staged copy, the dictionary and the content — so a refusal anywhere
 * leaves the database as it was. **Swap**: once it commits, the staged folders
 * move into place and what they replace is kept for the run's revert. A
 * failure before the swap leaves the site's files untouched and removes the
 * media files it placed.
 */
export async function installBundleContent(
  db: Db,
  config: CromboloConfig,
  input: ContentImportInput,
): Promise<ContentImportResult> {
  const bundle = readBundle(input.bundle, config.siteDir, input.passphrase)
  const { set, blobs, carried } = bundle
  // Before the backup and the sections: nothing of a bundle that cannot be
  // opened is applied.
  if (set.sealed)
    throw new PassphraseError(
      'This bundle is encrypted: give the passphrase it was exported with. Nothing was written.',
    )
  const manifest = set.manifest
  const replace = input.replace
  const refuse = (problems: string[], backup?: BackupResult): ContentImportResult => ({
    bundle: summarise(bundle),
    backup: backup ?? { kind: 'none' },
    runId: undefined,
    check: emptyCheck(manifest.id),
    blobs: null,
    published: 0,
    publishFailures: [],
    problems,
    sections: undefined,
  })

  // What has to be true before anything is backed up or written.
  if (replace && manifest.scope !== 'site')
    return refuse(['only a whole-site file (crombolo export --site) can replace a site'])
  const missing = requiresProblems(manifest, config.siteDir)
  if (missing.length > 0) return refuse(missing)
  if (manifest.media === 'omitted' && !input.allowMissingBlobs)
    return refuse([
      'this file was written without its media files (--no-media); pass --allow-missing-media to import the media items without them',
    ])
  // Referenced media arrives in the store one file at a time, before the file
  // that names it (story 107): every one has to be there already.
  let referencedPresent = false
  if (manifest.media === 'referenced') {
    const store = await mediaStoreFor(config)
    const absent: string[] = []
    for (const blob of manifest.blobs) if (!(await store.get(blob.key))) absent.push(blob.key)
    if (absent.length > 0 && !input.allowMissingBlobs)
      return refuse([
        `${absent.length} media file(s) this file refers to are not in the media store yet`,
        ...absent,
      ])
    referencedPresent = true
  }
  if (replace === 'replace-all' && !carriesAdministrator(set.people))
    return refuse([
      'this file carries no back-office administrator, so replacing everything would leave nobody able to sign in; export it with --with-users, or use --replace',
    ])

  // A replace takes the file's side of every difference, and replaces files.
  const replaced: ContentImportInput = replace
    ? { ...input, resolveAll: 'take-bundle', replaceFiles: true, publish: input.publish ?? true }
    : input
  const effective: ContentImportInput = referencedPresent
    ? { ...replaced, allowMissingBlobs: true }
    : replaced

  // The coarse layer, under the fine-grained revert: in-place conversion is not
  // reversible by itself, so the same rule as `upgrade` applies here.
  const backup = await backupBefore(config, {
    reason: 'content-import',
    backupTaken: input.backupTaken,
  })
  const prepared = await transferOptions(db, config, bundle, effective)
  const started = performance.now()

  /**
   * Structure first, but planned before anything is written: a blocking
   * schema change is caught from an overlay copy, and a file an editor may
   * have changed is not replaced without being asked.
   */
  const plan = carriesSections(carried)
    ? await planSections(db, config, carried, effective)
    : undefined
  if (plan?.schema?.classification === 'breaking')
    return refuse(
      [
        'the schema this bundle carries cannot be applied here without data work',
        ...plan.schema.findings,
      ],
      backup,
    )
  const needingPermission = plan ? replacementsNeedingPermission(plan, effective) : []
  if (needingPermission.length > 0)
    return refuse(
      [
        `${needingPermission.length} file(s) here would be replaced; pass --replace-files to allow it`,
        ...needingPermission.map((file: SectionFile) => file.path),
      ],
      backup,
    )

  // ---- 1. Stage
  const runDir = stageBackups(config)
  const staged =
    plan || replace
      ? stageSections(config, carried, { ...effective, replace: Boolean(replace) }, runDir)
      : undefined
  const store = blobs.size > 0 ? await mediaStoreFor(config) : undefined
  const placedHere: string[] = []
  let placed: ContentImportResult['blobs'] = null
  if (store) {
    for (const key of blobs.keys()) if (!(await store.get(key))) placedHere.push(key)
    placed = await placeBlobs(store, blobs, bundle.openBlob)
  }
  const undoStage = async () => {
    for (const key of placedHere) await store?.delete(key).catch(() => {})
    rmSync(runDir, { recursive: true, force: true })
  }

  // ---- 2. One transaction
  let schemaAction: string | undefined
  let dictionary: SectionResult['dictionary']
  let result: ImportResult
  try {
    result = await db.locks.withLock(Locks.Schema, () =>
      db.locks.withLock(Locks.ContentTree, () =>
        db.transaction(async (tx) => {
          const pruned = replace ? await pruneSite(tx, set, replace, config.nodeId) : []
          if (replace === 'replace-all') await prunePeople(tx, set.people)
          if (staged?.next.schema) {
            const report = await syncSchemaDirectory(
              tx,
              stagedConfig(config, staged),
              { nodeId: config.nodeId, revision: config.schemaRevision },
              { forceRetireTypes: Boolean(replace) },
            )
            if (report.action === 'refused' || report.action === 'skipped-older')
              throw new InstallRefused([
                `the schema this bundle carries was not applied: ${report.reason ?? report.action}`,
              ])
            schemaAction = report.action
          }
          const udtPath = `${BUNDLE_SECTIONS.dictionary}.udt`
          const carriesDictionary = (carried.carries.dictionary ?? []).includes(udtPath)
          if (carriesDictionary || replace) {
            const repo = new DictionaryRepository(tx)
            keepDictionary(runDir, writeDictionaryUdt(await dictionaryToUdt(repo)))
            if (replace) for (const root of await repo.children(null)) await repo.delete(root.key)
            for (const path of carried.carries.dictionary ?? []) {
              const file = carried.files.get(path)
              if (!file) continue
              const outcome = await importDictionaryUdt(tx, readFileSync(file, 'utf8'))
              dictionary = {
                imported: (dictionary?.imported ?? 0) + outcome.imported,
                skipped: [...(dictionary?.skipped ?? []), ...outcome.skipped],
              }
            }
          }
          const imported = await importBundle(tx, set, {
            ...prepared.options,
            publish: effective.publish ?? false,
            nodeId: config.nodeId,
            label: input.label,
            package: { name: bundle.package.packageName, version: bundle.package.version },
            exact: Boolean(replace),
          })
          if (!imported.runId) throw new InstallRefused([], imported)
          await recordPruned(tx, imported.runId, pruned)
          return imported
        }),
      ),
    )
  } catch (error) {
    await undoStage()
    if (!(error instanceof InstallRefused)) throw error
    if (!error.result) return refuse(error.problems, backup)
    await writeReport(db, error.result.check.findings, { source: 'transfer', scope: manifest.id })
    await recordPending(db, bundle, input, prepared.options.allowMissingBlobs ?? false)
    return {
      ...refuse(prepared.problems, backup),
      check: error.result.check,
    }
  }
  const runId = result.runId as string

  // ---- 3. Swap
  if (staged) {
    swapSections(config, staged)
    if (staged.next.schema && config.schemaStore)
      await publishSchema(config.schemaStore, config.schemaDir)
  }
  const kept = promoteStaged(config, runDir, runId)
  // Domains belong to where the site runs, never to the file: rebound by the
  // site's own `domains.toml` onto the pages now in its tree.
  if (replace) await syncDomainsFile(db, config.siteDir)
  await writeReport(db, result.check.findings, { source: 'transfer', scope: manifest.id })
  await new TransferAnswerRepository(db).clear(manifest.id)
  await recordInLedger(db, {
    name: `content import ${manifest.id}`,
    kind: 'transfer',
    durationMs: Math.round(performance.now() - started),
    appliedBy: config.nodeId,
    note: `run ${runId}, ${bundle.package.packageName}@${bundle.package.version}${replace ? `, --${replace}` : ''}`,
  })
  return {
    bundle: summarise(bundle),
    backup,
    runId,
    check: result.check,
    blobs: placed,
    published: result.published.length,
    publishFailures: result.publishFailures,
    problems: prepared.problems,
    sections: staged
      ? {
          written: staged.written,
          replaced: [],
          schema: schemaAction ? { action: schemaAction } : undefined,
          dictionary,
        }
      : undefined,
    replacedFilesKept: staged ? kept : undefined,
  }
}

export interface RevertedSections extends RestoredFiles {
  /** The schema sync after the swap back, when the run swapped schema in. */
  schema: string | undefined
  /** Whether the dictionary was put back as the run found it. */
  dictionary: boolean
}

/**
 * What an install did beyond its content, undone once `revertRun` has put the
 * content back (story 105): the folders swapped back, the schema re-synced to
 * them, and the dictionary restored as the run found it.
 */
export async function revertSections(
  db: Db,
  config: CromboloConfig,
  runId: string,
): Promise<RevertedSections> {
  const swapped = swappedSections(config, runId)
  const files = restoreSectionFiles(config, runId)
  let schema: string | undefined
  if (swapped.includes('schema')) {
    // A type the install brought has content only in the bin by now, which is
    // what retiring it here is for.
    const report = await syncSchemaDirectory(
      db,
      config,
      { nodeId: config.nodeId, revision: config.schemaRevision },
      { forceRetireTypes: true },
    )
    schema = report.action
    if (config.schemaStore) await publishSchema(config.schemaStore, config.schemaDir)
  }
  const kept = keptDictionary(config, runId)
  if (kept !== undefined)
    await db.transaction(async (tx) => {
      const repo = new DictionaryRepository(tx)
      for (const root of await repo.children(null)) await repo.delete(root.key)
      await importDictionaryUdt(tx, kept)
    })
  return { ...files, schema, dictionary: kept !== undefined }
}
