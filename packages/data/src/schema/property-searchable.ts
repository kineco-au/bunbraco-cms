/**
 * Migration 032 — a property can be kept out of backoffice search.
 *
 * `searchable = false` on a property in the schema files. Stored on the
 * property type, because the backoffice writes those files back from the
 * database and its save carries no such flag, so the column is what a save
 * preserves. Every existing property stays searchable. docs/search.md.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_SEARCH_INDEX } from './search-index.ts'

export const STATE_PROPERTY_SEARCHABLE = '{6f1d4a8e-0032-4b7e-8a2c-5d9f1e3b6c32}'

export const propertySearchableMigration: Migration = {
  from: STATE_SEARCH_INDEX,
  to: STATE_PROPERTY_SEARCHABLE,
  name: 'AddPropertySearchable',
  kind: 'expand',
  release: '0.10.0',
  async up(db: Db) {
    await schemaOps(db).addColumn(
      'property_type',
      'searchable',
      `${db.dialect.types.boolean} NOT NULL DEFAULT ${db.dialect.name === 'postgres' ? 'TRUE' : '1'}`,
    )
  },
}
