/**
 * Migration 020, which moved API-user client IDs onto bunbraco's own prefix.
 *
 * The rewrite is one `UPDATE` built from `||` and `SUBSTR`, which both dialects
 * spell the same way but do not agree about everywhere — hence a dialect test
 * rather than a unit one. What it must not do is touch `secret_hash`: the whole
 * point of renaming rather than re-issuing is that an existing integration
 * changes its client ID and keeps its secret.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { bunbracoPlan, clientIdPrefixMigration, type Db, DbDate, migrate } from '@bunbraco/data'
import { canConnect, dialectUnderTest, freshDb } from './support/db.ts'

type Credential = { client_id: string; secret_hash: string }

describe(`the client ID prefix (${dialectUnderTest})`, () => {
  let db: Db
  let userId: number

  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    db = await freshDb()
    await migrate(db, bunbracoPlan)
    // Column list and binding follow the seeder: `is_disabled` was renamed to
    // `is_locked_out` by the users-localisation migration, and both dialects
    // need their own spelling of a boolean and a timestamp.
    const now = DbDate.toDb(new Date())
    const bool = (value: boolean) => db.dialect.boolValue(value)
    await db.exec(
      `INSERT INTO user_account
         (key, user_name, login, email, security_stamp, language, kind,
          is_locked_out, is_approved, failed_login_attempts, create_date, update_date)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?)`,
      [
        '11111111-1111-1111-1111-111111111111',
        'robot',
        'robot',
        'robot@example.com',
        crypto.randomUUID(),
        'en-US',
        bool(false),
        bool(true),
        now,
        now,
      ],
    )
    const [row] = await db.query<{ id: number }>('SELECT id FROM user_account WHERE login = ?', [
      'robot',
    ])
    userId = Number(row?.id)
  })

  const credential = async (clientId: string, hash: string) => {
    await db.exec(
      'INSERT INTO user_client_credential (client_id, user_id, secret_hash, create_date) VALUES (?, ?, ?, ?)',
      [clientId, userId, hash, DbDate.toDb(new Date())],
    )
  }

  const credentials = () =>
    db.query<Credential>(
      'SELECT client_id, secret_hash FROM user_client_credential ORDER BY client_id',
    )

  test('renames an existing credential and leaves its secret alone', async () => {
    await credential('umbraco-back-office-deploy', 'hash-of-the-deploy-secret')
    await clientIdPrefixMigration.up(db)
    expect(await credentials()).toEqual([
      { client_id: 'bunbraco-back-office-deploy', secret_hash: 'hash-of-the-deploy-secret' },
    ])
  })

  test('leaves alone an ID that never carried the prefix, and its own output', async () => {
    await db.exec('DELETE FROM user_client_credential')
    await credential('bunbraco-back-office-already', 'hash-a')
    // A bare ID cannot be created through the API, but the rewrite still has to
    // be a fixed point over whatever is already in the table.
    await credential('legacy-robot', 'hash-b')
    await clientIdPrefixMigration.up(db)
    await clientIdPrefixMigration.up(db)
    expect(await credentials()).toEqual([
      { client_id: 'bunbraco-back-office-already', secret_hash: 'hash-a' },
      { client_id: 'legacy-robot', secret_hash: 'hash-b' },
    ])
  })
})
