/**
 * Password hashing: argon2id, with the algorithm recorded per row in
 * `password_config`. A hash imported from Umbraco (story 071) is verified in
 * its own format (`umbraco-passwords.ts`) and replaced with argon2id on the
 * first successful sign-in, as Umbraco rotates its legacy formats.
 */
import { verifyUmbracoPassword } from './umbraco-passwords.ts'

export const PASSWORD_ALGORITHM = 'ARGON2ID'

export interface PasswordConfig {
  hashAlgorithm: string
}

export const passwordConfigJson = (algorithm = PASSWORD_ALGORITHM): string =>
  JSON.stringify({ hashAlgorithm: algorithm } satisfies PasswordConfig)

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

/** Whether a stored hash is crombolo's own; anything else is replaced on a successful sign-in. Pure. */
export const isNativeHash = (hash: string | null | undefined): boolean =>
  typeof hash === 'string' && hash.startsWith('$argon2')

/**
 * Verifies a password. Returns false rather than throwing for a malformed or
 * absent hash, so a user row with no password simply cannot sign in. A hash
 * that is not argon2id is tried as Umbraco's, by its `passwordConfig`.
 */
export async function verifyPassword(
  password: string,
  hash: string | null,
  imported: { passwordConfig?: string | null; forMember?: boolean } = {},
): Promise<boolean> {
  if (!hash) return false
  if (!isNativeHash(hash))
    return verifyUmbracoPassword(password, hash, imported.passwordConfig, imported.forMember)
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}
