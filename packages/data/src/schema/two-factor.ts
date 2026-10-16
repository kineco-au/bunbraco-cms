/**
 * Migration 040 — two-factor sign-in (story 032).
 *
 * `two_factor_login` is a user's or member's authenticator, polymorphic on its
 * owner's key as Umbraco's `umbracoTwoFactorLogin` is: the provider, the secret
 * sealed with `CROMBOLO_SECRET_KEY`, and the last step a code was accepted for,
 * so a code cannot be used twice. `two_factor_recovery_code` holds the hashes of
 * the one-time recovery codes, each marked when used. docs/operations.md.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_SITE_SEARCH } from './site-search.ts'

export const STATE_TWO_FACTOR = '{4c2e7a90-0040-4d1b-9f63-8a5e2c7b1d40}'

export const twoFactorMigration: Migration = {
  from: STATE_SITE_SEARCH,
  to: STATE_TWO_FACTOR,
  name: 'AddTwoFactorLogin',
  kind: 'expand',
  release: '0.14.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE two_factor_login (
         id ${t.identity},
         owner_key ${t.varchar(36)} NOT NULL,
         provider_name ${t.varchar(100)} NOT NULL,
         secret ${t.text} NOT NULL,
         last_used_step ${t.bigint},
         create_date ${t.timestamp} NOT NULL,
         UNIQUE (owner_key, provider_name)
       )`,
    )
    await db.exec(
      `CREATE TABLE two_factor_recovery_code (
         id ${t.identity},
         owner_key ${t.varchar(36)} NOT NULL,
         code_hash ${t.varchar(64)} NOT NULL,
         used_date ${t.timestamp}
       )`,
    )
    await db.exec(
      'CREATE INDEX ix_two_factor_recovery_code_owner ON two_factor_recovery_code (owner_key)',
    )
  },
}
