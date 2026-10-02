/**
 * Member authentication on the front end, and the public-access check that
 * depends on it.
 *
 * Umbraco has no fixed URLs for this: a site writes a surface controller and
 * posts to it. There is no surface-controller equivalent here, so these four
 * endpoints are ours, under the fixed `/umbraco` namespace rather than the
 * movable backoffice path, because they belong to the framework and not to the
 * editor.
 *
 *   POST /umbraco/members/login     username, password, rememberMe?, returnUrl?
 *   POST /umbraco/members/logout
 *   POST /umbraco/members/register  name, email, username, password, returnUrl?
 *   GET  /umbraco/members/current
 *
 * A form post is answered with a redirect, a JSON post with JSON, so the same
 * endpoint serves a plain `<form>` in a TSX template and a fetch from the page.
 *
 * Registration is refused unless the site turns it on: an endpoint that creates
 * accounts is a decision a site makes, not one a framework makes for it.
 */
import {
  expireCookie,
  hashPassword,
  memberCookieName,
  passwordConfigJson,
  readCookie,
  readMemberTicket,
  serializeCookie,
  signMemberTicket,
  verifyPassword,
} from '@bunbraco/auth'
import {
  DEFAULT_PASSWORD_CONFIGURATION,
  isValidPassword,
  localReturnUrl,
  ObjectTypes,
} from '@bunbraco/core'
import {
  ContentTypeRepository,
  type Db,
  ensureKeyValue,
  MemberRepository,
  type NodeSchemaState,
  PublicAccessRepository,
} from '@bunbraco/data'
import type { AccessDecision, PublishedContent, RequestMember } from '@bunbraco/render'
import type { BunbracoConfig } from './config.ts'

/** The key member tickets are signed with, generated once and shared by every node. */
const SIGNING_KEY = 'bunbraco/memberCookieKey'

export const MEMBER_ROUTE_PREFIX = '/umbraco/members'

export interface MemberAuthOptions {
  /** The schema state this node runs at; a registration is refused without it. */
  nodeState?: NodeSchemaState
  nodeId?: string
}

export interface MemberAuth {
  /** The member this request carries, or undefined. */
  resolve(request: Request): Promise<RequestMember | undefined>
  /**
   * Whether a member may see a page, and what to render instead when not. The
   * answer is Umbraco's: the login page for a visitor who is not signed in, the
   * error page for one who is signed in but not allowed.
   */
  decide(content: PublishedContent, member: RequestMember | undefined): Promise<AccessDecision>
  /** Handles the member endpoints, or undefined when the path is not one. */
  handle(request: Request, pathname: string): Promise<Response | undefined>
}

const isFormPost = (request: Request) =>
  (request.headers.get('content-type') ?? '').includes('form')

async function readInput(request: Request): Promise<Record<string, string>> {
  if (isFormPost(request)) {
    const form = await request.formData().catch(() => undefined)
    if (!form) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of form.entries()) if (typeof value === 'string') out[key] = value
    return out
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(body ?? {}))
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out[key] = String(value)
  return out
}

/**
 * A `returnUrl` must be a path on this site. An absolute URL would let a login
 * form bounce a visitor somewhere else, which is the open-redirect this closes.
 *
 * `localReturnUrl` rather than a prefix test: a browser reads `/\evil.com` as
 * protocol-relative, so the leading single slash it appears to have is not a
 * guarantee of anything.
 */
const safeReturnUrl = (value: string | undefined): string | undefined => localReturnUrl(value)

/**
 * Whether a POST came from this site, rather than a form on someone else's.
 *
 * These three endpoints take a plain form post and act on the member cookie, and
 * `SameSite=Lax` does not cover a cross-site POST's effect here: an attacker's
 * form can sign a visitor into an account the attacker controls, or out of their
 * own. Umbraco's surface controllers carry an antiforgery token for this; with no
 * token to hand, the fetch metadata a browser sends is what distinguishes them.
 *
 * A request with neither header is allowed: that is a non-browser client, which
 * carries no ambient cookies to abuse.
 */
function fromThisSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin' || site === 'none'
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export function createMemberAuth(
  db: Db,
  config: BunbracoConfig,
  options: MemberAuthOptions = {},
): MemberAuth {
  // A registration is a write, so it is refused unless the repository is told
  // which schema state this node runs at.
  const members = new MemberRepository(db, { nodeState: options.nodeState, nodeId: options.nodeId })
  const access = new PublicAccessRepository(db)
  const memberTypes = new ContentTypeRepository(db, { kind: 'member' })
  const cookie = memberCookieName({
    siteName: config.siteName,
    securePrefix: config.secureCookies,
  })
  // Read once and held: every front-end request resolves a member, and that must
  // not cost a query for the key each time.
  let signingKey: Promise<string> | undefined
  const secret = () => {
    signingKey ??= ensureKeyValue(db, SIGNING_KEY, () => crypto.randomUUID())
    return signingKey
  }

  const asRequestMember = (member: {
    key: string
    name: string
    username: string
    email: string
    roles: string[]
  }): RequestMember => ({
    key: member.key,
    name: member.name,
    username: member.username,
    email: member.email,
    roles: member.roles,
  })

  const issue = async (key: string, stamp: string | null, persist: boolean) => {
    const expires = Math.floor(Date.now() / 1000) + config.memberSessionMinutes * 60
    const ticket = await signMemberTicket(await secret(), { id: key, stamp: stamp ?? '', expires })
    return serializeCookie({
      name: cookie,
      value: ticket,
      secure: config.secureCookies,
      // Without "remember me" the cookie lasts the browser session, though the
      // ticket inside it still expires.
      maxAgeSeconds: persist ? config.memberSessionMinutes * 60 : undefined,
    })
  }

  const resolve: MemberAuth['resolve'] = async (request) => {
    const ticket = await readMemberTicket(await secret(), readCookie(request, cookie))
    if (!ticket) return undefined
    const member = await members.byKey(ticket.id)
    if (!member) return undefined
    // The stamp is what makes revocation immediate: a password change or a
    // lockout rotates it, and every ticket issued before it is now worthless.
    if ((member.securityStamp ?? '') !== ticket.stamp) return undefined
    if (!member.isApproved || member.isLockedOut) return undefined
    return asRequestMember(member)
  }

  const decide: MemberAuth['decide'] = async (content, member) => {
    const entry = await access.entryFor(content.key)
    if (!entry) return { status: 'allowed' }
    const here = content.key.toLowerCase()
    // The login and error pages must render even when they sit inside the
    // branch they serve, or the substitution would never terminate.
    if (here === entry.loginNodeKey || here === entry.errorNodeKey) return { status: 'allowed' }
    if (!member) return { status: 'substitute', contentKey: entry.loginNodeKey }
    const allowed =
      entry.memberUserNames.some((name) => name.toLowerCase() === member.username.toLowerCase()) ||
      entry.memberGroupNames.some((name) =>
        member.roles.some((role) => role.toLowerCase() === name.toLowerCase()),
      )
    return allowed
      ? { status: 'allowed' }
      : { status: 'substitute', contentKey: entry.errorNodeKey }
  }

  const answer = (
    request: Request,
    result: { ok: true; body?: unknown } | { ok: false; status: number; error: string },
    options: { returnUrl?: string; cookies?: string[] } = {},
  ): Response => {
    const headers = new Headers()
    for (const value of options.cookies ?? []) headers.append('set-cookie', value)
    if (isFormPost(request)) {
      headers.set('location', options.returnUrl ?? '/')
      // 303 so the browser follows with GET rather than re-posting.
      return new Response(null, { status: 303, headers })
    }
    headers.set('content-type', 'application/json')
    return new Response(
      JSON.stringify(result.ok ? (result.body ?? { ok: true }) : { error: result.error }),
      { status: result.ok ? 200 : result.status, headers },
    )
  }

  const login = async (request: Request): Promise<Response> => {
    const input = await readInput(request)
    const returnUrl = safeReturnUrl(input.returnUrl)
    const username = (input.username ?? '').trim()
    const member = username ? await members.byUsername(username) : undefined
    // A failed form post lands back where it came from, with a flag the login
    // template can read; a failed fetch gets a 401.
    const back = returnUrl ?? '/'
    const failed = () =>
      answer(
        request,
        { ok: false, status: 401, error: 'The username or password is not correct.' },
        { returnUrl: `${back}${back.includes('?') ? '&' : '?'}memberLoginFailed=1` },
      )
    if (!member) {
      // Spend the same time as a real verification would, so a missing username
      // is not distinguishable by how quickly it fails.
      await verifyPassword(input.password ?? '', await hashPassword(crypto.randomUUID()))
      return failed()
    }
    // Checked before the password, so the answer never depends on whether the
    // password was right; the same throwaway verify as above keeps the time taken
    // from saying what the response does not.
    if (member.isLockedOut || !member.isApproved) {
      await verifyPassword(input.password ?? '', await hashPassword(crypto.randomUUID()))
      return failed()
    }
    if (!(await verifyPassword(input.password ?? '', member.passwordHash))) {
      await members.recordFailedLogin(member.key, config.maxFailedPasswordAttempts)
      return failed()
    }
    await members.recordLogin(member.key)
    return answer(
      request,
      { ok: true, body: { member: asRequestMember(member) } },
      {
        returnUrl: returnUrl ?? '/',
        cookies: [await issue(member.key, member.securityStamp, input.rememberMe === 'true')],
      },
    )
  }

  const logout = async (request: Request): Promise<Response> => {
    const input = await readInput(request)
    return answer(
      request,
      { ok: true },
      {
        returnUrl: safeReturnUrl(input.returnUrl) ?? '/',
        cookies: [expireCookie(cookie, config.secureCookies)],
      },
    )
  }

  const register = async (request: Request): Promise<Response> => {
    if (!config.allowMemberRegistration)
      return answer(request, {
        ok: false,
        status: 404,
        error: 'Member registration is not enabled on this site.',
      })
    const input = await readInput(request)
    const email = (input.email ?? '').trim()
    const username = (input.username ?? '').trim() || email
    const name = (input.name ?? '').trim() || username
    const password = input.password ?? ''
    if (!email || !username || !password)
      return answer(request, {
        ok: false,
        status: 400,
        error: 'A name, e-mail address and password are required.',
      })
    // The configured type, and only that: `memberRegistrationType` is the site's
    // statement of what a visitor may create, so honouring a type named in the
    // request would let them register as any member type the site defines.
    const alias = config.memberRegistrationType
    const type = await memberTypes.byAlias(alias)
    if (!type)
      return answer(request, {
        ok: false,
        status: 400,
        error: `The member type "${alias}" does not exist.`,
      })
    if ((await members.taken('username', username)) || (await members.taken('email', email)))
      return answer(request, {
        ok: false,
        status: 409,
        error: 'That username or e-mail address is already registered.',
      })
    // Members were held to no policy at all while backoffice users were; after
    // uniqueness, as ASP.NET Identity orders its own validators.
    if (!isValidPassword(password))
      return answer(request, {
        ok: false,
        status: 400,
        error: `A password must be at least ${DEFAULT_PASSWORD_CONFIGURATION.minimumPasswordLength} characters.`,
      })
    const groupKeys: string[] = []
    for (const groupName of config.memberRegistrationGroups) {
      const rows = await db.query<{ unique_id: string }>(
        'SELECT unique_id FROM node WHERE text = ? AND node_object_type = ?',
        [groupName, ObjectTypes.MemberGroup],
      )
      if (rows[0]) groupKeys.push(String(rows[0].unique_id))
    }
    const created = await members.create(
      {
        key: crypto.randomUUID(),
        contentTypeKey: type.key,
        templateKey: null,
        parentKey: null,
        values: [],
        variants: [{ culture: null, segment: null, name }],
      },
      {
        email,
        username,
        isApproved: true,
        isLockedOut: false,
        passwordHash: await hashPassword(password),
        passwordConfig: passwordConfigJson(),
        groupKeys,
      },
    )
    return answer(
      request,
      { ok: true, body: { member: asRequestMember(created) } },
      {
        returnUrl: safeReturnUrl(input.returnUrl) ?? '/',
        cookies: [await issue(created.key, created.securityStamp, false)],
      },
    )
  }

  return {
    resolve,
    decide,
    async handle(request, pathname) {
      if (!pathname.startsWith(`${MEMBER_ROUTE_PREFIX}/`)) return undefined
      const action = pathname.slice(MEMBER_ROUTE_PREFIX.length + 1)
      if (action === 'current') {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        const member = await resolve(request)
        return member ? Response.json({ member }) : Response.json({ member: null }, { status: 401 })
      }
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      if (!fromThisSite(request)) return new Response('Forbidden', { status: 403 })
      switch (action) {
        case 'login':
          return login(request)
        case 'logout':
          return logout(request)
        case 'register':
          return register(request)
        default:
          return undefined
      }
    },
  }
}
