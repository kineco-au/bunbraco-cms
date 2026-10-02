/**
 * Cookie handling for reference tokens.
 *
 * Umbraco v17+ never returns real token values to the browser: the token
 * endpoint's JSON body carries `[redacted]`, and the real values live in
 * `__Host-`-prefixed httpOnly cookies. The client sends `credentials: include`
 * and `refresh_token=[redacted]`, and the server substitutes the real value.
 *
 * The `__Host-` prefix requires Secure and `Path=/` with no Domain. Browsers
 * treat http://localhost as a secure context, so it works in local development,
 * but a site served over plain http on another hostname must drop the prefix —
 * hence `securePrefix`.
 */
export const REDACTED = '[redacted]'

export interface CookieNames {
  accessToken: string
  refreshToken: string
  session: string
}

export interface CookieOptions {
  /** Distinguishes cookies when several sites share a host. */
  siteName: string
  /** False drops the `__Host-` prefix and the Secure flag, for plain-http dev. */
  securePrefix: boolean
}

export function cookieNames(options: CookieOptions): CookieNames {
  const prefix = options.securePrefix ? '__Host-' : ''
  return {
    accessToken: `${prefix}umbAccessToken${options.siteName}`,
    refreshToken: `${prefix}umbRefreshToken${options.siteName}`,
    session: `${prefix}umbSession${options.siteName}`,
  }
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) out.set(name, decodeURIComponent(value))
  }
  return out
}

export function readCookie(request: Request, name: string): string | undefined {
  return parseCookies(request.headers.get('cookie')).get(name)
}

export interface SetCookieInit {
  name: string
  value: string
  maxAgeSeconds?: number
  secure: boolean
  /** Session cookies are scoped to the backoffice; tokens must be Path=/ for `__Host-`. */
  path?: string
}

export function serializeCookie(init: SetCookieInit): string {
  const parts = [
    `${init.name}=${encodeURIComponent(init.value)}`,
    `Path=${init.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (init.secure) parts.push('Secure')
  if (init.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, init.maxAgeSeconds)}`)
  return parts.join('; ')
}

export function expireCookie(name: string, secure: boolean, path = '/'): string {
  return serializeCookie({ name, value: '', maxAgeSeconds: 0, secure, path })
}

/**
 * Replaces a token value the client sent as `[redacted]` with the real one from
 * the cookie. A value that is not the redaction placeholder is returned as-is, so
 * a non-browser client can still present a real token.
 */
export function resolveRedacted(
  submitted: string | null | undefined,
  cookieValue: string | undefined,
): string | undefined {
  if (submitted && submitted !== REDACTED) return submitted
  return cookieValue
}
