/**
 * What content imports have been applied here, and what each one touched.
 *
 * The rows exist so that reverting is a lookup rather than a guess: each change
 * remembers the event its node was at beforehand and the published event it was
 * serving, which together *are* the previously-live state.
 */
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export type TransferDirection = 'import' | 'revert'
export type TransferRunStatus = 'applied' | 'reverted' | 'failed'
/**
 * What a run did to one node.
 *
 * `unchanged` is recorded too: a run that decided to do nothing still owns the
 * node. `recycle` is what a *revert* does to a node the import created, and it
 * is recorded so that reverting the revert knows to bring it back out of the
 * bin rather than only restoring its values.
 */
export type TransferAction = 'create' | 'update' | 'unchanged' | 'skip' | 'recycle'

export interface TransferRun {
  id: string
  bundleId: string
  bundleLabel: string | null
  direction: TransferDirection
  revertsRunId: string | null
  schemaStateId: number
  startedAt: Date
  finishedAt: Date | null
  appliedBy: string | null
  nodeCount: number
  status: TransferRunStatus
}

export interface TransferChange {
  id: number
  runId: string
  nodeKey: string
  kind: string
  action: TransferAction
  /** The node's latest event before this run, or null when the run created it. */
  beforeEventId: number | null
  /** The event it was serving before this run, or null if it was not published. */
  beforePublishedEventId: number | null
  /** The event this run appended, when it appended one. */
  eventId: number | null
}

export class TransferRunRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  async start(run: Omit<TransferRun, 'finishedAt' | 'status'>): Promise<void> {
    await this.#db.exec(
      `INSERT INTO content_transfer_run
         (id, bundle_id, bundle_label, direction, reverts_run_id, schema_state_id, started_at, applied_by, node_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied')`,
      [
        run.id,
        run.bundleId,
        run.bundleLabel,
        run.direction,
        run.revertsRunId,
        run.schemaStateId,
        DbDate.toDb(run.startedAt),
        run.appliedBy,
        run.nodeCount,
      ],
    )
  }

  async finish(id: string, nodeCount: number): Promise<void> {
    await this.#db.exec(
      'UPDATE content_transfer_run SET finished_at = ?, node_count = ? WHERE id = ?',
      [DbDate.toDb(new Date()), nodeCount, id],
    )
  }

  async setStatus(id: string, status: TransferRunStatus): Promise<void> {
    await this.#db.exec('UPDATE content_transfer_run SET status = ? WHERE id = ?', [status, id])
  }

  async record(change: Omit<TransferChange, 'id'>): Promise<void> {
    await this.#db.exec(
      `INSERT INTO content_transfer_change
         (run_id, node_key, kind, action, before_event_id, before_published_event_id, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        change.runId,
        change.nodeKey,
        change.kind,
        change.action,
        change.beforeEventId,
        change.beforePublishedEventId,
        change.eventId,
      ],
    )
  }

  async byId(id: string): Promise<TransferRun | undefined> {
    const rows = await this.#db.query('SELECT * FROM content_transfer_run WHERE id = ?', [id])
    return rows[0] ? mapRun(rows[0]) : undefined
  }

  /**
   * The import of this bundle that still stands here, if there is one. A run
   * that was reverted does not count: the content is gone, so importing again
   * is the right answer. This is what makes `start --bundle` import once.
   */
  async appliedFor(bundleId: string): Promise<TransferRun | undefined> {
    const rows = await this.#db.query(
      `SELECT * FROM content_transfer_run
         WHERE bundle_id = ? AND direction = 'import' AND status = 'applied'
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      [bundleId],
    )
    return rows[0] ? mapRun(rows[0]) : undefined
  }

  /** Runs, newest first. */
  async recent(limit = 20): Promise<TransferRun[]> {
    const rows = await this.#db.query(
      'SELECT * FROM content_transfer_run ORDER BY started_at DESC, id DESC LIMIT ?',
      [limit],
    )
    return rows.map(mapRun)
  }

  async changes(runId: string): Promise<TransferChange[]> {
    const rows = await this.#db.query(
      'SELECT * FROM content_transfer_change WHERE run_id = ? ORDER BY id',
      [runId],
    )
    return rows.map(mapChange)
  }

  /**
   * Runs after this one that touched any of the same nodes. Reverting while one
   * of these stands would quietly undo its work too, so revert refuses.
   */
  async laterRunsTouching(runId: string): Promise<string[]> {
    const rows = await this.#db.query<{ id: string }>(
      `SELECT DISTINCT later.id
         FROM content_transfer_change mine
         JOIN content_transfer_change theirs ON theirs.node_key = mine.node_key
         JOIN content_transfer_run later ON later.id = theirs.run_id
         JOIN content_transfer_run self ON self.id = mine.run_id
        WHERE mine.run_id = ?
          AND theirs.run_id <> mine.run_id
          AND later.started_at >= self.started_at
          AND later.status = 'applied'`,
      [runId],
    )
    return rows.map((row) => String(row.id))
  }
}

function mapRun(row: Record<string, unknown>): TransferRun {
  return {
    id: String(row.id),
    bundleId: String(row.bundle_id),
    bundleLabel: (row.bundle_label as string | null) ?? null,
    direction: String(row.direction) as TransferDirection,
    revertsRunId: (row.reverts_run_id as string | null) ?? null,
    schemaStateId: Number(row.schema_state_id),
    startedAt: DbDate.fromDb(row.started_at) ?? new Date(0),
    finishedAt: DbDate.fromDb(row.finished_at) ?? null,
    appliedBy: (row.applied_by as string | null) ?? null,
    nodeCount: Number(row.node_count),
    status: String(row.status) as TransferRunStatus,
  }
}

function mapChange(row: Record<string, unknown>): TransferChange {
  const int = (value: unknown) => (value === null || value === undefined ? null : Number(value))
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    nodeKey: String(row.node_key),
    kind: String(row.kind),
    action: String(row.action) as TransferAction,
    beforeEventId: int(row.before_event_id),
    beforePublishedEventId: int(row.before_published_event_id),
    eventId: int(row.event_id),
  }
}
