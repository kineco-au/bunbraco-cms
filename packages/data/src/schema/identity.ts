/**
 * Migration 001 — back-office identity.
 *
 * Table and column names follow docs/02-data-model.md: Umbraco's relational
 * model with snake_case names. `user` is reserved in Postgres, hence
 * `user_account`.
 */
import type { Db } from '../database.ts'
import { INITIAL_STATE, type Migration } from '../migrations.ts'

export const STATE_IDENTITY = '{6f1d4a8e-0001-4c21-9d3a-8b1e5c7a2f01}'

export const identityMigration: Migration = {
  from: INITIAL_STATE,
  to: STATE_IDENTITY,
  name: 'CreateIdentityTables',
  kind: 'expand',
  release: '0.1.0',
  async up(db: Db) {
    const t = db.dialect.types

    await db.exec(
      `CREATE TABLE user_account (
         id ${t.identity},
         key ${t.uuid} NOT NULL UNIQUE,
         user_name ${t.textCi} NOT NULL,
         login ${t.textCi} NOT NULL,
         email ${t.textCi} NOT NULL,
         password_hash ${t.text},
         password_config ${t.text},
         security_stamp ${t.text},
         language ${t.varchar(14)},
         avatar ${t.text},
         kind ${t.integer} NOT NULL,
         is_disabled ${t.boolean} NOT NULL,
         is_approved ${t.boolean} NOT NULL,
         failed_login_attempts ${t.integer} NOT NULL,
         last_login_date ${t.timestamp},
         last_lockout_date ${t.timestamp},
         last_password_change_date ${t.timestamp},
         invited_date ${t.timestamp},
         email_confirmed_date ${t.timestamp},
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_user_account_login ON user_account (login)')

    await db.exec(
      `CREATE TABLE user_group (
         id ${t.identity},
         key ${t.uuid} NOT NULL UNIQUE,
         alias ${t.textCi} NOT NULL UNIQUE,
         name ${t.textCi} NOT NULL,
         description ${t.text},
         icon ${t.text},
         has_access_to_all_languages ${t.boolean} NOT NULL,
         start_content_id ${t.integer},
         start_media_id ${t.integer},
         start_element_id ${t.integer},
         create_date ${t.timestamp} NOT NULL,
         update_date ${t.timestamp} NOT NULL
       )`,
    )

    await db.exec(
      `CREATE TABLE user_group_member (
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         user_group_id ${t.integer} NOT NULL REFERENCES user_group (id),
         PRIMARY KEY (user_id, user_group_id)
       )`,
    )

    await db.exec(
      `CREATE TABLE user_group_section (
         user_group_id ${t.integer} NOT NULL REFERENCES user_group (id),
         app_alias ${t.varchar(50)} NOT NULL,
         PRIMARY KEY (user_group_id, app_alias)
       )`,
    )

    // Keyed by the group's key, not its id, exactly as Umbraco does.
    await db.exec(
      `CREATE TABLE user_group_permission (
         id ${t.identity},
         user_group_key ${t.uuid} NOT NULL REFERENCES user_group (key),
         permission ${t.varchar(255)} NOT NULL
       )`,
    )

    await db.exec(
      `CREATE TABLE user_group_granular_permission (
         id ${t.identity},
         user_group_key ${t.uuid} NOT NULL REFERENCES user_group (key),
         unique_id ${t.uuid},
         permission ${t.varchar(255)} NOT NULL,
         context ${t.varchar(50)} NOT NULL
       )`,
    )

    await db.exec(
      `CREATE TABLE user_start_node (
         id ${t.identity},
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         start_node ${t.integer} NOT NULL,
         start_node_type ${t.integer} NOT NULL
       )`,
    )
    await db.exec(
      'CREATE UNIQUE INDEX ux_user_start_node ON user_start_node (start_node_type, start_node, user_id)',
    )

    /**
     * A browser session established by the login endpoint. It exists so the
     * authorize endpoint can identify the user without re-prompting, which is
     * how Umbraco's cookie-then-authorization-code flow works.
     */
    await db.exec(
      `CREATE TABLE user_login_session (
         session_id ${t.uuid} PRIMARY KEY,
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         logged_in_utc ${t.timestamp} NOT NULL,
         last_validated_utc ${t.timestamp} NOT NULL,
         logged_out_utc ${t.timestamp},
         ip_address ${t.text}
       )`,
    )
    await db.exec(
      'CREATE INDEX ix_user_login_session_validated ON user_login_session (last_validated_utc)',
    )

    /**
     * Single-use authorization codes. Only the hash is stored: a code is a
     * bearer credential, so a database read must not yield a usable one.
     */
    await db.exec(
      `CREATE TABLE auth_code (
         code_hash ${t.text} PRIMARY KEY,
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         session_id ${t.uuid} NOT NULL,
         client_id ${t.varchar(255)} NOT NULL,
         redirect_uri ${t.text} NOT NULL,
         code_challenge ${t.text} NOT NULL,
         code_challenge_method ${t.varchar(10)} NOT NULL,
         scope ${t.text} NOT NULL,
         expires_at ${t.timestamp} NOT NULL,
         consumed_at ${t.timestamp},
         create_date ${t.timestamp} NOT NULL
       )`,
    )

    /**
     * Reference tokens. Umbraco issues opaque, server-side tokens rather than
     * JWTs, so validation is a database lookup and revocation is immediate.
     * `parent_id` chains a refreshed token to the one it replaced so a whole
     * chain can be revoked on reuse.
     */
    await db.exec(
      `CREATE TABLE auth_token (
         id ${t.identity},
         token_hash ${t.text} NOT NULL UNIQUE,
         token_type ${t.varchar(20)} NOT NULL,
         user_id ${t.integer} NOT NULL REFERENCES user_account (id),
         session_id ${t.uuid} NOT NULL,
         client_id ${t.varchar(255)} NOT NULL,
         scope ${t.text} NOT NULL,
         expires_at ${t.timestamp} NOT NULL,
         create_date ${t.timestamp} NOT NULL,
         revoked_at ${t.timestamp},
         parent_id ${t.integer}
       )`,
    )
    await db.exec('CREATE INDEX ix_auth_token_session ON auth_token (session_id)')
    await db.exec('CREATE INDEX ix_auth_token_expires ON auth_token (expires_at)')
  },
}
