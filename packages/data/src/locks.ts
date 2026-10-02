/**
 * Named write locks around content-tree mutation. Umbraco takes a row lock per
 * lock id; SQLite has a single writer, so an in-process queue is both sufficient
 * and necessary, while Postgres uses advisory locks.
 */
import type { Db } from './database.ts'

/** Mirrors Umbraco's Constants.Locks. */
export const Locks = {
  Servers: -331,
  ContentTypes: -332,
  ContentTree: -333,
  MediaTree: -334,
  MemberTree: -335,
  MediaTypes: -336,
  MemberTypes: -337,
  Domains: -338,
  KeyValues: -339,
  Languages: -340,
  ScheduledPublishing: -341,
  /** Ours: schema sync and schema-state transitions. */
  Schema: -342,
} as const

export type LockId = (typeof Locks)[keyof typeof Locks]

export interface LockManager {
  /** Runs `fn` while holding the named lock. Re-entrant within one chain. */
  withLock<T>(id: LockId, fn: () => Promise<T>): Promise<T>
}

class SqliteLockManager implements LockManager {
  #queues = new Map<number, Promise<unknown>>()

  async withLock<T>(id: LockId, fn: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#queues.set(
      id,
      previous.then(() => gate),
    )
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.#queues.get(id) === gate) this.#queues.delete(id)
    }
  }
}

class PostgresLockManager implements LockManager {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  async withLock<T>(id: LockId, fn: () => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock(?)', [id])
      return fn()
    })
  }
}

export function createLockManager(db: Db): LockManager {
  return db.dialect.name === 'postgres' ? new PostgresLockManager(db) : new SqliteLockManager()
}
