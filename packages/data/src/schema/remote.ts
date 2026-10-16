/**
 * Migration 041 — the remote protocol (story 107). docs/remote-protocol.md.
 *
 * `device_authorization` is a sign-in by the OAuth device grant (RFC 8628):
 * the device code's hash, the code a person types, who approved it, and the
 * session its tokens belong to — which is what "signed-in devices" lists and
 * revokes. `remote_job` is a pull or a push: who asked, where it has got to,
 * the file it made or received in the media store, and the approval a
 * protected push may wait for — with its passphrase sealed under
 * `CROMBOLO_SECRET_KEY` meanwhile, since the import cannot run without it. Grants the four remote verbs to the
 * administrators group.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { grantBuiltInPermissions } from './seed.ts'
import { STATE_TWO_FACTOR } from './two-factor.ts'

export const STATE_REMOTE = '{2b7e5c91-0041-4f3a-8d26-9c4a1e7b3f51}'

export const remoteMigration: Migration = {
  from: STATE_TWO_FACTOR,
  to: STATE_REMOTE,
  name: 'AddRemote',
  kind: 'expand',
  release: '0.14.3',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE device_authorization (
         id ${t.identity},
         device_code_hash ${t.varchar(64)} NOT NULL UNIQUE,
         user_code ${t.varchar(16)} NOT NULL UNIQUE,
         client_id ${t.varchar(255)} NOT NULL,
         client_name ${t.varchar(255)},
         scope ${t.text} NOT NULL,
         status ${t.varchar(16)} NOT NULL,
         user_id ${t.integer} REFERENCES user_account (id),
         session_id ${t.uuid},
         interval_seconds ${t.integer} NOT NULL,
         last_polled_at ${t.timestamp},
         expires_at ${t.timestamp} NOT NULL,
         decided_at ${t.timestamp},
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec(
      'CREATE INDEX ix_device_authorization_session ON device_authorization (session_id)',
    )
    await db.exec(
      `CREATE TABLE remote_job (
         id ${t.varchar(36)} PRIMARY KEY,
         kind ${t.varchar(8)} NOT NULL,
         environment ${t.varchar(64)} NOT NULL,
         requested_by ${t.varchar(36)} NOT NULL,
         requested_by_name ${t.varchar(255)} NOT NULL,
         options ${t.text} NOT NULL,
         state ${t.varchar(24)} NOT NULL,
         stage ${t.varchar(64)},
         progress ${t.integer},
         file_key ${t.text},
         file_size ${t.bigint},
         sha256 ${t.varchar(64)},
         problem ${t.text},
         secret ${t.text},
         run_id ${t.varchar(36)},
         decided_by ${t.varchar(36)},
         decided_at ${t.timestamp},
         heartbeat_at ${t.timestamp} NOT NULL,
         expires_at ${t.timestamp} NOT NULL,
         create_date ${t.timestamp} NOT NULL
       )`,
    )
    await db.exec('CREATE INDEX ix_remote_job_state ON remote_job (state)')
    await grantBuiltInPermissions(db)
  },
}
