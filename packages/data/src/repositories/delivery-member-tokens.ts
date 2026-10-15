/**
 * The Delivery API's member tokens. A token is random and opaque; only its
 * SHA-256 is kept, so the table cannot be replayed from a backup.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export type MemberTokenKind = 'code' | 'access' | 'refresh'

export interface MemberToken {
  kind: MemberTokenKind
  memberKey: string
  clientId: string
  scopes: string[]
  redirectUri: string | null
  codeChallenge: string | null
  expiresAt: Date
  redeemedAt: Date | null
}

/** A new token for a client to hold, and the hash it is stored under. Pure apart from the randomness. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** PKCE S256: the verifier's SHA-256, base64url, against the challenge. Pure. */
export const pkceMatches = (verifier: string, challenge: string): boolean =>
  createHash('sha256').update(verifier).digest('base64url') === challenge

export class DeliveryMemberTokenRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  async issue(
    token: Omit<MemberToken, 'redeemedAt' | 'expiresAt'> & { lifetimeMs: number },
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token: value, hash } = newToken()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + token.lifetimeMs)
    await this.#db.exec(
      `INSERT INTO delivery_member_token
         (hash, kind, member_key, client_id, scopes, redirect_uri, code_challenge, expires_at, create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hash,
        token.kind,
        token.memberKey,
        token.clientId,
        token.scopes.join(' '),
        token.redirectUri,
        token.codeChallenge,
        DbDate.toDb(expiresAt),
        DbDate.toDb(now),
      ],
    )
    return { token: value, expiresAt }
  }

  /** The token a client presents, whatever its state; the caller judges it. */
  async find(token: string): Promise<MemberToken | undefined> {
    const rows = await this.#db.query('SELECT * FROM delivery_member_token WHERE hash = ?', [
      hashToken(token),
    ])
    const row = rows[0]
    if (!row) return undefined
    return {
      kind: String(row.kind) as MemberTokenKind,
      memberKey: String(row.member_key),
      clientId: String(row.client_id),
      scopes: String(row.scopes ?? '')
        .split(' ')
        .filter(Boolean),
      redirectUri: (row.redirect_uri as string | null) ?? null,
      codeChallenge: (row.code_challenge as string | null) ?? null,
      expiresAt: DbDate.fromDb(row.expires_at) ?? new Date(0),
      redeemedAt: DbDate.fromDb(row.redeemed_at) ?? null,
    }
  }

  /** Marks a code or refresh token used; false when it already was, so only one redemption wins. */
  async redeem(token: string): Promise<boolean> {
    const rows = await this.#db.query<{ hash: string }>(
      'UPDATE delivery_member_token SET redeemed_at = ? WHERE hash = ? AND redeemed_at IS NULL RETURNING hash',
      [DbDate.toDb(new Date()), hashToken(token)],
    )
    return rows.length > 0
  }

  async revoke(token: string): Promise<void> {
    await this.#db.exec('DELETE FROM delivery_member_token WHERE hash = ?', [hashToken(token)])
  }

  /** Every token a member holds, as signing out ends them. */
  async revokeMember(memberKey: string): Promise<void> {
    await this.#db.exec('DELETE FROM delivery_member_token WHERE member_key = ?', [memberKey])
  }

  /** Expired tokens, which nothing will accept again. */
  async purgeExpired(): Promise<void> {
    await this.#db.exec('DELETE FROM delivery_member_token WHERE expires_at < ?', [
      DbDate.toDb(new Date()),
    ])
  }
}
