/**
 * The OAuth 2.0 authorization server, shaped to what the Umbraco backoffice
 * actually sends. See docs/backoffice-hosting.md for the wire contract.
 */
import { type ExtensionSectionAlias, type SectionAlias, toSectionAliases } from '@crombolo/core'
import {
  DEVICE_CODE_SECONDS,
  DEVICE_POLL_SECONDS,
  type DeviceAuthorizationRow,
  type SignedInDevice,
} from './device.ts'
import { hashPassword, isNativeHash, passwordConfigJson, verifyPassword } from './password.ts'
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
 * was genuinely ours, and it moved to crombolo in migration 020.
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

/**
 * `user` on a refusal is for the audit log only, and never reaches the response:
 * the status alone is what the sign-in page may learn.
 */
export type LoginResult =
  | { status: 'success'; user: UserRow; sessionId: string }
  | { status: 'invalid'; user?: UserRow; lockedOut?: boolean }
  | { status: 'twoFactorRequired'; providers: string[]; user: UserRow }
  | { status: 'notAllowed'; reason: 'disabled' | 'lockedOut' | 'notApproved'; user?: UserRow }

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
  // RFC 8628's answers while a device sign-in waits.
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'

export type TokenResult =
  | { ok: true; grant: TokenGrant }
  | { ok: false; error: TokenError; description: string }

export interface ResolvedIdentity {
  user: UserRow
  sessionId: string
  allowedSections: Array<SectionAlias | ExtensionSectionAlias>
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

  /**
   * `twoFactorProviders`, when given, names the two-factor providers a user has
   * turned on (story 032): with any, a correct password stops short of a session
   * and the caller asks for a code.
   */
  async login(
    login: string,
    password: string,
    ipAddress?: string,
    twoFactorProviders?: (user: UserRow) => Promise<string[]>,
  ): Promise<LoginResult> {
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
        return { status: 'notAllowed', reason: 'lockedOut', user } as const
      }
      if (
        !(await verifyPassword(password, user.passwordHash, {
          passwordConfig: user.passwordConfig,
        }))
      ) {
        const attempts = await this.#store.recordLoginFailure(user.id)
        const lockedOut =
          this.#settings.maxFailedLoginAttempts > 0 &&
          attempts >= this.#settings.maxFailedLoginAttempts
        if (lockedOut) await this.#store.lockOut(user.id)
        return { status: 'invalid', user, lockedOut } as const
      }
      // `isApproved` stays behind the password on purpose: it is not a state an
      // attacker can induce, so answering it only to whoever knows the password
      // discloses strictly less than checking it up front.
      if (!user.isApproved) return { status: 'notAllowed', reason: 'notApproved', user } as const
      // An imported Umbraco hash is replaced now the password is known to match it.
      if (!isNativeHash(user.passwordHash))
        await this.#store.rehashPassword(
          user.id,
          await hashPassword(password),
          passwordConfigJson(),
        )

      const providers = (await twoFactorProviders?.(user)) ?? []
      if (providers.length > 0) return { status: 'twoFactorRequired', providers, user } as const

      const sessionId = crypto.randomUUID()
      await this.#store.recordLoginSuccess(user.id, sessionId, ipAddress)
      return { status: 'success', user, sessionId } as const
    })
  }

  /**
   * A wrong second factor counts as a wrong password does, towards lockout, so a
   * stolen password cannot be followed by guessing codes for free.
   */
  async twoFactorFailed(login: string): Promise<{ lockedOut: boolean }> {
    const user = await this.#store.findUserByLogin(login)
    if (!user) return { lockedOut: false }
    const attempts = await this.#store.recordLoginFailure(user.id)
    const lockedOut =
      this.#settings.maxFailedLoginAttempts > 0 && attempts >= this.#settings.maxFailedLoginAttempts
    if (lockedOut) await this.#store.lockOut(user.id)
    return { lockedOut }
  }

  /**
   * Signs a user in whom an external identity provider has vouched for (story
   * 031): no password, but the same refusals a password sign-in has — locked out
   * or not approved — and the same session afterwards.
   */
  async signInExternally(
    login: string,
    ipAddress?: string,
  ): Promise<
    | { status: 'success'; user: UserRow; sessionId: string }
    | { status: 'notAllowed'; reason: 'lockedOut' | 'notApproved' | 'unknown' }
  > {
    const user = await this.#store.findUserByLogin(login)
    if (!user) return { status: 'notAllowed', reason: 'unknown' }
    if (user.isLockedOut) return { status: 'notAllowed', reason: 'lockedOut' }
    if (!user.isApproved) return { status: 'notAllowed', reason: 'notApproved' }
    const sessionId = crypto.randomUUID()
    await this.#store.recordLoginSuccess(user.id, sessionId, ipAddress)
    return { status: 'success', user, sessionId }
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
    | { ok: true; accessToken: string; expiresIn: number; issuedAt: number; user: UserRow }
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
      user,
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

  /** Ends the session, and returns whose it was while it was still open. */
  async signOut(sessionId: string): Promise<UserRow | undefined> {
    const session = await this.#store.findSession(sessionId)
    const user = session ? await this.#store.findUserById(session.userId) : undefined
    await this.#store.endSession(sessionId)
    return user
  }

  async revokeAccessToken(accessToken: string): Promise<UserRow | undefined> {
    const token = await this.#store.findToken(accessToken, 'access')
    if (!token) return undefined
    return this.signOut(token.sessionId)
  }

  /** Starts a device sign-in (RFC 8628): the codes, and how often the client may poll. */
  async startDeviceAuthorization(
    clientId: string,
    clientName: string | null,
  ): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
    const created = await this.#store.devices.create({ clientId, clientName, scope: DEFAULT_SCOPE })
    return {
      deviceCode: created.deviceCode,
      userCode: created.userCode,
      expiresIn: DEVICE_CODE_SECONDS,
      interval: DEVICE_POLL_SECONDS,
    }
  }

  /** A device sign-in waiting for a person, by the code they typed; undefined once it is not. */
  async pendingDevice(userCode: string): Promise<DeviceAuthorizationRow | undefined> {
    const row = await this.#store.devices.byUserCode(userCode)
    if (row?.status !== 'pending' || row.expiresAt.getTime() < Date.now()) return undefined
    return row
  }

  /** Approves or denies a waiting device sign-in for the signed-in person. */
  async decideDevice(userCode: string, userId: number, approve: boolean): Promise<boolean> {
    const row = await this.pendingDevice(userCode)
    return row ? this.#store.devices.decide(row.id, userId, approve) : false
  }

  /**
   * The device's poll: pending until a person decides, then the tokens, once.
   * Polling faster than the interval answers `slow_down` and lengthens it, as
   * RFC 8628 says.
   */
  async pollDevice(
    deviceCode: string,
    clientId: string,
  ): Promise<TokenResult & { user?: UserRow }> {
    const row = await this.#store.devices.byDeviceCode(deviceCode)
    if (!row || row.clientId !== clientId)
      return { ok: false, error: 'invalid_grant', description: 'Unknown device code.' }
    if (row.status === 'denied')
      return { ok: false, error: 'access_denied', description: 'The sign-in was declined.' }
    if (row.status === 'issued')
      return { ok: false, error: 'invalid_grant', description: 'This device code has been used.' }
    if (row.expiresAt.getTime() < Date.now())
      return { ok: false, error: 'expired_token', description: 'The device code has expired.' }
    if (row.status === 'pending') {
      const tooSoon =
        row.lastPolledAt !== undefined &&
        Date.now() - row.lastPolledAt.getTime() < row.intervalSeconds * 1000
      await this.#store.devices.polled(row.id, row.intervalSeconds + (tooSoon ? 5 : 0))
      return tooSoon
        ? { ok: false, error: 'slow_down', description: 'Poll less often.' }
        : { ok: false, error: 'authorization_pending', description: 'Waiting for approval.' }
    }
    const user = row.userId === null ? undefined : await this.#store.findUserById(row.userId)
    if (!user || user.isLockedOut || !user.isApproved)
      return { ok: false, error: 'access_denied', description: 'This account cannot sign in.' }
    const sessionId = crypto.randomUUID()
    if (!(await this.#store.devices.issued(row.id, sessionId)))
      return { ok: false, error: 'invalid_grant', description: 'This device code has been used.' }
    await this.#store.recordLoginSuccess(user.id, sessionId)
    return { ok: true, grant: await this.#issue(user.id, sessionId, clientId, row.scope), user }
  }

  /** The devices signed in as this user. */
  signedInDevices(userId: number): Promise<SignedInDevice[]> {
    return this.#store.devices.signedIn(userId)
  }

  /** Signs a device out, ending its session; false when it is not this user's. */
  async revokeDevice(id: number, userId: number): Promise<boolean> {
    const row = await this.#store.devices.byId(id)
    if (!row || row.userId !== userId || !row.sessionId) return false
    await this.#store.endSession(row.sessionId)
    return true
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
