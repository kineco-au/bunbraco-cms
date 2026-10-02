/**
 * Migration 015 — redirects: the URLs a page used to answer on.
 *
 * Umbraco's `umbracoRedirectUrl` holds one row per retired route, always pointing
 * at a document, and resolves a duplicate by taking the most recent. This table
 * widens it in two ways, both needed by redirects a site declares in code rather
 * than earns by being renamed: a rule may match a subtree or a regular expression
 * as well as one exact route, and it may point at a path or an external URL as
 * well as at a document.
 *
 * `root_key` scopes a rule to the document a hostname roots, as Umbraco scopes a
 * route by the node id its domain sits on — so renaming the hostname leaves every
 * redirect below it working. `match_hash` is a digest of everything a rule matches
 * on: a unique index cannot dedupe over nullable columns, since NULL never equals
 * NULL in either dialect, and a pattern is too long to index directly. Umbraco
 * indexes a hash of the URL for the same two reasons.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_PUBLIC_ACCESS } from './public-access.ts'

export const STATE_REDIRECTS = '{6f1d4a8e-0015-4b73-a2c5-91e4d7b3086a}'

export const redirectsMigration: Migration = {
  from: STATE_PUBLIC_ACCESS,
  to: STATE_REDIRECTS,
  name: 'AddRedirectUrl',
  kind: 'expand',
  release: '0.6.0',
  async up(db: Db) {
    const t = db.dialect.types

    await db.exec(
      `CREATE TABLE redirect_url (
         id ${t.identity},
         key ${t.text} NOT NULL,
         source ${t.varchar(16)} NOT NULL,
         match_kind ${t.varchar(16)} NOT NULL,
         pattern ${t.text} NOT NULL,
         root_key ${t.text} NULL,
         culture ${t.varchar(32)} NULL,
         target_kind ${t.varchar(16)} NOT NULL,
         target ${t.text} NOT NULL,
         status_code ${t.integer} NOT NULL,
         sort_order ${t.integer} NOT NULL,
         match_hash ${t.varchar(64)} NOT NULL,
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_redirect_url_key ON redirect_url (key)')
    // One rule per thing matched: registering a route a page already gave up
    // replaces where it points rather than stacking another row behind it.
    await db.exec('CREATE UNIQUE INDEX ux_redirect_url_match ON redirect_url (match_hash)')
    // The dashboard lists by recency, and the Info tab lists by document.
    await db.exec('CREATE INDEX ix_redirect_url_target ON redirect_url (target_kind, target)')
  },
}
