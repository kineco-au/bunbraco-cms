/**
 * The published content cache.
 *
 * Published only — drafts are never cached — and rebuilt from the database on
 * invalidation. Umbraco runs three tiers here (in-process objects, a hybrid
 * memory/distributed cache, and a serialised table); a single Bun process needs
 * only the first, and the other two are pure throughput. See docs/05-rendering.md.
 *
 * Content is held once per culture: a node that varies by culture appears in
 * each culture it is published in, with that culture's name, URL and values
 * in scope; an invariant node appears in every culture. Pickers, links and
 * navigation resolve within the culture of the page that asks.
 */

import type { SchemaForm } from '@bunbraco/core'
import { PublishedMedia } from './media.ts'
import { type Navigation, PublishedContent, type PublishedProperty } from './model.ts'
import { matchRedirect, type RedirectRule } from './redirects.ts'
import { joinPath, URL_NAME_ALIAS, urlSegmentFor } from './url-segment.ts'
import { PublishedElement, type ValueContext } from './values.ts'

export interface PublishedNode {
  key: string
  id: number
  parentId: number
  level: number
  path: string
  sortOrder: number
  /** The invariant name; a culture's own name comes from `names`. */
  name: string
  contentTypeAlias: string
  templateAlias: string | null
  createDate: Date
  updateDate: Date
  /** The cultures a culture-varying node is published in; empty for an invariant node. */
  cultures: string[]
  /** Each published culture's name. */
  names?: Record<string, string>
  properties: PublishedProperty[]
}

/** A hostname (or wildcard) assigned to a document; see `DomainRepository`. */
export interface PublishedDomain {
  nodeId: number
  /** Normalised: no scheme, lowercase, no trailing slash, e.g. `example.com/en`. */
  domainName: string
  isoCode: string | null
  isWildcard: boolean
}

export interface PublishedLanguage {
  isoCode: string
  isDefault: boolean
  fallbackIsoCode: string | null
}

export interface PublishedContentSource {
  /** Every published document, in tree order. */
  loadPublished(): Promise<PublishedNode[]>
  /** Culture and hostnames, in sort order; none when omitted. */
  loadDomains?(): Promise<PublishedDomain[]>
  /** Every media item not in the recycle bin, for pickers; none when omitted. */
  loadMedia?(): Promise<PublishedMediaNode[]>
  /** The site's languages; an invariant site when omitted. */
  loadLanguages?(): Promise<PublishedLanguage[]>
  /** Dictionary translations, by item key then culture; none when omitted. */
  loadDictionary?(): Promise<Map<string, Map<string, string>>>
  /** Redirect rules, configured ones first; none when omitted. */
  loadRedirects?(): Promise<RedirectRule[]>
  /** Published library elements, for the pickers that point at them; none when omitted. */
  loadElements?(): Promise<PublishedElementNode[]>
}

/**
 * A published element: content something else points at, with no URL and no place
 * in a route. `cultures` is the set it is published in, empty for an invariant one,
 * so a culture's view holds only the elements that culture can see — which is how
 * Umbraco's own converter drops an element unpublished in the ambient culture.
 */
export interface PublishedElementNode {
  key: string
  contentTypeKey: string
  contentTypeAlias: string
  cultures: string[]
  properties: PublishedProperty[]
}

export interface PublishedMediaNode {
  key: string
  id: number
  name: string
  mediaTypeAlias: string
  properties: PublishedProperty[]
}

/** The published tree in one culture. */
export interface CultureView {
  culture: string | null
  byId: Map<number, PublishedContent>
  byKey: Map<string, PublishedContent>
  /** Published elements this culture can see, by lowercase key. */
  elements: Map<string, PublishedElement>
  childrenOf: Map<number, PublishedContent[]>
  roots: PublishedContent[]
  parentIdOf: Map<number, number>
}

export interface CacheSnapshot {
  /** Keyed by lowercase culture; `''` holds an invariant site's single view. */
  views: Map<string, CultureView>
  defaultCulture: string | null
  /** Routes without a hostname, in the default culture. */
  byRoute: Map<string, PublishedContent>
  /** `<domain name>:<route below it>`, for requests that match a hostname. */
  byDomainRoute: Map<string, PublishedContent>
  domains: PublishedDomain[]
  /** The key of the document each hostname roots, by its node id. */
  domainRoots: Map<number, string>
  /** `<culture>|<node id>` → the route the resolver reaches that content by. */
  routeKeys: Map<string, RouteKey>
  /** Configured rules first, in their declared order, then the tracked ones. */
  redirects: RedirectRule[]
  languages: PublishedLanguage[]
  media: Map<string, PublishedMedia>
  /** Item key (lowercase) → culture (lowercase) → translation. */
  dictionary: Map<string, Map<string, string>>
}

/** What a request resolved to: the content, and the culture its hostname assigns. */
export interface ResolvedRequest {
  content: PublishedContent
  culture: string | null
}

/**
 * How the resolver identifies a route: the path, and — when a hostname roots it —
 * the document that hostname sits on, so the identity survives a hostname change.
 */
export interface RouteKey {
  rootKey: string | null
  path: string
}

/** One route a document answers on, in one culture. */
export interface DocumentRoute extends RouteKey {
  key: string
  culture: string | null
}

/** Where a matched redirect sends the visitor. */
export interface RedirectHit {
  location: string
  statusCode: number
}

const EMPTY: CacheSnapshot = {
  views: new Map(),
  defaultCulture: null,
  byRoute: new Map(),
  byDomainRoute: new Map(),
  domains: [],
  domainRoots: new Map(),
  routeKeys: new Map(),
  redirects: [],
  languages: [],
  media: new Map(),
  dictionary: new Map(),
}

const normaliseRoute = (route: string) =>
  (route === '' ? '/' : route.replace(/\/+$/, '') || '/').toLowerCase()
const viewKey = (culture: string | null) => (culture ?? '').toLowerCase()
const routeKeyId = (culture: string | null, id: number) => `${viewKey(culture)}|${id}`

/** The fallback languages of `culture`, nearest first, stopping at a cycle. */
export function fallbackChain(
  languages: readonly PublishedLanguage[],
  culture: string | null,
): string[] {
  const chain: string[] = []
  let current = languages.find((l) => l.isoCode.toLowerCase() === viewKey(culture))
  while (current?.fallbackIsoCode) {
    const next = current.fallbackIsoCode
    if (
      chain.some((c) => c.toLowerCase() === next.toLowerCase()) ||
      next.toLowerCase() === viewKey(culture)
    )
      break
    chain.push(next)
    current = languages.find((l) => l.isoCode.toLowerCase() === next.toLowerCase())
  }
  return chain
}

/** What the cache needs besides content, for values that resolve outside it. */
export interface PublishedCacheOptions {
  /**
   * A form definition by key, for a `formPicker` property.
   *
   * A function rather than a map: form definitions are files, so they can change
   * without a publish invalidating this cache, and the lookup has to be able to
   * see that.
   */
  form?: (key: string) => SchemaForm | undefined
}

export class PublishedCache {
  #source: PublishedContentSource
  #snapshot: CacheSnapshot = EMPTY
  #loaded = false
  #options: PublishedCacheOptions

  constructor(source: PublishedContentSource, options: PublishedCacheOptions = {}) {
    this.#source = source
    this.#options = options
  }

  /** Dropped on publish or unpublish; the next read rebuilds it. */
  invalidate(): void {
    this.#loaded = false
  }

  async snapshot(): Promise<CacheSnapshot> {
    if (!this.#loaded) {
      this.#snapshot = await this.#build()
      this.#loaded = true
    }
    return this.#snapshot
  }

  #view(snapshot: CacheSnapshot, culture: string | null | undefined): CultureView | undefined {
    return (
      snapshot.views.get(viewKey(culture ?? snapshot.defaultCulture)) ??
      snapshot.views.get(viewKey(snapshot.defaultCulture))
    )
  }

  async byRoute(route: string): Promise<PublishedContent | undefined> {
    const snapshot = await this.snapshot()
    return snapshot.byRoute.get(normaliseRoute(route))
  }

  /**
   * Resolves a request as Umbraco does: the longest hostname (with its optional
   * path prefix) that matches roots the route at that domain's document, in its
   * culture; with no match, the route resolves without domains, in the default
   * culture or the one a wildcard domain assigns.
   */
  /** The longest hostname (with its optional path prefix) that matches the request. */
  #domainFor(
    snapshot: CacheSnapshot,
    host: string,
    route: string,
  ): { domain: PublishedDomain; rest: string } | undefined {
    const hostName = host.toLowerCase()
    const bare = hostName.replace(/:\d+$/, '')
    let best: { domain: PublishedDomain; rest: string; prefixLength: number } | undefined
    for (const domain of snapshot.domains) {
      if (domain.isWildcard) continue
      const slash = domain.domainName.indexOf('/')
      const domainHost = slash < 0 ? domain.domainName : domain.domainName.slice(0, slash)
      const prefix = slash < 0 ? '' : domain.domainName.slice(slash)
      if (domainHost !== hostName && domainHost !== bare) continue
      if (prefix && route !== prefix && !route.startsWith(`${prefix}/`)) continue
      if (best && best.prefixLength >= prefix.length) continue
      best = { domain, rest: route.slice(prefix.length) || '/', prefixLength: prefix.length }
    }
    return best
  }

  async resolve(host: string, pathname: string): Promise<ResolvedRequest | undefined> {
    const snapshot = await this.snapshot()
    const route = normaliseRoute(pathname)
    const best = this.#domainFor(snapshot, host, route)
    if (best) {
      const content = snapshot.byDomainRoute.get(`${best.domain.domainName}:${best.rest}`)
      return content ? { content, culture: best.domain.isoCode ?? content.culture } : undefined
    }
    const content = snapshot.byRoute.get(route)
    if (!content) return undefined
    const wildcard = this.#wildcardCulture(snapshot, content)
    if (wildcard) {
      const localised = snapshot.views.get(viewKey(wildcard))?.byId.get(content.id)
      if (localised) return { content: localised, culture: wildcard }
    }
    return { content, culture: content.culture }
  }

  /**
   * The redirect a request matches, once route resolution has found no page.
   *
   * Configured rules are tried before tracked ones, and a rule a hostname scopes
   * only against a request that hostname roots. A rule naming a document resolves
   * through the cache, so it follows the page when it is renamed; one naming a
   * document that is gone or unpublished does not match at all, which leaves the
   * 404 rather than sending the visitor nowhere.
   */
  async redirect(host: string, pathname: string): Promise<RedirectHit | undefined> {
    const snapshot = await this.snapshot()
    if (snapshot.redirects.length === 0) return undefined
    const route = normaliseRoute(pathname)
    const domain = this.#domainFor(snapshot, host, route)
    const rootKey = domain ? (snapshot.domainRoots.get(domain.domain.nodeId) ?? null) : null
    const culture = domain?.domain.isoCode ?? snapshot.defaultCulture
    for (const rule of snapshot.redirects) {
      if (rule.rootKey !== null && rule.rootKey !== rootKey) continue
      if (rule.culture !== null && viewKey(rule.culture) !== viewKey(culture)) continue
      const scoped = rule.rootKey !== null && domain ? domain.rest : route
      const target = matchRedirect(rule, scoped)
      if (target === undefined) continue
      if (rule.targetKind !== 'document') return { location: target, statusCode: rule.statusCode }
      const content = this.#view(snapshot, culture)?.byKey.get(target.toLowerCase())
      if (!content || content.url === '#') continue
      return { location: content.url, statusCode: rule.statusCode }
    }
    return undefined
  }

  /**
   * Every route the document answers on, per culture, and optionally those of its
   * published descendants — what the redirect tracker compares before and after a
   * publish or a move.
   */
  async routes(key: string, includeDescendants = false): Promise<DocumentRoute[]> {
    const snapshot = await this.snapshot()
    const out: DocumentRoute[] = []
    for (const view of snapshot.views.values()) {
      const content = view.byKey.get(key.toLowerCase())
      if (!content) continue
      const branch = includeDescendants ? [content, ...descendantsOf(view, content)] : [content]
      for (const node of branch) {
        // A culture with no reachable URL has no route to redirect — Umbraco's
        // `IsValidRoute` guard, which keeps dead rules out of the table.
        if (node.url === '#') continue
        const route = snapshot.routeKeys.get(routeKeyId(view.culture, node.id))
        if (route) out.push({ key: node.key, culture: view.culture, ...route })
      }
    }
    return out
  }

  /** The published children of a document, or of the tree root; keys, once each. */
  async childKeys(parentKey: string | null): Promise<string[]> {
    const snapshot = await this.snapshot()
    const keys = new Set<string>()
    for (const view of snapshot.views.values()) {
      if (parentKey === null) {
        for (const root of view.roots) keys.add(root.key)
        continue
      }
      const parent = view.byKey.get(parentKey.toLowerCase())
      if (!parent) continue
      for (const child of view.childrenOf.get(parent.id) ?? []) keys.add(child.key)
    }
    return [...keys]
  }

  /** The culture the nearest wildcard domain above the content assigns. */
  #wildcardCulture(snapshot: CacheSnapshot, content: PublishedContent): string | null {
    const ids = content.path.split(',').map(Number).reverse()
    for (const id of ids) {
      const wildcard = snapshot.domains.find((d) => d.nodeId === id && d.isWildcard)
      if (wildcard?.isoCode) return wildcard.isoCode
    }
    return null
  }

  /** The value context of a culture's view, for a model built outside it (preview). */
  async valueContext(culture?: string | null): Promise<ValueContext<PublishedContent>> {
    const snapshot = await this.snapshot()
    const view = this.#view(snapshot, culture)
    return {
      content: (key) => view?.byKey.get(key.toLowerCase()),
      media: (key) => snapshot.media.get(key.toLowerCase()),
      form: this.#options.form,
      urlOf: (content) => content.url,
      mediaUrlOf: (item) => (item as PublishedMedia).url,
    }
  }

  /** The content in `culture`, or in the default culture. */
  async byKey(key: string, culture?: string | null): Promise<PublishedContent | undefined> {
    const snapshot = await this.snapshot()
    return this.#view(snapshot, culture)?.byKey.get(key.toLowerCase())
  }

  /**
   * The content's URL in each culture it is published in; one invariant entry
   * for invariant content on a site without cultures in play.
   */
  async urls(key: string): Promise<Array<{ culture: string | null; url: string }>> {
    const snapshot = await this.snapshot()
    const out: Array<{ culture: string | null; url: string }> = []
    let invariant: PublishedContent | undefined
    for (const view of snapshot.views.values()) {
      const content = view.byKey.get(key.toLowerCase())
      if (!content) continue
      if (content.cultures.length === 0) invariant ??= content
      else out.push({ culture: view.culture, url: content.url })
    }
    if (out.length === 0 && invariant) return [{ culture: null, url: invariant.url }]
    return out
  }

  /** A dictionary item's translation in `culture`, then its fallback languages; '' when none. */
  async dictionary(key: string, culture: string | null): Promise<string> {
    const snapshot = await this.snapshot()
    return translate(snapshot, key, culture)
  }

  async navigation(culture?: string | null): Promise<Navigation> {
    const snapshot = await this.snapshot()
    const view = this.#view(snapshot, culture)
    const byId = view?.byId ?? new Map<number, PublishedContent>()
    const parentIdOf = view?.parentIdOf ?? new Map<number, number>()
    return {
      parent: (content) => {
        const parentId = parentIdOf.get(content.id)
        return parentId === undefined ? undefined : byId.get(parentId)
      },
      children: (content) => view?.childrenOf.get(content.id) ?? [],
      ancestors: (content) => {
        const found: PublishedContent[] = []
        let current = content
        for (;;) {
          const parentId = parentIdOf.get(current.id)
          const parent = parentId === undefined ? undefined : byId.get(parentId)
          if (!parent) break
          found.push(parent)
          current = parent
        }
        return found
      },
      root: () => view?.roots ?? [],
    }
  }

  async #build(): Promise<CacheSnapshot> {
    const nodes = await this.#source.loadPublished()
    const domains = (await this.#source.loadDomains?.()) ?? []
    const languages = (await this.#source.loadLanguages?.()) ?? []
    const dictionary = new Map<string, Map<string, string>>()
    for (const [key, translations] of (await this.#source.loadDictionary?.()) ?? new Map())
      dictionary.set(
        key.toLowerCase(),
        new Map([...translations].map(([culture, text]) => [culture.toLowerCase(), text])),
      )
    const media = new Map(
      ((await this.#source.loadMedia?.()) ?? []).map((m) => [
        m.key.toLowerCase(),
        new PublishedMedia(m),
      ]),
    )
    const redirects = (await this.#source.loadRedirects?.()) ?? []
    const elementNodes = (await this.#source.loadElements?.()) ?? []
    const defaultCulture =
      languages.find((l) => l.isDefault)?.isoCode ?? languages[0]?.isoCode ?? null
    const cultures: Array<string | null> =
      languages.length > 0 ? languages.map((l) => l.isoCode) : [null]

    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const domainsOf = new Map<number, PublishedDomain[]>()
    for (const domain of domains)
      if (!domain.isWildcard)
        domainsOf.set(domain.nodeId, [...(domainsOf.get(domain.nodeId) ?? []), domain])

    /** The hostname that roots a node in a culture: one of that culture, else one of none. */
    const domainFor = (nodeId: number, culture: string | null) => {
      const own = domainsOf.get(nodeId) ?? []
      return (
        own.find((d) => viewKey(d.isoCode) === viewKey(culture) && d.isoCode !== null) ??
        own.find((d) => d.isoCode === null) ??
        (viewKey(culture) === viewKey(defaultCulture) ? own[0] : undefined)
      )
    }

    const firstRootId = nodes
      .filter((node) => node.parentId <= 0)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0]?.id

    const byRoute = new Map<string, PublishedContent>()
    const byDomainRoute = new Map<string, PublishedContent>()
    const views = new Map<string, CultureView>()
    const routeKeys = new Map<string, RouteKey>()
    const domainRoots = new Map<number, string>()
    for (const nodeId of domainsOf.keys()) {
      const key = nodeById.get(nodeId)?.key
      if (key) domainRoots.set(nodeId, key.toLowerCase())
    }

    for (const culture of cultures) {
      const inCulture = (node: PublishedNode) =>
        node.cultures.length === 0 || node.cultures.some((c) => viewKey(c) === viewKey(culture))
      const nameIn = (node: PublishedNode) => {
        if (node.cultures.length === 0) return node.name
        const found = Object.entries(node.names ?? {}).find(
          ([c]) => viewKey(c) === viewKey(culture),
        )
        return found?.[1] ?? node.name
      }
      const segmentOf = new Map<number, string>()
      for (const node of nodes) {
        if (!inCulture(node)) continue
        const override =
          node.properties.find(
            (p) =>
              p.alias === URL_NAME_ALIAS && viewKey(p.culture) === viewKey(culture) && p.culture,
          ) ?? node.properties.find((p) => p.alias === URL_NAME_ALIAS && p.culture === null)
        segmentOf.set(
          node.id,
          urlSegmentFor(nameIn(node), typeof override?.value === 'string' ? override.value : null),
        )
      }

      /**
       * Umbraco's default (`HideTopLevelNodeFromPath`): a top-level node's segment
       * is left out of every URL below it, the first top-level node is `/`, and any
       * other is `/<segment>`. A route only exists if every ancestor is also
       * published in the culture — an unpublished ancestor breaks the route rather
       * than leaving a reachable orphan.
       */
      const routeOf = (node: PublishedNode): string | undefined => {
        if (node.parentId <= 0)
          return node.id === firstRootId ? '/' : joinPath([segmentOf.get(node.id) as string])
        const segments: string[] = []
        let current: PublishedNode = node
        for (;;) {
          const parent = nodeById.get(current.parentId)
          if (!parent || !segmentOf.has(parent.id)) return undefined
          segments.unshift(segmentOf.get(current.id) as string)
          if (parent.parentId <= 0) break
          current = parent
        }
        return joinPath(segments)
      }

      /** The route below the nearest document with a hostname for this culture, if there is one. */
      const domainRouteOf = (
        node: PublishedNode,
      ): { domain: PublishedDomain; route: string } | undefined => {
        const segments: string[] = []
        let current: PublishedNode | undefined = node
        while (current && segmentOf.has(current.id)) {
          const domain = domainFor(current.id, culture)
          if (domain) return { domain, route: joinPath(segments) }
          segments.unshift(segmentOf.get(current.id) as string)
          current = nodeById.get(current.parentId)
        }
        return undefined
      }

      const view: CultureView = {
        culture,
        byId: new Map(),
        byKey: new Map(),
        elements: new Map(),
        childrenOf: new Map(),
        roots: [],
        parentIdOf: new Map(),
      }
      const isDefault = viewKey(culture) === viewKey(defaultCulture)
      // Shallow and first-sorted nodes claim a route before any that collide with it.
      const ordered = [...nodes]
        .filter(inCulture)
        .sort((a, b) => a.level - b.level || a.sortOrder - b.sortOrder)
      for (const node of ordered) {
        const route = routeOf(node)
        if (route === undefined) continue
        const domainRoute = domainRouteOf(node)
        const variant = node.cultures.length > 0
        const url = domainRoute
          ? `//${domainRoute.domain.domainName}${domainRoute.route === '/' ? '/' : domainRoute.route}`
          : isDefault || !variant
            ? route
            : '#'
        const content = new PublishedContent({
          key: node.key,
          id: node.id,
          name: nameIn(node),
          contentTypeAlias: node.contentTypeAlias,
          urlSegment: segmentOf.get(node.id) as string,
          url,
          level: node.level,
          path: node.path,
          sortOrder: node.sortOrder,
          createDate: node.createDate,
          updateDate: node.updateDate,
          templateAlias: node.templateAlias,
          cultures: node.cultures,
          properties: node.properties,
          variationCulture: variant ? culture : null,
          languageFallback: fallbackChain(languages, culture),
        })
        view.byId.set(node.id, content)
        view.byKey.set(node.key.toLowerCase(), content)
        routeKeys.set(
          routeKeyId(culture, node.id),
          domainRoute
            ? {
                rootKey: domainRoots.get(domainRoute.domain.nodeId) ?? null,
                path: normaliseRoute(domainRoute.route),
              }
            : { rootKey: null, path: normaliseRoute(route) },
        )
        if (isDefault && !byRoute.has(route.toLowerCase()))
          byRoute.set(route.toLowerCase(), content)
        // Every hostname on the rooting document serves its own culture's view;
        // one with no culture serves the default's
        if (domainRoute)
          for (const domain of domainsOf.get(domainRoute.domain.nodeId) ?? []) {
            const serves =
              domain.isoCode === null ? isDefault : viewKey(domain.isoCode) === viewKey(culture)
            const key = `${domain.domainName}:${domainRoute.route.toLowerCase()}`
            if (serves && !byDomainRoute.has(key)) byDomainRoute.set(key, content)
          }
        if (nodeById.has(node.parentId) && segmentOf.has(node.parentId)) {
          view.parentIdOf.set(node.id, node.parentId)
          const siblings = view.childrenOf.get(node.parentId) ?? []
          siblings.push(content)
          view.childrenOf.set(node.parentId, siblings)
        } else {
          view.roots.push(content)
        }
      }
      for (const siblings of view.childrenOf.values())
        siblings.sort((a, b) => a.sortOrder - b.sortOrder)
      view.roots.sort((a, b) => a.sortOrder - b.sortOrder)

      // Pickers and links resolve against this culture's view.
      const context: ValueContext<PublishedContent, PublishedMedia> = {
        content: (key) => view.byKey.get(key.toLowerCase()),
        media: (key) => media.get(key.toLowerCase()),
        // Read lazily: the map is filled just below, with this very context, so an
        // element picking another element resolves too.
        element: (key) => view.elements.get(key.toLowerCase()),
        form: this.#options.form,
        urlOf: (content) => content.url,
        mediaUrlOf: (item) => item.url,
      }
      // An invariant element is visible in every culture; a varying one only in the
      // cultures it is published in. Built with this culture's context, so a
      // property inside an element resolves pickers within the same culture.
      for (const node of elementNodes) {
        if (node.cultures.length > 0 && !node.cultures.some((c) => viewKey(c) === viewKey(culture)))
          continue
        view.elements.set(
          node.key.toLowerCase(),
          new PublishedElement(
            {
              key: node.key,
              contentTypeKey: node.contentTypeKey,
              contentTypeAlias: node.contentTypeAlias,
              properties: node.properties,
            },
            context,
          ),
        )
      }

      for (const content of view.byId.values()) {
        content.withValueContext(context)
        // Ancestors are wired after every node exists, for the `ancestors` fallback.
        const ancestors: PublishedContent[] = []
        let currentId = view.parentIdOf.get(content.id)
        while (currentId !== undefined) {
          const parent = view.byId.get(currentId)
          if (!parent) break
          ancestors.push(parent)
          currentId = view.parentIdOf.get(parent.id)
        }
        content.withAncestors(ancestors)
      }
      views.set(viewKey(culture), view)
    }

    return {
      views,
      defaultCulture,
      byRoute,
      byDomainRoute,
      domains,
      domainRoots,
      routeKeys,
      redirects,
      languages,
      media,
      dictionary,
    }
  }
}

/** The content below `content` in one culture's view, breadth first. */
function descendantsOf(view: CultureView, content: PublishedContent): PublishedContent[] {
  const out: PublishedContent[] = []
  const queue = [content]
  while (queue.length > 0) {
    const next = queue.shift() as PublishedContent
    for (const child of view.childrenOf.get(next.id) ?? []) {
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

/** A dictionary item's translation in `culture`, then its fallback languages; '' when none. */
export function translate(snapshot: CacheSnapshot, key: string, culture: string | null): string {
  const item = snapshot.dictionary.get(key.toLowerCase())
  if (!item) return ''
  const wanted = culture ?? snapshot.defaultCulture
  for (const c of [wanted, ...fallbackChain(snapshot.languages, wanted)]) {
    const text = c ? item.get(c.toLowerCase()) : undefined
    if (text) return text
  }
  return ''
}

/** A model for one node outside the cache, such as a draft in preview. */
export function contentForNode(
  node: PublishedNode,
  url: string,
  culture: string | null = null,
  languages: readonly PublishedLanguage[] = [],
): PublishedContent {
  const variant = node.cultures.length > 0
  const scoped = variant ? (culture ?? node.cultures[0] ?? null) : null
  const name =
    (scoped &&
      Object.entries(node.names ?? {}).find(([c]) => viewKey(c) === viewKey(scoped))?.[1]) ||
    node.name
  const override =
    node.properties.find(
      (p) => p.alias === URL_NAME_ALIAS && p.culture && viewKey(p.culture) === viewKey(scoped),
    ) ??
    node.properties.find(
      (property) => property.alias === URL_NAME_ALIAS && property.culture === null,
    )
  return new PublishedContent({
    key: node.key,
    id: node.id,
    name,
    contentTypeAlias: node.contentTypeAlias,
    urlSegment: urlSegmentFor(name, typeof override?.value === 'string' ? override.value : null),
    url,
    level: node.level,
    path: node.path,
    sortOrder: node.sortOrder,
    createDate: node.createDate,
    updateDate: node.updateDate,
    templateAlias: node.templateAlias,
    cultures: node.cultures,
    properties: node.properties,
    variationCulture: scoped,
    languageFallback: fallbackChain(languages, scoped),
  })
}
