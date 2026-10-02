/**
 * Migration 016 — the Elements recycle bin node.
 *
 * Elements are Umbraco 18's publishable content without a URL, and they need
 * nothing new in the schema: an element is a node facet exactly as a document is
 * (`node` + `content` + `content_version`), its folders are `node` rows with the
 * ElementContainer object type, and the document repository takes it as a fifth
 * `kind`. The one thing missing is somewhere to trash them into.
 *
 * `seedContent` creates all three bins on a fresh install; this adds the element
 * one to a database seeded before elements existed. Umbraco's own id and object
 * type are used (`Constants.System.RecycleBinElement = -22`), so a database here
 * numbers its bins as Umbraco's does.
 */

import { ObjectTypes, SystemNodes } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'
import type { Migration } from '../migrations.ts'
import { STATE_REDIRECTS } from './redirects.ts'

export const STATE_ELEMENTS = '{6f1d4a8e-0016-4d8a-b1f7-5c3e9a204d61}'

export const elementsMigration: Migration = {
  from: STATE_REDIRECTS,
  to: STATE_ELEMENTS,
  name: 'AddElementRecycleBin',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    // One statement, with both guards in SQL, because `bunbraco upgrade --plan`
    // runs every migration against a recorder whose `query` refuses to read —
    // a migration that reads cannot be planned, and the plan is the thing that
    // lets a release be reviewed before it runs.
    //
    // `FROM node` is the first guard: a fresh database is seeded *after*
    // migrations, and `seedContent` only seeds while `node` is empty, so
    // inserting here would suppress the entire seed — data types included — and
    // leave every content type unresolvable. No rows, no insert; the seed creates
    // all three bins itself. `NOT EXISTS` is the second: idempotent for a
    // database that already has the bin.
    await db.exec(
      `INSERT INTO node
         (id, unique_id, parent_id, level, path, sort_order, trashed, text, node_object_type, create_date)
       SELECT ?, ?, ?, 0, ?, 0, ?, ?, ?, ?
         FROM node
        WHERE NOT EXISTS (SELECT 1 FROM node WHERE id = ?)
        LIMIT 1`,
      [
        SystemNodes.ElementRecycleBin,
        crypto.randomUUID(),
        SystemNodes.Root,
        `${SystemNodes.Root},${SystemNodes.ElementRecycleBin}`,
        db.dialect.boolValue(false),
        'Recycle Bin',
        ObjectTypes.ElementRecycleBin,
        DbDate.toDb(new Date()),
        SystemNodes.ElementRecycleBin,
      ],
    )
  },
}
