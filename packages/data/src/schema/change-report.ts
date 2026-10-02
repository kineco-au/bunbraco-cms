/**
 * Migration 018 — `upgrade_report` becomes `change_report`: the same stable
 * findings shape, now shared by the pre-upgrade check and content transfer.
 *
 * `source` and `scope` exist because a run resolves whatever it no longer
 * reports. Unscoped, a content check would resolve every open upgrade finding,
 * a development boot would wipe a transfer report on every restart, and
 * checking one bundle would resolve another's. The sweep filters on both.
 *
 * A rename is not expand, and the lint that says so is right in general: the
 * rule keeps the previous release's code able to read an upgraded database.
 * At 0.x there is no deployed node to protect and `upgrade_report` shipped in
 * this same pre-release line, so the exception is taken deliberately here and
 * comes off at 1.0.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_ASSISTANT } from './assistant.ts'

export const STATE_CHANGE_REPORT = '{6f1d4a8e-0018-4a3f-9c62-7d5b1e8a3c92}'

export const changeReportMigration: Migration = {
  from: STATE_ASSISTANT,
  to: STATE_CHANGE_REPORT,
  name: 'RenameUpgradeReportToChangeReport',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    const t = db.dialect.types
    const ops = schemaOps(db)
    await ops.renameTable('upgrade_report', 'change_report')
    // Both dialects keep an index across a table rename, under its old name.
    await ops.dropIndex('ix_upgrade_report_subject', 'change_report')
    await ops.addColumn('change_report', 'source', `${t.varchar(20)} NOT NULL DEFAULT 'upgrade'`)
    await ops.addColumn('change_report', 'scope', t.varchar(64))
    await ops.addIndex('ix_change_report_subject', 'change_report', [
      'source',
      'scope',
      'code',
      'subject_key',
      'property_alias',
      'culture',
    ])
  },
}
