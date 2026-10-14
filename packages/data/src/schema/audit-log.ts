/**
 * Migration 033 — the audit log. docs/audit-log.md.
 *
 * `audit_entry` records who did what, when and from where: every backoffice
 * change, every sign-in and failed sign-in, and what the command line and the
 * background jobs changed. Names are copied in when an entry is written, so an
 * entry still reads after its user or item is gone. It starts empty: history from
 * before this migration stays in the content versions it came from.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_PROPERTY_SEARCHABLE } from './property-searchable.ts'

export const STATE_AUDIT_LOG = '{6f1d4a8e-0033-4c1a-9e7d-3a5b8c2d4e33}'

export const auditLogMigration: Migration = {
  from: STATE_PROPERTY_SEARCHABLE,
  to: STATE_AUDIT_LOG,
  name: 'AddAuditLog',
  kind: 'expand',
  release: '0.10.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE audit_entry (
         id ${t.identity},
         occurred_at ${t.timestamp} NOT NULL,
         category ${t.varchar(32)} NOT NULL,
         action ${t.varchar(64)} NOT NULL,
         user_key ${t.uuid},
         user_name ${t.varchar(255)},
         entity_type ${t.varchar(64)},
         entity_key ${t.varchar(255)},
         entity_name ${t.varchar(255)},
         source ${t.varchar(16)} NOT NULL,
         ip_address ${t.varchar(64)},
         forwarded_for ${t.varchar(255)},
         detail ${t.text}
       )`,
    )
    await db.exec('CREATE INDEX ix_audit_entry_occurred ON audit_entry (occurred_at)')
    await db.exec('CREATE INDEX ix_audit_entry_entity ON audit_entry (entity_key, occurred_at)')
    await db.exec('CREATE INDEX ix_audit_entry_user ON audit_entry (user_key, occurred_at)')
  },
}
