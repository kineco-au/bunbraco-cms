/**
 * Migration 034 — diagnostics and choice sources. docs/diagnostics.md, docs/forms.md.
 *
 * `server.crombolo_version` is the Crombolo release each node runs, beside the
 * schema set version `server.version` already holds, so the cluster health check
 * can say when nodes disagree. `form_entry_value.label` is the option label a
 * visitor saw for a choice drawn from a source, so an entry still reads after the
 * node or dictionary item behind it is renamed or removed.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_AUDIT_LOG } from './audit-log.ts'

export const STATE_DIAGNOSTICS = '{6f1d4a8e-0034-4c1a-9e7d-3a5b8c2d4e34}'

export const diagnosticsMigration: Migration = {
  from: STATE_AUDIT_LOG,
  to: STATE_DIAGNOSTICS,
  name: 'AddNodeVersionAndChoiceLabel',
  kind: 'expand',
  release: '0.12.0',
  async up(db: Db) {
    const ops = schemaOps(db)
    await ops.addColumn('server', 'crombolo_version', db.dialect.types.varchar(64))
    await ops.addColumn('form_entry_value', 'label', db.dialect.types.text)
  },
}
