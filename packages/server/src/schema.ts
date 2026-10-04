/**
 * Schema-as-code at runtime: the boot sync, the development watcher that
 * re-syncs on file changes, and the cache-instruction poll that keeps this
 * node's caches coherent with the others. docs/09-schema-as-code.md.
 */

import { existsSync, readdirSync, watch } from 'node:fs'
import { basename } from 'node:path'
import {
  type CacheInstructionKind,
  cacheInstructionsAfter,
  compareStates,
  contractsLedgeredAfter,
  currentSchemaState,
  type Db,
  ensureSystemMediaTypes,
  ensureSystemMemberTypes,
  type Finding,
  latestCacheInstructionId,
  latestLedgerId,
  type NodeSchemaState,
  readWritesPaused,
  touchServer,
  updateSchemaStateHash,
  type WritesPaused,
  writeReport,
} from '@bunbraco/data'
import {
  type ChangeClass,
  type CheckReport,
  hashSchemaSet,
  loadSchemaDirectory,
  loadValueMigrations,
  runCheck,
  type SyncOptions,
  type SyncReport,
  syncSchema,
  writeKeysBack,
} from '@bunbraco/schema'
import type { BunbracoConfig } from './config.ts'
import { logger } from './logging.ts'
import { materialiseSchema } from './schema-store.ts'

export interface SchemaBoot {
  /** The state this node runs at: the files' version, the deploy's revision. */
  nodeState: NodeSchemaState
  nodeId: string
  /** Undefined when there is no schema directory. */
  report: SyncReport | undefined
  /** True when the database is ahead of the files: reads only, 409 on writes. */
  compatibilityMode: boolean
  /** The pre-upgrade check run at boot (development), written to `change_report`. */
  check?: CheckReport
}

/** Production boot found the site diff needs data work: that is `upgrade check`'s job, not boot's. */
export class UpgradeRequiredError extends Error {
  constructor(readonly check: CheckReport) {
    super(
      `schema/ changes need data work before they can apply (${check.outstanding.length} finding(s), ${check.classification}): ` +
        'run `bunbraco upgrade check`, then `bunbraco upgrade check --fix`, then `bunbraco upgrade`.',
    )
  }
}

/** The check over the site's diff, with its value migrations loaded. */
export async function checkSchemaDirectory(
  db: Db,
  config: BunbracoConfig,
  node: { nodeId: string; revision: string },
  options: { set?: Record<string, unknown> } = {},
): Promise<CheckReport> {
  const loaded = loadSchemaDirectory(config.schemaDir)
  return runCheck(
    db,
    loaded,
    { nodeId: node.nodeId, version: loaded.set.version, revision: node.revision },
    {
      ...syncOptionsFor(config),
      set: options.set,
      migrations: await loadValueMigrations(config.schemaDir),
      backOfficePath: config.backOfficePath,
    },
  )
}

export class SchemaBootError extends Error {
  constructor(readonly report: SyncReport) {
    super(
      report.problems.length > 0
        ? `schema/ has problems:\n${report.problems.map((p) => `  ${p.file}: ${p.path ? `${p.path}: ` : ''}${p.message}`).join('\n')}`
        : `schema sync refused: ${report.reason ?? 'unknown reason'}`,
    )
  }
}

/** The view files a schema may name as templates. */
export function templateAliasesIn(viewsDir: string): Set<string> {
  if (!existsSync(viewsDir)) return new Set()
  return new Set(
    readdirSync(viewsDir)
      .filter((name) => /\.(tsx|jsx)$/.test(name))
      .map((name) => basename(name).replace(/\.(tsx|jsx)$/, '')),
  )
}

export function syncOptionsFor(config: BunbracoConfig): SyncOptions {
  return {
    mode: config.development ? 'development' : 'production',
    templateAliases: templateAliasesIn(config.viewsDir),
  }
}

/** One sync of the directory, with key write-back in development. */
export async function syncSchemaDirectory(
  db: Db,
  config: BunbracoConfig,
  node: { nodeId: string; version?: string; revision: string },
  options: Partial<SyncOptions> = {},
): Promise<SyncReport> {
  const loaded = loadSchemaDirectory(config.schemaDir)
  const report = await syncSchema(
    db,
    loaded,
    { nodeId: node.nodeId, version: loaded.set.version, revision: node.revision },
    { ...syncOptionsFor(config), ...options },
  )
  if (
    report.action === 'applied' &&
    config.schemaWritable &&
    report.assignedKeys.length > 0 &&
    report.state
  ) {
    writeKeysBack(loaded, report.assignedKeys)
    await updateSchemaStateHash(db, report.state.id, hashSchemaSet(loaded.set))
  }
  return report
}

export async function bootSchema(db: Db, config: BunbracoConfig): Promise<SchemaBoot> {
  const nodeId = config.nodeId
  if (!existsSync(config.schemaDir)) {
    const nodeState = { version: '0', revision: config.schemaRevision }
    await touchServer(db, { nodeId, ...nodeState, role: config.role })
    await ensureSystemMediaTypes(db, { linkFolderChildren: true })
    await ensureSystemMemberTypes(db)
    return { nodeState, nodeId, report: undefined, compatibilityMode: false }
  }
  const loaded = loadSchemaDirectory(config.schemaDir)
  const nodeState = { version: loaded.set.version, revision: config.schemaRevision }
  await touchServer(db, { nodeId, ...nodeState, role: config.role })
  if (!config.syncSchemaAtBoot)
    return { nodeState, nodeId, report: undefined, compatibilityMode: false }

  const node = { nodeId, revision: config.schemaRevision }
  if (!config.development) {
    // A rolling deploy expands; anything needing data refuses and names the command.
    const check = await checkSchemaDirectory(db, config, node)
    if (check.sync.action === 'would-apply' && check.outstanding.length > 0)
      throw new UpgradeRequiredError(check)
  }
  const report = await syncSchemaDirectory(db, config, node)
  if (report.action === 'refused') throw new SchemaBootError(report)
  // Folder allows whichever built-in media types the site has — unless a file
  // defines Folder, and so says itself what it allows.
  const folderInFiles = (loaded.set.mediaTypes ?? []).some((t) => t.alias === 'Folder')
  await ensureSystemMediaTypes(db, { linkFolderChildren: !folderInFiles })
  await ensureSystemMemberTypes(db)
  const boot: SchemaBoot = {
    nodeState,
    nodeId,
    report,
    compatibilityMode: report.action === 'skipped-older',
  }
  if (config.development) {
    // pending-allowed: the findings go to the dashboard, and boot continues.
    boot.check = await checkSchemaDirectory(db, config, node)
    await writeReport(db, boot.check.findings, { source: 'upgrade' })
  }
  return boot
}

export interface SchemaWatcher {
  close(): void
}

/** Re-syncs on every change under `schema/`; development only. */
export function watchSchema(
  db: Db,
  config: BunbracoConfig,
  node: { nodeId: string; revision: string },
  onReport: (report: SyncReport) => void,
): SchemaWatcher | undefined {
  if (!existsSync(config.schemaDir)) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let again = false
  let closed = false
  const run = async () => {
    if (closed) return
    if (running) {
      again = true
      return
    }
    running = true
    try {
      onReport(await syncSchemaDirectory(db, config, node))
    } catch (error) {
      if (!closed) logger('schema').error('Watching the schema files failed', { error })
    } finally {
      running = false
      if (again) {
        again = false
        void run()
      }
    }
  }
  const watcher = watch(config.schemaDir, { recursive: true }, (_event, file) => {
    if (file && !String(file).endsWith('.toml')) return
    clearTimeout(timer)
    timer = setTimeout(() => void run(), 150)
  })
  watcher.unref()
  return {
    close() {
      closed = true
      clearTimeout(timer)
      watcher.close()
    },
  }
}

export interface CachePollerOptions {
  db: Db
  nodeId: string
  nodeState: NodeSchemaState
  /** Recorded in `server` on each poll, so the cluster can be read back by role. */
  role?: string
  /** Called for instructions other nodes appended. */
  onInstruction(kind: CacheInstructionKind, payload: Record<string, unknown>): void
}

/** Polls `cache_instruction` from where this node came in; own instructions are skipped. */
export class CacheInstructionPoller {
  #options: CachePollerOptions
  #cursor = 0
  #timer: ReturnType<typeof setInterval> | undefined
  #behind = false
  #bootLedgerId = 0
  #readsUnsafe = false
  #paused: WritesPaused | undefined

  /** True once an upgrade has moved the database past this node: reads only. */
  get behind(): boolean {
    return this.#behind
  }

  /**
   * True once the node is behind and a contract — a framework contract or a
   * site purge — has run since it booted. Expand-only changes leave an old
   * node's reads correct, as-of its own state; a contract removes something it
   * may still read, so only then must it stop serving.
   */
  get readsUnsafe(): boolean {
    return this.#readsUnsafe
  }

  /** Set while an operator has paused editing cluster-wide. */
  get paused(): WritesPaused | undefined {
    return this.#paused
  }

  constructor(options: CachePollerOptions) {
    this.#options = options
  }

  async start(intervalMs: number): Promise<void> {
    this.#bootLedgerId = await latestLedgerId(this.#options.db)
    this.#paused = await readWritesPaused(this.#options.db)
    this.#cursor = await latestCacheInstructionId(this.#options.db)
    if (intervalMs > 0) {
      this.#timer = setInterval(() => void this.poll().catch(() => {}), intervalMs)
      this.#timer.unref()
    }
  }

  /** Returns how many foreign instructions were applied. */
  async poll(): Promise<number> {
    const { db, nodeId, nodeState, onInstruction } = this.#options
    const instructions = await cacheInstructionsAfter(db, this.#cursor)
    let applied = 0
    for (const instruction of instructions) {
      this.#cursor = Math.max(this.#cursor, instruction.id)
      if (instruction.createdBy === nodeId) continue
      onInstruction(instruction.kind, instruction.payload)
      applied += 1
    }
    await touchServer(db, { nodeId, ...nodeState, role: this.#options.role })
    const current = await currentSchemaState(db)
    const behind = compareStates(nodeState, current) < 0
    if (behind && !this.#behind) onInstruction('schema', { stateId: current.id })
    this.#behind = behind
    // Sticky: once a contract has passed this node, no later poll makes its
    // reads trustworthy again — only a replacement node does.
    if (behind && !this.#readsUnsafe)
      this.#readsUnsafe = (await contractsLedgeredAfter(db, this.#bootLedgerId)) > 0
    this.#paused = await readWritesPaused(db)
    return applied
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }
}

export interface SchemaImportResult {
  /** Files copied down from the store; undefined when the schema is a directory. */
  materialised: number | undefined
  /** How the files compare with the live database, from the same check that gates an upgrade. */
  classification: ChangeClass
  /** Findings a person should see before this is applied. */
  findings: Finding[]
  /** Undefined for a dry run, which asks what would happen without doing it. */
  report: SyncReport | undefined
}

/**
 * Applies the schema files to the database at runtime, rather than only at boot.
 *
 * This is what makes the files the source of truth rather than a projection of
 * the database: a TOML edited in a commit, published by another node, or written
 * by the backoffice arrives here and is imported the same way, through one path.
 *
 * Deliberately never automatic. It runs when someone asks, or when an operation
 * needs it — committing an assistant changeset, publishing type changes — because
 * importing a half-finished schema underneath an editor mid-save is worse than
 * importing a minute later.
 *
 * `nodeState` is refreshed in place on success: the poller, `/health` and the
 * published-content source all hold that one object, and without it a node that
 * has just imported its own change would immediately judge itself behind and
 * drain.
 */
export async function importSchema(
  db: Db,
  config: BunbracoConfig,
  boot: { nodeId: string; nodeState: NodeSchemaState },
  options: { dryRun?: boolean } = {},
): Promise<SchemaImportResult> {
  let materialised: number | undefined
  if (config.schemaStore) {
    materialised = (await materialiseSchema(config.schemaStore, config.schemaCacheDir)).length
    config.schemaDir = config.schemaCacheDir
  }
  if (!existsSync(config.schemaDir)) {
    return { materialised, classification: 'none', findings: [], report: undefined }
  }

  const node = { nodeId: boot.nodeId, revision: config.schemaRevision }
  const check = await checkSchemaDirectory(db, config, node)
  if (options.dryRun) {
    return {
      materialised,
      classification: check.classification,
      findings: check.outstanding,
      report: undefined,
    }
  }

  const report = await syncSchemaDirectory(db, config, node)
  if (report.action === 'applied') {
    boot.nodeState.version = loadSchemaDirectory(config.schemaDir).set.version
    boot.nodeState.revision = config.schemaRevision
  }
  return {
    materialised,
    classification: check.classification,
    findings: check.outstanding,
    report,
  }
}
