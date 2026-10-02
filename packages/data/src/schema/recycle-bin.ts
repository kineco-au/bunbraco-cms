/**
 * Migration 006 — `document.original_parent_id`: where a trashed document came
 * from, so the recycle bin can say so and a restore can put it back.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_UPGRADE_REPORT } from './upgrade-report.ts'

export const STATE_RECYCLE_BIN = '{6f1d4a8e-0006-4c21-9d3a-8b1e5c7a2f06}'

export const recycleBinMigration: Migration = {
  from: STATE_UPGRADE_REPORT,
  to: STATE_RECYCLE_BIN,
  name: 'AddRecycleBinOriginalParent',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    await schemaOps(db).addColumn('document', 'original_parent_id', db.dialect.types.integer)
  },
}
