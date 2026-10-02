/**
 * Migration 020 — API-user client IDs carry bunbraco's own prefix.
 *
 * The prefix exists so an API user's client ID cannot collide with the
 * backoffice client's own, which is `umbraco-back-office` and is not ours to
 * rename: the vendored client sends it on every authorize call. The API-user
 * prefix *is* ours, and it put Umbraco's name on a string administrators type
 * and paste into their own integration config.
 *
 * Only the ID moves. `secret_hash` is untouched, so an existing credential
 * keeps working once the caller sends the new ID — no secret has to be
 * re-issued.
 *
 * The two prefixes are spelled out rather than imported. A migration has to
 * describe what it did on the day it ran, and a constant someone later edits
 * would quietly rewrite history.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_TRANSFER_RUNS } from './transfer-runs.ts'

export const STATE_CLIENT_ID_PREFIX = '{6f1d4a8e-0020-4b7d-8e41-6c2a9f3d5e84}'

const OLD_PREFIX = 'umbraco-back-office-'
const NEW_PREFIX = 'bunbraco-back-office-'

export const clientIdPrefixMigration: Migration = {
  from: STATE_TRANSFER_RUNS,
  to: STATE_CLIENT_ID_PREFIX,
  name: 'RenameClientIdPrefix',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    // `client_id` is the primary key and nothing references it, so this is an
    // update in place. SUBSTR is 1-based in both dialects.
    await db.exec(
      `UPDATE user_client_credential
          SET client_id = ? || SUBSTR(client_id, ?)
        WHERE client_id LIKE ?`,
      [NEW_PREFIX, OLD_PREFIX.length + 1, `${OLD_PREFIX}%`],
    )
  },
}
