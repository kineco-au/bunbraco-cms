/**
 * Persistence for identity, sessions, codes and reference tokens.
 *
 * Everything bearer-shaped is stored hashed, so a database read cannot yield a
 * usable credential.
 */
import { type Db, DbDate, fromDbBool, Locks } from '@bunbraco/data'
import { hashToken } from './pkce.ts'

export interface UserRow {
  id: number
  key: string
  userName: string
  login: string
  email: string
  passwordHash: string | null
  language: string | null
  avatar: string | null
  isLockedOut: boolean
  isApproved: boolean
  failedLoginAttempts: number
  /** Umbraco's `UserKind`: API users sign in with client credentials only. */
  kind: 'Default' | 'Api'
}

export interface AuthorizationCodeInit {
  code: string
  userId: number
  sessionId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  scope: string
  expiresAt: Date
}

export interface AuthorizationCodeRow extends Omit<AuthorizationCodeInit, 'code'> {
  consumedAt: Date | undefined
}

export type TokenType = 'access' | 'refresh'

export interface TokenInit {
  token: string
  type: TokenType
  userId: number
  sessionId: string
  clientId: string
  scope: string
  expiresAt: Date
  parentId?: number
}

export interface TokenRow {
  id: number
  type: TokenType
  userId: number
  sessionId: string
  clientId: string
  scope: string
  expiresAt: Date
  revokedAt: Date | undefined
}

function mapUser(row: Record<string, unknown>): UserRow {
  return {
    id: Number(row.id),
    key: String(row.key),
    userName: String(row.user_name),
    login: String(row.login),
    email: String(row.email),
    passwordHash: (row.password_hash as string | null) ?? null,
    language: (row.language as string | null) ?? null,
    avatar: (row.avatar as string | null) ?? null,
    isLockedOut: fromDbBool(row.is_locked_out),
    isApproved: fromDbBool(row.is_approved),
    failedLoginAttempts: Number(row.failed_login_attempts ?? 0),
    kind: Number(row.kind) === 1 ? 'Api' : 'Default',
  }
}

const USER_COLUMNS =
  'id, key, user_name, login, email, password_hash, language, avatar, is_locked_out, is_approved, failed_login_attempts, kind'

export class AuthStore {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async findUserByLogin(login: string): Promise<UserRow | undefined> {
    // login is a case-insensitive column in both dialects, so no lower() needed.
    const rows = await this.#db.query(`SELECT ${USER_COLUMNS} FROM user_account WHERE login = ?`, [
      login,
    ])
    return rows[0] ? mapUser(rows[0]) : undefined
  }

  async findUserById(id: number): Promise<UserRow | undefined> {
    const rows = await this.#db.query(`SELECT ${USER_COLUMNS} FROM user_account WHERE id = ?`, [id])
    return rows[0] ? mapUser(rows[0]) : undefined
  }

  /** An API user's client credential: whose it is, and the secret's hash. */
  async findClientCredential(
    clientId: string,
  ): Promise<{ userId: number; secretHash: string } | undefined> {
    const rows = await this.#db.query<{ user_id: number; secret_hash: string }>(
      'SELECT user_id, secret_hash FROM user_client_credential WHERE client_id = ?',
      [clientId],
    )
    return rows[0]
      ? { userId: Number(rows[0].user_id), secretHash: String(rows[0].secret_hash) }
      : undefined
  }

  async recordLoginSuccess(userId: number, sessionId: string, ipAddress?: string): Promise<void> {
    const now = DbDate.toDb(new Date())
    await this.#db.exec(
      'UPDATE user_account SET failed_login_attempts = 0, last_login_date = ?, update_date = ? WHERE id = ?',
      [now, now, userId],
    )
    await this.#db.exec(
      `INSERT INTO user_login_session (session_id, user_id, logged_in_utc, last_validated_utc, ip_address)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, userId, now, now, ipAddress ?? null],
    )
  }

  async recordLoginFailure(userId: number): Promise<number> {
    const rows = await this.#db.query<{ failed_login_attempts: number }>(
      'SELECT failed_login_attempts FROM user_account WHERE id = ?',
      [userId],
    )
    const attempts = Number(rows[0]?.failed_login_attempts ?? 0) + 1
    await this.#db.exec(
      'UPDATE user_account SET failed_login_attempts = ?, update_date = ? WHERE id = ?',
      [attempts, DbDate.toDb(new Date()), userId],
    )
    return attempts
  }

  async lockOut(userId: number): Promise<void> {
    const now = DbDate.toDb(new Date())
    await this.#db.exec(
      'UPDATE user_account SET is_locked_out = ?, last_lockout_date = ?, update_date = ? WHERE id = ?',
      [this.#db.dialect.boolValue(true), now, now, userId],
    )
  }

  /**
   * Replaces a user's password. The caller supplies an already-hashed value, so
   * this module never needs to know which algorithm is in use.
   */
  async setPassword(userId: number, passwordHash: string, passwordConfig: string): Promise<void> {
    const now = DbDate.toDb(new Date())
    await this.#db.exec(
      `UPDATE user_account
       SET password_hash = ?, password_config = ?, security_stamp = ?,
           last_password_change_date = ?, failed_login_attempts = 0, update_date = ?
       WHERE id = ?`,
      [passwordHash, passwordConfig, crypto.randomUUID(), now, now, userId],
    )
  }

  /** Ends every session a user holds, so a password change logs them out. */
  async endAllSessionsForUser(userId: number): Promise<number> {
    const sessions = await this.#db.query<{ session_id: string }>(
      'SELECT session_id FROM user_login_session WHERE user_id = ? AND logged_out_utc IS NULL',
      [userId],
    )
    for (const session of sessions) await this.endSession(String(session.session_id))
    return sessions.length
  }

  /** Clears a lockout without touching the password. */
  async enable(userId: number): Promise<void> {
    await this.#db.exec(
      'UPDATE user_account SET is_locked_out = ?, is_approved = ?, failed_login_attempts = 0, update_date = ? WHERE id = ?',
      [
        this.#db.dialect.boolValue(false),
        this.#db.dialect.boolValue(true),
        DbDate.toDb(new Date()),
        userId,
      ],
    )
  }

  async findSession(sessionId: string): Promise<{ userId: number } | undefined> {
    const rows = await this.#db.query<{ user_id: number }>(
      'SELECT user_id FROM user_login_session WHERE session_id = ? AND logged_out_utc IS NULL',
      [sessionId],
    )
    return rows[0] ? { userId: Number(rows[0].user_id) } : undefined
  }

  async endSession(sessionId: string): Promise<void> {
    const now = DbDate.toDb(new Date())
    await this.#db.exec(
      'UPDATE user_login_session SET logged_out_utc = ? WHERE session_id = ? AND logged_out_utc IS NULL',
      [now, sessionId],
    )
    await this.#db.exec(
      'UPDATE auth_token SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL',
      [now, sessionId],
    )
  }

  async createAuthorizationCode(init: AuthorizationCodeInit): Promise<void> {
    await this.#db.exec(
      `INSERT INTO auth_code
         (code_hash, user_id, session_id, client_id, redirect_uri, code_challenge,
          code_challenge_method, scope, expires_at, create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hashToken(init.code),
        init.userId,
        init.sessionId,
        init.clientId,
        init.redirectUri,
        init.codeChallenge,
        init.codeChallengeMethod,
        init.scope,
        DbDate.toDb(init.expiresAt),
        DbDate.toDb(new Date()),
      ],
    )
  }

  /**
   * Consumes a code atomically under the key-value lock: an authorization code is
   * single-use, and two simultaneous exchanges must not both succeed.
   */
  async consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRow | undefined> {
    return this.#db.locks.withLock(Locks.KeyValues, async () => {
      const hash = hashToken(code)
      const rows = await this.#db.query(
        `SELECT user_id, session_id, client_id, redirect_uri, code_challenge,
                code_challenge_method, scope, expires_at, consumed_at
         FROM auth_code WHERE code_hash = ?`,
        [hash],
      )
      const row = rows[0]
      if (!row) return undefined
      await this.#db.exec('UPDATE auth_code SET consumed_at = ? WHERE code_hash = ?', [
        DbDate.toDb(new Date()),
        hash,
      ])
      return {
        userId: Number(row.user_id),
        sessionId: String(row.session_id),
        clientId: String(row.client_id),
        redirectUri: String(row.redirect_uri),
        codeChallenge: String(row.code_challenge),
        codeChallengeMethod: String(row.code_challenge_method),
        scope: String(row.scope),
        expiresAt: DbDate.fromDb(row.expires_at) ?? new Date(0),
        consumedAt: DbDate.fromDb(row.consumed_at),
      }
    })
  }

  async createToken(init: TokenInit): Promise<number> {
    await this.#db.exec(
      `INSERT INTO auth_token
         (token_hash, token_type, user_id, session_id, client_id, scope, expires_at, create_date, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hashToken(init.token),
        init.type,
        init.userId,
        init.sessionId,
        init.clientId,
        init.scope,
        DbDate.toDb(init.expiresAt),
        DbDate.toDb(new Date()),
        init.parentId ?? null,
      ],
    )
    const rows = await this.#db.query<{ id: number }>(
      'SELECT id FROM auth_token WHERE token_hash = ?',
      [hashToken(init.token)],
    )
    return Number(rows[0]?.id ?? 0)
  }

  async findToken(token: string, type: TokenType): Promise<TokenRow | undefined> {
    const rows = await this.#db.query(
      `SELECT id, token_type, user_id, session_id, client_id, scope, expires_at, revoked_at
       FROM auth_token WHERE token_hash = ? AND token_type = ?`,
      [hashToken(token), type],
    )
    const row = rows[0]
    if (!row) return undefined
    return {
      id: Number(row.id),
      type: String(row.token_type) as TokenType,
      userId: Number(row.user_id),
      sessionId: String(row.session_id),
      clientId: String(row.client_id),
      scope: String(row.scope),
      expiresAt: DbDate.fromDb(row.expires_at) ?? new Date(0),
      revokedAt: DbDate.fromDb(row.revoked_at),
    }
  }

  async revokeToken(id: number): Promise<void> {
    await this.#db.exec(
      'UPDATE auth_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      [DbDate.toDb(new Date()), id],
    )
  }

  /** Removes expired codes and tokens; called by the background job. */
  async pruneExpired(now = new Date()): Promise<void> {
    const cutoff = DbDate.toDb(now)
    await this.#db.exec('DELETE FROM auth_code WHERE expires_at < ?', [cutoff])
    await this.#db.exec('DELETE FROM auth_token WHERE expires_at < ?', [cutoff])
  }

  /** Section aliases and admin membership, unioned across the user's groups. */
  async loadAuthorization(userId: number): Promise<{
    appAliases: string[]
    groupKeys: string[]
    isAdmin: boolean
    hasAccessToAllLanguages: boolean
    permissions: string[]
    granular: Array<{ nodeKey: string; permission: string; context: string }>
  }> {
    const groups = await this.#db.query(
      `SELECT g.id, g.key, g.alias, g.has_access_to_all_languages
       FROM user_group g
       JOIN user_group_member m ON m.user_group_id = g.id
       WHERE m.user_id = ?`,
      [userId],
    )
    const groupKeys = groups.map((g) => String(g.key))
    const isAdmin = groups.some((g) => String(g.alias) === 'admin')
    const hasAccessToAllLanguages = groups.some((g) => fromDbBool(g.has_access_to_all_languages))

    if (groups.length === 0) {
      return {
        appAliases: [],
        groupKeys: [],
        isAdmin: false,
        hasAccessToAllLanguages: false,
        permissions: [],
        granular: [],
      }
    }

    const sections = await this.#db.query<{ app_alias: string }>(
      `SELECT DISTINCT s.app_alias
       FROM user_group_section s
       JOIN user_group_member m ON m.user_group_id = s.user_group_id
       WHERE m.user_id = ?`,
      [userId],
    )
    const permissions = await this.#db.query<{ permission: string }>(
      `SELECT DISTINCT p.permission
       FROM user_group_permission p
       JOIN user_group g ON g.key = p.user_group_key
       JOIN user_group_member m ON m.user_group_id = g.id
       WHERE m.user_id = ?`,
      [userId],
    )
    const granular = await this.#db.query(
      `SELECT gp.unique_id, gp.permission, gp.context
       FROM user_group_granular_permission gp
       JOIN user_group g ON g.key = gp.user_group_key
       JOIN user_group_member m ON m.user_group_id = g.id
       WHERE m.user_id = ? AND gp.unique_id IS NOT NULL`,
      [userId],
    )

    return {
      appAliases: sections.map((s) => String(s.app_alias)),
      groupKeys,
      isAdmin,
      hasAccessToAllLanguages,
      permissions: permissions.map((p) => String(p.permission)),
      granular: granular.map((g) => ({
        nodeKey: String(g.unique_id),
        permission: String(g.permission),
        context: String(g.context),
      })),
    }
  }
}
