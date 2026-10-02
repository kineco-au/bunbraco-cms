/**
 * Password hashing.
 *
 * Umbraco stores ASP.NET Core Identity v3 hashes (PBKDF2-HMAC-SHA512). We are not
 * reading existing Umbraco databases, so we use argon2id instead, and keep the
 * `password_config` marker column so the algorithm is recorded per row and can be
 * rotated later exactly as Umbraco rotates its legacy formats.
 */
export const PASSWORD_ALGORITHM = 'ARGON2ID'

export interface PasswordConfig {
  hashAlgorithm: string
}

export const passwordConfigJson = (algorithm = PASSWORD_ALGORITHM): string =>
  JSON.stringify({ hashAlgorithm: algorithm } satisfies PasswordConfig)

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

/**
 * Verifies a password. Returns false rather than throwing for a malformed or
 * absent hash, so a user row with no password simply cannot sign in.
 */
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) return false
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}
