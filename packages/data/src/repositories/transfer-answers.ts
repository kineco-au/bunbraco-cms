/**
 * Pending content imports and the answers given to their conflicts in the
 * backoffice. The answers are laid over a bundle's `resolutions.json` at import.
 */
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'

export interface PendingTransfer {
  bundleId: string
  label: string | null
  /** A package name the site depends on, or a directory on this server. */
  target: string
  targetKind: 'package' | 'directory'
  /** Where the check placed the bundle's roots, as given. */
  under: string | null
  publish: boolean
  allowMissingBlobs: boolean
  checkedAt: Date
  checkedBy: string | null
}

export interface TransferAnswer {
  nodeKey: string
  /** `"*"` for the whole node, else `alias` or `alias@culture`. */
  handle: string
  resolution: string
  answeredBy: string | null
  answeredAt: Date
}

/** Answers as `byNode`, the shape `resolutions.json` and the import take. Pure. */
export function answersByNode(
  answers: readonly Pick<TransferAnswer, 'nodeKey' | 'handle' | 'resolution'>[],
): Record<string, Record<string, string>> {
  const byNode: Record<string, Record<string, string>> = {}
  for (const answer of answers)
    byNode[answer.nodeKey] = {
      ...(byNode[answer.nodeKey] ?? {}),
      [answer.handle]: answer.resolution,
    }
  return byNode
}

const pendingFrom = (row: Record<string, unknown>): PendingTransfer => ({
  bundleId: row.bundle_id as string,
  label: (row.label as string | null) ?? null,
  target: row.target as string,
  targetKind: row.target_kind === 'directory' ? 'directory' : 'package',
  under: (row.under_target as string | null) ?? null,
  publish: fromDbBool(row.publish),
  allowMissingBlobs: fromDbBool(row.allow_missing_blobs),
  checkedAt: DbDate.fromDb(row.checked_at) ?? new Date(0),
  checkedBy: (row.checked_by as string | null) ?? null,
})

export class TransferAnswerRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  /** Records the latest check of a bundle; its answers stand. */
  async recordCheck(pending: PendingTransfer): Promise<void> {
    const bool = (value: boolean) => this.#db.dialect.boolValue(value)
    await this.#db.transaction(async (tx) => {
      await tx.exec('DELETE FROM transfer_pending WHERE bundle_id = ?', [pending.bundleId])
      await tx.exec(
        `INSERT INTO transfer_pending
           (bundle_id, label, target, target_kind, under_target, publish, allow_missing_blobs, checked_at, checked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pending.bundleId,
          pending.label,
          pending.target,
          pending.targetKind,
          pending.under,
          bool(pending.publish),
          bool(pending.allowMissingBlobs),
          DbDate.toDb(pending.checkedAt),
          pending.checkedBy,
        ],
      )
    })
  }

  async pending(bundleId: string): Promise<PendingTransfer | undefined> {
    const rows = await this.#db.query('SELECT * FROM transfer_pending WHERE bundle_id = ?', [
      bundleId,
    ])
    return rows[0] ? pendingFrom(rows[0]) : undefined
  }

  async allPending(): Promise<PendingTransfer[]> {
    return (await this.#db.query('SELECT * FROM transfer_pending ORDER BY checked_at DESC')).map(
      pendingFrom,
    )
  }

  async setAllowMissingBlobs(bundleId: string, allow: boolean): Promise<void> {
    await this.#db.exec('UPDATE transfer_pending SET allow_missing_blobs = ? WHERE bundle_id = ?', [
      this.#db.dialect.boolValue(allow),
      bundleId,
    ])
  }

  async answers(bundleId: string): Promise<TransferAnswer[]> {
    const rows = await this.#db.query(
      'SELECT * FROM transfer_answer WHERE bundle_id = ? ORDER BY node_key, handle',
      [bundleId],
    )
    return rows.map((row) => ({
      nodeKey: row.node_key as string,
      handle: row.handle as string,
      resolution: row.resolution as string,
      answeredBy: (row.answered_by as string | null) ?? null,
      answeredAt: DbDate.fromDb(row.answered_at) ?? new Date(0),
    }))
  }

  /** Sets one answer, or clears it when `resolution` is null. */
  async answer(
    bundleId: string,
    answer: { nodeKey: string; handle: string; resolution: string | null; by: string | null },
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.exec(
        'DELETE FROM transfer_answer WHERE bundle_id = ? AND node_key = ? AND handle = ?',
        [bundleId, answer.nodeKey, answer.handle],
      )
      if (answer.resolution === null) return
      await tx.exec(
        `INSERT INTO transfer_answer (bundle_id, node_key, handle, resolution, answered_by, answered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          bundleId,
          answer.nodeKey,
          answer.handle,
          answer.resolution,
          answer.by,
          DbDate.toDb(new Date()),
        ],
      )
    })
  }

  /** Once the import is applied there is nothing pending, and nothing left to answer. */
  async clear(bundleId: string): Promise<void> {
    await this.#db.exec('DELETE FROM transfer_answer WHERE bundle_id = ?', [bundleId])
    await this.#db.exec('DELETE FROM transfer_pending WHERE bundle_id = ?', [bundleId])
  }
}
