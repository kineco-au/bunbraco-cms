/** Test harness for running the same suite against both dialects. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { connect, type Db, type DialectName, resolveDialectName } from '@bunbraco/data'

// Tests build their throwaway sites with `mkdtemp` under `output/`, which does not
// create parents. Every such test reaches this module, directly or through
// harness.ts, and an import is evaluated before the importer's body — so this is
// the one place that cannot be skipped by a test that needs the directory.
mkdirSync(join(process.cwd(), 'output'), { recursive: true })

export const dialectUnderTest: DialectName = resolveDialectName()

let postgresReachable: boolean | undefined

/**
 * Makes sure the test database has a `public` schema, using a connection of its
 * own rather than `connect()`.
 *
 * A run interrupted between the drop and the create in `resetPostgresSchema`
 * leaves the database with no schemas at all — and `connect()` issues
 * `CREATE EXTENSION IF NOT EXISTS citext` on every Postgres connection, which
 * needs a schema on the search_path to put it in. So every later run fails at
 * *connect*, before reaching the code that would recreate the schema, with 240-odd
 * "no schema has been selected to create in" errors and no way out but psql.
 * Repairing it here costs one statement and makes a Ctrl-C survivable.
 */
async function ensurePublicSchema(): Promise<void> {
  const url = Bun.env.BUNBRACO_POSTGRES_URL ?? Bun.env.DATABASE_URL
  if (!url) return
  const { SQL } = await import('bun')
  const sql = new SQL({ url, max: 1 })
  try {
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS public')
  } finally {
    await sql.close()
  }
}

export async function canConnect(): Promise<boolean> {
  if (dialectUnderTest === 'sqlite') return true
  if (postgresReachable !== undefined) return postgresReachable
  try {
    const db = await connect()
    await db.query('SELECT 1')
    await db.close()
    postgresReachable = true
  } catch {
    postgresReachable = false
  }
  return postgresReachable
}

/**
 * A fresh, empty database for one test.
 *
 * SQLite gets its own in-memory database. Postgres resets the `public` schema
 * instead of creating a per-test one: `SET search_path` is per-connection and
 * Bun's SQL client pools connections, so a search_path set on one connection
 * does not apply to the next query. Resetting the schema is pooling-safe.
 * The cost is that Postgres test files cannot run concurrently against the
 * same database.
 *
 * The schema is ensured before connecting and the extension is qualified, both so
 * that a run interrupted mid-reset recovers by itself; see `ensurePublicSchema`.
 */
export async function freshDb(): Promise<Db> {
  if (dialectUnderTest === 'sqlite') return connect({ dialect: 'sqlite', file: ':memory:' })
  await ensurePublicSchema()
  const db = await connect({ dialect: 'postgres' })
  await db.exec('DROP SCHEMA IF EXISTS public CASCADE')
  await db.exec('CREATE SCHEMA public')
  await db.exec('CREATE EXTENSION IF NOT EXISTS citext SCHEMA public')
  return db
}

/**
 * Undoes what migrations 010 onward did — their tables, dependants first, 011's
 * column rename and 018's table rename — so a test can rewind the recorded
 * state to before them and migrate forward again.
 *
 * Every migration that creates or renames something needs its undo here, or the
 * replay runs its `CREATE TABLE` against a table that is already there.
 */
export async function undoMigrationsSinceContentEditing(db: Db): Promise<void> {
  // 018 renamed the report table, so the replay would rename an absent one.
  await db.exec('DROP INDEX IF EXISTS ix_change_report_subject')
  await db.exec('ALTER TABLE change_report DROP COLUMN source')
  await db.exec('ALTER TABLE change_report DROP COLUMN scope')
  await db.exec('ALTER TABLE change_report RENAME TO upgrade_report')
  await db.exec(
    'CREATE INDEX ix_upgrade_report_subject ON upgrade_report (code, subject_key, property_alias, culture)',
  )
  await db.exec('ALTER TABLE user_account RENAME COLUMN is_locked_out TO is_disabled')
  await db.exec('ALTER TABLE document_culture_variation DROP COLUMN published_event_id')
  await db.exec('ALTER TABLE document_culture_variation DROP COLUMN published_name')
  for (const table of [
    'content_transfer_change',
    'content_transfer_run',
    'assistant_change',
    'assistant_changeset',
    'redirect_url',
    'public_access_rule',
    'public_access',
    'external_login_token',
    'external_login',
    'member_group_member',
    'member',
    'log_viewer_query',
    'dictionary_text',
    'dictionary_item',
    'user_client_credential',
    'user_token',
    'user_data',
    'user_group_language',
    'content_schedule',
    'user_notification',
    'domain',
  ])
    await db.exec(`DROP TABLE IF EXISTS ${table}`)
}

/**
 * Postgres tests share one database, so the schema is reset before a server
 * boots — otherwise seeding is skipped as already done and state leaks between
 * tests and files. SQLite gets a private in-memory database and needs nothing.
 *
 * The consequence is that Postgres test files must not run concurrently against
 * the same database.
 */
export async function resetPostgresSchema(): Promise<void> {
  if (dialectUnderTest !== 'postgres') return
  await ensurePublicSchema()
  const db = await connect({ poolSize: 1 })
  try {
    // One transaction, because DDL is transactional in Postgres and the drop and
    // the create must not be separable. A test that times out between them — which
    // a slow machine makes possible — leaves the database with no `public` schema,
    // and every later file then fails with "no schema has been selected to create
    // in", which looks like a dozen unrelated bugs rather than one interrupted
    // reset. Rolled back, the worst case is a reset that did not happen.
    await db.transaction(async (tx) => {
      await tx.exec('DROP SCHEMA IF EXISTS public CASCADE')
      await tx.exec('CREATE SCHEMA public')
      // Qualified for the same reason as in `freshDb`: an interrupted run leaves no
      // schema, and an unqualified CREATE EXTENSION then fails for good.
      await tx.exec('CREATE EXTENSION IF NOT EXISTS citext SCHEMA public')
    })
  } finally {
    await db.close()
  }
}
