/**
 * Migration 017 — changesets: what the assistant has proposed and nobody has
 * approved yet.
 *
 * The assistant never writes to the CMS. It appends to a changeset, and a person
 * approves each item, so the proposal has to outlive the conversation that
 * produced it: a changeset raised over MCP by an agent in a terminal is reviewed
 * in the backoffice by a user in a browser, in another process.
 *
 * `body` holds the Management API request the approval will dispatch, as JSON, so
 * an approved item needs no translation — the proposal *is* a prepared request,
 * and applying it takes the same authorised path as the editor's own Save.
 * `baseline` is what the entity looked like when the proposal was made; apply
 * refuses when it no longer matches, rather than overwriting someone's work.
 *
 * The tables are created whether or not the assistant is configured, and sit
 * empty when it is not. A migration conditional on configuration would make
 * schema state depend on a config file, which the upgrade plan cannot express.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_ELEMENTS } from './elements.ts'

export const STATE_ASSISTANT = '{6f1d4a8e-0017-4c92-8f3b-2a7e5d1c4b80}'

export const assistantMigration: Migration = {
  from: STATE_ELEMENTS,
  to: STATE_ASSISTANT,
  name: 'AddAssistantChangesets',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    const t = db.dialect.types

    await db.exec(
      `CREATE TABLE assistant_changeset (
         id ${t.identity},
         key ${t.text} NOT NULL,
         user_key ${t.text} NOT NULL,
         title ${t.text} NOT NULL,
         origin ${t.varchar(16)} NOT NULL,
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_assistant_changeset_key ON assistant_changeset (key)')
    // The drawer lists the signed-in user's own changesets, most recent first.
    await db.exec(
      'CREATE INDEX ix_assistant_changeset_user ON assistant_changeset (user_key, update_date)',
    )

    await db.exec(
      `CREATE TABLE assistant_change (
         id ${t.identity},
         key ${t.text} NOT NULL,
         changeset_key ${t.text} NOT NULL,
         sort_order ${t.integer} NOT NULL,
         kind ${t.varchar(32)} NOT NULL,
         summary ${t.text} NOT NULL,
         status ${t.varchar(16)} NOT NULL,
         params ${t.text} NOT NULL,
         body ${t.text} NOT NULL,
         baseline ${t.text} NULL,
         problems ${t.text} NOT NULL,
         error ${t.text} NULL,
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_assistant_change_key ON assistant_change (key)')
    await db.exec(
      'CREATE INDEX ix_assistant_change_changeset ON assistant_change (changeset_key, sort_order)',
    )
  },
}
