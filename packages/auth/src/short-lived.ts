/**
 * A small signed token for a step between two requests — the browser holding
 * it while it fetches a two-factor code, say — so nothing is stored server
 * side. HS256 with the site's own key; it expires on its own.
 */
import { type JWTPayload, jwtVerify, SignJWT } from 'jose'

const keyOf = (secret: string) => new TextEncoder().encode(secret)

export async function signShortLived(
  secret: string,
  payload: Record<string, string | number>,
  seconds: number,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(keyOf(secret))
}

/** The payload back, or undefined when the token is missing, altered or expired. */
export async function readShortLived(
  secret: string,
  value: string | undefined,
): Promise<JWTPayload | undefined> {
  if (!value) return undefined
  try {
    return (await jwtVerify(value, keyOf(secret), { algorithms: ['HS256'] })).payload
  } catch {
    return undefined
  }
}
