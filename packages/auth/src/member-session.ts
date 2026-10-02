/**
 * The cookie a signed-in member carries on the front end.
 *
 * Umbraco authenticates members with ASP.NET Identity's application cookie, and
 * revokes one by rotating the member's security stamp. This is the same design
 * without the framework: a signed ticket naming the member, its expiry and the
 * stamp it was issued against. Nothing is stored server side, so a load-balanced
 * set needs only the shared signing key — and because the stamp is checked on
 * every request, changing a password or locking an account ends every session it
 * had, immediately.
 *
 * The ticket is signed, not encrypted: it carries no secret, and a member reading
 * their own key learns nothing. Tampering is what matters, and HMAC-SHA256 over
 * the payload is what stops it.
 */
const ENCODER = new TextEncoder()

export interface MemberTicket {
  /** The member's key. */
  id: string
  /** The security stamp the ticket was issued against. */
  stamp: string
  /** Seconds since the epoch. */
  expires: number
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

const fromBase64url = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** A signed ticket: `<payload>.<signature>`, both base64url. */
export async function signMemberTicket(secret: string, ticket: MemberTicket): Promise<string> {
  const payload = base64url(ENCODER.encode(JSON.stringify(ticket)))
  const signature = await crypto.subtle.sign('HMAC', await key(secret), ENCODER.encode(payload))
  return `${payload}.${base64url(new Uint8Array(signature))}`
}

/**
 * Reads a ticket, or undefined when it is malformed, unsigned by us, or expired.
 * Whether the stamp still matches is the caller's business — only it can look
 * the member up.
 */
export async function readMemberTicket(
  secret: string,
  value: string | undefined,
  now: Date = new Date(),
): Promise<MemberTicket | undefined> {
  if (!value) return undefined
  const [payload, signature] = value.split('.')
  if (!payload || !signature) return undefined
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await key(secret),
      fromBase64url(signature) as unknown as ArrayBuffer,
      ENCODER.encode(payload),
    )
  } catch {
    return undefined
  }
  if (!valid) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as MemberTicket
    if (typeof parsed?.id !== 'string' || typeof parsed?.expires !== 'number') return undefined
    if (parsed.expires * 1000 <= now.getTime()) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** The cookie name, alongside the backoffice's own so the two never collide. */
export function memberCookieName(options: { siteName: string; securePrefix: boolean }): string {
  return `${options.securePrefix ? '__Host-' : ''}umbMember${options.siteName}`
}
