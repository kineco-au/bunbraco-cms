/**
 * Verifying the password hashes an Umbraco site stores, so an imported user or
 * member signs in with the password they had; a success is then re-hashed to
 * argon2id. In the order Umbraco's `UmbracoPasswordHasher` and
 * `MemberPasswordHasher` try them:
 *
 * - ASP.NET Core Identity v3 (`0x01`, PBKDF2 with the PRF and iterations it
 *   records) and v2 (`0x00`, PBKDF2-HMAC-SHA1, 1,000 iterations);
 * - Umbraco 4's HMAC-SHA1 keyed with the password itself;
 * - Umbraco 6–8's HMAC-SHA256 (or plain SHA1) over a base64 salt that prefixes
 *   the hash, named by `passwordConfig` — or assumed for a member with none,
 *   as a site upgraded from 8 has.
 *
 * Every comparison is constant-time. Pure.
 */
import { createHash, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto'

export const UMBRACO_PASSWORD_ALGORITHMS = [
  'PBKDF2.ASPNETCORE.V3',
  'PBKDF2.ASPNETCORE.V2',
  'HMACSHA256',
  'HMACSHA1',
] as const

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

const utf16 = (value: string) => Buffer.from(value, 'utf16le')

function base64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return undefined
  return Buffer.from(value, 'base64')
}

const PRFS = ['sha1', 'sha256', 'sha512'] as const

/** ASP.NET Core Identity v3 or v2, by its first byte; the password as UTF-8. */
export function verifyAspNetIdentity(password: string, hash: string): boolean {
  const bytes = base64(hash)
  if (!bytes || bytes.length === 0) return false
  if (bytes[0] === 0x00) {
    if (bytes.length !== 49) return false
    const salt = bytes.subarray(1, 17)
    const expected = bytes.subarray(17)
    return same(pbkdf2Sync(password, salt, 1000, 32, 'sha1'), expected)
  }
  if (bytes[0] === 0x01) {
    if (bytes.length < 13) return false
    const prf = PRFS[bytes.readUInt32BE(1)]
    const iterations = bytes.readUInt32BE(5)
    const saltLength = bytes.readUInt32BE(9)
    if (!prf || iterations < 1 || saltLength < 16 || bytes.length < 13 + saltLength + 16)
      return false
    const salt = bytes.subarray(13, 13 + saltLength)
    const expected = bytes.subarray(13 + saltLength)
    return same(pbkdf2Sync(password, salt, iterations, expected.length, prf), expected)
  }
  return false
}

/** Umbraco 4's "legacy encoding": HMAC-SHA1 whose key is the password, over the password. */
export function verifyUmbraco4(password: string, hash: string): boolean {
  const expected = base64(hash)
  if (!expected) return false
  return same(createHmac('sha1', utf16(password)).update(utf16(password)).digest(), expected)
}

/**
 * Umbraco 6–8: a 24-character base64 salt, then the base64 hash of the
 * password (UTF-16) under HMAC-SHA256 keyed with the salt repeated to 64
 * bytes — .NET's key length for it — or SHA1 over salt and password.
 */
export function verifyUmbraco8(password: string, hash: string, algorithm = 'HMACSHA256'): boolean {
  if (hash.length <= 24) return false
  const salt = base64(hash.slice(0, 24))
  const expected = base64(hash.slice(24))
  if (!salt || !expected || salt.length === 0) return false
  const name = algorithm.toUpperCase()
  if (name === 'HMACSHA256') {
    const key = Buffer.alloc(64)
    for (let at = 0; at < key.length; at += salt.length)
      salt.copy(key, at, 0, Math.min(salt.length, key.length - at))
    return same(createHmac('sha256', key).update(utf16(password)).digest(), expected)
  }
  if (name === 'SHA1')
    return same(
      createHash('sha1')
        .update(Buffer.concat([salt, utf16(password)]))
        .digest(),
      expected,
    )
  return false
}

/** The `hashAlgorithm` an Umbraco `passwordConfig` names, when it names one. Pure. */
export function umbracoAlgorithmOf(passwordConfig: string | null | undefined): string | undefined {
  if (!passwordConfig) return undefined
  try {
    const parsed = JSON.parse(passwordConfig) as { hashAlgorithm?: unknown }
    return typeof parsed.hashAlgorithm === 'string' ? parsed.hashAlgorithm : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a password matches a hash an Umbraco site stored. `forMember`: a
 * member with no `passwordConfig` is assumed to be on Umbraco 8's hashing,
 * which is how Umbraco treats one upgraded from 8.
 */
export function verifyUmbracoPassword(
  password: string,
  hash: string | null | undefined,
  passwordConfig: string | null | undefined,
  forMember = false,
): boolean {
  if (!hash || !password) return false
  if (verifyAspNetIdentity(password, hash)) return true
  if (verifyUmbraco4(password, hash)) return true
  const algorithm = umbracoAlgorithmOf(passwordConfig) ?? (forMember ? 'HMACSHA256' : undefined)
  if (!algorithm) return false
  return verifyUmbraco8(password, hash, algorithm)
}

/** Whether a `passwordConfig` is one of Umbraco's, rather than crombolo's argon2id. Pure. */
export const isUmbracoPasswordConfig = (passwordConfig: string | null | undefined): boolean => {
  const algorithm = umbracoAlgorithmOf(passwordConfig)
  return algorithm !== undefined && algorithm.toUpperCase() !== 'ARGON2ID'
}
