/**
 * Migration 042 — `document.trashed_date`: when an item went into the recycle
 * bin, so `crombolo recycle-bin empty --older-than` can leave what was trashed
 * recently (story 152). Items trashed before this migration have none, and are
 * treated as of unknown age.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_REMOTE } from './remote.ts'

export const STATE_TRASHED_DATE = '{8d3f1a62-0042-4b7e-9c15-2e6a4f0b8d43}'

export const trashedDateMigration: Migration = {
  from: STATE_REMOTE,
  to: STATE_TRASHED_DATE,
  name: 'AddTrashedDate',
  kind: 'expand',
  release: '0.16.0',
  async up(db: Db) {
    await schemaOps(db).addColumn('document', 'trashed_date', db.dialect.types.timestamp)
  },
}
