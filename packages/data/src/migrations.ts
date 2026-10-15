/**
 * Umbraco tracks upgrade state as a single state token in `key_value`, not a
 * version number and not a list of applied migrations: the plan is a chain of
 * transitions walked forward to its final state. That design handles concurrent
 * development branches far better than sequence numbers, so we keep it — and
 * harden it (docs/packaging-and-upgrades.md): a ledger of every step that
 * ran, expand/contract declared and linted, a recorded plan, and an explicit
 * refusal when the database is newer than the code.
 */
import type { Db } from './database.ts'
import type { Dialect } from './dialect.ts'
import type { LockManager } from './locks.ts'
import { Locks } from './locks.ts'

export const MIGRATION_STATE_KEY = 'Crombolo.Core.Upgrader.State'
export const INITIAL_STATE = '{00000000-0000-0000-0000-000000000000}'

export type MigrationKind = 'expand' | 'contract'

export interface Migration {
  /** State the database must be in for this step to apply. */
  from: string
  /** State the database is in once this step has run. */
  to: string
  name: string
  /** Expand adds and never removes; contract removes what an earlier release's expand added. Default expand. */
  kind?: MigrationKind
  /** The framework release that ships this step. Required for a contract and for what it contracts. */
  release?: string
  /** For a contract: the name of the expand migration it removes. */
  contracts?: string
  /** Recorded in the ledger, and compared when the plan verifies what ran. Defaults to `name`. */
  checksum?: string
  up(db: Db): Promise<void>
  /**
   * Writes data once `up` has run, in the same transaction. `planUpgrade` cannot
   * predict what it writes, so a step that has one is reported as unplannable.
   */
  backfill?(db: Db): Promise<void>
}

/** Where a chain keeps its state, and what it calls itself in the ledger. */
export interface ChainOptions {
  /** The `key_value` key holding the chain's state. */
  stateKey?: string
  /** The state before the first step. */
  initialState?: string
  /** A bundle's id, for a bundle's chain; absent for core's. */
  bundle?: string
}

function compareRelease(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map(Number)
  const pb = b.split(/[.+-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

/**
 * What a release promises a running cluster. `compatible`: every migration it
 * ships is an expand, so the previous release keeps working against the
 * migrated database and nodes can be rolled one at a time. `breaking`: it ships
 * a contract, which removes something an older node may still read.
 */
export type MigrationCompatibility = 'compatible' | 'breaking'

/** Derived, not asserted: `breaking` exactly when the release ships a contract. */
export function migrationCompatibility(
  plan: MigrationPlan,
  release: string,
): MigrationCompatibility {
  const contracts = plan.migrations.some(
    (m) =>
      m.kind === 'contract' && m.release !== undefined && compareRelease(m.release, release) === 0,
  )
  return contracts ? 'breaking' : 'compatible'
}

/** `x.0.0` with x ≥ 1. Pre-1.0 no release is major, so nothing may contract before 1.0.0. */
export function isMajorRelease(release: string): boolean {
  const [major = 0, minor = 0, patch = 0] = release.split(/[.+-]/).map(Number)
  return major >= 1 && minor === 0 && patch === 0
}

export class MigrationPlan {
  readonly migrations: readonly Migration[]
  readonly stateKey: string
  readonly initialState: string
  readonly bundle: string | undefined

  constructor(migrations: readonly Migration[], options: ChainOptions = {}) {
    this.migrations = migrations
    this.stateKey = options.stateKey ?? MIGRATION_STATE_KEY
    this.initialState = options.initialState ?? INITIAL_STATE
    this.bundle = options.bundle
    let expected = this.initialState
    const seen = new Map<string, Migration>()
    for (const migration of migrations) {
      if (migration.from !== expected) {
        throw new Error(
          `Migration '${migration.name}' expects state ${migration.from} but the chain is at ${expected}.`,
        )
      }
      if (migration.kind === 'contract') {
        const expand = migration.contracts ? seen.get(migration.contracts) : undefined
        if (!migration.contracts || !expand)
          throw new Error(
            `Contract migration '${migration.name}' must name the expand migration it removes.`,
          )
        if (expand.kind === 'contract')
          throw new Error(
            `Contract migration '${migration.name}' cannot contract another contract.`,
          )
        if (!migration.release || !expand.release)
          throw new Error(
            `Contract migration '${migration.name}' and '${expand.name}' must both declare a release.`,
          )
        if (compareRelease(expand.release, migration.release) >= 0)
          throw new Error(
            `Contract migration '${migration.name}' (${migration.release}) may only remove what an earlier release added; '${expand.name}' is ${expand.release}.`,
          )
        if (!isMajorRelease(migration.release))
          throw new Error(
            `Contract migration '${migration.name}' ships in ${migration.release}, but a contract may only ship in a major release (x.0.0): minors and patches are rolled under live nodes and must only add.`,
          )
      }
      seen.set(migration.name, migration)
      expected = migration.to
    }
  }

  get finalState(): string {
    return this.migrations.at(-1)?.to ?? this.initialState
  }

  /** The steps that have run when the chain is at a state; undefined when the state is not in it. */
  appliedAt(state: string): Migration[] | undefined {
    if (state === this.initialState) return []
    const index = this.migrations.findIndex((m) => m.to === state)
    return index < 0 ? undefined : this.migrations.slice(0, index + 1)
  }

  /** The steps still to run from a state; empty when current. Undefined when the state is not in the plan. */
  pendingFrom(state: string): Migration[] | undefined {
    if (state === this.finalState) return []
    const index = this.migrations.findIndex((m) => m.from === state)
    if (index < 0) return undefined
    return this.migrations.slice(index)
  }
}

/** Connections whose ledger tables are known to exist with every column. */
const ensured = new WeakSet<Db>()

async function ensureTables(db: Db): Promise<void> {
  if (ensured.has(db)) return
  const t = db.dialect.types
  await db.exec(
    `CREATE TABLE IF NOT EXISTS key_value (
       key ${t.text} PRIMARY KEY,
       value ${t.text},
       update_date ${t.timestamp} NOT NULL
     )`,
  )
  await db.exec(
    `CREATE TABLE IF NOT EXISTS migration_history (
       id ${t.identity},
       name ${t.varchar(255)} NOT NULL,
       kind ${t.varchar(20)} NOT NULL,
       from_state ${t.varchar(255)},
       to_state ${t.varchar(255)},
       applied_at ${t.timestamp} NOT NULL,
       duration_ms ${t.integer} NOT NULL,
       checksum ${t.varchar(64)},
       applied_by ${t.varchar(255)},
       note ${t.text},
       bundle ${t.varchar(64)}
     )`,
  )
  // A ledger from before bundles could own tables has no `bundle` column. It is
  // added here, where the table is, rather than by a core migration: the ledger
  // has to be able to record a bundle's step whatever state core is at.
  if (!(await hasColumn(db, 'migration_history', 'bundle')))
    await db.exec(`ALTER TABLE migration_history ADD COLUMN bundle ${t.varchar(64)}`)
  ensured.add(db)
}

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const rows =
    db.dialect.name === 'sqlite'
      ? await db.query<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
      : await db.query<{ name: string }>(
          'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
          [table],
        )
  return rows.some((row) => row.name === column)
}

/** A chain's state: core's unless a plan says otherwise. */
export async function readState(
  db: Db,
  chain: Pick<MigrationPlan, 'stateKey' | 'initialState'> = {
    stateKey: MIGRATION_STATE_KEY,
    initialState: INITIAL_STATE,
  },
): Promise<string> {
  await ensureTables(db)
  const rows = await db.query<{ value: string }>('SELECT value FROM key_value WHERE key = ?', [
    chain.stateKey,
  ])
  return rows[0]?.value ?? chain.initialState
}

async function writeState(db: Db, state: string, key = MIGRATION_STATE_KEY): Promise<void> {
  const now = db.dialect.now()
  await db.query(`UPDATE key_value SET value = ?, update_date = ${now} WHERE key = ?`, [state, key])
  const rows = await db.query<{ value: string }>('SELECT value FROM key_value WHERE key = ?', [key])
  if (rows.length === 0) {
    await db.exec(
      `INSERT INTO key_value (key, value, update_date) VALUES (${db.dialect.placeholder(1)}, ${db.dialect.placeholder(2)}, ${now})`,
      [key, state],
    )
  }
}

/** Forgets a setting entirely, as a purged bundle's state is forgotten. */
export async function deleteKeyValue(db: Db, key: string): Promise<void> {
  await ensureTables(db)
  await db.exec('DELETE FROM key_value WHERE key = ?', [key])
}

export interface LedgerEntry {
  name: string
  /** 'expand' | 'contract' for framework steps; 'value' for a value migration; 'upgrade' for a cut-over. */
  kind: string
  fromState?: string | null
  toState?: string | null
  durationMs: number
  checksum?: string | null
  appliedBy?: string | null
  note?: string | null
  /** The bundle whose chain this step belongs to; null for core. */
  bundle?: string | null
}

/**
 * A setting in `key_value`, Umbraco's own place for one, read and written as a
 * string. Used for facts a node must agree on across restarts and across a load
 * balanced set — the key member session cookies are signed with, for one.
 */
export async function readKeyValue(db: Db, key: string): Promise<string | undefined> {
  await ensureTables(db)
  const rows = await db.query<{ value: string | null }>(
    'SELECT value FROM key_value WHERE key = ?',
    [key],
  )
  return rows[0]?.value ?? undefined
}

export async function writeKeyValue(db: Db, key: string, value: string): Promise<void> {
  await ensureTables(db)
  const now = db.dialect.now()
  await db.exec(`UPDATE key_value SET value = ?, update_date = ${now} WHERE key = ?`, [value, key])
  const rows = await db.query('SELECT value FROM key_value WHERE key = ?', [key])
  if (rows.length === 0)
    await db.exec(`INSERT INTO key_value (key, value, update_date) VALUES (?, ?, ${now})`, [
      key,
      value,
    ])
}

/**
 * Reads a setting, generating and storing one the first time it is asked for.
 * Two nodes racing settle on whichever row landed first.
 */
export async function ensureKeyValue(db: Db, key: string, create: () => string): Promise<string> {
  const existing = await readKeyValue(db, key)
  if (existing) return existing
  await writeKeyValue(db, key, create())
  return (await readKeyValue(db, key)) ?? ''
}

/** Appends a row to `migration_history`. */
export async function recordInLedger(db: Db, entry: LedgerEntry): Promise<void> {
  await ensureTables(db)
  await db.exec(
    `INSERT INTO migration_history (name, kind, from_state, to_state, applied_at, duration_ms, checksum, applied_by, note, bundle)
     VALUES (?, ?, ?, ?, ${db.dialect.now()}, ?, ?, ?, ?, ?)`,
    [
      entry.name,
      entry.kind,
      entry.fromState ?? null,
      entry.toState ?? null,
      entry.durationMs,
      entry.checksum ?? null,
      entry.appliedBy ?? null,
      entry.note ?? null,
      entry.bundle ?? null,
    ],
  )
}

/** The newest ledger row's id, so a node can later ask what was ledgered after it booted. */
export async function latestLedgerId(db: Db): Promise<number> {
  await ensureTables(db)
  const rows = await db.query<{ n: number | null }>('SELECT MAX(id) AS n FROM migration_history')
  return Number(rows[0]?.n ?? 0)
}

/**
 * How many contract steps — framework contracts and site purges — were ledgered
 * after a row id. A bundle's contract is not counted: it removes only the
 * bundle's own tables, which no read of core's depends on.
 */
export async function contractsLedgeredAfter(db: Db, afterId: number): Promise<number> {
  const rows = await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM migration_history WHERE id > ? AND kind = 'contract' AND bundle IS NULL",
    [afterId],
  )
  return Number(rows[0]?.n ?? 0)
}

export interface LedgerRow extends LedgerEntry {
  id: number
  appliedAt: string
}

export async function readLedger(db: Db): Promise<LedgerRow[]> {
  await ensureTables(db)
  const rows = await db.query(
    'SELECT id, name, kind, from_state, to_state, applied_at, duration_ms, checksum, applied_by, note, bundle FROM migration_history ORDER BY id',
  )
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    kind: String(row.kind),
    fromState: (row.from_state as string | null) ?? null,
    toState: (row.to_state as string | null) ?? null,
    appliedAt: String(row.applied_at),
    durationMs: Number(row.duration_ms),
    checksum: (row.checksum as string | null) ?? null,
    appliedBy: (row.applied_by as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    bundle: (row.bundle as string | null) ?? null,
  }))
}

/**
 * A step failed and was rolled back; every step before it is applied. Says which,
 * and that running the upgrade again carries on from there.
 */
export class MigrationStepError extends Error {
  constructor(
    readonly step: string,
    readonly applied: readonly string[],
    readonly bundle: string | undefined,
    override readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `The upgrade stopped at ${bundle ? `the bundle "${bundle}"'s step` : 'step'} ${step}: ${reason}. ` +
        `Nothing from that step was kept${applied.length > 0 ? `; the ${applied.length} step(s) before it are applied` : ''}. ` +
        'Fix the cause and run the upgrade again: it carries on from this step.',
    )
  }
}

/** The database is at a state this code's plan does not know: newer code wrote it. */
export class UpgradeStateError extends Error {
  constructor(
    readonly databaseState: string,
    readonly codeState: string,
    /** The bundle whose chain it is, when it is not core's. */
    readonly bundle?: string,
  ) {
    super(
      bundle
        ? `The database holds the bundle "${bundle}"'s tables at state ${databaseState}, which this version of the bundle (its steps end at ${codeState}) does not know. ` +
            'A newer release of the bundle wrote them; install that release, or restore the backup taken before the upgrade.'
        : `The database is at migration state ${databaseState}, which this version of crombolo (plan ends at ${codeState}) does not know. ` +
            'It was upgraded by a newer version; run that version, or restore the backup taken before the upgrade.',
    )
  }
}

/** A bundle step changed after it ran here: what is in the database is not what the code says made it. */
export class BundleStepEditedError extends Error {
  constructor(
    readonly bundle: string,
    readonly step: string,
  ) {
    super(
      `The bundle "${bundle}"'s step "${step}" is not the step that ran on this database: it was edited after it shipped. ` +
        'A shipped step is never changed; put the change in a new step.',
    )
  }
}

/** Steps pending on this database, in order. Throws when the database is ahead of the code. */
export async function pendingMigrations(db: Db, plan: MigrationPlan): Promise<Migration[]> {
  const state = await readState(db, plan)
  const pending = plan.pendingFrom(state)
  if (!pending) throw new UpgradeStateError(state, plan.finalState, plan.bundle)
  return pending
}

/**
 * Refuses a bundle chain whose applied steps no longer match the code. Only the
 * rows since the bundle was last purged count: a purge starts its chain again.
 */
async function verifyApplied(db: Db, plan: MigrationPlan, state: string): Promise<void> {
  if (!plan.bundle) return
  const applied = plan.appliedAt(state) ?? []
  if (applied.length === 0) return
  const rows = await db.query<{ name: string; kind: string; checksum: string | null }>(
    'SELECT name, kind, checksum FROM migration_history WHERE bundle = ? ORDER BY id',
    [plan.bundle],
  )
  const purged = rows.map((row) => row.kind).lastIndexOf('purge')
  const ran = new Map(
    rows
      .slice(purged + 1)
      .filter((row) => row.kind === 'expand' || row.kind === 'contract')
      .map((row) => [row.name, row.checksum]),
  )
  for (const step of applied) {
    const recorded = ran.get(step.name)
    if (recorded !== undefined && recorded !== (step.checksum ?? step.name))
      throw new BundleStepEditedError(plan.bundle, step.name)
  }
}

export interface MigrateResult {
  from: string
  to: string
  applied: string[]
}

export interface MigrateOptions {
  /** Recorded as `applied_by` in the ledger. */
  by?: string
}

/** Walks the plan forward from the database's current state, one transaction per step, ledgering each. */
export async function migrate(
  db: Db,
  plan: MigrationPlan,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  return db.locks.withLock(Locks.KeyValues, async () => {
    const from = await readState(db, plan)
    let state = from
    const applied: string[] = []
    const pending = plan.pendingFrom(state)
    if (!pending) throw new UpgradeStateError(state, plan.finalState, plan.bundle)
    await verifyApplied(db, plan, state)
    for (const next of pending) {
      const started = performance.now()
      // The state and the ledger row commit with the step, so an interrupted
      // run resumes at the first step that did not land and never repeats one.
      await db
        .transaction(async (tx) => {
          await next.up(tx)
          await next.backfill?.(tx)
          await writeState(tx, next.to, plan.stateKey)
          await recordInLedger(tx, {
            name: next.name,
            kind: next.kind ?? 'expand',
            fromState: next.from,
            toState: next.to,
            durationMs: Math.round(performance.now() - started),
            checksum: next.checksum ?? next.name,
            appliedBy: options.by ?? null,
            note: next.release ? `release ${next.release}` : null,
            bundle: plan.bundle ?? null,
          })
        })
        .catch((error: unknown) => {
          throw new MigrationStepError(next.name, applied, plan.bundle, error)
        })
      state = next.to
      applied.push(next.name)
    }
    return { from, to: state, applied }
  })
}

/** A fresh install stamps the final state so no migrations then run. */
export async function stampFinalState(db: Db, plan: MigrationPlan): Promise<void> {
  await ensureTables(db)
  await writeState(db, plan.finalState, plan.stateKey)
}

// ---------------------------------------------------------------- the plan

/** Thrown by the recording database when a migration reads: its writes cannot be predicted. */
export class UnplannableError extends Error {
  constructor(readonly sql: string) {
    super(`reads data to decide what to write: ${sql.trim().split('\n')[0]}`)
  }
}

/** A `Db` that captures statements instead of executing them. */
class RecordingDb implements Db {
  readonly dialect: Dialect
  readonly locks: LockManager
  readonly statements: string[]

  constructor(dialect: Dialect, locks: LockManager, statements: string[] = []) {
    this.dialect = dialect
    this.locks = locks
    this.statements = statements
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    throw new UnplannableError(sql)
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    const rendered = this.dialect.render(sql)
    this.statements.push(
      params.length > 0 ? `${rendered}  -- params: ${JSON.stringify(params)}` : rendered,
    )
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this)
  }

  async close(): Promise<void> {}
}

export interface PlannedStep {
  name: string
  kind: MigrationKind
  release: string | null
  from: string
  to: string
  /** The DDL this step would run, or undefined when it reads data to decide. */
  statements: string[] | undefined
  unplannable?: string
}

/** What `migrate()` would do, without doing it. */
export async function planUpgrade(db: Db, plan: MigrationPlan): Promise<PlannedStep[]> {
  const pending = await pendingMigrations(db, plan)
  const steps: PlannedStep[] = []
  for (const migration of pending) {
    const recorder = new RecordingDb(db.dialect, db.locks)
    const step: PlannedStep = {
      name: migration.name,
      kind: migration.kind ?? 'expand',
      release: migration.release ?? null,
      from: migration.from,
      to: migration.to,
      statements: undefined,
    }
    try {
      await migration.up(recorder)
      step.statements = recorder.statements
      if (migration.backfill) step.unplannable = 'backfills data, which only running it can show'
    } catch (error) {
      if (error instanceof UnplannableError) step.unplannable = error.message
      else throw error
    }
    steps.push(step)
  }
  return steps
}
