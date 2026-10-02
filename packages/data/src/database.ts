/** Driver-agnostic database handle. */
import { Database as BunSqlite } from 'bun:sqlite'
import { type Dialect, type DialectName, dialectFor } from './dialect.ts'
import { createLockManager, type LockManager } from './locks.ts'

export interface Db {
  readonly dialect: Dialect
  readonly locks: LockManager
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string, params?: unknown[]): Promise<void>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export interface ConnectOptions {
  dialect?: DialectName
  /** Postgres connection pool size. */
  poolSize?: number
  /** SQLite file path, or ':memory:'. Ignored for Postgres. */
  file?: string
  /** Postgres connection string. Ignored for SQLite. */
  url?: string
}

class SqliteDb implements Db {
  readonly dialect = dialectFor('sqlite')
  readonly locks: LockManager
  #db: BunSqlite
  #inTransaction: boolean

  constructor(db: BunSqlite, locks?: LockManager, inTransaction = false) {
    this.#db = db
    this.locks = locks ?? createLockManager(this)
    this.#inTransaction = inTransaction
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.#db.query(this.dialect.render(sql)).all(...(params as never[])) as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    this.#db.query(this.dialect.render(sql)).run(...(params as never[]))
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return fn(this)
    this.#db.exec('BEGIN')
    try {
      const result = await fn(new SqliteDb(this.#db, this.locks, true))
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
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
}

class PostgresDb implements Db {
  readonly dialect = dialectFor('postgres')
  readonly locks: LockManager
  #sql: SqlTag
  #inTransaction: boolean

  constructor(sql: SqlTag, locks?: LockManager, inTransaction = false) {
    this.#sql = sql
    this.locks = locks ?? createLockManager(this)
    this.#inTransaction = inTransaction
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.#sql.unsafe(this.dialect.render(sql), params)) as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.#sql.unsafe(this.dialect.render(sql), params)
  }

  /** Nested calls join the enclosing transaction, as they do on SQLite. */
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.#inTransaction) return fn(this)
    return this.#sql.begin(async (tx) => fn(new PostgresDb(tx, this.locks, true)))
  }

  async close(): Promise<void> {
    await this.#sql.close()
  }
}

export function resolveDialectName(options: ConnectOptions = {}): DialectName {
  return options.dialect ?? (Bun.env.BUNBRACO_DB as DialectName | undefined) ?? 'sqlite'
}

export async function connect(options: ConnectOptions = {}): Promise<Db> {
  if (resolveDialectName(options) === 'postgres') {
    const url = options.url ?? Bun.env.BUNBRACO_POSTGRES_URL ?? Bun.env.DATABASE_URL
    if (!url) throw new Error('Postgres selected but no connection string was provided.')
    const { SQL } = await import('bun')
    // A modest pool: many short-lived connections exhaust Postgres' client limit,
    // and a single process does not need more.
    const sql = new SQL({ url, max: options.poolSize ?? 5 }) as unknown as SqlTag
    const db = new PostgresDb(sql)
    await db.exec('CREATE EXTENSION IF NOT EXISTS citext')
    return db
  }
  const sqlite = new BunSqlite(options.file ?? ':memory:', { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec('PRAGMA busy_timeout = 5000')
  return new SqliteDb(sqlite)
}
