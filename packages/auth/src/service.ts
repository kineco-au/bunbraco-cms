/**
 * The OAuth 2.0 authorization server, shaped to what the Umbraco backoffice
 * actually sends. See docs/04-backoffice-hosting.md for the wire contract.
 */
import { type SectionAlias, toSectionAliases } from '@bunbraco/core'
import { hashPassword, passwordConfigJson, verifyPassword } from './password.ts'
import { type CodeChallengeMethod, generateToken, verifyChallenge } from './pkce.ts'
import type { AuthStore, UserRow } from './store.ts'

/**
 * The `client_id` the vendored backoffice sends, which `routes.ts` checks an
 * incoming request against. Not a name we pick: `umb-auth-client.js` takes it as
 * a constructor default and `auth.context.js` constructs that client without
 * passing one, so the browser puts this exact string on every authorize and
 * token call. There is no attribute and no setting to change it.
 *
 * Renaming the value therefore does not rebrand anything — it makes the server
 * reject the only client that calls it, and every sign-in fails with
 * `invalid_client`. The API-user prefix in `adapters/users.ts` is the one that
 * was genuinely ours, and it moved to bunbraco in migration 020.
 */
export const BACKOFFICE_CLIENT_ID = 'umbraco-back-office'
export const DEFAULT_SCOPE = 'offline_access'

export interface AuthSettings {
  /** Access token lifetime. Umbraco uses a quarter of the session timeout. */
  accessTokenSeconds: number
  refreshTokenSeconds: number
  authorizationCodeSeconds: number
  /** Failed attempts before the account is locked. 0 disables lockout. */
  maxFailedLoginAttempts: number
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  accessTokenSeconds: 20 * 60,
  refreshTokenSeconds: 80 * 60,
  authorizationCodeSeconds: 5 * 60,
  maxFailedLoginAttempts: 10,
}

export type LoginResult =
  | { status: 'success'; user: UserRow; sessionId: string }
  | { status: 'invalid' }
  | { status: 'twoFactorRequired'; providers: string[] }
  | { status: 'notAllowed'; reason: 'disabled' | 'lockedOut' | 'notApproved' }

export interface AuthorizationRequest {
  clientId: string
  redirectUri: string
  scope: string
  state: string | undefined
  codeChallenge: string
  codeChallengeMethod: CodeChallengeMethod
}

export interface TokenGrant {
  accessToken: string
  refreshToken: string
  expiresIn: number
  issuedAt: number
  sessionId: string
  userId: number
}

export type TokenError =
  | 'invalid_grant'
  | 'invalid_request'
  | 'invalid_client'
  | 'unauthorized_client'

export type TokenResult =
  | { ok: true; grant: TokenGrant }
  | { ok: false; error: TokenError; description: string }

export interface ResolvedIdentity {
  user: UserRow
  sessionId: string
  allowedSections: SectionAlias[]
  groupKeys: string[]
  isAdmin: boolean
  hasAccessToAllLanguages: boolean
  permissions: string[]
}

/**
 * Normalises login timing so a valid username with a wrong password takes the
 * same time as an unknown username. Without this, response time reveals which
 * accounts exist.
 */
async function withMinimumDuration<T>(minimumMs: number, work: () => Promise<T>): Promise<T> {
  const started = Bun.nanoseconds()
  const result = await work()
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000
  if (elapsedMs < minimumMs) await Bun.sleep(minimumMs - elapsedMs)
  return result
}

const DUMMY_HASH_PROMISE = hashPassword(crypto.randomUUID())

export class AuthService {
  #store: AuthStore
  #settings: AuthSettings

  constructor(store: AuthStore, settings: AuthSettings = DEFAULT_AUTH_SETTINGS) {
    this.#store = store
    this.#settings = settings
  }

  get settings(): AuthSettings {
    return this.#settings
  }

  async login(login: string, password: string, ipAddress?: string): Promise<LoginResult> {
    return withMinimumDuration(120, async () => {
      const user = await this.#store.findUserByLogin(login)
      if (!user) {
        // Verify against a throwaway hash so an unknown user costs the same.
        await verifyPassword(password, await DUMMY_HASH_PROMISE)
        return { status: 'invalid' } as const
      }
      // Before the password, as ASP.NET Identity's PreSignInCheck does it. After
      // it, the two answers differ by whether the password was right — so once an
      // attacker has tripped the lockout themselves, guessing on is free and the
      // status code tells them when they have found it. The throwaway verify keeps
      // this path costing what the others cost.
      if (user.isLockedOut) {
        await verifyPassword(password, await DUMMY_HASH_PROMISE)
        return { status: 'notAllowed', reason: 'lockedOut' } as const
      }
      if (!(await verifyPassword(password, user.passwordHash))) {
        const attempts = await this.#store.recordLoginFailure(user.id)
        if (
          this.#settings.maxFailedLoginAttempts > 0 &&
          attempts >= this.#settings.maxFailedLoginAttempts
        ) {
          await this.#store.lockOut(user.id)
        }
        return { status: 'invalid' } as const
      }
      // `isApproved` stays behind the password on purpose: it is not a state an
      // attacker can induce, so answering it only to whoever knows the password
      // discloses strictly less than checking it up front.
      if (!user.isApproved) return { status: 'notAllowed', reason: 'notApproved' } as const

      const sessionId = crypto.randomUUID()
      await this.#store.recordLoginSuccess(user.id, sessionId, ipAddress)
      return { status: 'success', user, sessionId } as const
    })
  }

  /** Issues a single-use authorization code for an already-authenticated session. */
  async authorize(
    sessionId: string,
    userId: number,
    request: AuthorizationRequest,
  ): Promise<string> {
    const code = generateToken()
    await this.#store.createAuthorizationCode({
      code,
      userId,
      sessionId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      scope: request.scope,
      expiresAt: new Date(Date.now() + this.#settings.authorizationCodeSeconds * 1000),
    })
    return code
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    clientId: string,
    redirectUri: string,
  ): Promise<TokenResult> {
    const record = await this.#store.consumeAuthorizationCode(code)
    if (!record)
      return { ok: false, error: 'invalid_grant', description: 'Unknown authorization code.' }
    if (record.consumedAt) {
      // Replay: the code was already exchanged, so kill the whole session.
      await this.#store.endSession(record.sessionId)
      return { ok: false, error: 'invalid_grant', description: 'Authorization code already used.' }
    }
    if (record.expiresAt.getTime() < Date.now()) {
      return { ok: false, error: 'invalid_grant', description: 'Authorization code has expired.' }
    }
    if (record.clientId !== clientId) {
      return { ok: false, error: 'invalid_client', description: 'Client mismatch.' }
    }
    if (record.redirectUri !== redirectUri) {
      return { ok: false, error: 'invalid_grant', description: 'Redirect URI mismatch.' }
    }
    if (
      !verifyChallenge(
        codeVerifier,
        record.codeChallenge,
        record.codeChallengeMethod as CodeChallengeMethod,
      )
    ) {
      return { ok: false, error: 'invalid_grant', description: 'PKCE verification failed.' }
    }

    return {
      ok: true,
      grant: await this.#issue(record.userId, record.sessionId, clientId, record.scope),
    }
  }

  async refresh(refreshToken: string, clientId: string): Promise<TokenResult> {
    const existing = await this.#store.findToken(refreshToken, 'refresh')
    if (!existing)
      return { ok: false, error: 'invalid_grant', description: 'Unknown refresh token.' }
    if (existing.revokedAt) {
      // Reuse of a rotated token means the chain is compromised.
      await this.#store.endSession(existing.sessionId)
      return { ok: false, error: 'invalid_grant', description: 'Refresh token has been revoked.' }
    }
    if (existing.expiresAt.getTime() < Date.now()) {
      return { ok: false, error: 'invalid_grant', description: 'Refresh token has expired.' }
    }
    if (existing.clientId !== clientId) {
      return { ok: false, error: 'invalid_client', description: 'Client mismatch.' }
    }
    const session = await this.#store.findSession(existing.sessionId)
    if (!session) return { ok: false, error: 'invalid_grant', description: 'Session has ended.' }

    await this.#store.revokeToken(existing.id)
    return {
      ok: true,
      grant: await this.#issue(
        existing.userId,
        existing.sessionId,
        clientId,
        existing.scope,
        existing.id,
      ),
    }
  }

  /**
   * The client-credentials grant for API users: a secret checked against the
   * user's credential yields an access token and no refresh token.
   */
  async clientCredentials(
    clientId: string,
    secret: string,
  ): Promise<
    | { ok: true; accessToken: string; expiresIn: number; issuedAt: number }
    | { ok: false; error: TokenError; description: string }
  > {
    const credential = await this.#store.findClientCredential(clientId)
    const valid = credential ? await verifyPassword(secret, credential.secretHash) : false
    const user = credential && valid ? await this.#store.findUserById(credential.userId) : undefined
    if (user?.kind !== 'Api' || user.isLockedOut || !user.isApproved)
      return { ok: false, error: 'invalid_client', description: 'Invalid client credentials.' }
    const sessionId = crypto.randomUUID()
    await this.#store.recordLoginSuccess(user.id, sessionId)
    const accessToken = generateToken()
    const now = Date.now()
    await this.#store.createToken({
      token: accessToken,
      type: 'access',
      userId: user.id,
      sessionId,
      clientId,
      scope: DEFAULT_SCOPE,
      expiresAt: new Date(now + this.#settings.accessTokenSeconds * 1000),
    })
    return {
      ok: true,
      accessToken,
      expiresIn: this.#settings.accessTokenSeconds,
      issuedAt: Math.floor(now / 1000),
    }
  }

  /** Resolves a reference access token to an identity, or undefined. */
  async resolveAccessToken(accessToken: string): Promise<ResolvedIdentity | undefined> {
    const token = await this.#store.findToken(accessToken, 'access')
    if (!token || token.revokedAt || token.expiresAt.getTime() < Date.now()) return undefined
    const session = await this.#store.findSession(token.sessionId)
    if (!session) return undefined
    const user = await this.#store.findUserById(token.userId)
    if (!user || user.isLockedOut || !user.isApproved) return undefined

    const authorization = await this.#store.loadAuthorization(user.id)
    return {
      user,
      sessionId: token.sessionId,
      allowedSections: toSectionAliases(authorization.appAliases),
      groupKeys: authorization.groupKeys,
      isAdmin: authorization.isAdmin,
      hasAccessToAllLanguages: authorization.hasAccessToAllLanguages,
      permissions: authorization.permissions,
    }
  }

  async resolveSession(sessionId: string): Promise<{ userId: number } | undefined> {
    return this.#store.findSession(sessionId)
  }

  async signOut(sessionId: string): Promise<void> {
    await this.#store.endSession(sessionId)
  }

  async revokeAccessToken(accessToken: string): Promise<void> {
    const token = await this.#store.findToken(accessToken, 'access')
    if (token) await this.#store.endSession(token.sessionId)
  }

  async #issue(
    userId: number,
    sessionId: string,
    clientId: string,
    scope: string,
    parentId?: number,
  ): Promise<TokenGrant> {
    const accessToken = generateToken()
    const refreshToken = generateToken()
    const now = Date.now()
    await this.#store.createToken({
      token: accessToken,
      type: 'access',
      userId,
      sessionId,
      clientId,
      scope,
      expiresAt: new Date(now + this.#settings.accessTokenSeconds * 1000),
      parentId,
    })
    await this.#store.createToken({
      token: refreshToken,
      type: 'refresh',
      userId,
      sessionId,
      clientId,
      scope,
      expiresAt: new Date(now + this.#settings.refreshTokenSeconds * 1000),
      parentId,
    })
    return {
      accessToken,
      refreshToken,
      expiresIn: this.#settings.accessTokenSeconds,
      issuedAt: Math.floor(now / 1000),
      sessionId,
      userId,
    }
  }
}

export { passwordConfigJson }
