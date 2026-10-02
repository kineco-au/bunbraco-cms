/**
 * Administrator account maintenance.
 *
 * A seeded password is printed once, on the run that creates the account, and
 * seeding is idempotent — so without this there is no way back into a database
 * whose generated password has scrolled away.
 */
import { hashPassword, passwordConfigJson, verifyPassword } from './password.ts'
import { generateToken } from './pkce.ts'
import type { AuthStore } from './store.ts'

export interface EnsuredAdmin {
  login: string
  password: string
  /** False when the account already existed and only its password was replaced. */
  created: boolean
  /** Sessions invalidated by the password change. */
  sessionsEnded: number
}

/** A readable but high-entropy password for local development. */
export function generatePassword(): string {
  return generateToken(12).replaceAll('-', '').replaceAll('_', '').slice(0, 16)
}

/**
 * Guarantees that `login` can sign in with the returned password, clearing any
 * lockout on the way. A changed password ends existing sessions, because a change
 * that leaves old tokens working is not a change; an unchanged one keeps them, so
 * restarting with a configured password does not sign editors out.
 */
export async function resetAdminPassword(
  store: AuthStore,
  login: string,
  password = generatePassword(),
): Promise<EnsuredAdmin | undefined> {
  const user = await store.findUserByLogin(login)
  if (!user) return undefined

  await store.enable(user.id)
  if (await verifyPassword(password, user.passwordHash))
    return { login: user.login, password, created: false, sessionsEnded: 0 }

  await store.setPassword(user.id, await hashPassword(password), passwordConfigJson())
  const sessionsEnded = await store.endAllSessionsForUser(user.id)

  return { login: user.login, password, created: false, sessionsEnded }
}
