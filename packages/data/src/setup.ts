/**
 * Whether a site still waits for its owner to set it up from the browser. Kept
 * in the database, not in memory, so a restart can never reopen it.
 */
import type { Db } from './database.ts'
import { Locks } from './locks.ts'
import { insertSuperUser, type SeedAdmin, type SeedOptions } from './schema/seed.ts'

export const SETUP_STATE_KEY = 'crombolo:setup'

/** `none` is every database set up before this existed, or seeded with an administrator. */
export type SetupState = 'pending' | 'complete' | 'none'

export async function readSetupState(db: Db): Promise<SetupState> {
  const rows = await db.query<{ value: string }>('SELECT value FROM key_value WHERE key = ?', [
    SETUP_STATE_KEY,
  ])
  const value = rows[0]?.value
  return value === 'pending' || value === 'complete' ? value : 'none'
}

async function writeSetupState(db: Db, state: 'pending' | 'complete'): Promise<void> {
  const now = db.dialect.now()
  const updated = await db.query<{ key: string }>(
    `UPDATE key_value SET value = ?, update_date = ${now} WHERE key = ? RETURNING key`,
    [state, SETUP_STATE_KEY],
  )
  if (updated.length === 0)
    await db.exec(`INSERT INTO key_value (key, value, update_date) VALUES (?, ?, ${now})`, [
      SETUP_STATE_KEY,
      state,
    ])
}

/** Opens setup on a database that has just been created with no administrator. */
export function markSetupPending(db: Db): Promise<void> {
  return writeSetupState(db, 'pending')
}

/**
 * Creates the administrator and closes setup for good, or answers `closed` when
 * it was already done. Under a lock, so two attempts at once cannot both win.
 */
export function completeSetup(
  db: Db,
  admin: SeedAdmin,
  options: Pick<SeedOptions, 'hashPassword' | 'passwordConfig'>,
): Promise<'created' | 'closed'> {
  return db.locks.withLock(Locks.KeyValues, () =>
    db.transaction(async (tx) => {
      if ((await readSetupState(tx)) !== 'pending') return 'closed'
      await insertSuperUser(tx, { ...options, admin })
      await writeSetupState(tx, 'complete')
      return 'created'
    }),
  )
}
