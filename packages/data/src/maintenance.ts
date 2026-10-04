/**
 * A cluster-wide pause on editing, held in `key_value` so every node sees it on
 * its next write rather than its next poll. Readers are never affected; the
 * write gate (`assertNodeMayWrite`) refuses editor writes while it is set.
 */
import type { Db } from './database.ts'
import { readKeyValue, writeKeyValue } from './migrations.ts'

export const WRITES_PAUSED_KEY = 'Bunbraco.Operations.WritesPaused'

export interface WritesPaused {
  reason: string
  by: string | null
  at: string
}

export function parseWritesPaused(value: string | null | undefined): WritesPaused | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<WritesPaused>
    return {
      reason: String(parsed.reason ?? ''),
      by: parsed.by ?? null,
      at: String(parsed.at ?? ''),
    }
  } catch {
    return { reason: '', by: null, at: '' }
  }
}

export async function readWritesPaused(db: Db): Promise<WritesPaused | undefined> {
  return parseWritesPaused(await readKeyValue(db, WRITES_PAUSED_KEY))
}

export async function pauseWrites(
  db: Db,
  options: { reason: string; by?: string },
): Promise<WritesPaused> {
  const paused: WritesPaused = {
    reason: options.reason,
    by: options.by ?? null,
    at: new Date().toISOString(),
  }
  await writeKeyValue(db, WRITES_PAUSED_KEY, JSON.stringify(paused))
  return paused
}

/** An empty value rather than a deleted row, so the key keeps its history in `update_date`. */
export async function resumeWrites(db: Db): Promise<void> {
  await writeKeyValue(db, WRITES_PAUSED_KEY, '')
}
