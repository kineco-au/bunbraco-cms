/** Driver-agnostic database handle. */

import { Database as BunSqlite } from 'bun:sqlite'
import { ambient, ambientFor } from './ambient.ts'
import { type Dialect, type DialectName, dialectFor } from './dialect.ts'
import { createLockManager, DEFAULT_LOCK_TIMEOUT_MS, type LockManager } from './locks.ts'

export interface Db {
  readonly dialect: Dialect
  readonly locks: LockManager
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string, params?: unknown[]): Promise<void>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
  /** Postgres only: calls `onNotify` for each `NOTIFY` on `channel`; resolves to the way to stop. */
  listen?(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>
}

export interface ConnectOptions {
  dialect?: DialectName
  /** Postgres connection pool size. */
  poolSize?: number
  /** SQLite file path, or ':memory:'. Ignored for Postgres. */
  file?: string
  /** Postgres connection string. Ignored for SQLite. */
  url?: string
  /** How long a write waits for a content lock; defaults to `CROMBOLO_LOCK_TIMEOUT_SECONDS`, else 15s. */
  lockTimeoutMs?: number
}

export function resolveLockTimeoutMs(options: ConnectOptions = {}): number {
  if (options.lockTimeoutMs !== undefined) return options.lockTimeoutMs
  const seconds = Number(Bun.env.CROMBOLO_LOCK_TIMEOUT_SECONDS)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_LOCK_TIMEOUT_MS
}

/**
 * One connection has one transaction at a time, but async chains interleave:
 * a background job's BEGIN between a request's BEGIN and COMMIT would fail, or
 * worse, land its statements in the request's transaction. So top-level
 * transactions queue here, and a chain already inside one joins it.
 */
class SqliteDb implements Db {
  readonly dialect = dialectFor('sqlite')
  readonly locks: LockManager
  #db: BunSqlite
  #inTransaction: boolean
  #gate: { tail: Promise<void> }

  constructor(
    db: BunSqlite,
    locks?: LockManager,
    inTransaction = false,
    gate: { tail: Promise<void> } = { tail: Promise.resolve() },
    lockTimeoutMs?: number,
  ) {
    this.#db = db
    this.locks = locks ?? createLockManager(this, { timeoutMs: lockTimeoutMs })
    this.#inTransaction = inTransaction
    this.#gate = gate
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.#db.query(this.dialect.render(sql)).all(...(params as never[])) as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    this.#db.query(this.dialect.render(sql)).run(...(params as never[]))
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return fn(this)
    const tx = new SqliteDb(this.#db, this.locks, true, this.#gate)
    if (ambientFor(this.#db)) return fn(tx)
    const previous = this.#gate.tail
    let release!: () => void
    this.#gate.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      this.#db.exec('BEGIN')
      const store = { owner: this.#db, tx: tx as unknown }
      try {
        const result = await ambient.run(store, () => fn(tx))
        this.#db.exec('COMMIT')
        return result
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      } finally {
        store.tx = undefined
      }
    } finally {
      release()
    }
  }

  async close(): Promise<void> {
    this.#db.close()
  }
}

interface SqlTag {
  unsafe(sql: string, params?: unknown[]): Promise<unknown>
  begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T>
  close(): Promise<void>
  listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<{ unlisten(): Promise<void> }>
}

class PostgresDb implements Db {
  readonly dialect = dialectFor('postgres')
  readonly locks: LockManager
  #sql: SqlTag
  #inTransaction: boolean

  constructor(sql: SqlTag, locks?: LockManager, inTransaction = false, lockTimeoutMs?: number) {
    this.#sql = sql
    this.locks = locks ?? createLockManager(this, { timeoutMs: lockTimeoutMs })
    this.#inTransaction = inTransaction
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.#sql.unsafe(this.dialect.render(sql), params)) as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.#sql.unsafe(this.dialect.render(sql), params)
  }

  /**
   * Nested calls join the enclosing transaction, as they do on SQLite. The
   * chain is marked as inside one, so a deadlock is not retried into a
   * transaction Postgres has already aborted.
   */
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return fn(this)
    return this.#sql.begin(async (sql) => {
      const tx = new PostgresDb(sql, this.locks, true)
      const store = { owner: this, tx: tx as unknown }
      try {
        return await ambient.run(store, () => fn(tx))
      } finally {
        store.tx = undefined
      }
    })
  }

  async close(): Promise<void> {
    await this.#sql.close()
  }

  async listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>> {
    if (this.#inTransaction) throw new Error('A transaction cannot listen.')
    const subscription = await this.#sql.listen(channel, onNotify)
    return () => subscription.unlisten()
  }
}

export function resolveDialectName(options: ConnectOptions = {}): DialectName {
  return options.dialect ?? (Bun.env.CROMBOLO_DB as DialectName | undefined) ?? 'sqlite'
}

export async function connect(options: ConnectOptions = {}): Promise<Db> {
  if (resolveDialectName(options) === 'postgres') {
    const url = options.url ?? Bun.env.CROMBOLO_POSTGRES_URL ?? Bun.env.DATABASE_URL
    if (!url) throw new Error('Postgres selected but no connection string was provided.')
    const { SQL } = await import('bun')
    // A modest pool: many short-lived connections exhaust Postgres' client limit,
    // and a single process does not need more.
    const sql = new SQL({ url, max: options.poolSize ?? 5 }) as unknown as SqlTag
    const db = new PostgresDb(sql, undefined, false, resolveLockTimeoutMs(options))
    await db.exec('CREATE EXTENSION IF NOT EXISTS citext')
    return db
  }
  const sqlite = new BunSqlite(options.file ?? ':memory:', { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec('PRAGMA busy_timeout = 5000')
  return new SqliteDb(sqlite, undefined, false, undefined, resolveLockTimeoutMs(options))
}
