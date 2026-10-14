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
import { existsSync } from 'node:fs'
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
  type Db,
  describeRefFailure,
  type NodeRow,
  recordInLedger,
  resolveNodeRef,
  writeReport,
} from '@crombolo/data'
import {
  type CheckOptions,
  type ContentSet,
  checkBundle,
  importBundle,
  isPackageName,
  loadBundle,
  loadResolutions,
  type Resolution,
  type TransferCheck,
} from '@crombolo/transfer'
import { type BackupResult, backupBefore } from './backup.ts'
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
} from './bundle-sections.ts'
import { type CromboloConfig, VERSION } from './config.ts'
import { mediaStoreFor, placeBlobs } from './media-files.ts'
import { componentAliasesIn } from './schema.ts'

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
  set: ContentSet
  blobs: ReadonlyMap<string, string>
  /** The sections it carries beyond its content; empty for a content-only bundle. */
  carried: CarriedSections
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
export function readBundle(target: string, siteDir: string): ResolvedBundle {
  const { directory, dependency } = locate(target, siteDir)
  const json = readPackageJson(join(directory, 'package.json'))
  if (!json) {
    if (existsSync(join(directory, PAYLOAD_MANIFEST)))
      throw new CommandError(
        `${target} is a bare ${PAYLOAD_MANIFEST} with no package.json. Every bundle is an npm package: ` +
          `a package.json whose "crombolo" field names the payload directory, with the payload under bundle/.`,
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
  return {
    package: pkg,
    payloadDir: pkg.contentDir,
    dependency,
    set: loaded.set,
    blobs: loaded.blobs,
    carried: carriedSections(loaded),
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
  /** A decision per node key, on top of any the bundle carries. */
  resolutions?: Record<string, Resolution>
  resolveAll?: Resolution
  allowMissingBlobs?: boolean
}

/** The options `check` and `import` share: saved decisions, then the caller's, then placement. */
export async function transferOptions(
  db: Db,
  config: CromboloConfig,
  bundle: ResolvedBundle,
  input: Omit<TransferInput, 'bundle'>,
): Promise<{ options: CheckOptions; under: NodeRow | undefined; problems: string[] }> {
  const saved = loadResolutions(bundle.payloadDir, bundle.set.manifest.id)
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
  /** Where the payload was read from, which is where saved decisions are written. */
  payloadDir: string
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

/** Read-only: what installing a bundle here would do. Its findings go to the Changes dashboard. */
export async function checkBundleContent(
  db: Db,
  config: CromboloConfig,
  input: TransferInput,
): Promise<ContentCheckResult> {
  const bundle = readBundle(input.bundle, config.siteDir)
  const set = bundle.set
  const prepared = await transferOptions(db, config, bundle, input)
  const check = await checkBundle(db, set, prepared.options)
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
    decisions: {
      all: prepared.options.resolveAll ?? null,
      byNode: prepared.options.resolutions ?? {},
    },
    problems: prepared.problems,
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

/** Back up, re-check, then apply in one transaction and record the run. */
export async function installBundleContent(
  db: Db,
  config: CromboloConfig,
  input: ContentImportInput,
): Promise<ContentImportResult> {
  const bundle = readBundle(input.bundle, config.siteDir)
  const { set, blobs, carried } = bundle
  // The coarse layer, under the fine-grained revert: in-place conversion is not
  // reversible by itself, so the same rule as `upgrade` applies here.
  const backup = await backupBefore(config, {
    reason: 'content-import',
    backupTaken: input.backupTaken,
  })
  const prepared = await transferOptions(db, config, bundle, input)
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
  const plan = carriesSections(carried) ? await planSections(db, config, carried, input) : undefined
  const refuse = (problems: string[]): ContentImportResult => ({
    bundle: summarise(bundle),
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
   * content type — so an overwrite destroys somebody's work, and the site
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
    package: { name: bundle.package.packageName, version: bundle.package.version },
  })
  await writeReport(db, result.check.findings, { source: 'transfer', scope: set.manifest.id })
  const outcome: ContentImportResult = {
    bundle: summarise(bundle),
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
    note: `run ${result.runId}, ${bundle.package.packageName}@${bundle.package.version}`,
  })
  return outcome
}
