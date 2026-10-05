/**
 * Server-side bundle extensions: a bundle that has to answer a request, not just
 * render a screen.
 *
 * `docs/17-bundles.md` argued that server-side extensions should not exist here,
 * and the objection was specific — loading third-party JS into a running node
 * has no isolation story, and a `role: web` node would never see a runtime
 * install. What answers it is wiring rather than sandboxing: **nothing in this
 * file is discovered**. A bundle installed from the marketplace writes
 * `package.json` and nothing more; its server half exists only because someone
 * imported the factory into `bunbraco.config.ts` and deployed that, which is a
 * reviewable diff that reaches every node. The path from "someone clicked
 * install" to "third-party code is in the request path" is not merely guarded,
 * it is absent.
 *
 * What a wired bundle then gets is deliberately small:
 *
 * - Routes mount under `<backoffice>/bunbraco/api/bundle/<id>/`. The id and every
 *   route path are validated, so a bundle can neither shadow a core route nor
 *   reach another bundle's.
 * - The host authenticates and checks the declared section **before** dispatch. A
 *   handler never sees an anonymous request, and a bundle cannot declare a public
 *   route or widen its own authorisation.
 * - It receives only the capabilities it declared, frozen. No `Db`, no config, no
 *   filesystem. A capability is a narrow interface this file owns and implements,
 *   so the blast radius is what core chose to expose rather than what the bundle
 *   can reach.
 * - A handler that throws becomes a 500 and a log line naming the bundle, never a
 *   broken request path.
 *
 * Deliberately not offered: migrations, raw SQL, and anything that writes the
 * site's files. A bundle that needs a table of its own needs a release of this
 * CMS, because a migration that arrives with a dependency is a schema no
 * `migration_history` can account for.
 */
import { hasCultureAccess, hasSection, type Principal } from '@bunbraco/api-management'
import type { AppAlias } from '@bunbraco/core'
import {
  type Db,
  type RedirectMatchKind,
  RedirectRepository,
  type RedirectRow,
  type RedirectTargetKind,
} from '@bunbraco/data'
import { normaliseRedirectPath, type PublishedCache } from '@bunbraco/render'

/** The segment every bundle's routes hang below, inside the plugin API. */
export const BUNDLE_API_SEGMENT = 'bundle'

/**
 * A bundle's id, which is also its URL segment: lowercase, no dots or slashes, so
 * it cannot climb out of its namespace however it is spelled.
 */
const BUNDLE_ID = /^[a-z][a-z0-9-]{1,38}$/

/**
 * A route path below the bundle's namespace. Literal segments, optionally one
 * `:name` parameter each, and no leading or trailing slash — so a path cannot
 * traverse, and `''` means the namespace root.
 */
const ROUTE_PATH =
  /^(?:[a-z0-9][a-z0-9-]*|:[a-z][a-z0-9]*)(?:\/(?:[a-z0-9][a-z0-9-]*|:[a-z][a-z0-9]*))*$/

export type BundleMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** What the host writes to the site's log on the bundle's behalf. */
export interface BundleLog {
  info(message: string, properties?: Record<string, unknown>): void
  warn(message: string, properties?: Record<string, unknown>): void
  error(message: string, properties?: Record<string, unknown>): void
}

/** A redirect rule as the capability reports it. */
export interface BundleRedirectRule extends RedirectRow {
  /** Whether this bundle may change or delete it: only a `manual` rule. */
  editable: boolean
}

/** A rule to store. `source` is not a field: the capability sets it to `manual`. */
export interface BundleRedirectInput {
  matchKind: RedirectMatchKind
  pattern: string
  rootKey?: string | null
  culture?: string | null
  targetKind: RedirectTargetKind
  target: string
  statusCode?: number
  sortOrder?: number
}

export type BundleRedirectSaved =
  | { ok: true; rule: BundleRedirectRule }
  | { ok: false; message: string; reason?: 'notFound' | 'notEditable' }

/**
 * Redirect rules an administrator manages.
 *
 * `list` reports every rule in force, because a screen that hid the configured
 * and tracked ones would be lying about what the site does. Writing is confined
 * to `manual`: the capability sets the source itself and refuses a key belonging
 * to any other, so a bundle cannot forge a configured rule, delete one the
 * config file owns, or interfere with the URL tracker.
 */
export interface BundleRedirects {
  list(options?: { filter?: string; skip?: number; take?: number }): Promise<{
    total: number
    items: BundleRedirectRule[]
  }>
  byKey(key: string): Promise<BundleRedirectRule | undefined>
  save(input: BundleRedirectInput): Promise<BundleRedirectSaved>
  /**
   * Changes an existing rule, pattern included. A rule is identified by what it
   * matches, so editing the pattern is a different row — the host does the
   * delete and the insert rather than leaving a bundle to discover that and
   * leave the original behind.
   */
  replace(key: string, input: BundleRedirectInput): Promise<BundleRedirectSaved>
  remove(key: string): Promise<'deleted' | 'notFound' | 'notEditable'>
}

/** Reading where a document lives now, for a screen that shows a rule's target. */
export interface BundleDocuments {
  url(key: string, culture?: string | null): Promise<string | undefined>
}

/** Everything core is willing to hand a bundle. A capability is a key of this. */
export interface BundleHost {
  redirects: BundleRedirects
  documents: BundleDocuments
  log: BundleLog
}

export type BundleCapability = keyof BundleHost

/**
 * Re-exported so a bundle needs one dependency rather than three. `principal`
 * arrives on every `BundleRequest`, and a bundle that lifts a check out into a
 * helper has to be able to name its type; `AppAlias` is what `section` takes.
 */
export type { AppAlias, Principal }

/**
 * The two checks a bundle is likely to want beyond the section the host has
 * already enforced. `hasSection` normalises the alias, which matters because
 * `allowedSections` arrives either bare or `Umb.Section.*` depending on where it
 * was read — comparing the strings by hand is the mistake this avoids.
 *
 * Anything finer — a permission verb, a start node, a per-node check — is read
 * off `principal` directly: `isAdmin`, `permissions`, `groupKeys`, `groups`,
 * `startNodes`, `languages`.
 */
export { hasCultureAccess, hasSection }

/** Every capability name, for validating what a bundle asked for. */
export const BUNDLE_CAPABILITIES: readonly BundleCapability[] = ['redirects', 'documents', 'log']

export interface BundleRequest<C extends BundleCapability = BundleCapability> {
  request: Request
  url: URL
  /** Already authenticated, and already holding the bundle's declared section. */
  principal: Principal
  /** The `:name` segments of the matched route. */
  params: Record<string, string>
  /** Only what the bundle declared, frozen. */
  host: Pick<BundleHost, C>
}

export interface ServerBundleRoute<C extends BundleCapability = BundleCapability> {
  method: BundleMethod
  /** Below the bundle's namespace; `''` is the namespace root. */
  path: string
  handler(context: BundleRequest<C>): Response | Promise<Response>
}

export interface ServerBundle<C extends BundleCapability = BundleCapability> {
  /** URL segment and log name; unique across the site's bundles. */
  id: string
  /** What the boot log and an error message call it. */
  name: string
  /**
   * The section a caller must have access to, as an application alias. Every
   * route is gated on it; there is no per-route override and no public route.
   */
  section: AppAlias
  capabilities: readonly C[]
  routes: readonly ServerBundleRoute<C>[]
}

/** A bundle as mounted, with the prefix its routes answer below. */
export interface MountedBundle {
  id: string
  name: string
  section: AppAlias
  capabilities: readonly BundleCapability[]
  /** `<backoffice>/bunbraco/api/bundle/<id>`. */
  prefix: string
  routes: readonly { method: BundleMethod; path: string }[]
}

/**
 * Every reason this set of bundles cannot be mounted. Returned rather than
 * thrown so the boot can report all of them at once; `createServerBundles`
 * turns a non-empty list into a failed boot, because a bundle that is half
 * mounted is worse than one that is absent.
 */
export function validateServerBundles(bundles: readonly ServerBundle[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const bundle of bundles) {
    const label = bundle.id || bundle.name || '<unnamed>'
    if (!BUNDLE_ID.test(bundle.id))
      problems.push(
        `Bundle "${label}" has the id "${bundle.id}", which is not 2–39 characters of lowercase letters, digits and hyphens starting with a letter.`,
      )
    else if (seen.has(bundle.id)) problems.push(`Two bundles claim the id "${bundle.id}".`)
    else seen.add(bundle.id)
    if (!bundle.name) problems.push(`Bundle "${label}" has no name.`)
    for (const capability of bundle.capabilities)
      if (!BUNDLE_CAPABILITIES.includes(capability))
        problems.push(
          `Bundle "${label}" asked for the capability "${capability}", which no host offers.`,
        )
    const routes = new Set<string>()
    for (const route of bundle.routes) {
      if (route.path !== '' && !ROUTE_PATH.test(route.path))
        problems.push(
          `Bundle "${label}" declares the route path "${route.path}", which is not a plain path of segments.`,
        )
      const signature = `${route.method} ${route.path}`
      if (routes.has(signature)) problems.push(`Bundle "${label}" declares "${signature}" twice.`)
      routes.add(signature)
    }
  }
  return problems
}

/** `rules/:key` against `rules/abc` — the params, or undefined when it does not match. */
function matchRoute(path: string, requested: string): Record<string, string> | undefined {
  if (path === '' && requested === '') return {}
  const declared = path.split('/')
  const actual = requested.split('/')
  if (declared.length !== actual.length) return undefined
  const params: Record<string, string> = {}
  for (const [index, segment] of declared.entries()) {
    const value = actual[index] as string
    if (segment.startsWith(':')) {
      if (value === '') return undefined
      params[segment.slice(1)] = decodeURIComponent(value)
    } else if (segment !== value) return undefined
  }
  return params
}

const STATUS_CODES = new Set([301, 302, 307, 308])
const MATCH_KINDS = new Set<RedirectMatchKind>(['exact', 'prefix', 'regex'])
const TARGET_KINDS = new Set<RedirectTargetKind>(['document', 'path', 'url'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ABSOLUTE_URL = /^https?:\/\/\S+$/i

/**
 * Checks a rule before it is stored, so one bad row cannot sit in the table
 * breaking route resolution for every request. A regex is compiled here rather
 * than at match time for exactly that reason: the matcher runs on the request
 * path, and a pattern that throws there would 500 the site rather than the
 * screen that saved it.
 */
export function validateRedirectInput(
  input: BundleRedirectInput,
): { ok: true; value: Required<BundleRedirectInput> } | { ok: false; message: string } {
  if (!MATCH_KINDS.has(input.matchKind))
    return { ok: false, message: 'Choose how the URL is matched.' }
  if (!TARGET_KINDS.has(input.targetKind))
    return { ok: false, message: 'Choose what the redirect points at.' }
  const statusCode = input.statusCode ?? 301
  if (!STATUS_CODES.has(statusCode))
    return { ok: false, message: 'The status code must be 301, 302, 307 or 308.' }

  const pattern = input.pattern?.trim() ?? ''
  if (pattern === '') return { ok: false, message: 'Enter the URL to redirect from.' }
  if (input.matchKind === 'regex') {
    try {
      new RegExp(pattern, 'i')
    } catch {
      return { ok: false, message: 'That is not a valid regular expression.' }
    }
  }

  const target = input.target?.trim() ?? ''
  if (target === '') return { ok: false, message: 'Enter where the redirect should go.' }
  if (input.targetKind === 'document' && !UUID.test(target))
    return { ok: false, message: 'Pick the page to redirect to.' }
  if (input.targetKind === 'url' && !ABSOLUTE_URL.test(target))
    return { ok: false, message: 'An external target must be a full http:// or https:// URL.' }

  const normalised = input.matchKind === 'regex' ? pattern : normaliseRedirectPath(pattern)
  const rootKey = input.rootKey?.trim() ? input.rootKey.trim().toLowerCase() : null
  if (rootKey !== null && !UUID.test(rootKey))
    return { ok: false, message: 'The site a rule is scoped to must be a document key.' }

  // A rule pointing a route at itself would loop the browser; the exact case is
  // cheap to catch and is what a typo produces.
  if (input.targetKind === 'path' && normaliseRedirectPath(target) === normalised)
    return { ok: false, message: 'That rule points the URL at itself.' }

  return {
    ok: true,
    value: {
      matchKind: input.matchKind,
      pattern: normalised,
      rootKey,
      culture: input.culture?.trim() ? input.culture.trim().toLowerCase() : null,
      targetKind: input.targetKind,
      target: input.targetKind === 'document' ? target.toLowerCase() : target,
      statusCode,
      sortOrder: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0,
    },
  }
}

/** The manual-redirect capability over the repository core already owns. */
export function createBundleRedirects(options: {
  db: Db
  cache?: PublishedCache
}): BundleRedirects {
  const redirects = new RedirectRepository(options.db)
  const report = (row: RedirectRow): BundleRedirectRule => ({
    ...row,
    editable: row.source === 'manual',
  })
  // Rules are part of the published cache's snapshot, so a write that does not
  // drop it does not take effect until something else does. The capability does
  // this rather than the bundle, which cannot be relied on to remember.
  const invalidate = () => options.cache?.invalidate()

  return {
    async list(paging = {}) {
      const result = await redirects.list(paging)
      return { total: result.total, items: result.items.map(report) }
    },
    async byKey(key) {
      const found = await redirects.byKey(key)
      return found ? report(found) : undefined
    },
    async save(input) {
      const checked = validateRedirectInput(input)
      if (!checked.ok) return { ok: false, message: checked.message }
      const stored = await redirects.save({ ...checked.value, source: 'manual' })
      invalidate()
      return { ok: true, rule: report(stored) }
    },
    async replace(key, input) {
      // Validated before anything is deleted, so the ordinary failure — a
      // malformed rule — cannot cost the rule being edited.
      const checked = validateRedirectInput(input)
      if (!checked.ok) return { ok: false, message: checked.message }
      const found = await redirects.byKey(key)
      if (!found)
        return { ok: false, message: 'That redirect no longer exists.', reason: 'notFound' }
      if (found.source !== 'manual')
        return {
          ok: false,
          message:
            found.source === 'config'
              ? "That redirect is declared in the site's configuration, so the file owns it."
              : 'That redirect was recorded by a rename, so it cannot be edited here.',
          reason: 'notEditable',
        }
      await redirects.delete(key)
      const stored = await redirects.save({ ...checked.value, source: 'manual' })
      invalidate()
      return { ok: true, rule: report(stored) }
    },
    async remove(key) {
      const found = await redirects.byKey(key)
      if (!found) return 'notFound'
      // The file owns a configured rule and the tracker owns a tracked one; a
      // bundle deleting either would be undone at the next boot or publish
      // anyway, so it is refused rather than silently reverted.
      if (found.source !== 'manual') return 'notEditable'
      await redirects.delete(key)
      invalidate()
      return 'deleted'
    },
  }
}

export interface ServerBundlesOptions {
  bundles: readonly ServerBundle[]
  /** `<backoffice>/bunbraco/api`, from `createBackOfficePaths`. */
  pluginApiPath: string
  host: BundleHost
  /** Named per bundle, so a log line says which one wrote it. */
  log(bundleId: string): BundleLog
}

export interface ServerBundles {
  readonly mounted: readonly MountedBundle[]
  /** The prefix every bundle route sits below, including the trailing slash. */
  readonly basePath: string
  /**
   * Answers a request in the bundle namespace. `undefined` means the path belongs
   * to no bundle, so the caller falls through to its own 404.
   */
  handle(request: Request, url: URL, principal: Principal): Promise<Response | undefined>
}

/**
 * Mounts the site's bundles, or fails the boot saying why.
 *
 * Validation is not advisory: a bundle with a bad id would otherwise answer on a
 * path nobody intended, and one asking for a capability the host does not have
 * would fail on its first request rather than at boot.
 */
export function createServerBundles(options: ServerBundlesOptions): ServerBundles {
  const problems = validateServerBundles(options.bundles)
  if (problems.length > 0)
    throw new Error(`The configured bundles cannot be mounted:\n- ${problems.join('\n- ')}`)

  const basePath = `${options.pluginApiPath}/${BUNDLE_API_SEGMENT}/`
  const byId = new Map(options.bundles.map((bundle) => [bundle.id, bundle]))
  const logs = new Map(options.bundles.map((bundle) => [bundle.id, options.log(bundle.id)]))

  const mounted: MountedBundle[] = options.bundles.map((bundle) => ({
    id: bundle.id,
    name: bundle.name,
    section: bundle.section,
    capabilities: bundle.capabilities,
    prefix: `${basePath}${bundle.id}`,
    routes: bundle.routes.map((route) => ({ method: route.method, path: route.path })),
  }))

  /** Only the declared capabilities, frozen, so a handler cannot reach further. */
  const contextFor = (bundle: ServerBundle): Pick<BundleHost, BundleCapability> => {
    const host: Record<string, unknown> = {}
    for (const capability of bundle.capabilities)
      host[capability] =
        capability === 'log' ? (logs.get(bundle.id) as BundleLog) : options.host[capability]
    return Object.freeze(host) as Pick<BundleHost, BundleCapability>
  }

  return {
    mounted,
    basePath,
    async handle(request, url, principal) {
      const pathname = url.pathname
      if (!pathname.startsWith(basePath)) return undefined
      const rest = pathname.slice(basePath.length)
      const slash = rest.indexOf('/')
      const id = slash === -1 ? rest : rest.slice(0, slash)
      const bundle = byId.get(id)
      if (!bundle) return undefined

      // Authorisation is the host's, not the bundle's: every route is gated on
      // the declared section, and a bundle has no way to opt a route out.
      if (!hasSection(principal, bundle.section)) return new Response('Forbidden', { status: 403 })

      const requested = (slash === -1 ? '' : rest.slice(slash + 1)).replace(/\/$/, '')
      const method = request.method.toUpperCase()
      let pathExists = false
      for (const route of bundle.routes) {
        const params = matchRoute(route.path, requested)
        if (!params) continue
        pathExists = true
        if (route.method !== method) continue
        try {
          return await route.handler({
            request,
            url,
            principal,
            params,
            host: contextFor(bundle),
          })
        } catch (error) {
          // A bundle's mistake is its own 500, named, rather than an unhandled
          // rejection in the request path.
          logs.get(bundle.id)?.error('The bundle {bundle} failed to answer {method} {path}', {
            bundle: bundle.name,
            method,
            path: pathname,
            error,
          })
          return new Response('Internal Server Error', { status: 500 })
        }
      }
      return new Response(pathExists ? 'Method Not Allowed' : 'Not Found', {
        status: pathExists ? 405 : 404,
      })
    },
  }
}
