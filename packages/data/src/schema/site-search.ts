/**
 * Migration 039 — site search for visitors (story 140). docs/search.md.
 *
 * `site_search_document` holds one row per page and culture, from its
 * published values only: the name, and the text of its properties in three
 * columns by weight, each folded as backoffice search folds. `text` keeps the
 * same text as written, for excerpts. SQLite matches through an FTS5 table kept
 * in step by triggers, Postgres through a generated `tsvector` whose four
 * weights are the four columns.
 *
 * `site_search` on a property says which column its text goes in, or `off`;
 * on a content type, false leaves its pages out. Both default to searchable.
 * Every page is queued, which is the backfill.
 */
import { ObjectTypes } from '@crombolo/core'
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_APPROVALS } from './approvals.ts'

export const STATE_SITE_SEARCH = '{9a5d1b4e-0039-4c73-8d18-4e0a3c1f7d59}'

const COLUMNS = ['name', 'high', 'normal', 'low'] as const

export const siteSearchMigration: Migration = {
  from: STATE_APPROVALS,
  to: STATE_SITE_SEARCH,
  name: 'AddSiteSearch',
  kind: 'expand',
  release: '0.14.0',
  async up(db: Db) {
    const t = db.dialect.types
    const postgres = db.dialect.name === 'postgres'
    const ops = schemaOps(db)
    await ops.addColumn('property_type', 'site_search', `${t.varchar(8)} NOT NULL DEFAULT 'normal'`)
    await ops.addColumn(
      'content_type',
      'site_search',
      `${t.boolean} NOT NULL DEFAULT ${postgres ? 'TRUE' : '1'}`,
    )
    await db.exec(
      `CREATE TABLE site_search_document (
         id ${t.identity},
         node_id ${t.integer} NOT NULL REFERENCES node (id) ON DELETE CASCADE,
         culture ${t.varchar(14)} NOT NULL,
         name ${t.text} NOT NULL,
         high ${t.text} NOT NULL,
         normal ${t.text} NOT NULL,
         low ${t.text} NOT NULL,
         text ${t.json} NOT NULL,
         indexed_at ${t.timestamp} NOT NULL${
           postgres
             ? `,
         terms tsvector GENERATED ALWAYS AS (
           setweight(to_tsvector('simple', name), 'A') || setweight(to_tsvector('simple', high), 'B') ||
           setweight(to_tsvector('simple', normal), 'C') || setweight(to_tsvector('simple', low), 'D')
         ) STORED`
             : ''
         },
         UNIQUE (node_id, culture)
       )`,
    )
    if (postgres) {
      await db.exec(
        'CREATE INDEX ix_site_search_document_terms ON site_search_document USING GIN (terms)',
      )
    } else {
      const columns = COLUMNS.join(', ')
      const fromNew = COLUMNS.map((c) => `new.${c}`).join(', ')
      const fromOld = COLUMNS.map((c) => `old.${c}`).join(', ')
      await db.exec(
        `CREATE VIRTUAL TABLE site_search_document_fts USING fts5(
           ${columns}, content='site_search_document', content_rowid='id',
           tokenize='unicode61 remove_diacritics 2'
         )`,
      )
      await db.exec(
        `CREATE TRIGGER site_search_document_ai AFTER INSERT ON site_search_document BEGIN
           INSERT INTO site_search_document_fts (rowid, ${columns}) VALUES (new.id, ${fromNew});
         END`,
      )
      await db.exec(
        `CREATE TRIGGER site_search_document_ad AFTER DELETE ON site_search_document BEGIN
           INSERT INTO site_search_document_fts (site_search_document_fts, rowid, ${columns})
           VALUES ('delete', old.id, ${fromOld});
         END`,
      )
      await db.exec(
        `CREATE TRIGGER site_search_document_au AFTER UPDATE ON site_search_document BEGIN
           INSERT INTO site_search_document_fts (site_search_document_fts, rowid, ${columns})
           VALUES ('delete', old.id, ${fromOld});
           INSERT INTO site_search_document_fts (rowid, ${columns}) VALUES (new.id, ${fromNew});
         END`,
      )
    }
    await db.exec(
      `INSERT INTO search_index_queue (node_id, generation, queued_at)
       SELECT id, 1, ${db.dialect.now()} FROM node WHERE node_object_type = ?
       ON CONFLICT (node_id) DO NOTHING`,
      [ObjectTypes.Document],
    )
  },
}
