/**
 * Named write locks around content-tree mutation. Umbraco takes a row lock per
 * lock id; SQLite has a single writer, so an in-process queue is both sufficient
 * and necessary, while Postgres uses advisory locks.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { insideTransaction } from './ambient.ts'
import { ContentBusyError, DEFAULT_RETRY, type RetryPolicy, retryContention } from './busy.ts'
import type { Db } from './database.ts'

export const DEFAULT_LOCK_TIMEOUT_MS = 15_000

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

export interface LockOptions {
  /** How long to wait for the lock before answering busy. */
  timeoutMs?: number
  retry?: RetryPolicy
}

/**
 * An in-process FIFO per lock id with a bounded wait. Ownership passes straight
 * to the next waiter on release, and a waiter that times out leaves the line.
 */
export class LockQueue {
  #lines = new Map<number, Array<() => void>>()

  async hold<T>(id: number, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await this.#acquire(id, timeoutMs)
    try {
      return await fn()
    } finally {
      this.#release(id)
    }
  }

  #acquire(id: number, timeoutMs: number): Promise<void> {
    const line = this.#lines.get(id)
    if (!line) {
      this.#lines.set(id, [])
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const at = line.indexOf(grant)
        if (at >= 0) line.splice(at, 1)
        reject(new ContentBusyError('lockTimeout'))
      }, timeoutMs)
      line.push(grant)
    })
  }

  #release(id: number): void {
    const next = this.#lines.get(id)?.shift()
    if (next) next()
    else this.#lines.delete(id)
  }
}

/** Retries only from outside any transaction: one the database aborted cannot be resumed. */
function guarded<T>(fn: () => Promise<T>, retry: RetryPolicy): Promise<T> {
  return retryContention(fn, insideTransaction() ? { ...retry, attempts: 1 } : retry)
}

class SqliteLockManager implements LockManager {
  #queue = new LockQueue()
  #timeoutMs: number
  #retry: RetryPolicy

  constructor(options: LockOptions) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.#retry = options.retry ?? DEFAULT_RETRY
  }

  withLock<T>(id: LockId, fn: () => Promise<T>): Promise<T> {
    return reentrant(id, fn, (run) =>
      guarded(() => this.#queue.hold(id, this.#timeoutMs, run), this.#retry),
    )
  }
}

/**
 * The in-process queue first, then the advisory lock, which orders the nodes.
 * Without the queue every waiting request held a pooled connection blocked on
 * the advisory lock, and a pool full of waiters left the holder none to work on.
 */
class PostgresLockManager implements LockManager {
  #db: Db
  #queue = new LockQueue()
  #timeoutMs: number
  #retry: RetryPolicy

  constructor(db: Db, options: LockOptions) {
    this.#db = db
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.#retry = options.retry ?? DEFAULT_RETRY
  }

  withLock<T>(id: LockId, fn: () => Promise<T>): Promise<T> {
    const timeout = Math.max(1, Math.round(this.#timeoutMs))
    return reentrant(id, fn, (run) =>
      guarded(
        () =>
          this.#queue.hold(id, this.#timeoutMs, () =>
            this.#db.transaction(async (tx) => {
              await tx.exec(`SET LOCAL lock_timeout = ${timeout}`)
              await tx.exec('SELECT pg_advisory_xact_lock(?)', [id])
              return run()
            }),
          ),
        this.#retry,
      ),
    )
  }
}

export function createLockManager(db: Db, options: LockOptions = {}): LockManager {
  return db.dialect.name === 'postgres'
    ? new PostgresLockManager(db, options)
    : new SqliteLockManager(options)
}
