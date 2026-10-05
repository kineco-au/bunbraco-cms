/**
 * Migration 023 — form entries. `docs/18-forms.md`.
 *
 * The definition is a file, so there is no form table and nothing to point at:
 * an entry carries `form_key`, the UUID from `schema/forms/*.toml`, and keeps
 * it even when that file is deleted. The entries are the business record and
 * must not disappear because a developer removed a form; the backoffice lists
 * orphaned ones under the name the form last had.
 *
 * Values are a row each rather than a JSON blob, because they are what an
 * entries list filters, sorts and exports by field — which is a query, not a
 * read of the whole thing.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_CREATED_PACKAGES } from './created-packages.ts'

export const STATE_FORMS = '{6f1d4a8e-0023-4e72-9a55-3d7c1b8e4f02}'

export const formsMigration: Migration = {
  from: STATE_CREATED_PACKAGES,
  to: STATE_FORMS,
  name: 'AddFormEntries',
  kind: 'expand',
  release: '0.5.0',
  async up(db: Db) {
    const t = db.dialect.types

    await db.exec(
      `CREATE TABLE form_entry (
         id ${t.varchar(64)} NOT NULL,
         form_key ${t.varchar(64)} NOT NULL,
         form_alias ${t.varchar(255)} NOT NULL,
         state ${t.varchar(16)} NOT NULL,
         culture ${t.varchar(14)},
         page_key ${t.varchar(64)},
         ip_hash ${t.varchar(64)},
         user_agent ${t.varchar(512)},
         spam ${t.boolean} NOT NULL,
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL,
         PRIMARY KEY (id)
       )`,
    )
    // The entries view is always "this form, newest first, within a date range",
    // so that is the index rather than one per column.
    await db.exec('CREATE INDEX ix_form_entry_form ON form_entry (form_key, create_date)')
    await db.exec('CREATE INDEX ix_form_entry_state ON form_entry (form_key, state)')

    await db.exec(
      `CREATE TABLE form_entry_value (
         entry_id ${t.varchar(64)} NOT NULL,
         field_alias ${t.varchar(255)} NOT NULL,
         sort_order ${t.integer} NOT NULL,
         value ${t.text},
         PRIMARY KEY (entry_id, field_alias, sort_order),
         FOREIGN KEY (entry_id) REFERENCES form_entry (id) ON DELETE CASCADE
       )`,
    )
    // Reading one entry's values, and filtering a list by one field's value.
    await db.exec('CREATE INDEX ix_form_entry_value_field ON form_entry_value (field_alias)')
  },
}
