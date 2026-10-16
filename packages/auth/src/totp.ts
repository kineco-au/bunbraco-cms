/**
 * Time-based one-time passwords for two-factor sign-in (story 032): RFC 6238
 * over HMAC-SHA1, 30-second steps and 6 digits, which is what every
 * authenticator app expects. A code one step either side of now is accepted for
 * clock drift; a code at or before the last step used is refused, so a code seen
 * over someone's shoulder cannot be used again.
 *
 * Recovery codes stand in for a code once each, and are kept only as hashes.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { renderSVG } from 'uqr'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6

/** Bytes as base32 (RFC 4648, no padding), the form authenticator apps read. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Base32 back to bytes; spaces and lower case, as people type it, are fine. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** A new secret: 20 random bytes, as RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The step a moment falls in. */
export const totpStep = (at: Date = new Date()) =>
  Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS)

/** The code for a step (RFC 4226's HOTP over the step counter). */
export function totpCode(secret: Uint8Array, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', secret).update(counter).digest()
  const offset = (hmac[hmac.length - 1] as number) & 0x0f
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return binary.toString().padStart(digits, '0')
}

/**
 * The step a code matches, within one step of now and after the last step used;
 * undefined for a wrong, stale or reused code.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { at?: Date; lastUsedStep?: number | null } = {},
): number | undefined {
  const digits = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(digits)) return undefined
  let secret: Uint8Array
  try {
    secret = base32Decode(secretBase32)
  } catch {
    return undefined
  }
  const now = totpStep(options.at)
  for (const step of [now, now - 1, now + 1]) {
    if (
      options.lastUsedStep !== undefined &&
      options.lastUsedStep !== null &&
      step <= options.lastUsedStep
    )
      continue
    const expected = Buffer.from(totpCode(secret, step))
    if (timingSafeEqual(expected, Buffer.from(digits))) return step
  }
  return undefined
}

/** The `otpauth://` URI an authenticator app reads from the QR code. */
export function otpauthUri(options: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${options.issuer}:${options.account}`)
  const query = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${query}`
}

/** The QR code for an `otpauth` URI, as an SVG `data:` URL an `<img>` can show. */
export function qrCodeDataUrl(text: string): string {
  const svg = renderSVG(text, { border: 2 })
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Ten recovery codes, `xxxxx-xxxxx`, from an alphabet with nothing to confuse. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10)
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length])
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`
  })
}

/** How a recovery code is stored, and looked up: its SHA-256, ignoring case and spacing. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex')
}
