/**
 * Umbraco's Delivery API v2 over the published cache: content and media
 * items, paths and queries, with its access, culture and Start-Item rules.
 * Every answer is read from memory, so it scales with the nodes that render.
 * docs/delivery-api.md.
 */
import { branchAccess } from '@crombolo/core'
import type {
  PublishedCache,
  PublishedContent,
  PublishedMedia,
  SearchableText,
} from '@crombolo/render'
import { excerpt, excerptHtml, isRightToLeft } from '@crombolo/render'
import {
  ALL_FIELDS,
  type ExpansionNode,
  ExpansionSyntaxError,
  parseExpansion,
} from './expansion.ts'
import {
  type ApiRoute,
  apiContentResponse,
  apiMediaResponse,
  type OutputContext,
} from './output.ts'
import { accessTo, type DeliveryMember, type ProtectionRule } from './protection.ts'
import {
  compareBy,
  parseContentFilters,
  parseContentSelector,
  parseContentSorts,
  parseMediaQuery,
  passesFilters,
  QUERY_ERRORS,
  type QueryError,
} from './query.ts'
import {
  type DeliveryApiSettings,
  isAllowedContentType,
  memberAuthorizationEnabled,
} from './settings.ts'

export interface DeliveryApiPorts {
  settings: DeliveryApiSettings
  cache: PublishedCache
  /** Where the API answers: `/umbraco/delivery/api`, as in Umbraco. */
  prefix: string
  /** Every protected node and who may see it; read once a request, and only when needed. */
  protection(): Promise<ProtectionRule[]>
  /** The member an access token names; undefined for none, or one not valid now. */
  member(token: string): Promise<DeliveryMember | undefined>
  /** The member sign-in endpoints under `v1/security/member/`, when built. */
  security?(request: Request, action: string): Promise<Response | undefined>
  /**
   * Site search over published pages (story 140), behind `v2/search`: a
   * Crombolo addition, which Umbraco's Delivery API has no equivalent of.
   */
  search?(
    term: string,
    options: {
      culture: string
      types: readonly string[]
      skip: number
      take: number
      access: { denied: readonly number[]; allowed: readonly number[] }
    },
  ): Promise<{ total: number; items: Array<{ key: string; score: number; text: SearchableText }> }>
}

export interface DeliveryApi {
  handle(request: Request): Promise<Response | undefined>
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOT_KEY = '00000000-0000-0000-0000-000000000000'
const CONTENT_VARY = 'Accept-Language, Accept-Segment, Preview, Start-Item'

/** 401, 403 and 404 carry no body in Umbraco's Delivery API. */
const bare = (status: number) => new Response(null, { status })

const problem = (error: QueryError) =>
  Response.json(
    {
      type: 'Error',
      title: QUERY_ERRORS[error].title,
      status: 400,
      detail: QUERY_ERRORS[error].detail,
    },
    { status: 400, headers: { 'content-type': 'application/problem+json' } },
  )

const invalid = (field: string, value: string) =>
  Response.json(
    {
      type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
      title: 'One or more validation errors occurred.',
      status: 400,
      errors: { [field]: [`The value '${value}' is not valid.`] },
    },
    { status: 400, headers: { 'content-type': 'application/problem+json' } },
  )

/** The caller's key, compared exactly; a site without one has none to match. Pure. */
export const hasValidApiKey = (settings: DeliveryApiSettings, request: Request): boolean =>
  settings.apiKey !== undefined && request.headers.get('api-key') === settings.apiKey

export const isPreview = (request: Request): boolean =>
  request.headers.get('preview')?.toLowerCase() === 'true'

/** Umbraco's `ApiAccessService`. Pure. */
export function contentAccess(settings: DeliveryApiSettings, request: Request): boolean {
  if (!settings.enabled) return false
  if (isPreview(request)) return hasValidApiKey(settings, request)
  return settings.publicAccess || hasValidApiKey(settings, request)
}

export function mediaAccess(settings: DeliveryApiSettings, request: Request): boolean {
  return (
    settings.enabled &&
    settings.media.enabled &&
    ((settings.publicAccess && settings.media.publicAccess) || hasValidApiKey(settings, request))
  )
}

/** `Accept-Language` only when it is one plain culture name; otherwise none. Pure. */
export function requestedCulture(header: string | null): string | undefined {
  const value = header?.trim()
  return value && /^[\w-]*$/.test(value) ? value : undefined
}

/** The bearer token from the `Authorization` header only — never the query string. Pure. */
export function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')
  return match?.[1]?.trim() || undefined
}

const intParam = (url: URL, name: string, fallback: number): number | Response => {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : invalid(name, raw)
}

const expansionOf = (url: URL): { expand: ExpansionNode; include: ExpansionNode } | Response => {
  try {
    const fields = url.searchParams.get('fields')
    return {
      expand: parseExpansion(url.searchParams.get('expand') ?? ''),
      include: fields ? parseExpansion(fields) : ALL_FIELDS,
    }
  } catch (error) {
    if (!(error instanceof ExpansionSyntaxError)) throw error
    return Response.json(
      { type: 'Error', title: 'Invalid expansion', status: 400, detail: error.message },
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    )
  }
}

export function createDeliveryApi(ports: DeliveryApiPorts): DeliveryApi {
  const { settings, cache } = ports
  const prefix = ports.prefix.replace(/\/$/, '')

  /** Everything a content request decides once: culture, member, rules, routes. */
  async function contentRequest(request: Request) {
    const asked = requestedCulture(request.headers.get('accept-language'))
    const culture = asked ?? (await cache.defaultCulture())
    const known = asked === undefined || (await cache.hasCulture(asked))
    const nav = await cache.navigation(culture)
    const hide = await cache.hidesTopLevel()
    const roots = nav.root()
    const rtl = isRightToLeft(culture)

    let member: DeliveryMember | undefined
    const token = bearerToken(request)
    if (token && memberAuthorizationEnabled(settings)) member = await ports.member(token)
    const loadedRules = new Map((await ports.protection()).map((rule) => [rule.nodeId, rule]))

    const routeIn = async (inCulture: string | null) => {
      const view = await cache.navigation(inCulture)
      const first = view.root()[0]
      const cultureRtl = isRightToLeft(inCulture)
      return (content: PublishedContent): ApiRoute | undefined => {
        const here = view.byKey(content.key)
        if (!here) return undefined
        const ancestors = view.ancestors(here)
        const root = ancestors[ancestors.length - 1] ?? here
        let path: string
        if (ancestors.length === 0)
          path = hide && first && here.id !== first.id ? `/${here.urlSegment}` : '/'
        else {
          const below = [...ancestors.slice(0, -1).reverse(), here].map((c) => c.urlSegment)
          path = `/${(cultureRtl ? below.reverse() : below).join('/')}`
        }
        return { path, queryString: null, startItem: { id: root.key, path: root.urlSegment } }
      }
    }
    const route = await routeIn(culture)

    const ctx: OutputContext = {
      route,
      content: (key) => nav.byKey(key),
      allowedType: (alias) => isAllowedContentType(settings, alias),
      access: (content) => accessTo(content.path, loadedRules, member),
    }

    /** Below a node by URL segments, exactly as stored. */
    const walk = (
      from: readonly PublishedContent[],
      segments: readonly string[],
    ): PublishedContent | undefined => {
      let level = from
      let found: PublishedContent | undefined
      for (const segment of segments) {
        found = level.find((c) => c.urlSegment === segment)
        if (!found) return undefined
        level = nav.children(found)
      }
      return found
    }

    /** `Start-Item`: a root's key, or a root's segment in any case. */
    const startItemHeader = request.headers.get('start-item')?.replace(/^\/+|\/+$/g, '')
    const startItem = startItemHeader
      ? roots.find((r) =>
          GUID.test(startItemHeader)
            ? r.key === startItemHeader.toLowerCase()
            : r.urlSegment.toLowerCase() === startItemHeader.toLowerCase(),
        )
      : undefined
    const badStartItem = Boolean(startItemHeader) && !startItem

    const byPath = (raw: string): PublishedContent | undefined => {
      const decoded = raw.includes('%2F') || raw.includes('%2f') ? decodeURIComponent(raw) : raw
      let segments = decoded.split('/').filter(Boolean)
      if (rtl) segments = [...segments].reverse()
      if (startItem)
        return segments.length === 0 ? startItem : walk(nav.children(startItem), segments)
      if (segments.length === 0) return roots[0]
      if (!hide) return walk(roots, segments)
      if (segments.length === 1) {
        const root = roots.find((r) => r.urlSegment === segments[0])
        if (root) return root
      }
      for (const root of roots) {
        const found = walk(nav.children(root), segments)
        if (found) return found
      }
      return undefined
    }

    const servable = (content: PublishedContent | undefined) =>
      content &&
      known &&
      isAllowedContentType(settings, content.contentType.alias) &&
      route(content)
        ? content
        : undefined

    const respond = async (content: PublishedContent, url: URL) => {
      const expansion = expansionOf(url)
      if (expansion instanceof Response) return expansion
      const routes = new Map<string, (c: PublishedContent) => ApiRoute | undefined>()
      for (const c of content.cultures) routes.set(c, await routeIn(c))
      return apiContentResponse(
        content,
        ctx,
        (c) => routes.get(c)?.(content),
        expansion.expand,
        expansion.include,
      )
    }

    return {
      culture,
      known,
      nav,
      roots,
      member,
      rules: [...loadedRules.values()],
      ctx,
      byPath,
      startItem,
      badStartItem,
      servable,
      respond,
    }
  }

  type ContentRequest = Awaited<ReturnType<typeof contentRequest>>

  const json = (body: unknown) => Response.json(body, { headers: { vary: CONTENT_VARY } })

  async function contentItem(r: ContentRequest, content: PublishedContent | undefined, url: URL) {
    const found = r.servable(content)
    if (!found) return bare(404)
    const access = r.ctx.access(found)
    if (access !== 'allowed') return bare(access === 'forbidden' ? 403 : 401)
    const body = await r.respond(found, url)
    if (body instanceof Response) return body
    return body ? json(body) : bare(404)
  }

  async function contentItems(r: ContentRequest, url: URL) {
    const ids = [...new Set(url.searchParams.getAll('id').map((id) => id.toLowerCase()))]
    for (const id of ids) if (!GUID.test(id)) return invalid('id', id)
    const found = ids.flatMap((id) => {
      const content = r.servable(r.nav.byKey(id))
      return content ? [content] : []
    })
    for (const content of found) {
      const access = r.ctx.access(content)
      if (access !== 'allowed') return bare(access === 'forbidden' ? 403 : 401)
    }
    const out = []
    for (const content of found) {
      const body = await r.respond(content, url)
      if (body instanceof Response) return body
      if (body) out.push(body)
    }
    return json(out)
  }

  async function contentQuery(r: ContentRequest, url: URL) {
    const selector = parseContentSelector(url.searchParams.get('fetch'))
    if (typeof selector === 'string') return problem(selector)
    const filters = parseContentFilters(url.searchParams.getAll('filter'))
    if (typeof filters === 'string') return problem(filters)
    const sorts = parseContentSorts(url.searchParams.getAll('sort'))
    if (typeof sorts === 'string') return problem(sorts)
    const skip = intParam(url, 'skip', 0)
    if (skip instanceof Response) return skip
    const take = intParam(url, 'take', 10)
    if (take instanceof Response) return take

    const all = r.known ? await cache.contentIn(r.culture) : []
    const resolveTarget = (target: string): PublishedContent | 'roots' | undefined => {
      if (!target) return undefined
      if (target === ROOT_KEY) return 'roots'
      if (GUID.test(target)) return r.nav.byKey(target)
      return r.byPath(target)
    }
    let candidates: PublishedContent[]
    if (selector.kind === 'all')
      candidates = r.startItem
        ? all.filter(
            (c) => c.id !== r.startItem?.id && c.path.split(',').includes(String(r.startItem?.id)),
          )
        : all
    else {
      const target = resolveTarget(selector.target)
      if (!target) candidates = []
      else if (selector.kind === 'children')
        candidates = target === 'roots' ? r.roots : r.nav.children(target)
      else if (target === 'roots') candidates = selector.kind === 'descendants' ? all : []
      else if (selector.kind === 'ancestors') candidates = [...r.nav.ancestors(target)].reverse()
      else
        candidates = all.filter(
          (c) => c.id !== target.id && c.path.split(',').includes(String(target.id)),
        )
    }

    // A members-only page is never listed for a caller who cannot open it,
    // whether or not member sign-in is on (Umbraco lists them when it is off).
    const visible = candidates.filter(
      (c) =>
        isAllowedContentType(settings, c.contentType.alias) &&
        r.ctx.access(c) === 'allowed' &&
        passesFilters(
          {
            contentType: c.contentType.alias,
            name: c.name,
            createDate: c.createDate,
            updateDate: c.updateDate,
          },
          filters,
        ),
    )
    const ordered =
      sorts.length > 0
        ? [...visible].sort(
            compareBy(sorts) as (a: PublishedContent, b: PublishedContent) => number,
          )
        : visible
    const items = []
    for (const content of ordered.slice(skip, skip + take)) {
      const body = await r.respond(content, url)
      if (body instanceof Response) return body
      if (body) items.push(body)
    }
    return json({ total: ordered.length, items })
  }

  /** Media's tree, by parent, and each item's path of lowercased names. */
  async function mediaTree() {
    const media = await cache.allMedia()
    const byId = new Map(media.map((m) => [m.id, m]))
    const childrenOf = new Map<number, PublishedMedia[]>()
    for (const m of media) childrenOf.set(m.parentId, [...(childrenOf.get(m.parentId) ?? []), m])
    for (const list of childrenOf.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    const pathOf = (m: PublishedMedia): string => {
      const names: string[] = []
      for (let at: PublishedMedia | undefined = m; at; at = byId.get(at.parentId))
        names.unshift(at.name.toLowerCase())
      return `/${names.join('/')}/`
    }
    const byPath = (raw: string): PublishedMedia | undefined => {
      let level = childrenOf.get(-1) ?? []
      let found: PublishedMedia | undefined
      for (const segment of decodeURIComponent(raw).split('/').filter(Boolean)) {
        found = level.find((m) => m.name.toLowerCase() === segment.toLowerCase())
        if (!found) return undefined
        level = childrenOf.get(found.id) ?? []
      }
      return found
    }
    const byKey = new Map(media.map((m) => [m.key.toLowerCase(), m]))
    return { media, childrenOf, pathOf, byPath, byKey }
  }

  async function handleMedia(request: Request, url: URL, rest: string) {
    if (!mediaAccess(settings, request)) return bare(401)
    const tree = await mediaTree()
    const answer = (m: PublishedMedia) => apiMediaResponse(m, tree.pathOf(m))
    if (rest === 'items') {
      const ids = [...new Set(url.searchParams.getAll('id').map((id) => id.toLowerCase()))]
      for (const id of ids) if (!GUID.test(id)) return invalid('id', id)
      return Response.json(
        ids.flatMap((id) =>
          tree.byKey.has(id) ? [answer(tree.byKey.get(id) as PublishedMedia)] : [],
        ),
      )
    }
    if (rest.startsWith('item/')) {
      const target = rest.slice('item/'.length)
      const found = GUID.test(target) ? tree.byKey.get(target.toLowerCase()) : tree.byPath(target)
      return found ? Response.json(answer(found)) : bare(404)
    }
    if (rest !== '') return undefined
    const query = parseMediaQuery({
      fetch: url.searchParams.get('fetch'),
      filters: url.searchParams.getAll('filter'),
      sorts: url.searchParams.getAll('sort'),
    })
    if (typeof query === 'string') return problem(query)
    const skip = intParam(url, 'skip', 0)
    if (skip instanceof Response) return skip
    const take = intParam(url, 'take', 10)
    if (take instanceof Response) return take
    let parent: PublishedMedia | 'root' | undefined
    if (query.parent === '') parent = undefined
    else if (/^\/+$/.test(query.parent)) parent = 'root'
    else if (GUID.test(query.parent)) parent = tree.byKey.get(query.parent.toLowerCase())
    else parent = tree.byPath(query.parent)
    const children = parent ? (tree.childrenOf.get(parent === 'root' ? -1 : parent.id) ?? []) : []
    const filtered = children.filter((m) =>
      query.filters.every((f) =>
        f.kind === 'mediaType'
          ? m.mediaType.alias === f.value
          : m.name.toLowerCase().includes(f.value.toLowerCase()),
      ),
    )
    const ordered = query.sort
      ? [...filtered].sort(
          compareBy([query.sort]) as unknown as (a: PublishedMedia, b: PublishedMedia) => number,
        )
      : filtered
    return Response.json({
      total: ordered.length,
      items: ordered.slice(skip, skip + take).map(answer),
    })
  }

  /**
   * `v2/search?term=&contentType=&skip=&take=`: published pages matching every
   * word, best first, as content items with `score` and an `excerpt` in HTML.
   * A members-only page is left out, and not counted, for a caller who cannot
   * open it.
   */
  async function contentSearch(r: ContentRequest, url: URL) {
    if (!ports.search) return bare(404)
    const skip = intParam(url, 'skip', 0)
    if (skip instanceof Response) return skip
    const take = intParam(url, 'take', 10)
    if (take instanceof Response) return take
    const term = url.searchParams.get('term')?.trim() ?? ''
    if (!term || !r.known) return json({ total: 0, items: [] })
    // A member who may not sign in now opens nothing a visitor could not.
    const member =
      r.member?.approved && !r.member.lockedOut
        ? { username: r.member.userName, groups: r.member.groups }
        : undefined
    const hits = await ports.search(term, {
      culture: r.culture ?? '',
      types: url.searchParams.getAll('contentType').filter(Boolean),
      skip,
      take: Math.min(take, 100),
      access: branchAccess(r.rules, member),
    })
    const items = []
    for (const hit of hits.items) {
      const content = r.servable(r.nav.byKey(hit.key))
      if (!content || r.ctx.access(content) !== 'allowed') continue
      const body = await r.respond(content, url)
      if (body instanceof Response) return body
      if (body)
        items.push({ ...body, score: hit.score, excerpt: excerptHtml(excerpt(hit.text, term)) })
    }
    return json({ total: hits.total, items })
  }

  return {
    async handle(request) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith(`${prefix}/`)) return undefined
      const rest = url.pathname.slice(prefix.length + 1)

      const security = /^v1\/security\/member\/(.+)$/.exec(rest)
      if (security) return ports.security?.(request, security[1] as string)

      if (/^v2\/search\/?$/.test(rest)) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return bare(405)
        if (!contentAccess(settings, request)) return bare(401)
        return contentSearch(await contentRequest(request), url)
      }

      const match = /^v2\/(content|media)(?:\/(.*))?$/.exec(rest)
      if (!match) return undefined
      if (request.method !== 'GET' && request.method !== 'HEAD') return bare(405)
      const area = match[1]
      const tail = (match[2] ?? '').replace(/\/$/, '')

      if (area === 'media')
        return (
          (await handleMedia(request, url, tail === '' && match[2] === undefined ? '' : tail)) ??
          bare(404)
        )

      if (!contentAccess(settings, request)) return bare(401)
      const r = await contentRequest(request)
      if (r.badStartItem) return Response.json('The Start-Item could not be found', { status: 404 })
      if (tail === '' && match[2] === undefined) return contentQuery(r, url)
      if (tail === 'items') return contentItems(r, url)
      if (match[2]?.startsWith('item')) {
        const target = (match[2] as string).replace(/^item\/?/, '')
        return contentItem(r, GUID.test(target) ? r.nav.byKey(target) : r.byPath(target), url)
      }
      return bare(404)
    },
  }
}
