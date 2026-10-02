/**
 * Migration 003 — the append-only value layer, schema state, and the columns
 * schema-as-code needs.
 *
 * Pre-1.0, so this replaces `property_data` outright; after 1.0 a change of this
 * shape would be an expand followed by a contract in a later major.
 */
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'
import type { Migration } from '../migrations.ts'
import { STATE_CONTENT } from './content.ts'

export const STATE_VALUES = '{6f1d4a8e-0003-4c21-9d3a-8b1e5c7a2f03}'

export const valuesMigration: Migration = {
  from: STATE_CONTENT,
  to: STATE_VALUES,
  name: 'CreateAppendOnlyValues',
  kind: 'expand',
  release: '0.1.0',
  async up(db: Db) {
    const t = db.dialect.types

    /**
     * One row per sync or upgrade. `current` is what nodes gate writes on;
     * `prepared` is what `upgrade check --fix` creates elements under so they
     * are pending for everyone without blocking anyone.
     */
    await db.exec(
      `CREATE TABLE schema_state (
         id ${t.identity},
         version ${t.varchar(50)} NOT NULL,
         revision ${t.varchar(50)} NOT NULL,
         hash ${t.varchar(64)},
         status ${t.varchar(10)} NOT NULL,
         synced_at ${t.timestamp} NOT NULL,
         synced_by ${t.varchar(255)}
       )`,
    )
    await db.exec(
      `INSERT INTO schema_state (version, revision, hash, status, synced_at, synced_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['0', '0', null, 'current', DbDate.toDb(new Date()), 'install'],
    )

    /** The event kind: save | publish | rollback | migrate. */
    await db.exec(`ALTER TABLE content_version ADD COLUMN kind ${t.varchar(10)}`)

    await db.exec(
      `CREATE TABLE property_value (
         id ${t.identity},
         node_id ${t.integer} NOT NULL REFERENCES node (id),
         property_type_id ${t.integer} NOT NULL REFERENCES property_type (id),
         language_id ${t.integer} REFERENCES language (id),
         segment ${t.varchar(256)},
         event_id ${t.integer} NOT NULL REFERENCES content_version (id),
         schema_state_id ${t.integer} NOT NULL REFERENCES schema_state (id),
         is_current ${t.boolean} NOT NULL,
         int_value ${t.integer},
         decimal_value ${t.numeric},
         date_value ${t.timestamp},
         varchar_value ${t.varchar(512)},
         text_value ${t.text},
         sortable_value ${t.varchar(512)}
       )`,
    )
    // The one index that serves the draft read, the as-of reads and the
    // per-key "latest" lookups.
    await db.exec(
      `CREATE INDEX ix_property_value_key ON property_value
         (node_id, property_type_id, language_id, segment, id DESC)`,
    )
    await db.exec('CREATE INDEX ix_property_value_event ON property_value (event_id)')
    await db.exec('CREATE INDEX ix_property_value_current ON property_value (node_id, is_current)')

    await db.exec('DROP TABLE property_data')

    // Schema-as-code references data types by alias; Umbraco has only a key and a name.
    await db.exec(`ALTER TABLE data_type ADD COLUMN alias ${t.textCi}`)

    // Schema-as-code: the deployment that introduced an element, and retirement.
    for (const table of ['content_type', 'property_type', 'data_type']) {
      await db.exec(
        `ALTER TABLE ${table} ADD COLUMN since_state_id ${t.integer} REFERENCES schema_state (id)`,
      )
      await db.exec(`ALTER TABLE ${table} ADD COLUMN retired_at ${t.timestamp}`)
    }

    // Multi-node plumbing: node identity and the polled change log.
    await db.exec(
      `CREATE TABLE server (
         node_id ${t.varchar(255)} PRIMARY KEY,
         version ${t.varchar(50)},
         revision ${t.varchar(50)},
         last_seen ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec(
      `CREATE TABLE cache_instruction (
         id ${t.identity},
         kind ${t.varchar(50)} NOT NULL,
         payload ${t.text},
         created_at ${t.timestamp} NOT NULL,
         created_by ${t.varchar(255)}
       )`,
    )
  },
}
