/**
 * Migration 013 — members and the identities they sign in with.
 *
 * A member is a node facet, exactly like a document: `node` + `content` +
 * `content_version` + `member`, so member types, properties and versioning are
 * the machinery that already exists. Member groups are plain `node` rows with
 * the MemberGroup object type — no table of their own — and `member_group_member`
 * is the membership between them (Umbraco's `cmsMember2MemberGroup`).
 *
 * `external_login` is deliberately polymorphic: `user_or_member_key` serves
 * back-office users and members alike, as Umbraco's does, so federation added
 * for one works for the other.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_LOG_VIEWER } from './log-viewer.ts'

export const STATE_MEMBERS = '{6f1d4a8e-0013-4c21-9d3a-8b1e5c7a2f13}'

export const membersMigration: Migration = {
  from: STATE_LOG_VIEWER,
  to: STATE_MEMBERS,
  name: 'AddMembers',
  kind: 'expand',
  release: '0.5.0',
  async up(db: Db) {
    const t = db.dialect.types

    // Umbraco's `cmsMember`, snake-cased. The password columns stay nullable:
    // a member who only ever signs in through a provider has no password.
    await db.exec(
      `CREATE TABLE member (
         node_id ${t.integer} PRIMARY KEY REFERENCES content (node_id),
         email ${t.textCi} NOT NULL,
         login_name ${t.textCi} NOT NULL,
         password ${t.text},
         password_config ${t.text},
         security_stamp_token ${t.text},
         email_confirmed_date ${t.timestamp},
         failed_password_attempts ${t.integer} NOT NULL,
         is_locked_out ${t.boolean} NOT NULL,
         is_approved ${t.boolean} NOT NULL,
         last_login_date ${t.timestamp},
         last_lockout_date ${t.timestamp},
         last_password_change_date ${t.timestamp}
       )`,
    )
    await db.exec('CREATE UNIQUE INDEX ux_member_login ON member (login_name)')
    await db.exec('CREATE INDEX ix_member_email ON member (email)')

    await db.exec(
      `CREATE TABLE member_group_member (
         member_id ${t.integer} NOT NULL REFERENCES member (node_id),
         member_group_id ${t.integer} NOT NULL REFERENCES node (id),
         PRIMARY KEY (member_id, member_group_id)
       )`,
    )
    await db.exec(
      'CREATE INDEX ix_member_group_member_group ON member_group_member (member_group_id)',
    )

    await db.exec(
      `CREATE TABLE external_login (
         id ${t.identity},
         user_or_member_key ${t.text} NOT NULL,
         login_provider ${t.textCi} NOT NULL,
         provider_key ${t.text} NOT NULL,
         create_date ${t.timestamp} NOT NULL,
         user_data ${t.text}
       )`,
    )
    // One identity per provider per principal, and the sign-in lookup is by
    // the provider's own key.
    await db.exec(
      `CREATE UNIQUE INDEX ux_external_login_provider_principal
         ON external_login (login_provider, user_or_member_key)`,
    )
    await db.exec(
      `CREATE INDEX ix_external_login_provider_key
         ON external_login (login_provider, provider_key)`,
    )

    await db.exec(
      `CREATE TABLE external_login_token (
         id ${t.identity},
         external_login_id ${t.integer} NOT NULL REFERENCES external_login (id),
         name ${t.textCi} NOT NULL,
         value ${t.text} NOT NULL,
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec(
      `CREATE UNIQUE INDEX ux_external_login_token_name
         ON external_login_token (external_login_id, name)`,
    )
  },
}
