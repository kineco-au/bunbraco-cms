/** Lock contention: recognising it in driver errors, retrying it, and the error an editor sees. */

export type Contention = 'deadlock' | 'lockTimeout' | 'busy'

/** A write gave up waiting for another to finish. Answered as 503 with Retry-After. */
export class ContentBusyError extends Error {
  constructor(
    readonly contention: Contention,
    readonly retryAfterSeconds = 2,
  ) {
    super('Someone else is changing this content right now. Try again in a moment.')
  }
}

const POSTGRES_CODES: Record<string, Contention> = {
  '40P01': 'deadlock',
  '40001': 'deadlock',
  '55P03': 'lockTimeout',
}

/** Which kind of contention a driver error reports, if any. */
export function classifyContention(error: unknown): Contention | undefined {
  if (error instanceof ContentBusyError) return error.contention
  if (!error || typeof error !== 'object') return undefined
  const { code, errno, message } = error as { code?: unknown; errno?: unknown; message?: unknown }
  // Bun's Postgres driver reports the SQLSTATE as `errno`, other drivers as `code`.
  for (const state of [errno, code])
    if (typeof state === 'string' && POSTGRES_CODES[state]) return POSTGRES_CODES[state]
  if (
    typeof code === 'string' &&
    (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  )
    return 'busy'
  if (errno === 5 || errno === 6) return 'busy'
  if (typeof message === 'string' && /database (table )?is locked/i.test(message)) return 'busy'
  return undefined
}

export interface RetryPolicy {
  /** Attempts in all, the first included. */
  attempts: number
  /** Waits between attempts; injected so a test does not sleep. */
  sleep: (ms: number) => Promise<void>
  backoffMs: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 2,
  sleep: (ms) => Bun.sleep(ms),
  backoffMs: 50,
}

/**
 * Runs `fn`, retrying a deadlock: the database rolled the transaction back, so
 * running it again is safe. A lock timeout is not retried, since the wait has
 * already been spent. Contention that outlasts the policy becomes ContentBusyError.
 */
export async function retryContention<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const contention = classifyContention(error)
      if (!contention) throw error
      if (contention !== 'deadlock' || attempt >= policy.attempts) {
        throw error instanceof ContentBusyError ? error : new ContentBusyError(contention)
      }
      await policy.sleep(policy.backoffMs * attempt)
    }
  }
}
