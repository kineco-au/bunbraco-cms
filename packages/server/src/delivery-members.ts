/**
 * Member sign-in for the Delivery API, at Umbraco's
 * `/umbraco/delivery/api/v1/security/member/*`: the authorization code flow
 * with PKCE for an app a member signs in to, and client credentials for the
 * members a site names in config. Tokens are checked against the member as
 * they are now, so a member locked out, unapproved, deleted or moved between
 * groups is held to it at once. docs/delivery-api.md, "Member sign-in".
 *
 * Where this departs from Umbraco, on purpose: PKCE must be S256, signing out
 * ends the member's tokens, and a token is read from the `Authorization`
 * header (or a form body), never the query string.
 */
import {
  type DeliveryApiSettings,
  type DeliveryMember,
  memberAuthorizationProblems,
} from '@crombolo/api-delivery'
import {
  type Db,
  DeliveryMemberTokenRepository,
  MemberRepository,
  pkceMatches,
} from '@crombolo/data'
import type { MemberAuth } from './member-auth.ts'

export const MEMBER_CLIENT_ID = 'umbraco-member'
const SCOPES = new Set(['openid', 'offline_access'])
const CODE_LIFETIME_MS = 5 * 60_000

/** OpenIddict renders an authorize or sign-out error as plain `key:value` lines, never a redirect. */
const local = (error: string, description: string) =>
  new Response(`error:${error}\nerror_description:${description}\n`, {
    status: 400,
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
  })

const tokenError = (error: string, description: string, status = 400) =>
  Response.json(
    { error, error_description: description },
    {
      status,
      headers: status === 401 ? { 'www-authenticate': 'Basic realm="Crombolo"' } : undefined,
    },
  )

const isAbsolute = (url: string) => {
  try {
    return Boolean(new URL(url).protocol) && !url.includes('#')
  } catch {
    return false
  }
}

/** A request's form fields, and HTTP Basic client credentials when sent. */
async function formOf(request: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => undefined)
    for (const [key, value] of form?.entries() ?? [])
      if (typeof value === 'string') out[key] = value
  }
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')
  if (basic) {
    const [id, secret] = Buffer.from(basic[1] as string, 'base64')
      .toString('utf8')
      .split(':')
    if (id && out.client_id === undefined) out.client_id = decodeURIComponent(id)
    if (secret !== undefined && out.client_secret === undefined)
      out.client_secret = decodeURIComponent(secret)
  }
  return out
}

export interface DeliveryMemberSecurity {
  /** The member a bearer token names, as they are now; undefined when none may be. */
  member(token: string): Promise<DeliveryMember | undefined>
  handle(request: Request, action: string): Promise<Response | undefined>
  /** Said once at boot: what turns a flow off. */
  problems: string[]
}

export function createDeliveryMemberSecurity(options: {
  db: Db
  settings: DeliveryApiSettings
  members: Pick<MemberAuth, 'resolve' | 'signOutCookie'>
}): DeliveryMemberSecurity {
  const { db, settings } = options
  const tokens = new DeliveryMemberTokenRepository(db)
  const memberRepo = new MemberRepository(db)
  const code = settings.memberAuthorization.authorizationCodeFlow
  const credentials = settings.memberAuthorization.clientCredentialsFlow
  const problems = memberAuthorizationProblems(settings)
  // Umbraco removes the app client when its flow is misconfigured, and every
  // authorize call then names the client invalid; so does this.
  const codeFlowOn =
    code.enabled &&
    code.loginRedirectUrls.length > 0 &&
    code.loginRedirectUrls.every(isAbsolute) &&
    code.logoutRedirectUrls.every(isAbsolute)
  const timeoutMs = settings.memberAuthorization.timeoutMinutes * 60_000

  const live = async (memberKey: string): Promise<DeliveryMember | undefined> => {
    const member = await memberRepo.byKey(memberKey)
    if (!member) return undefined
    return {
      key: member.key,
      userName: member.username,
      groups: member.roles,
      approved: member.isApproved,
      lockedOut: member.isLockedOut,
    }
  }

  const grant = async (memberKey: string, clientId: string, scopes: string[]) => {
    await tokens.purgeExpired()
    const access = await tokens.issue({
      kind: 'access',
      memberKey,
      clientId,
      scopes,
      redirectUri: null,
      codeChallenge: null,
      lifetimeMs: timeoutMs / 4,
    })
    const body: Record<string, unknown> = {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.round(timeoutMs / 4 / 1000),
      scope: scopes.join(' '),
    }
    if (scopes.includes('offline_access'))
      body.refresh_token = (
        await tokens.issue({
          kind: 'refresh',
          memberKey,
          clientId,
          scopes,
          redirectUri: null,
          codeChallenge: null,
          lifetimeMs: timeoutMs,
        })
      ).token
    return Response.json(body, { headers: { 'cache-control': 'no-store' } })
  }

  async function authorize(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const q = (name: string) => url.searchParams.get(name) ?? ''
    if (!q('client_id'))
      return local('invalid_request', "The mandatory 'client_id' parameter is missing.")
    if (q('client_id') !== MEMBER_CLIENT_ID || !codeFlowOn)
      return local('invalid_request', "The specified 'client_id' is invalid.")
    if (!q('redirect_uri'))
      return local('invalid_request', "The mandatory 'redirect_uri' parameter is missing.")
    if (!isAbsolute(q('redirect_uri')))
      return local('invalid_request', "The 'redirect_uri' parameter must be a valid absolute URI.")
    if (!q('response_type'))
      return local('invalid_request', "The mandatory 'response_type' parameter is missing.")
    if (q('response_type') !== 'code')
      return local('unsupported_response_type', "The specified 'response_type' is not supported.")
    if (!q('code_challenge'))
      return local('invalid_request', "The mandatory 'code_challenge' parameter is missing.")
    // S256 only: Umbraco also allows `plain`, which a stolen code defeats.
    if (q('code_challenge_method') !== 'S256')
      return local('invalid_request', "The specified 'code_challenge_method' is not supported.")
    if (!code.loginRedirectUrls.includes(q('redirect_uri')))
      return local(
        'invalid_request',
        "The specified 'redirect_uri' is not valid for this client application.",
      )
    const scopes = q('scope').split(' ').filter(Boolean)
    if (!scopes.every((s) => SCOPES.has(s)))
      return local('invalid_scope', "The specified 'scope' is invalid.")

    const signedIn = await options.members.resolve(request)
    if (!signedIn) {
      if (!code.loginPage)
        return local(
          'login_required',
          'This site has no member login page set for signing in from an app.',
        )
      const login = new URL(code.loginPage, url)
      login.searchParams.set('returnUrl', `${url.pathname}${url.search}`)
      return new Response(null, {
        status: 302,
        headers: { location: `${login.pathname}${login.search}` },
      })
    }
    const issued = await tokens.issue({
      kind: 'code',
      memberKey: signedIn.key,
      clientId: MEMBER_CLIENT_ID,
      scopes,
      redirectUri: q('redirect_uri'),
      codeChallenge: q('code_challenge'),
      lifetimeMs: CODE_LIFETIME_MS,
    })
    const back = new URL(q('redirect_uri'))
    back.searchParams.set('code', issued.token)
    if (q('state')) back.searchParams.set('state', q('state'))
    back.searchParams.set('iss', `${url.origin}/`)
    return new Response(null, { status: 302, headers: { location: back.toString() } })
  }

  async function token(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const form = await formOf(request)
    const grantType = form.grant_type ?? ''
    if (!grantType)
      return tokenError('invalid_request', "The mandatory 'grant_type' parameter is missing.")
    if (!['authorization_code', 'refresh_token', 'client_credentials'].includes(grantType))
      return tokenError('unsupported_grant_type', "The specified 'grant_type' is not supported.")
    const clientId = form.client_id ?? ''
    if (!clientId)
      return tokenError('invalid_client', "The mandatory 'client_id' parameter is missing.", 401)

    if (grantType === 'client_credentials') {
      const configured = credentials.enabled
        ? credentials.associatedMembers.find((m) => m.clientId === clientId)
        : undefined
      if (!configured)
        return tokenError('invalid_client', "The specified 'client_id' is invalid.", 401)
      if (!form.client_secret)
        return tokenError(
          'invalid_client',
          'Client authentication is required for this application.',
          401,
        )
      if (form.client_secret !== configured.clientSecret)
        return tokenError('invalid_client', 'The specified client credentials are invalid.', 401)
      const scopes = (form.scope ?? '').split(' ').filter(Boolean)
      if (scopes.includes('offline_access'))
        return tokenError(
          'invalid_request',
          "The client application is not allowed to use the 'offline_access' scope.",
        )
      const member = await memberRepo.byUsername(configured.userName)
      if (!member)
        return tokenError('Authorization failed', "Invalid 'client_id' or client configuration.")
      return grant(
        member.key,
        clientId,
        scopes.filter((s) => SCOPES.has(s)),
      )
    }

    if (clientId !== MEMBER_CLIENT_ID || !codeFlowOn)
      return tokenError('invalid_client', "The specified 'client_id' is invalid.", 401)
    if (form.client_secret)
      return tokenError(
        'invalid_client',
        "The 'client_secret' parameter is not valid for this client application.",
        401,
      )

    if (grantType === 'authorization_code') {
      if (!form.code)
        return tokenError('invalid_request', "The mandatory 'code' parameter is missing.")
      if (!form.code_verifier)
        return tokenError('invalid_request', "The mandatory 'code_verifier' parameter is missing.")
      const found = await tokens.find(form.code)
      if (found?.kind !== 'code' || found.clientId !== MEMBER_CLIENT_ID)
        return tokenError('invalid_grant', 'The specified authorization code is invalid.')
      if (found.redeemedAt)
        return tokenError(
          'invalid_grant',
          'The specified authorization code has already been redeemed.',
        )
      if (found.expiresAt.getTime() < Date.now())
        return tokenError('invalid_grant', 'The specified authorization code is no longer valid.')
      if ((form.redirect_uri ?? '') !== found.redirectUri)
        return tokenError(
          'invalid_grant',
          "The specified 'redirect_uri' parameter doesn't match the client redirection URI the authorization code was initially sent to.",
        )
      if (!found.codeChallenge || !pkceMatches(form.code_verifier, found.codeChallenge))
        return tokenError('invalid_grant', "The specified 'code_verifier' is invalid.")
      if (!(await tokens.redeem(form.code)))
        return tokenError(
          'invalid_grant',
          'The specified authorization code has already been redeemed.',
        )
      return grant(found.memberKey, MEMBER_CLIENT_ID, found.scopes)
    }

    // A refresh: rolled, so the one presented is spent.
    const presented = form.refresh_token ?? ''
    if (!presented)
      return tokenError('invalid_request', "The mandatory 'refresh_token' parameter is missing.")
    const found = await tokens.find(presented)
    if (found?.kind !== 'refresh' || found.clientId !== MEMBER_CLIENT_ID)
      return tokenError('invalid_grant', 'The specified refresh token is invalid.')
    if (found.redeemedAt)
      return tokenError('invalid_grant', 'The specified refresh token has already been redeemed.')
    if (found.expiresAt.getTime() < Date.now())
      return tokenError('invalid_grant', 'The specified refresh token is no longer valid.')
    if (!(await tokens.redeem(presented)))
      return tokenError('invalid_grant', 'The specified refresh token has already been redeemed.')
    return grant(found.memberKey, MEMBER_CLIENT_ID, found.scopes)
  }

  async function signOut(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const target = url.searchParams.get('post_logout_redirect_uri')
    if (target !== null) {
      if (!isAbsolute(target))
        return local(
          'invalid_request',
          "The 'post_logout_redirect_uri' parameter must be a valid absolute URI.",
        )
      if (!code.logoutRedirectUrls.includes(target))
        return local('invalid_request', "The specified 'post_logout_redirect_uri' is invalid.")
    }
    // Umbraco only clears the cookie; here the member's tokens end too.
    const signedIn = await options.members.resolve(request)
    if (signedIn) await tokens.revokeMember(signedIn.key)
    const headers = new Headers({ 'set-cookie': options.members.signOutCookie() })
    if (!target) return new Response(null, { status: 200, headers })
    const back = new URL(target)
    const state = url.searchParams.get('state')
    if (state) back.searchParams.set('state', state)
    headers.set('location', back.toString())
    return new Response(null, { status: 302, headers })
  }

  async function revoke(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const form = await formOf(request)
    if (!form.token)
      return tokenError('invalid_request', "The mandatory 'token' parameter is missing.")
    const found = await tokens.find(form.token)
    if (found && found.clientId !== (form.client_id ?? ''))
      return tokenError(
        'invalid_token',
        'The client application is not allowed to revoke the specified token.',
      )
    if (found) await tokens.revoke(form.token)
    return new Response(null, { status: 200 })
  }

  const member = async (token: string): Promise<DeliveryMember | undefined> => {
    const found = await tokens.find(token)
    if (found?.kind !== 'access' || found.expiresAt.getTime() < Date.now()) return undefined
    return live(found.memberKey)
  }

  async function userinfo(request: Request): Promise<Response> {
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
    const found = bearer ? await member(bearer) : undefined
    const record = found ? await memberRepo.byKey(found.key) : undefined
    if (!found || !record || !found.approved || found.lockedOut)
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate': `Bearer error="${bearer ? 'invalid_token' : 'missing_token'}"`,
        },
      })
    return Response.json({
      sub: record.key,
      ...(record.name ? { name: record.name } : {}),
      ...(record.email ? { email: record.email } : {}),
      role: record.roles,
    })
  }

  return {
    member,
    problems,
    async handle(request, action) {
      switch (action) {
        case 'authorize':
          return authorize(request)
        case 'token':
          return token(request)
        case 'signout':
          return signOut(request)
        case 'revoke':
          return revoke(request)
        case 'userinfo':
          return userinfo(request)
        default:
          return undefined
      }
    },
  }
}
