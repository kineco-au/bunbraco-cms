/**
 * The content notification outbox (story 045): who is to hear of which change
 * to which page, and whether they have. A row is claimed by one node, the same
 * way a form workflow run is: the `state = 'pending'` in the UPDATE is the
 * whole mechanism.
 */
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export type ContentNotificationState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface ContentNotification {
  id: string
  recipientUserKey: string
  actionId: string
  nodeKey: string
  nodeName: string
  actorUserKey: string | null
  actorName: string | null
  detail: string | null
  occurredAt: Date
  state: ContentNotificationState
  attempts: number
  lastError: string | null
  runAfter: Date
}

export interface NewContentNotification {
  recipientUserKey: string
  actionId: string
  nodeKey: string
  nodeName: string
  actorUserKey: string | null
  actorName: string | null
  detail: string | null
  occurredAt: Date
  runAfter: Date
}

const COLUMNS = `id, recipient_user_key, action_id, node_key, node_name, actor_user_key, actor_name,
  detail, occurred_at, state, attempts, last_error, run_after`

function hydrate(row: Record<string, unknown>): ContentNotification {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
  return {
    id: String(row.id),
    recipientUserKey: String(row.recipient_user_key),
    actionId: String(row.action_id),
    nodeKey: String(row.node_key),
    nodeName: String(row.node_name),
    actorUserKey: text(row.actor_user_key),
    actorName: text(row.actor_name),
    detail: text(row.detail),
    occurredAt: DbDate.fromDb(row.occurred_at) ?? new Date(0),
    state: String(row.state) as ContentNotificationState,
    attempts: Number(row.attempts),
    lastError: text(row.last_error),
    runAfter: DbDate.fromDb(row.run_after) ?? new Date(0),
  }
}

export class ContentNotificationRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async enqueue(rows: readonly NewContentNotification[]): Promise<void> {
    if (rows.length === 0) return
    const now = DbDate.toDb(new Date())
    await this.#db.transaction(async (tx) => {
      for (const row of rows)
        await tx.exec(
          `INSERT INTO content_notification (id, recipient_user_key, action_id, node_key, node_name,
             actor_user_key, actor_name, detail, occurred_at, state, attempts, last_error, run_after,
             create_date, update_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            row.recipientUserKey,
            row.actionId,
            row.nodeKey,
            row.nodeName,
            row.actorUserKey,
            row.actorName,
            row.detail,
            DbDate.toDb(row.occurredAt),
            DbDate.toDb(row.runAfter),
            now,
            now,
          ],
        )
    })
  }

  /** The people with something due to them: each one is a single e-mail. */
  async dueRecipients(now = new Date(), limit = 25): Promise<string[]> {
    const rows = await this.#db.query<{ recipient_user_key: string }>(
      `SELECT recipient_user_key FROM content_notification
        WHERE state = 'pending' AND run_after <= ?
        GROUP BY recipient_user_key ORDER BY MIN(run_after) LIMIT ?`,
      [DbDate.toDb(now), limit],
    )
    return rows.map((row) => String(row.recipient_user_key))
  }

  /** Takes everything due to one person, or nothing when another node got there first. */
  async claimFor(recipientUserKey: string, now = new Date()): Promise<ContentNotification[]> {
    const rows = await this.#db.query(
      `UPDATE content_notification
          SET state = 'running', attempts = attempts + 1, update_date = ?
        WHERE recipient_user_key = ? AND state = 'pending' AND run_after <= ?
        RETURNING ${COLUMNS}`,
      [DbDate.toDb(now), recipientUserKey, DbDate.toDb(now)],
    )
    return rows.map(hydrate).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  }

  async #finish(
    ids: readonly string[],
    state: ContentNotificationState,
    error: string | null,
    runAfter?: Date,
  ) {
    if (ids.length === 0) return
    const marks = ids.map(() => '?').join(', ')
    await this.#db.exec(
      `UPDATE content_notification SET state = ?, last_error = ?, update_date = ?${runAfter ? ', run_after = ?' : ''}
        WHERE id IN (${marks})`,
      [
        state,
        error?.slice(0, 2000) ?? null,
        DbDate.toDb(new Date()),
        ...(runAfter ? [DbDate.toDb(runAfter)] : []),
        ...ids,
      ],
    )
  }

  succeed(ids: readonly string[]): Promise<void> {
    return this.#finish(ids, 'done', null)
  }

  /** Not sent, and not to be: the reason is kept for whoever looks. */
  skip(ids: readonly string[], reason: string): Promise<void> {
    return this.#finish(ids, 'skipped', reason)
  }

  /** A failure: back in the queue at `retryAt`, or finished when there is none. */
  fail(ids: readonly string[], error: string, retryAt?: Date): Promise<void> {
    return this.#finish(ids, retryAt ? 'pending' : 'failed', error, retryAt)
  }

  /** Rows a node took and never finished — it died — go back in the queue. */
  async releaseStale(olderThan: Date): Promise<number> {
    const rows = await this.#db.query(
      `UPDATE content_notification SET state = 'pending', update_date = ?
        WHERE state = 'running' AND update_date < ? RETURNING id`,
      [DbDate.toDb(new Date()), DbDate.toDb(olderThan)],
    )
    return rows.length
  }

  async prune(before: Date): Promise<number> {
    const rows = await this.#db.query(
      `DELETE FROM content_notification WHERE state IN ('done', 'skipped') AND update_date < ? RETURNING id`,
      [DbDate.toDb(before)],
    )
    return rows.length
  }

  async forRecipient(recipientUserKey: string): Promise<ContentNotification[]> {
    const rows = await this.#db.query(
      `SELECT ${COLUMNS} FROM content_notification WHERE recipient_user_key = ? ORDER BY occurred_at`,
      [recipientUserKey],
    )
    return rows.map(hydrate)
  }

  async all(): Promise<ContentNotification[]> {
    const rows = await this.#db.query(
      `SELECT ${COLUMNS} FROM content_notification ORDER BY occurred_at`,
    )
    return rows.map(hydrate)
  }
}
