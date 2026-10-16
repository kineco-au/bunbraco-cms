/**
 * An OpenID Connect provider served by the test, for external sign-in (story
 * 031): discovery, signing keys, an authorize endpoint that signs whoever the
 * test says straight in, and a token endpoint issuing ID tokens signed with a
 * real RSA key. Each part can be told to misbehave, so the tests can show what
 * a forged, stale or misdirected token comes to.
 */
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'

export interface FakeSignIn {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  groups?: string[]
}

export interface FakeOidc {
  issuer: string
  /** Who signs in next. */
  as(person: FakeSignIn): void
  /** Changes the next ID token: a wrong audience, an expiry in the past, a key it was not signed with. */
  tamper(change: {
    audience?: string
    expired?: boolean
    foreignKey?: boolean
    nonce?: string
  }): void
  /** The last authorize request's parameters. */
  lastAuthorize(): URLSearchParams | undefined
  stop(): void
}

export async function startFakeOidc(clientId: string): Promise<FakeOidc> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const foreign = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fake-1', alg: 'RS256', use: 'sig' }
  let person: FakeSignIn = { sub: 'nobody' }
  let tamper: Parameters<FakeOidc['tamper']>[0] = {}
  let authorize: URLSearchParams | undefined
  const codes = new Map<string, { nonce: string; person: FakeSignIn }>()

  let issuer = ''
  const server: Bun.Server<undefined> = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === '/.well-known/openid-configuration')
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        })
      if (url.pathname === '/jwks') return Response.json({ keys: [jwk] })
      if (url.pathname === '/authorize') {
        authorize = url.searchParams
        const code = crypto.randomUUID()
        codes.set(code, { nonce: url.searchParams.get('nonce') ?? '', person })
        const back = new URL(url.searchParams.get('redirect_uri') as string)
        back.searchParams.set('code', code)
        back.searchParams.set('state', url.searchParams.get('state') ?? '')
        return Response.redirect(back.href, 302)
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const form = new URLSearchParams(await request.text())
        const grant = codes.get(form.get('code') ?? '')
        if (!grant || form.get('client_id') !== clientId || !form.get('code_verifier'))
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        codes.delete(form.get('code') as string)
        const claims: JWTPayload = { ...grant.person, nonce: tamper.nonce ?? grant.nonce }
        const now = Math.floor(Date.now() / 1000)
        const token = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid: 'fake-1' })
          .setIssuer(issuer)
          .setAudience(tamper.audience ?? clientId)
          .setIssuedAt(tamper.expired ? now - 7200 : now)
          .setExpirationTime(tamper.expired ? now - 3600 : now + 600)
          .sign(tamper.foreignKey ? foreign.privateKey : privateKey)
        tamper = {}
        return Response.json({ id_token: token, access_token: 'opaque', token_type: 'Bearer' })
      }
      return new Response('Not found', { status: 404 })
    },
  })

  issuer = `http://localhost:${server.port}`
  return {
    issuer,
    as: (next) => {
      person = next
    },
    tamper: (change) => {
      tamper = change
    },
    lastAuthorize: () => authorize,
    stop: () => server.stop(true),
  }
}
