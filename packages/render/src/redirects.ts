/**
 * Redirect rules and matching a request against them.
 *
 * One shape carries both kinds: the rules a rename or a move records by itself,
 * which always name a document, and the rules a site declares in its config,
 * which may also name a path or an external URL. Umbraco has no configured
 * redirects — its answer is a rewrite rule in front of the site — so that half
 * of the vocabulary is ours.
 */

/** How a rule's `pattern` is matched against a route. */
export type RedirectMatchKind = 'exact' | 'prefix' | 'regex'

/** What the rule's `target` names. */
export type RedirectTargetKind = 'document' | 'path' | 'url'

export interface RedirectRule {
  /** Identity in the Management API and the database; absent until stored. */
  key?: string
  matchKind: RedirectMatchKind
  /** The whole route, the subtree above it, or a regular expression's source. */
  pattern: string
  /**
   * Set only on a rule a hostname scopes: the key of the document that hostname
   * roots, so the rule survives the hostname being changed, and `pattern` is the
   * route below that document. A configured rule leaves this null and matches
   * the path of any request.
   */
  rootKey: string | null
  culture: string | null
  targetKind: RedirectTargetKind
  /** A document key, or a path or URL in which `$1`…`$9` stand for the captures. */
  target: string
  statusCode: number
  /** Configured rules are matched in this order, before any tracked rule. */
  sortOrder: number
  /** Configured in code, written by an administrator, or recorded by a rename. */
  source: 'tracked' | 'config' | 'manual'
}

/** Where a configured redirect sends the visitor. */
export type RedirectTo = string | { document: string }

export interface RedirectOptions {
  /** 301 by default, as a retired URL is normally gone for good. */
  status?: 301 | 302 | 307 | 308
  /** Restrict the rule to requests resolving in one culture. */
  culture?: string
}

const ABSOLUTE = /^(https?:)?\/\//i

/** Trailing slashes carry no meaning in a route, and matching is case-insensitive. */
export function normaliseRedirectPath(path: string): string {
  const trimmed = path.trim()
  const withSlash = trimmed.startsWith('/') || ABSOLUTE.test(trimmed) ? trimmed : `/${trimmed}`
  return (withSlash.replace(/\/+$/, '') || '/').toLowerCase()
}

/**
 * A redirect for `bunbraco.config.ts`.
 *
 * `from` is a route, a route ending in `/*` to match everything below it, or a
 * regular expression. `to` is a route, an absolute URL, or `{ document }` — a
 * document key, which is resolved when the request arrives and so follows the
 * page when it is later renamed or moved.
 */
export function redirect(
  from: string | RegExp,
  to: RedirectTo,
  options: RedirectOptions = {},
): RedirectRule {
  const match =
    from instanceof RegExp
      ? { matchKind: 'regex' as const, pattern: from.source }
      : from.endsWith('/*')
        ? { matchKind: 'prefix' as const, pattern: normaliseRedirectPath(from.slice(0, -2)) }
        : { matchKind: 'exact' as const, pattern: normaliseRedirectPath(from) }
  const target =
    typeof to === 'string'
      ? ABSOLUTE.test(to.trim())
        ? { targetKind: 'url' as const, target: to.trim() }
        : { targetKind: 'path' as const, target: to.trim() }
      : { targetKind: 'document' as const, target: to.document.toLowerCase() }
  return {
    ...match,
    ...target,
    rootKey: null,
    culture: options.culture ?? null,
    statusCode: options.status ?? 301,
    sortOrder: 0,
    source: 'config',
  }
}

/** `$1`…`$9` from the captures, and `$$` for a literal dollar. */
function substitute(template: string, captures: readonly string[]): string {
  return template.replace(/\$(\$|[1-9])/g, (_, token: string) =>
    token === '$' ? '$' : (captures[Number(token) - 1] ?? ''),
  )
}

/**
 * The rule's target with its captures filled in, or undefined when the route
 * does not match. A prefix rule offers the tail below the prefix as `$1`.
 */
export function matchRedirect(rule: RedirectRule, route: string): string | undefined {
  switch (rule.matchKind) {
    case 'exact':
      return route === rule.pattern ? rule.target : undefined
    case 'prefix': {
      // `/*` is the whole site — the rule for moving one somewhere else — and its
      // prefix normalises to `/`, which would otherwise only match the home page.
      if (rule.pattern === '/') return substitute(rule.target, [route.replace(/^\//, '')])
      if (route !== rule.pattern && !route.startsWith(`${rule.pattern}/`)) return undefined
      const tail = route.slice(rule.pattern.length).replace(/^\//, '')
      return substitute(rule.target, [tail])
    }
    case 'regex': {
      // The route reaching here is already lowercased, so a pattern written with
      // capitals would never match without this flag.
      const found = new RegExp(rule.pattern, 'i').exec(route)
      return found
        ? substitute(
            rule.target,
            found.slice(1).map((c) => c ?? ''),
          )
        : undefined
    }
  }
}
