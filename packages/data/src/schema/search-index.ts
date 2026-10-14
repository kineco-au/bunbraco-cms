/**
 * Migration 031 — the backoffice search index. docs/search.md.
 *
 * `search_document` holds one row per item and culture: its name and the text of
 * its current values, folded to lowercase without diacritics. SQLite matches it
 * through an FTS5 table kept in step by triggers; Postgres through a generated
 * `tsvector` column. Both use language-neutral word splitting, so the two
 * dialects find the same things.
 *
 * `search_index_queue` is what a write leaves for the indexer: a node id and a
 * generation, bumped each time the node is queued again, so a row re-queued
 * while it was being indexed survives the indexer's delete. Every existing
 * page, media item and member is queued here, which is the backfill.
 */
import { ObjectTypes } from '@crombolo/core'
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_TRANSFER_RUN_PACKAGE } from './transfer-run-package.ts'

export const STATE_SEARCH_INDEX = '{6f1d4a8e-0031-4f3a-9c6d-2b8e5a1f7d31}'

export const searchIndexMigration: Migration = {
  from: STATE_TRANSFER_RUN_PACKAGE,
  to: STATE_SEARCH_INDEX,
  name: 'AddSearchIndex',
  kind: 'expand',
  release: '0.10.0',
  async up(db: Db) {
    const t = db.dialect.types
    const postgres = db.dialect.name === 'postgres'
    await db.exec(
      `CREATE TABLE search_document (
         id ${t.identity},
         node_id ${t.integer} NOT NULL REFERENCES node (id) ON DELETE CASCADE,
         culture ${t.varchar(14)} NOT NULL,
         name ${t.text} NOT NULL,
         body ${t.text} NOT NULL,
         fields ${t.json} NOT NULL,
         field_count ${t.integer} NOT NULL,
         indexed_at ${t.timestamp} NOT NULL${
           postgres
             ? `,
         terms tsvector GENERATED ALWAYS AS (
           setweight(to_tsvector('simple', name), 'A') || setweight(to_tsvector('simple', body), 'B')
         ) STORED`
             : ''
         },
         UNIQUE (node_id, culture)
       )`,
    )
    if (postgres) {
      await db.exec('CREATE INDEX ix_search_document_terms ON search_document USING GIN (terms)')
    } else {
      await db.exec(
        `CREATE VIRTUAL TABLE search_document_fts USING fts5(
           name, body, content='search_document', content_rowid='id',
           tokenize='unicode61 remove_diacritics 2'
         )`,
      )
      await db.exec(
        `CREATE TRIGGER search_document_ai AFTER INSERT ON search_document BEGIN
           INSERT INTO search_document_fts (rowid, name, body) VALUES (new.id, new.name, new.body);
         END`,
      )
      await db.exec(
        `CREATE TRIGGER search_document_ad AFTER DELETE ON search_document BEGIN
           INSERT INTO search_document_fts (search_document_fts, rowid, name, body)
           VALUES ('delete', old.id, old.name, old.body);
         END`,
      )
      await db.exec(
        `CREATE TRIGGER search_document_au AFTER UPDATE ON search_document BEGIN
           INSERT INTO search_document_fts (search_document_fts, rowid, name, body)
           VALUES ('delete', old.id, old.name, old.body);
           INSERT INTO search_document_fts (rowid, name, body) VALUES (new.id, new.name, new.body);
         END`,
      )
    }
    await db.exec(
      `CREATE TABLE search_index_queue (
         node_id ${t.integer} PRIMARY KEY REFERENCES node (id) ON DELETE CASCADE,
         generation ${t.integer} NOT NULL,
         queued_at ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec(
      `INSERT INTO search_index_queue (node_id, generation, queued_at)
       SELECT id, 1, ${db.dialect.now()} FROM node WHERE node_object_type IN (?, ?, ?)`,
      [ObjectTypes.Document, ObjectTypes.Media, ObjectTypes.Member],
    )
  },
}
