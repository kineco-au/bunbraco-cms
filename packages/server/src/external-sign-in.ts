/**
 * Signing in through an external identity provider (story 031), for members on
 * the site and users in the backoffice alike: the browser leaves for the
 * provider and comes back to a callback, which verifies who signed in, finds or
 * links or creates their account, makes their groups follow the provider, and
 * ends exactly as a password sign-in does. docs/operations.md.
 *
 *   GET {base}/{provider}?returnUrl=…   leave for the provider
 *   GET {base}/{provider}/callback      come back from it
 */
import {
  OidcClient,
  OidcError,
  type OidcIdentity,
  readCookie,
  readFlowState,
  serializeCookie,
  signFlowState,
} from '@crombolo/auth'
import { localReturnUrl } from '@crombolo/core'
import {
  type Db,
  type ExternalLoginAudience,
  ExternalLoginRepository,
  ensureKeyValue,
  externalLoginProvider,
} from '@crombolo/data'
import type { IdentityProvider } from './identity-providers.ts'

/** A member or user, as far as signing in is concerned. */
export interface ExternalAccount {
  key: string
  email: string
  /** Member group names, or user group aliases. */
  groups: readonly string[]
}

/** What a first sign-in through a provider comes to. Pure. */
export type SignInDecision =
  | { kind: 'signIn'; ownerKey: string }
  | { kind: 'link'; ownerKey: string }
  | { kind: 'create' }
  | { kind: 'refuse'; reason: string }

/**
 * Who a provider's sign-in is, given who is already linked to it and who has
 * its email. An account already linked signs in. Otherwise an account with the
 * same email is linked only when the provider allows it and vouches for the
 * email; it is never merged otherwise. Nobody at all is created, when allowed.
 */
export function decideSignIn(input: {
  linked: string | undefined
  sameEmail: string | undefined
  identity: Pick<OidcIdentity, 'email' | 'emailVerified'>
  provider: Pick<IdentityProvider, 'autoCreate' | 'linkByEmail' | 'emailsVerified'> & {
    name: string
  }
}): SignInDecision {
  const { linked, sameEmail, identity, provider } = input
  if (linked) return { kind: 'signIn', ownerKey: linked }
  if (!identity.email)
    return { kind: 'refuse', reason: `${provider.name} did not say what your email address is.` }
  if (sameEmail) {
    const verified = identity.emailVerified || provider.emailsVerified
    if (provider.linkByEmail && verified) return { kind: 'link', ownerKey: sameEmail }
    return {
      kind: 'refuse',
      reason:
        'An account with this email address already exists. Sign in the way you usually do, or ask for the two to be linked.',
    }
  }
  if (!provider.autoCreate)
    return { kind: 'refuse', reason: `No account here is linked to your ${provider.name} sign-in.` }
  return { kind: 'create' }
}

/**
 * An account's groups once the provider's claim is applied: the groups the
 * mapping manages are made to match the claim, and every other group is kept.
 * Pure.
 */
export function syncedGroups(
  current: readonly string[],
  claimValues: readonly string[],
  map: Readonly<Record<string, string>>,
): string[] {
  const managed = new Set(Object.values(map).map((g) => g.toLowerCase()))
  const wanted = claimValues.flatMap((value) => (map[value] ? [map[value]] : []))
  const kept = current.filter((group) => !managed.has(group.toLowerCase()))
  const out: string[] = []
  for (const group of [...kept, ...wanted])
    if (!out.some((g) => g.toLowerCase() === group.toLowerCase())) out.push(group)
  return out
}

/** What one audience — members or users — does at each step. */
export interface ExternalSignInAudience {
  audience: ExternalLoginAudience
  providers: readonly IdentityProvider[]
  /** Where the routes answer: `{base}/{provider}` and `{base}/{provider}/callback`. */
  basePath: string
  byKey(key: string): Promise<ExternalAccount | undefined>
  byEmail(email: string): Promise<ExternalAccount | undefined>
  create(
    identity: OidcIdentity,
    provider: IdentityProvider,
    groups: string[],
  ): Promise<ExternalAccount>
  setGroups(account: ExternalAccount, groups: string[]): Promise<void>
  /** Signs the account in: the cookies to set, or why it may not. */
  signIn(
    account: ExternalAccount,
    request: Request,
  ): Promise<{ cookies: string[] } | { refused: string }>
  /** Where a sign-in goes back to when it fails, with the reason to show. */
  failed(returnUrl: string, reason: string): string
}

export interface ExternalSignIn {
  /** The provider URL to start a sign-in, for a link or button. */
  startUrl(providerId: string, returnUrl?: string): string
  handle(request: Request, pathname: string): Promise<Response | undefined>
}

const FLOW_KEY = 'crombolo/externalLoginKey'

export function createExternalSignIn(
  db: Db,
  audience: ExternalSignInAudience,
  options: {
    applicationUrl: string
    secureCookies: boolean
    log?: (message: string) => void
    /** The provider as a sign-in uses it, with an administrator's overrides on top (story 033). */
    resolve?: (provider: IdentityProvider) => Promise<IdentityProvider>
  },
): ExternalSignIn {
  const logins = new ExternalLoginRepository(db)
  // One client per effective configuration, so discovery stays cached until a
  // setting changes, and a changed one is used at once.
  const clients = new Map<string, OidcClient>()
  const clientFor = (provider: IdentityProvider) => {
    const key = JSON.stringify(provider.oidc)
    let client = clients.get(key)
    if (!client) {
      client = new OidcClient(provider.oidc)
      clients.set(key, client)
    }
    return client
  }
  const byId = new Map(audience.providers.map((provider) => [provider.oidc.id, provider]))
  let key: Promise<string> | undefined
  const secret = () => {
    key ??= ensureKeyValue(db, FLOW_KEY, () => crypto.randomUUID())
    return key
  }
  const flowCookie = `crombolo-external-${audience.audience}`
  const originOf = (request: Request) =>
    (options.applicationUrl || new URL(request.url).origin).replace(/\/$/, '')
  const callbackUrl = (request: Request, id: string) =>
    `${originOf(request)}${audience.basePath}/${id}/callback`
  const redirect = (location: string, cookies: string[] = []) => {
    const headers = new Headers({ location })
    for (const cookie of cookies) headers.append('set-cookie', cookie)
    return new Response(null, { status: 302, headers })
  }
  // Lax (as every cookie here is), not Strict: the provider sends the browser
  // back with a top-level GET, which a Strict cookie would not ride along on.
  const flowCookieValue = (value: string, maxAgeSeconds: number) =>
    serializeCookie({
      name: flowCookie,
      value,
      secure: options.secureCookies,
      maxAgeSeconds,
      path: audience.basePath,
    })

  const start = async (request: Request, provider: IdentityProvider, client: OidcClient) => {
    const returnUrl = localReturnUrl(new URL(request.url).searchParams.get('returnUrl')) ?? '/'
    try {
      const { url, flow } = await client.start(callbackUrl(request, provider.oidc.id), returnUrl)
      return redirect(url, [flowCookieValue(await signFlowState(await secret(), flow), 600)])
    } catch (error) {
      options.log?.(`${provider.oidc.name} sign-in could not start: ${(error as Error).message}`)
      return redirect(
        audience.failed(returnUrl, `${provider.oidc.name} is not reachable right now.`),
      )
    }
  }

  const finish = async (request: Request, provider: IdentityProvider, client: OidcClient) => {
    const clear = flowCookieValue('', 0)
    const flow = await readFlowState(await secret(), readCookie(request, flowCookie))
    if (!flow || flow.provider !== provider.oidc.id)
      return redirect(
        audience.failed('/', 'That sign-in took too long, or was not started here. Try again.'),
        [clear],
      )
    const back = (reason: string) => redirect(audience.failed(flow.returnUrl, reason), [clear])
    let identity: OidcIdentity
    try {
      identity = await client.finish(
        new URL(request.url),
        flow,
        callbackUrl(request, provider.oidc.id),
      )
    } catch (error) {
      if (!(error instanceof OidcError)) throw error
      options.log?.(error.message)
      return back(`Signing in with ${provider.oidc.name} did not work.`)
    }

    const loginProvider = externalLoginProvider(audience.audience, provider.oidc.id)
    const linked = await logins.find(loginProvider, identity.subject)
    // A link to an account that has since been deleted counts for nothing.
    const linkedAccount = linked ? await audience.byKey(linked.ownerKey) : undefined
    const sameEmail =
      !linkedAccount && identity.email ? await audience.byEmail(identity.email) : undefined
    const decision = decideSignIn({
      linked: linkedAccount?.key,
      sameEmail: sameEmail?.key,
      identity,
      provider: { ...provider, name: provider.oidc.name },
    })
    let account: ExternalAccount
    switch (decision.kind) {
      case 'refuse':
        return back(decision.reason)
      case 'signIn':
        account = linkedAccount as ExternalAccount
        break
      case 'link':
        account = sameEmail as ExternalAccount
        await logins.link(account.key, loginProvider, identity.subject)
        break
      case 'create': {
        const groups = syncedGroups(provider.defaultGroups, identity.groups, provider.groupMap)
        account = await audience.create(identity, provider, groups)
        await logins.link(account.key, loginProvider, identity.subject)
        break
      }
    }
    if (decision.kind !== 'create' && Object.keys(provider.groupMap).length > 0) {
      const groups = syncedGroups(account.groups, identity.groups, provider.groupMap)
      if (groups.join('\n') !== account.groups.join('\n')) await audience.setGroups(account, groups)
    }
    const signedIn = await audience.signIn(account, request)
    if ('refused' in signedIn) return back(signedIn.refused)
    return redirect(flow.returnUrl, [clear, ...signedIn.cookies])
  }

  return {
    startUrl(providerId, returnUrl) {
      const query = returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ''
      return `${audience.basePath}/${providerId}${query}`
    },
    async handle(request, pathname) {
      if (!pathname.startsWith(`${audience.basePath}/`)) return undefined
      const [id, step, ...rest] = pathname.slice(audience.basePath.length + 1).split('/')
      const declared = id ? byId.get(id) : undefined
      if (!declared || rest.length > 0) return undefined
      if (request.method !== 'GET') return new Response(null, { status: 405 })
      const provider = options.resolve ? await options.resolve(declared) : declared
      const client = clientFor(provider)
      if (step === undefined || step === '') return start(request, provider, client)
      if (step === 'callback') return finish(request, provider, client)
      return undefined
    },
  }
}
