/**
 * Migration 019 — what a content import did, so reverting it is deterministic.
 *
 * You could try to find an import in the event log afterwards, by kind and
 * timestamp. It would not work: nothing distinguishes one run's `save` events
 * from an editor's concurrent save in the same second, and once a node exists
 * there is no way to recover that the import is what created it. Both facts are
 * needed to put the site back, so they are recorded as the run happens.
 *
 * `content_transfer_change` holds, per node, the event the node was at before
 * the run and the published event it was serving — which is exactly what
 * "restore the previously-live state" means. Shape follows
 * `assistant_changeset`/`assistant_change`: a header with its items.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_CHANGE_REPORT } from './change-report.ts'

export const STATE_TRANSFER_RUNS = '{6f1d4a8e-0019-4b7d-8e41-6c2a9f3d5e84}'

export const transferRunsMigration: Migration = {
  from: STATE_CHANGE_REPORT,
  to: STATE_TRANSFER_RUNS,
  name: 'AddContentTransferRuns',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    const t = db.dialect.types

    await db.exec(
      `CREATE TABLE content_transfer_run (
         id ${t.varchar(64)} NOT NULL,
         bundle_id ${t.varchar(64)} NOT NULL,
         bundle_label ${t.varchar(255)},
         direction ${t.varchar(16)} NOT NULL,
         reverts_run_id ${t.varchar(64)},
         schema_state_id ${t.integer} NOT NULL,
         started_at ${t.timestamp} NOT NULL,
         finished_at ${t.timestamp},
         applied_by ${t.varchar(255)},
         node_count ${t.integer} NOT NULL,
         status ${t.varchar(16)} NOT NULL,
         PRIMARY KEY (id)
       )`,
    )
    // `content runs` lists them newest first.
    await db.exec(
      'CREATE INDEX ix_content_transfer_run_started ON content_transfer_run (started_at)',
    )

    await db.exec(
      `CREATE TABLE content_transfer_change (
         id ${t.identity},
         run_id ${t.varchar(64)} NOT NULL,
         node_key ${t.varchar(255)} NOT NULL,
         kind ${t.varchar(16)} NOT NULL,
         action ${t.varchar(16)} NOT NULL,
         before_event_id ${t.integer},
         before_published_event_id ${t.integer},
         event_id ${t.integer}
       )`,
    )
    await db.exec(
      'CREATE UNIQUE INDEX ux_content_transfer_change_node ON content_transfer_change (run_id, node_key)',
    )
    // Revert asks "has a later run touched this node?", which is a scan by node.
    await db.exec(
      'CREATE INDEX ix_content_transfer_change_node ON content_transfer_change (node_key)',
    )
  },
}
