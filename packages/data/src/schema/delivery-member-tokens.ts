/**
 * Migration 037 — the Delivery API's member tokens (story 050):
 * authorization codes, access and refresh tokens, each stored as the SHA-256
 * of what the client holds, never the token itself. docs/delivery-api.md,
 * "Member sign-in".
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_TRANSFER_ANSWERS } from './transfer-answers.ts'

export const STATE_DELIVERY_MEMBER_TOKENS = '{7d3b9e2c-0037-4a51-b8f6-2c4e1a9d5b37}'

export const deliveryMemberTokensMigration: Migration = {
  from: STATE_TRANSFER_ANSWERS,
  to: STATE_DELIVERY_MEMBER_TOKENS,
  name: 'AddDeliveryMemberTokens',
  kind: 'expand',
  release: '0.12.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE delivery_member_token (
         hash ${t.varchar(64)} NOT NULL,
         kind ${t.varchar(16)} NOT NULL,
         member_key ${t.varchar(64)} NOT NULL,
         client_id ${t.varchar(255)} NOT NULL,
         scopes ${t.varchar(255)} NOT NULL,
         redirect_uri ${t.text},
         code_challenge ${t.varchar(128)},
         expires_at ${t.timestamp} NOT NULL,
         redeemed_at ${t.timestamp},
         create_date ${t.timestamp} NOT NULL,
         PRIMARY KEY (hash)
       )`,
    )
    await db.exec(
      'CREATE INDEX ix_delivery_member_token_member ON delivery_member_token (member_key)',
    )
  },
}
