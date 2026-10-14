/**
 * Database bootstrap: connect, migrate, seed.
 *
 * Migration and seeding run at startup rather than through the install wizard;
 * the wizard is story 080. Both are idempotent, so restarting is safe.
 */
import { hashPassword, passwordConfigJson } from '@crombolo/auth'
import {
  connect,
  cromboloPlan,
  type Db,
  ensureBuiltInDataTypes,
  ensureSystemContentTypes,
  ensureSystemMediaTypes,
  ensureSystemMemberTypes,
  INITIAL_STATE,
  migrate,
  pendingMigrations,
  readState,
  seedContent,
  seedIdentity,
} from '@crombolo/data'
import type { CromboloConfig } from './config.ts'

/** Production never auto-upgrades: an existing database with steps pending refuses to boot. */
export class UpgradePendingError extends Error {
  constructor(readonly steps: string[]) {
    super(
      `${steps.length} framework migration(s) pending on this database: ${steps.join(', ')}. ` +
        'Production does not upgrade at boot; run `crombolo upgrade check`, then `crombolo upgrade`.',
    )
  }
}

export interface Bootstrap {
  db: Db
  /** Present only when this run created the admin account. */
  seededAdminPassword: string | undefined
}

/** A `web` node boots against a database it does not own; `api` has to have been there first. */
export class DatabaseNotReadyError extends Error {
  constructor(readonly steps: string[]) {
    super(
      `This node runs as 'web' and does not migrate, but the database has ${steps.length} ` +
        'migration(s) pending. Start the `api` node first, or run `crombolo upgrade`.',
    )
  }
}

/**
 * Connects without migrating or seeding, for a node whose role is to read.
 *
 * The refusal matters more than the connection: a read-only node that quietly
 * migrated would race the node that owns the schema, and one that quietly
 * served an unmigrated database would answer queries against missing tables.
 */
export async function attachDatabase(config: CromboloConfig): Promise<Bootstrap> {
  const db = await connect({ file: config.sqliteFile })
  const pending = await pendingMigrations(db, cromboloPlan)
  if (pending.length > 0) {
    await db.close()
    throw new DatabaseNotReadyError(pending.map((m) => m.name))
  }
  return { db, seededAdminPassword: undefined }
}

export async function bootstrapDatabase(config: CromboloConfig): Promise<Bootstrap> {
  const db = await connect({ file: config.sqliteFile })
  // pendingMigrations throws when the database is newer than this code.
  const pending = await pendingMigrations(db, cromboloPlan)
  const fresh = (await readState(db)) === INITIAL_STATE
  if (pending.length > 0 && !fresh && !config.development) {
    await db.close()
    throw new UpgradePendingError(pending.map((m) => m.name))
  }
  return { db, seededAdminPassword: await installDatabase(db, config) }
}

/**
 * Migrates and seeds — idempotent. Boot calls it after the production check
 * above; the upgrade CLI calls it directly, since applying the framework's
 * steps is exactly its job. Returns the admin password when this run created
 * the account and none was configured.
 */
export async function installDatabase(db: Db, config: CromboloConfig): Promise<string | undefined> {
  await migrate(db, cromboloPlan, { by: config.nodeId })

  const password = config.adminPassword ?? crypto.randomUUID().replaceAll('-', '').slice(0, 20)
  const seeded = await seedIdentity(db, {
    admin: {
      name: 'Administrator',
      login: config.adminLogin,
      email: config.adminLogin,
      password,
    },
    hashPassword,
    passwordConfig: passwordConfigJson(),
  })

  await seedContent(db)
  // A database from an older version gains the built-ins it lacks.
  await ensureBuiltInDataTypes(db)
  await ensureSystemMediaTypes(db)
  await ensureSystemMemberTypes(db)
  await ensureSystemContentTypes(db)

  return seeded && !config.adminPassword ? password : undefined
}
