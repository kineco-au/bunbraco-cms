/**
 * Migration 022 — the created-package definitions the Packages section builds.
 *
 * A definition, never an artifact: the zip is built when it is downloaded
 * (`docs/17-packages.md`), so there are no bytes here to go stale when a
 * document type the package carries is edited afterwards.
 *
 * The selection lists are JSON text rather than a row each. They are read and
 * written whole and never queried into, so a child table would be a join for
 * nothing — and the contract hands them over as arrays in exactly this shape.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_SERVER_ROLE } from './server-role.ts'

export const STATE_CREATED_PACKAGES = '{6f1d4a8e-0022-4e72-9a55-3d7c1b8e4f02}'

export const createdPackagesMigration: Migration = {
  from: STATE_SERVER_ROLE,
  to: STATE_CREATED_PACKAGES,
  name: 'AddCreatedPackages',
  kind: 'expand',
  release: '0.5.0',
  async up(db: Db) {
    const t = db.dialect.types

    await db.exec(
      `CREATE TABLE created_package (
         id ${t.varchar(64)} NOT NULL,
         name ${t.textCi} NOT NULL,
         content_node_id ${t.varchar(64)},
         content_load_child_nodes ${t.boolean} NOT NULL,
         media_load_child_nodes ${t.boolean} NOT NULL,
         media_ids ${t.text} NOT NULL,
         element_ids ${t.text},
         document_types ${t.text} NOT NULL,
         media_types ${t.text} NOT NULL,
         data_types ${t.text} NOT NULL,
         templates ${t.text} NOT NULL,
         partial_views ${t.text} NOT NULL,
         stylesheets ${t.text} NOT NULL,
         scripts ${t.text} NOT NULL,
         languages ${t.text} NOT NULL,
         dictionary_items ${t.text} NOT NULL,
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL,
         PRIMARY KEY (id)
       )`,
    )
    // Umbraco refuses two packages with the same name, and the list is ordered
    // by it. `textCi` rather than `varchar` so the constraint means the same
    // thing on both dialects: Postgres collates case-sensitively by default,
    // where SQLite's varchar is already NOCASE.
    await db.exec('CREATE UNIQUE INDEX ux_created_package_name ON created_package (name)')
  },
}
