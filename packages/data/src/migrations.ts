/**
 * Umbraco tracks upgrade state as a single state token in `key_value`, not a
 * version number and not a list of applied migrations: the plan is a chain of
 * transitions walked forward to its final state. That design handles concurrent
 * development branches far better than sequence numbers, so we keep it — and
 * harden it (docs/10-packaging-and-upgrades.md): a ledger of every step that
 * ran, expand/contract declared and linted, a recorded plan, and an explicit
 * refusal when the database is newer than the code.
 */
import type { Db } from './database.ts'
import type { Dialect } from './dialect.ts'
import type { LockManager } from './locks.ts'
import { Locks } from './locks.ts'

export const MIGRATION_STATE_KEY = 'Bunbraco.Core.Upgrader.State'
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
  up(db: Db): Promise<void>
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

export class MigrationPlan {
  readonly migrations: readonly Migration[]

  constructor(migrations: readonly Migration[]) {
    this.migrations = migrations
    let expected = INITIAL_STATE
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
      }
      seen.set(migration.name, migration)
      expected = migration.to
    }
  }

  get finalState(): string {
    return this.migrations.at(-1)?.to ?? INITIAL_STATE
  }

  /** The steps still to run from a state; empty when current. Undefined when the state is not in the plan. */
  pendingFrom(state: string): Migration[] | undefined {
    if (state === this.finalState) return []
    const index = this.migrations.findIndex((m) => m.from === state)
    if (index < 0) return undefined
    return this.migrations.slice(index)
  }
}

async function ensureTables(db: Db): Promise<void> {
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
       note ${t.text}
     )`,
  )
}

export async function readState(db: Db): Promise<string> {
  await ensureTables(db)
  const rows = await db.query<{ value: string }>('SELECT value FROM key_value WHERE key = ?', [
    MIGRATION_STATE_KEY,
  ])
  return rows[0]?.value ?? INITIAL_STATE
}

async function writeState(db: Db, state: string): Promise<void> {
  const now = db.dialect.now()
  await db.query(`UPDATE key_value SET value = ?, update_date = ${now} WHERE key = ?`, [
    state,
    MIGRATION_STATE_KEY,
  ])
  const rows = await db.query<{ value: string }>('SELECT value FROM key_value WHERE key = ?', [
    MIGRATION_STATE_KEY,
  ])
  if (rows.length === 0) {
    await db.exec(
      `INSERT INTO key_value (key, value, update_date) VALUES (${db.dialect.placeholder(1)}, ${db.dialect.placeholder(2)}, ${now})`,
      [MIGRATION_STATE_KEY, state],
    )
  }
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
    `INSERT INTO migration_history (name, kind, from_state, to_state, applied_at, duration_ms, checksum, applied_by, note)
     VALUES (?, ?, ?, ?, ${db.dialect.now()}, ?, ?, ?, ?)`,
    [
      entry.name,
      entry.kind,
      entry.fromState ?? null,
      entry.toState ?? null,
      entry.durationMs,
      entry.checksum ?? null,
      entry.appliedBy ?? null,
      entry.note ?? null,
    ],
  )
}

export interface LedgerRow extends LedgerEntry {
  id: number
  appliedAt: string
}

export async function readLedger(db: Db): Promise<LedgerRow[]> {
  await ensureTables(db)
  const rows = await db.query(
    'SELECT id, name, kind, from_state, to_state, applied_at, duration_ms, checksum, applied_by, note FROM migration_history ORDER BY id',
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
  }))
}

/** The database is at a state this code's plan does not know: newer code wrote it. */
export class UpgradeStateError extends Error {
  constructor(
    readonly databaseState: string,
    readonly codeState: string,
  ) {
    super(
      `The database is at migration state ${databaseState}, which this version of bunbraco (plan ends at ${codeState}) does not know. ` +
        'It was upgraded by a newer version; run that version, or restore the backup taken before the upgrade.',
    )
  }
}

/** Steps pending on this database, in order. Throws when the database is ahead of the code. */
export async function pendingMigrations(db: Db, plan: MigrationPlan): Promise<Migration[]> {
  const state = await readState(db)
  const pending = plan.pendingFrom(state)
  if (!pending) throw new UpgradeStateError(state, plan.finalState)
  return pending
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
    const from = await readState(db)
    let state = from
    const applied: string[] = []
    const pending = plan.pendingFrom(state)
    if (!pending) throw new UpgradeStateError(state, plan.finalState)
    for (const next of pending) {
      const started = performance.now()
      await db.transaction(async (tx) => {
        await next.up(tx)
      })
      state = next.to
      await writeState(db, state)
      await recordInLedger(db, {
        name: next.name,
        kind: next.kind ?? 'expand',
        fromState: next.from,
        toState: next.to,
        durationMs: Math.round(performance.now() - started),
        checksum: next.name,
        appliedBy: options.by ?? null,
        note: next.release ? `release ${next.release}` : null,
      })
      applied.push(next.name)
    }
    return { from, to: state, applied }
  })
}

/** A fresh install stamps the final state so no migrations then run. */
export async function stampFinalState(db: Db, plan: MigrationPlan): Promise<void> {
  await ensureTables(db)
  await writeState(db, plan.finalState)
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
    } catch (error) {
      if (error instanceof UnplannableError) step.unplannable = error.message
      else throw error
    }
    steps.push(step)
  }
  return steps
}
