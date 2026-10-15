/** Contention a write could not get past, answered as a retryable 503 rather than a 500. */
import { problemResponse, serviceBusy } from '@crombolo/core'
import { ContentBusyError, classifyContention } from '@crombolo/data'

/** The response for an error that is lock contention; undefined for anything else. */
export function busyResponse(error: unknown): Response | undefined {
  const contention = classifyContention(error)
  if (!contention) return undefined
  const busy = error instanceof ContentBusyError ? error : new ContentBusyError(contention)
  return problemResponse(serviceBusy(busy.message), {
    'retry-after': String(busy.retryAfterSeconds),
  })
}
