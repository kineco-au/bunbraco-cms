/**
 * Migration 010 — what the document action menu stores beyond versions:
 * scheduled publishing (Umbraco's `umbracoContentSchedule`), per-user
 * notification subscriptions (`umbracoUser2NodeNotify`) and culture and
 * hostnames (`umbracoDomain`), snake-cased.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_RICH_TEXT_UI } from './rich-text-ui.ts'

export const STATE_CONTENT_EDITING = '{6f1d4a8e-0010-4c21-9d3a-8b1e5c7a2f10}'

export const contentEditingMigration: Migration = {
  from: STATE_RICH_TEXT_UI,
  to: STATE_CONTENT_EDITING,
  name: 'AddContentEditingTables',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE content_schedule (
         id ${t.identity},
         node_id ${t.integer} NOT NULL REFERENCES node (id),
         language_id ${t.integer} NULL REFERENCES language (id),
         action ${t.varchar(16)} NOT NULL,
         date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec('CREATE INDEX ix_content_schedule_date ON content_schedule (date)')
    await db.exec(
      `CREATE TABLE user_notification (
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         node_id ${t.integer} NOT NULL REFERENCES node (id),
         action ${t.varchar(64)} NOT NULL,
         PRIMARY KEY (user_id, node_id, action)
       )`,
    )
    await db.exec(
      `CREATE TABLE domain (
         id ${t.identity},
         node_id ${t.integer} NOT NULL REFERENCES node (id),
         language_id ${t.integer} NULL REFERENCES language (id),
         domain_name ${t.textCi} NOT NULL,
         sort_order ${t.integer} NOT NULL
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ix_domain_name ON domain (domain_name)')
  },
}
