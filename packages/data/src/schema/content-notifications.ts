/**
 * Migration 043 — content notifications delivered (story 045).
 *
 * `content_notification` is the outbox: one row per person per change to a
 * page they asked to hear about, sent by a background job and claimed by one
 * node. It holds names as they were, and no foreign keys, so deleting a page or
 * a user afterwards cannot break a row. `user_notification` gains the index a
 * lookup by page needs.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_TRASHED_DATE } from './trashed-date.ts'

export const STATE_CONTENT_NOTIFICATIONS = '{5a7c2e19-0043-4d8f-b361-0f4e9a2c7d43}'

export const contentNotificationsMigration: Migration = {
  from: STATE_TRASHED_DATE,
  to: STATE_CONTENT_NOTIFICATIONS,
  name: 'AddContentNotifications',
  kind: 'expand',
  release: '0.17.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE content_notification (
         id ${t.varchar(64)} PRIMARY KEY,
         recipient_user_key ${t.uuid} NOT NULL,
         action_id ${t.varchar(64)} NOT NULL,
         node_key ${t.uuid} NOT NULL,
         node_name ${t.text} NOT NULL,
         actor_user_key ${t.uuid},
         actor_name ${t.text},
         detail ${t.text},
         occurred_at ${t.timestamp} NOT NULL,
         state ${t.varchar(16)} NOT NULL,
         attempts ${t.integer} NOT NULL,
         last_error ${t.text},
         run_after ${t.timestamp} NOT NULL,
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec(
      'CREATE INDEX ix_content_notification_due ON content_notification (state, run_after)',
    )
    await db.exec(
      'CREATE INDEX ix_content_notification_recipient ON content_notification (recipient_user_key, state)',
    )
    await db.exec(
      'CREATE INDEX ix_user_notification_node_action ON user_notification (node_id, action)',
    )
  },
}
