/**
 * Migration 035 — webhooks. docs/webhooks.md.
 *
 * `webhook` holds the ones kept in this environment; the ones kept with the
 * site's files are read from `schema/webhooks/`. Their headers are one encrypted
 * blob, because a header is where an API token goes.
 *
 * `webhook_delivery` is the queue, for a webhook's request or a bundle's
 * handler alike: claimed with `UPDATE … WHERE state = 'pending' … RETURNING`, so
 * one node of a cluster delivers each. `webhook_log` keeps every attempt.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_DIAGNOSTICS } from './diagnostics.ts'

export const STATE_WEBHOOKS = '{6f1d4a8e-0035-4c1a-9e7d-3a5b8c2d4e35}'

export const webhooksMigration: Migration = {
  from: STATE_DIAGNOSTICS,
  to: STATE_WEBHOOKS,
  name: 'AddWebhooks',
  kind: 'expand',
  release: '0.12.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE webhook (
         key ${t.varchar(64)} NOT NULL,
         name ${t.varchar(255)},
         description ${t.text},
         url ${t.text} NOT NULL,
         enabled ${t.boolean} NOT NULL,
         events ${t.text} NOT NULL,
         content_type_keys ${t.text} NOT NULL,
         headers ${t.text},
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL,
         PRIMARY KEY (key)
       )`,
    )
    await db.exec(
      `CREATE TABLE webhook_delivery (
         id ${t.varchar(64)} NOT NULL,
         subscriber ${t.varchar(255)} NOT NULL,
         event_alias ${t.varchar(128)} NOT NULL,
         payload ${t.text} NOT NULL,
         state ${t.varchar(16)} NOT NULL,
         attempts ${t.integer} NOT NULL,
         last_error ${t.text},
         run_after ${t.timestamp} NOT NULL,
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL,
         PRIMARY KEY (id)
       )`,
    )
    await db.exec('CREATE INDEX ix_webhook_delivery_due ON webhook_delivery (state, run_after)')
    await db.exec(
      `CREATE TABLE webhook_log (
         key ${t.varchar(64)} NOT NULL,
         delivery_id ${t.varchar(64)} NOT NULL,
         subscriber ${t.varchar(255)} NOT NULL,
         event_alias ${t.varchar(128)} NOT NULL,
         url ${t.text} NOT NULL,
         status_code ${t.integer},
         success ${t.boolean} NOT NULL,
         exception ${t.boolean} NOT NULL,
         retry_count ${t.integer} NOT NULL,
         request_headers ${t.text} NOT NULL,
         request_body ${t.text} NOT NULL,
         response_headers ${t.text} NOT NULL,
         response_body ${t.text} NOT NULL,
         log_date ${t.timestamp} NOT NULL,
         PRIMARY KEY (key)
       )`,
    )
    await db.exec('CREATE INDEX ix_webhook_log_subscriber ON webhook_log (subscriber, log_date)')
  },
}
