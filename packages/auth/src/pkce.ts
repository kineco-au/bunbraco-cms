/**
 * PKCE (RFC 7636). The client generates a 128-character verifier and sends us
 * the S256 challenge; we verify the verifier against it at token exchange.
 */
import { createHash } from 'node:crypto'

export type CodeChallengeMethod = 'S256' | 'plain'

export function base64UrlEncode(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url')
}

export function deriveChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest())
}

/**
 * `plain` is accepted only because the spec defines it; the backoffice always
 * sends S256, so a plain challenge in practice means something is wrong.
 */
export function verifyChallenge(
  verifier: string,
  challenge: string,
  method: CodeChallengeMethod,
): boolean {
  const expected = method === 'S256' ? deriveChallenge(verifier) : verifier
  return timingSafeEqual(expected, challenge)
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

/** Opaque, high-entropy credential: authorization codes and reference tokens. */
export function generateToken(bytes = 48): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)))
}

/**
 * Credentials are stored hashed so a database read cannot yield a usable token.
 * SHA-256 is right here, not argon2: these are high-entropy random values, not
 * guessable secrets, and validation happens on every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}
