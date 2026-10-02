/**
 * HTTP surface for back-office security.
 *
 * These endpoints live on Umbraco's BackOfficeController, which is excluded from
 * the OpenAPI document, so they are matched by path rather than through the
 * contract-first router.
 */
import { MANAGEMENT_API_PATH, problemDetails, problemResponse } from '@bunbraco/core'
import {
  type CookieOptions,
  cookieNames,
  expireCookie,
  REDACTED,
  readCookie,
  resolveRedacted,
  serializeCookie,
} from './cookies.ts'
import type { AuthService } from './service.ts'
import { BACKOFFICE_CLIENT_ID, DEFAULT_SCOPE } from './service.ts'

export const SECURITY_PREFIX = `${MANAGEMENT_API_PATH}/security/back-office`

export interface AuthRouteOptions {
  backOfficePath: string
  service: AuthService
  cookies: CookieOptions
}

export interface AuthRoutes {
  /** Handles a security endpoint, or returns undefined when the path is not one. */
  handle(request: Request, pathname: string): Promise<Response | undefined>
}

/**
 * An OAuth error response. A 400 or 401 carrying a JSON `error` member is
 * definitive: the client stops retrying. Any other shape is treated as transient
 * and retried, which leaves the editor hanging.
 */
function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status })
}

export function createAuthRoutes(options: AuthRouteOptions): AuthRoutes {
  // The contract's path, not the backoffice's: these are Management API
  // operations and the client calls them there wherever the editor is mounted.
  const prefix = SECURITY_PREFIX
  const names = cookieNames(options.cookies)
  const secure = options.cookies.securePrefix
  const { service } = options

  const expectedRedirectUri = (origin: string) =>
    `${origin}${options.backOfficePath}/oauth_complete`

  function sessionCookie(sessionId: string, maxAgeSeconds: number): string {
    return serializeCookie({ name: names.session, value: sessionId, secure, maxAgeSeconds })
  }

  /** Real token values only ever leave the server inside these cookies. */
  function tokenCookies(
    accessToken: string,
    refreshToken: string,
    accessTtl: number,
    refreshTtl: number,
  ): string[] {
    return [
      serializeCookie({
        name: names.accessToken,
        value: accessToken,
        secure,
        maxAgeSeconds: accessTtl,
      }),
      serializeCookie({
        name: names.refreshToken,
        value: refreshToken,
        secure,
        maxAgeSeconds: refreshTtl,
      }),
    ]
  }

  function clearedCookies(): string[] {
    return [
      expireCookie(names.accessToken, secure),
      expireCookie(names.refreshToken, secure),
      expireCookie(names.session, secure),
    ]
  }

  async function handleAuthorize(request: Request, url: URL): Promise<Response> {
    const params = url.searchParams
    const clientId = params.get('client_id') ?? ''
    const redirectUri = params.get('redirect_uri') ?? ''
    const responseType = params.get('response_type') ?? ''
    const codeChallenge = params.get('code_challenge') ?? ''
    const method = (params.get('code_challenge_method') ?? 'S256') as 'S256' | 'plain'
    const state = params.get('state') ?? undefined

    if (clientId !== BACKOFFICE_CLIENT_ID) {
      return oauthError('invalid_client', `Unknown client '${clientId}'.`)
    }
    if (responseType !== 'code') {
      return oauthError(
        'unsupported_response_type',
        'Only the authorization code flow is supported.',
      )
    }
    // PKCE is mandatory: the client is public and cannot hold a secret.
    if (!codeChallenge) {
      return oauthError('invalid_request', 'code_challenge is required.')
    }
    if (redirectUri !== expectedRedirectUri(url.origin)) {
      return oauthError('invalid_request', 'redirect_uri is not registered for this client.')
    }

    const sessionId = readCookie(request, names.session)
    const session = sessionId ? await service.resolveSession(sessionId) : undefined
    if (!sessionId || !session) {
      // No session yet: send the browser to the login page, which returns here.
      const loginUrl = new URL(`${options.backOfficePath}/login`, url.origin)
      loginUrl.searchParams.set('returnUrl', url.pathname + url.search)
      return Response.redirect(loginUrl.href, 302)
    }

    const code = await service.authorize(sessionId, session.userId, {
      clientId,
      redirectUri,
      scope: params.get('scope') ?? DEFAULT_SCOPE,
      state,
      codeChallenge,
      codeChallengeMethod: method,
    })

    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    if (state) target.searchParams.set('state', state)
    return Response.redirect(target.href, 302)
  }

  async function handleToken(request: Request, url: URL): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    const grantType = form.get('grant_type') ?? ''
    const clientId = form.get('client_id') ?? ''

    // API users: a machine client presents its own id and secret and gets a bearer token back
    if (grantType === 'client_credentials') {
      const issued = await service.clientCredentials(clientId, form.get('client_secret') ?? '')
      if (!issued.ok) return oauthError(issued.error, issued.description, 401)
      return Response.json({
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        issued_at: issued.issuedAt,
        scope: DEFAULT_SCOPE,
      })
    }

    if (clientId !== BACKOFFICE_CLIENT_ID) {
      return oauthError('invalid_client', `Unknown client '${clientId}'.`)
    }

    const result =
      grantType === 'authorization_code'
        ? await (async () => {
            const code = form.get('code')
            const verifier = form.get('code_verifier')
            if (!code || !verifier) {
              return {
                ok: false as const,
                error: 'invalid_request' as const,
                description: 'code and code_verifier are required.',
              }
            }
            return service.exchangeCode(
              code,
              verifier,
              clientId,
              form.get('redirect_uri') ?? expectedRedirectUri(url.origin),
            )
          })()
        : grantType === 'refresh_token'
          ? await (async () => {
              // The client sends `[redacted]`; the real token is in the cookie.
              const refreshToken = resolveRedacted(
                form.get('refresh_token'),
                readCookie(request, names.refreshToken),
              )
              if (!refreshToken) {
                return {
                  ok: false as const,
                  error: 'invalid_grant' as const,
                  description: 'No refresh token was presented.',
                }
              }
              return service.refresh(refreshToken, clientId)
            })()
          : {
              ok: false as const,
              error: 'unsupported_grant_type' as const,
              description: `Unsupported grant_type '${grantType}'.`,
            }

    if (!result.ok) {
      const status = result.error === 'invalid_client' ? 401 : 400
      const response = oauthError(result.error, result.description, status)
      // A definitive rejection must not leave stale cookies behind.
      for (const cookie of clearedCookies()) response.headers.append('set-cookie', cookie)
      return response
    }

    const { grant } = result
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
    for (const cookie of tokenCookies(
      grant.accessToken,
      grant.refreshToken,
      service.settings.accessTokenSeconds,
      service.settings.refreshTokenSeconds,
    )) {
      headers.append('set-cookie', cookie)
    }
    headers.append(
      'set-cookie',
      sessionCookie(grant.sessionId, service.settings.refreshTokenSeconds),
    )

    return new Response(
      JSON.stringify({
        access_token: REDACTED,
        refresh_token: REDACTED,
        token_type: 'Bearer',
        expires_in: grant.expiresIn,
        issued_at: grant.issuedAt,
        scope: DEFAULT_SCOPE,
      }),
      { status: 200, headers },
    )
  }

  async function handleLogin(request: Request): Promise<Response> {
    let body: { username?: unknown; password?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return problemResponse(
        problemDetails({ title: 'Invalid request', status: 400, detail: 'Expected a JSON body.' }),
      )
    }
    const username = typeof body.username === 'string' ? body.username : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username || !password) {
      return problemResponse(
        problemDetails({
          title: 'Invalid request',
          status: 400,
          detail: 'username and password are required.',
        }),
      )
    }

    const result = await service.login(
      username,
      password,
      request.headers.get('x-forwarded-for') ?? undefined,
    )

    // Status codes the login UI branches on: 401 invalid, 402 needs 2FA,
    // 403 locked or not approved.
    if (result.status === 'invalid') {
      return problemResponse(
        problemDetails({
          title: 'Invalid credentials',
          status: 401,
          operationStatus: 'InvalidCredentials',
        }),
      )
    }
    if (result.status === 'notAllowed') {
      return problemResponse(
        problemDetails({ title: 'Login not allowed', status: 403, operationStatus: result.reason }),
      )
    }
    if (result.status === 'twoFactorRequired') {
      return Response.json(
        { twoFactorLoginView: null, enabledTwoFactorProviderNames: result.providers },
        { status: 402 },
      )
    }

    return new Response(null, {
      status: 200,
      headers: {
        'set-cookie': sessionCookie(result.sessionId, service.settings.refreshTokenSeconds),
      },
    })
  }

  async function handleRevoke(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    const token = resolveRedacted(form.get('token'), readCookie(request, names.accessToken))
    if (token) await service.revokeAccessToken(token)
    const response = new Response(null, { status: 200 })
    for (const cookie of clearedCookies()) response.headers.append('set-cookie', cookie)
    return response
  }

  async function handleSignOut(request: Request, url: URL): Promise<Response> {
    const sessionId = readCookie(request, names.session)
    if (sessionId) await service.signOut(sessionId)

    const requested = url.searchParams.get('post_logout_redirect_uri')
    const allowed = `${url.origin}${options.backOfficePath}/logout`
    const location = requested === allowed ? allowed : `${url.origin}${options.backOfficePath}`
    const response = new Response(null, { status: 302, headers: { location } })
    for (const cookie of clearedCookies()) response.headers.append('set-cookie', cookie)
    return response
  }

  return {
    async handle(request, pathname) {
      if (!pathname.startsWith(`${prefix}/`)) return undefined
      const action = pathname.slice(prefix.length + 1)
      const url = new URL(request.url)

      if (action === 'authorize' && request.method === 'GET') return handleAuthorize(request, url)
      if (action === 'token' && request.method === 'POST') return handleToken(request, url)
      if (action === 'login' && request.method === 'POST') return handleLogin(request)
      if (action === 'revoke' && request.method === 'POST') return handleRevoke(request)
      if (action === 'signout') return handleSignOut(request, url)
      if (action === 'verify-2fa' && request.method === 'POST') {
        return oauthError(
          'unsupported_grant_type',
          'Two-factor authentication is not implemented.',
          400,
        )
      }
      return undefined
    },
  }
}
