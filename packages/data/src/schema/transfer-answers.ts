/**
 * Migration 036 — a pending import and its answers, so a content transfer's
 * conflicts can be answered in the backoffice. docs/content-transfer.md.
 *
 * `transfer_pending` is the last check of each bundle: where it was found and
 * what the check was asked to do, so the dashboard can run the same import.
 * `transfer_answer` holds the choices made there, one per node and property
 * handle, as `resolutions.json` would.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_WEBHOOKS } from './webhooks.ts'

export const STATE_TRANSFER_ANSWERS = '{2c8e5b1a-0036-4f3d-8a6e-9d1c4b7a2e36}'

export const transferAnswersMigration: Migration = {
  from: STATE_WEBHOOKS,
  to: STATE_TRANSFER_ANSWERS,
  name: 'AddTransferAnswers',
  kind: 'expand',
  release: '0.12.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE transfer_pending (
         bundle_id ${t.varchar(64)} NOT NULL,
         label ${t.varchar(255)},
         target ${t.text} NOT NULL,
         target_kind ${t.varchar(16)} NOT NULL,
         under_target ${t.text},
         publish ${t.boolean} NOT NULL,
         allow_missing_blobs ${t.boolean} NOT NULL,
         checked_at ${t.timestamp} NOT NULL,
         checked_by ${t.varchar(255)},
         PRIMARY KEY (bundle_id)
       )`,
    )
    await db.exec(
      `CREATE TABLE transfer_answer (
         bundle_id ${t.varchar(64)} NOT NULL,
         node_key ${t.varchar(64)} NOT NULL,
         handle ${t.varchar(255)} NOT NULL,
         resolution ${t.varchar(16)} NOT NULL,
         answered_by ${t.varchar(255)},
         answered_at ${t.timestamp} NOT NULL,
         PRIMARY KEY (bundle_id, node_key, handle)
       )`,
    )
  },
}
