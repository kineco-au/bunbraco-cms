/**
 * Migration 004 — `since_version`: the version a file says an element goes
 * live in, kept beside `since_state_id` (the deployment that created the row)
 * so "is this pending on my node" is one comparison. docs/09, "since".
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_VALUES } from './values.ts'

export const STATE_SINCE_VERSION = '{6f1d4a8e-0004-4c21-9d3a-8b1e5c7a2f04}'

export const sinceVersionMigration: Migration = {
  from: STATE_VALUES,
  to: STATE_SINCE_VERSION,
  name: 'AddSinceVersion',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    const ops = schemaOps(db)
    const type = db.dialect.types.varchar(50)
    await ops.addColumn('content_type', 'since_version', type)
    await ops.addColumn('property_type', 'since_version', type)
    await ops.addColumn('data_type', 'since_version', type)
  },
}
