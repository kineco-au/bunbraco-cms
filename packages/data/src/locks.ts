/**
 * Named write locks around content-tree mutation. Umbraco takes a row lock per
 * lock id; SQLite has a single writer, so an in-process queue is both sufficient
 * and necessary, while Postgres uses advisory locks.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
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

/**
 * The locks the current async chain holds. A holder is emptied on release, so
 * work the holder left running in the background does not inherit the lock.
 */
const held = new AsyncLocalStorage<Set<LockId>>()

/** Runs `fn` directly when this chain already holds `id`; otherwise takes it. */
async function reentrant<T>(
  id: LockId,
  fn: () => Promise<T>,
  acquire: (run: () => Promise<T>) => Promise<T>,
): Promise<T> {
  const current = held.getStore()
  if (current?.has(id)) return fn()
  return acquire(async () => {
    const holding = new Set(current)
    holding.add(id)
    try {
      return await held.run(holding, fn)
    } finally {
      holding.clear()
    }
  })
}

class SqliteLockManager implements LockManager {
  #queues = new Map<number, Promise<unknown>>()

  withLock<T>(id: LockId, fn: () => Promise<T>): Promise<T> {
    return reentrant(id, fn, (run) => this.#acquire(id, run))
  }

  async #acquire<T>(id: LockId, fn: () => Promise<T>): Promise<T> {
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

  withLock<T>(id: LockId, fn: () => Promise<T>): Promise<T> {
    return reentrant(id, fn, (run) =>
      this.#db.transaction(async (tx) => {
        await tx.exec('SELECT pg_advisory_xact_lock(?)', [id])
        return run()
      }),
    )
  }
}

export function createLockManager(db: Db): LockManager {
  return db.dialect.name === 'postgres' ? new PostgresLockManager(db) : new SqliteLockManager()
}
