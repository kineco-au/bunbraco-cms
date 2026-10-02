/**
 * Migration 005 — `upgrade_report`: the pre-upgrade check's findings, in a
 * stable shape the backoffice dashboard reads whatever version is live.
 * docs/10-packaging-and-upgrades.md, "The upgrade dashboard ships in the first release".
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_SINCE_VERSION } from './since-version.ts'

export const STATE_UPGRADE_REPORT = '{6f1d4a8e-0005-4c21-9d3a-8b1e5c7a2f05}'

export const upgradeReportMigration: Migration = {
  from: STATE_SINCE_VERSION,
  to: STATE_UPGRADE_REPORT,
  name: 'AddUpgradeReport',
  kind: 'expand',
  release: '0.2.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE upgrade_report (
         id ${t.identity},
         run_id ${t.varchar(64)} NOT NULL,
         kind ${t.varchar(20)} NOT NULL,
         code ${t.varchar(64)} NOT NULL,
         subject_type ${t.varchar(32)} NOT NULL,
         subject_key ${t.varchar(255)} NOT NULL,
         subject_name ${t.varchar(255)},
         property_alias ${t.varchar(255)},
         culture ${t.varchar(14)},
         message ${t.text} NOT NULL,
         link ${t.text},
         status ${t.varchar(20)} NOT NULL,
         first_seen ${t.timestamp} NOT NULL,
         last_seen ${t.timestamp} NOT NULL,
         resolved_at ${t.timestamp}
       )`,
    )
    await db.exec(
      'CREATE INDEX ix_upgrade_report_subject ON upgrade_report (code, subject_key, property_alias, culture)',
    )
  },
}
