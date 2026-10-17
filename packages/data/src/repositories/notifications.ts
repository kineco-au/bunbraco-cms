/**
 * Which actions on a node a user asked to be notified of (Umbraco's
 * `umbracoUser2NodeNotify`). Delivered by e-mail through the content
 * notification outbox (story 045); kept regardless while a site has no e-mail.
 */
import type { Db } from '../database.ts'

/** The actions Umbraco offers in the notifications dialog, by letter and alias. */
export const NOTIFIABLE_ACTIONS: ReadonlyArray<{ actionId: string; alias: string }> = [
  { actionId: 'Umb.Document.Duplicate', alias: 'copy' },
  { actionId: 'Umb.Document.Delete', alias: 'delete' },
  { actionId: 'Umb.Document.Move', alias: 'move' },
  { actionId: 'Umb.Document.Create', alias: 'create' },
  { actionId: 'Umb.Document.PublicAccess', alias: 'protect' },
  { actionId: 'Umb.Document.Publish', alias: 'publish' },
  { actionId: 'Umb.DocumentRecycleBin.Restore', alias: 'restore' },
  { actionId: 'Umb.Document.Permissions', alias: 'rights' },
  { actionId: 'Umb.Document.Rollback', alias: 'rollback' },
  { actionId: 'Umb.Document.Sort', alias: 'sort' },
  { actionId: 'Umb.Document.Update', alias: 'update' },
]

export class NotificationRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async subscribed(userId: number, nodeId: number): Promise<string[]> {
    const rows = await this.#db.query<{ action: string }>(
      'SELECT action FROM user_notification WHERE user_id = ? AND node_id = ?',
      [userId, nodeId],
    )
    return rows.map((row) => String(row.action))
  }

  /** Replaces the user's subscriptions on a node; unknown action ids are ignored. */
  async set(userId: number, nodeId: number, actionIds: readonly string[]): Promise<void> {
    const known = new Set(NOTIFIABLE_ACTIONS.map((a) => a.actionId))
    await this.#db.transaction(async (tx) => {
      await tx.exec('DELETE FROM user_notification WHERE user_id = ? AND node_id = ?', [
        userId,
        nodeId,
      ])
      for (const action of new Set(actionIds))
        if (known.has(action))
          await tx.exec(
            'INSERT INTO user_notification (user_id, node_id, action) VALUES (?, ?, ?)',
            [userId, nodeId, action],
          )
    })
  }

  /**
   * Who asked to hear of an action on any node of a path: a subscription on a
   * page covers the pages under it, as Umbraco's does.
   */
  async subscribersFor(actionId: string, pathNodeIds: readonly number[]): Promise<number[]> {
    if (pathNodeIds.length === 0) return []
    const rows = await this.#db.query<{ user_id: number }>(
      `SELECT DISTINCT user_id FROM user_notification
        WHERE action = ? AND node_id IN (${pathNodeIds.map(() => '?').join(', ')})`,
      [actionId, ...pathNodeIds],
    )
    return rows.map((row) => Number(row.user_id))
  }
}
