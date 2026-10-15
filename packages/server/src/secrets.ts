/**
 * Secrets kept in the database, sealed with `CROMBOLO_SECRET_KEY`: AES-256-GCM,
 * so a value cannot be read or quietly altered without the key. The key lives
 * only in the environment, so a database dump alone reveals nothing.
 * docs/webhooks.md.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export const SECRET_KEY_VARIABLE = 'CROMBOLO_SECRET_KEY'
export const MIN_SECRET_KEY_LENGTH = 32

const VERSION = 'v1'

/** The configured key, or undefined when it is missing or too short to trust. */
export function usableSecretKey(value: string | undefined): string | undefined {
  return value && value.length >= MIN_SECRET_KEY_LENGTH ? value : undefined
}

const keyBytes = (key: string) => createHash('sha256').update(key, 'utf8').digest()

export function sealSecret(plain: string, key: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`
}

/** Throws when the value was sealed with another key, or has been altered. */
export function openSecret(sealed: string, key: string): string {
  const [version, encoded] = sealed.split(':', 2)
  if (version !== VERSION || !encoded) throw new Error('Not a sealed secret.')
  const raw = Buffer.from(encoded, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}
