/**
 * Migration 011 — what users and localisation store beyond identity: a group's
 * languages (`umbracoUserGroup2Language`), per-user key/value data
 * (`umbracoUserData`), single-use tokens for invites and password resets, API
 * users' client credentials, and dictionary items with their translations
 * (`cmsDictionary`, `cmsLanguageText`), snake-cased. It also renames
 * `user_account.is_disabled` to `is_locked_out`, which is what it always meant:
 * a disabled user is one that is not approved, as in Umbraco. And each culture
 * of a document records the publish event and name it was last published with,
 * so publishing one culture leaves the others as they were published.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_CONTENT_EDITING } from './content-editing.ts'

export const STATE_USERS_LOCALISATION = '{6f1d4a8e-0011-4c21-9d3a-8b1e5c7a2f11}'

export const usersLocalisationMigration: Migration = {
  from: STATE_CONTENT_EDITING,
  to: STATE_USERS_LOCALISATION,
  name: 'AddUserAndLocalisationTables',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    const t = db.dialect.types
    // The seed inserted the built-in groups with explicit ids, which left
    // Postgres' identity where the next group would collide with them
    const sync = db.dialect.syncIdentity('user_group')
    if (sync) await db.exec(sync)
    const ops = schemaOps(db)
    await ops.renameColumn('user_account', 'is_disabled', 'is_locked_out')
    await ops.addColumn('document_culture_variation', 'published_event_id', t.integer)
    await ops.addColumn('document_culture_variation', 'published_name', t.varchar(255))
    await db.exec(
      `CREATE TABLE user_group_language (
         user_group_id ${t.integer} NOT NULL REFERENCES user_group (id),
         language_id ${t.integer} NOT NULL REFERENCES language (id),
         PRIMARY KEY (user_group_id, language_id)
       )`,
    )
    await db.exec(
      `CREATE TABLE user_data (
         key ${t.uuid} PRIMARY KEY,
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         data_group ${t.varchar(255)} NOT NULL,
         identifier ${t.varchar(255)} NOT NULL,
         value ${t.text} NOT NULL
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_user_data ON user_data (user_id, data_group, identifier)')
    await db.exec(
      `CREATE TABLE user_token (
         token_hash ${t.varchar(128)} PRIMARY KEY,
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         purpose ${t.varchar(20)} NOT NULL,
         expires_at ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec(
      `CREATE TABLE user_client_credential (
         client_id ${t.varchar(255)} PRIMARY KEY,
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         secret_hash ${t.text} NOT NULL,
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec(
      `CREATE TABLE dictionary_item (
         id ${t.identity},
         key ${t.uuid} NOT NULL UNIQUE,
         parent_key ${t.uuid} NULL REFERENCES dictionary_item (key),
         item_key ${t.textCi} NOT NULL UNIQUE
       )`,
    )
    await db.exec(
      `CREATE TABLE dictionary_text (
         dictionary_key ${t.uuid} NOT NULL REFERENCES dictionary_item (key),
         language_id ${t.integer} NOT NULL REFERENCES language (id),
         value ${t.text} NOT NULL,
         PRIMARY KEY (dictionary_key, language_id)
       )`,
    )
  },
}
