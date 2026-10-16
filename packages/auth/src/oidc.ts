/**
 * Signing in through an external identity provider (story 031): OpenID Connect,
 * authorization code with PKCE. Discovery, the redirect and the code exchange
 * are plain `fetch`; the ID token is verified with `jose` against the
 * provider's published keys — signature, issuer, audience, expiry and nonce.
 *
 * What the browser carries between leaving for the provider and coming back —
 * `state`, `nonce`, the PKCE verifier and where to return — is a short-lived
 * token signed with the site's own key, so nothing is stored server side.
 */
import { createRemoteJWKSet, type JWTPayload, jwtVerify, SignJWT } from 'jose'
import { deriveChallenge, generateToken } from './pkce.ts'

/** How a provider's claims are read. Each names a claim in the ID token. */
export interface OidcClaims {
  email: string
  name: string
  /** Where group or role values come from, for mapping onto groups. */
  groups?: string
}

/** One provider, as a preset describes it. */
export interface OidcProviderOptions {
  /** The provider's id: what `external_login` records, and part of its URLs. */
  id: string
  /** What a sign-in button says: "Sign in with {name}". */
  name: string
  issuer: string
  clientId: string
  clientSecret?: string
  scopes: readonly string[]
  claims: OidcClaims
}

/** Who the provider says signed in. */
export interface OidcIdentity {
  /** The provider's stable id for the account (`sub`). */
  subject: string
  email: string | undefined
  emailVerified: boolean
  name: string | undefined
  /** The values of the provider's groups claim, when it names one. */
  groups: string[]
  claims: JWTPayload
}

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

/** What a sign-in carries while the browser is away at the provider. */
export interface OidcFlowState {
  provider: string
  state: string
  nonce: string
  verifier: string
  returnUrl: string
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000
const FLOW_SECONDS = 10 * 60

export class OidcError extends Error {}

const stringClaim = (claims: JWTPayload, name: string): string | undefined => {
  const value = claims[name]
  return typeof value === 'string' && value ? value : undefined
}

const listClaim = (claims: JWTPayload, name: string | undefined): string[] => {
  if (!name) return []
  const value = claims[name]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return typeof value === 'string' && value ? [value] : []
}

/** A provider's sign-in, from discovery to a verified identity. */
export class OidcClient {
  readonly options: OidcProviderOptions
  #discovery: { value: Discovery; at: number } | undefined
  #keys: ReturnType<typeof createRemoteJWKSet> | undefined

  constructor(options: OidcProviderOptions) {
    this.options = options
  }

  /** The provider's endpoints, from its discovery document, cached for an hour. */
  async discovery(): Promise<Discovery> {
    if (this.#discovery && Date.now() - this.#discovery.at < DISCOVERY_TTL_MS)
      return this.#discovery.value
    const url = `${this.options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok)
      throw new OidcError(`${this.options.name} discovery failed: ${response.status} from ${url}`)
    const value = (await response.json()) as Discovery
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
      if (typeof value[field] !== 'string')
        throw new OidcError(`${this.options.name} discovery has no ${field}`)
    this.#discovery = { value, at: Date.now() }
    this.#keys = createRemoteJWKSet(new URL(value.jwks_uri))
    return value
  }

  /** A new flow: its state, nonce and PKCE verifier, and the URL to send the browser to. */
  async start(
    redirectUri: string,
    returnUrl: string,
  ): Promise<{ url: string; flow: OidcFlowState }> {
    const { authorization_endpoint } = await this.discovery()
    const flow: OidcFlowState = {
      provider: this.options.id,
      state: generateToken(),
      nonce: generateToken(),
      verifier: generateToken(),
      returnUrl,
    }
    const url = new URL(authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.options.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', this.options.scopes.join(' '))
    url.searchParams.set('state', flow.state)
    url.searchParams.set('nonce', flow.nonce)
    url.searchParams.set('code_challenge', await deriveChallenge(flow.verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    return { url: url.href, flow }
  }

  /**
   * The provider's answer, checked against the flow that started it, turned
   * into a verified identity. Throws `OidcError` with a reason fit to log.
   */
  async finish(callback: URL, flow: OidcFlowState, redirectUri: string): Promise<OidcIdentity> {
    const error = callback.searchParams.get('error')
    if (error)
      throw new OidcError(
        `${this.options.name} refused the sign-in: ${callback.searchParams.get('error_description') ?? error}`,
      )
    if (callback.searchParams.get('state') !== flow.state)
      throw new OidcError('the sign-in came back with a state it did not start with')
    const code = callback.searchParams.get('code')
    if (!code) throw new OidcError(`${this.options.name} sent no code`)

    const { token_endpoint } = await this.discovery()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.options.clientId,
      code_verifier: flow.verifier,
    })
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret)
    const response = await fetch(token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
    if (!response.ok)
      throw new OidcError(`${this.options.name} would not exchange the code: ${response.status}`)
    const tokens = (await response.json()) as { id_token?: string }
    if (!tokens.id_token) throw new OidcError(`${this.options.name} sent no ID token`)
    return this.verify(tokens.id_token, flow.nonce)
  }

  /** An ID token, verified: signed by the provider's keys, for us, current, and this flow's. */
  async verify(idToken: string, nonce: string): Promise<OidcIdentity> {
    const discovery = await this.discovery()
    const keys = this.#keys as ReturnType<typeof createRemoteJWKSet>
    let claims: JWTPayload
    try {
      ;({ payload: claims } = await jwtVerify(idToken, keys, {
        issuer: discovery.issuer ?? this.options.issuer,
        audience: this.options.clientId,
      }))
    } catch (error) {
      throw new OidcError(
        `the ID token from ${this.options.name} is not valid: ${(error as Error).message}`,
      )
    }
    if (claims.nonce !== nonce) throw new OidcError('the ID token was not issued for this sign-in')
    if (!claims.sub) throw new OidcError(`the ID token from ${this.options.name} names no subject`)
    const verified = claims.email_verified
    return {
      subject: claims.sub,
      email: stringClaim(claims, this.options.claims.email)?.toLowerCase(),
      emailVerified: verified === true || verified === 'true',
      name: stringClaim(claims, this.options.claims.name),
      groups: listClaim(claims, this.options.claims.groups),
      claims,
    }
  }
}

const secretKey = (secret: string) => new TextEncoder().encode(secret)

/** The flow, signed, for the cookie the browser carries to the provider and back. */
export async function signFlowState(secret: string, flow: OidcFlowState): Promise<string> {
  return new SignJWT({ ...flow })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${FLOW_SECONDS}s`)
    .sign(secretKey(secret))
}

/** The flow back from its cookie, or undefined when it is missing, altered or stale. */
export async function readFlowState(
  secret: string,
  value: string | undefined,
): Promise<OidcFlowState | undefined> {
  if (!value) return undefined
  try {
    const { payload } = await jwtVerify(value, secretKey(secret), { algorithms: ['HS256'] })
    const flow = payload as unknown as OidcFlowState
    for (const field of ['provider', 'state', 'nonce', 'verifier', 'returnUrl'] as const)
      if (typeof flow[field] !== 'string') return undefined
    return flow
  } catch {
    return undefined
  }
}
