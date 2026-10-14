/**
 * Front-end rendering: resolve a URL to published content, find its template, and
 * execute it.
 *
 * A template is a .tsx module whose default export is a function of PageProps.
 * `export const layout = 'alias'` names the layout template, which is how Umbraco
 * declares it too — in the file, not the database.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FormSubmissionState } from '@crombolo/core'
import { renderScope } from './context.ts'
import { RawHtml } from './html.ts'
import { type Child, renderToString } from './jsx-runtime.ts'
import type { PageProps, PublishedContent, RequestMember } from './model.ts'
import { type PublishedCache, translate, urlsIn } from './published-cache.ts'
import { absoluteUrl, type SeoSiteDefaults } from './seo.ts'
import type { ViewSnapshots } from './snapshots.ts'

export interface ComponentModule {
  default: (props: PageProps) => Child | Promise<Child>
  /** Alias of the layout template to wrap this one in. */
  layout?: string
}

// biome-ignore lint/suspicious/noExplicitAny: an untyped page, as `PageProps` defaults to.
export interface LayoutProps<Properties = any> extends PageProps<Properties> {
  children: RawHtml
}

export interface RenderOptions {
  cache: PublishedCache
  componentsDir: string
  /**
   * Content-addressed copies of `componentsDir` to import from.
   *
   * Without one the renderer imports straight from `componentsDir`, which is what a
   * unit test wants and means an edited view is not picked up until the process
   * restarts — see `snapshots.ts` for why.
   */
  snapshots?: ViewSnapshots
  /** How long a page may take to render, layouts included; 0 for no limit. */
  renderTimeoutMs?: number
}

export const DEFAULT_RENDER_TIMEOUT_MS = 10_000

export type RenderResult =
  | { status: 'ok'; html: string; content: PublishedContent }
  | { status: 'notFound' }
  /** The page names another to send its visitors to (`umbracoRedirect`). */
  | { status: 'redirect'; location: string; content: PublishedContent }
  | { status: 'noTemplate'; content: PublishedContent }
  | { status: 'error'; error: Error; content: PublishedContent }

const MAX_LAYOUT_DEPTH = 10

/**
 * A whole document gets `<!DOCTYPE html>`, which JSX has no way to write and
 * without which a browser renders in quirks mode. A page that writes its own,
 * or renders something other than a document, is left as it is.
 */
export function withDoctype(html: string): string {
  return /^\s*<html[\s>]/i.test(html) ? `<!DOCTYPE html>${html}` : html
}
/** Umbraco's own guard against a login page that is itself protected. */
const MAX_ACCESS_SUBSTITUTIONS = 8

/**
 * What a public-access check decides for a page: render it, or render another
 * one in its place — the login page for a visitor who is not signed in, the
 * error page for a member who may not see it. Umbraco rewrites rather than
 * redirects, so the URL the visitor asked for is the URL they keep.
 */
export type AccessDecision = { status: 'allowed' } | { status: 'substitute'; contentKey: string }

/** Per-request context: who is asking, and what they are allowed to see. */
export interface RenderRequest {
  member?: RequestMember
  access?: (content: PublishedContent) => Promise<AccessDecision>
  /**
   * A form submission the server has just handled, for this request's page.
   *
   * The endpoint redirects back here rather than answering with markup of its
   * own, so the form reappears with its errors — or its thank-you — inside the
   * layout it was rendered in.
   */
  submission?: FormSubmissionState
  /** Scheme and host the visitor used, for absolute addresses; `http://localhost` when absent. */
  origin?: string
  /** The address requested, as the visitor sent it. */
  url?: string
  /** Site-wide search and sharing values. */
  seo?: SeoSiteDefaults
  /** Aborts when nobody is waiting for the page any more: the visitor disconnected. */
  signal?: AbortSignal
}

/**
 * Whether an alias is a path that stays inside the components tree.
 *
 * `@crombolo/server` has the same rule as `isSafeAlias`; it is written again
 * here because render does not depend on server, and the two are checked
 * against each other in the suite.
 */
function isSafeComponentAlias(alias: string): boolean {
  if (alias.length === 0 || alias.startsWith('/') || alias.includes('\\')) return false
  if (/^[a-zA-Z]:/.test(alias)) return false
  return alias.split('/').every((part) => /^[A-Za-z0-9_-]+$/.test(part))
}

export class Renderer {
  #cache: PublishedCache
  #componentsDir: string
  #snapshots: ViewSnapshots | undefined
  /** Keyed by the generation that holds the view, so one swap retires them all. */
  #modules = new Map<string, ComponentModule>()
  #importedFrom: string | undefined
  #renderTimeoutMs: number

  constructor(options: RenderOptions) {
    this.#cache = options.cache
    // Resolved to an absolute path: a dynamic import of a relative specifier
    // resolves against this module, not the working directory.
    this.#componentsDir = resolve(options.componentsDir)
    this.#snapshots = options.snapshots
    this.#renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
  }

  /**
   * Drops this renderer's own map of views.
   *
   * On its own this changes nothing about what renders: the module registry
   * behind `import()` belongs to the runtime, so re-importing one path hands
   * back the same module whatever this map holds. What makes an edited view be
   * read is a snapshot at a new path.
   */
  invalidate(): void {
    this.#modules.clear()
  }

  /**
   * Where views are imported from now: a snapshot when there is one.
   *
   * A generation change clears this renderer's map. The runtime's registry keeps
   * the old modules either way, but holding our own references to generations
   * nobody renders would grow without limit.
   */
  #importDir(): string {
    const dir = this.#snapshots?.directory() ?? this.#componentsDir
    if (dir !== this.#importedFrom) {
      this.#modules.clear()
      this.#importedFrom = dir
    }
    return dir
  }

  /**
   * The file a view is imported from, inside the current generation.
   *
   * Not the file anybody edits — that is `sourceFor`, and the two differ by the
   * generation in between.
   */
  componentPath(alias: string): string | undefined {
    // An alias is a path under `components/`, so it may carry folders — but it
    // reaches here from the database, and a path from the database is a path
    // from a request. Each segment is checked rather than the whole string, so
    // `..`, an absolute path and a drive letter are all refused while
    // `pages/homePage` resolves.
    if (!isSafeComponentAlias(alias)) return undefined
    const file = join(this.#importDir(), `${alias}.tsx`)
    return existsSync(file) ? file : undefined
  }

  /**
   * Rewrites snapshot paths back to `componentsDir`, for anything a person reads: an
   * error, a log line, a stack trace. A snapshot names a directory nobody edits
   * and a generation they cannot act on, so naming it would send them to the
   * wrong file.
   *
   * Every generation, not just the current one: a stack can name a module loaded
   * from the generation before a swap.
   */
  inSource(text: string): string {
    const cacheDir = this.#snapshots?.cacheDir
    if (!cacheDir) return text
    const escaped = cacheDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text.replaceAll(new RegExp(`${escaped}[/\\\\][0-9a-f]+`, 'g'), this.#componentsDir)
  }

  /** Renders the page a request resolves to; `host` lets hostnames root and localise it. */
  async render(route: string, host = '', request: RenderRequest = {}): Promise<RenderResult> {
    const resolved = await this.#cache.resolve(host, route)
    if (!resolved) return { status: 'notFound' }
    const { culture } = resolved
    if (resolved.redirect)
      return { status: 'redirect', location: resolved.redirect, content: resolved.content }
    const permitted = await this.#permitted(resolved.content, culture, request)
    if (!permitted) return { status: 'notFound' }
    const content = permitted
    if (!content.componentAlias) return { status: 'noTemplate', content }

    try {
      const html = await this.#renderContent(content, content.componentAlias, culture, request)
      return html === undefined
        ? { status: 'noTemplate', content }
        : { status: 'ok', html, content }
    } catch (error) {
      return { status: 'error', error: error as Error, content }
    }
  }

  /**
   * The page to render in place of this one, following the access check until it
   * is satisfied. Undefined means nothing can be shown — a rule naming a page
   * that no longer exists, which is a 404 rather than an open door.
   */
  async #permitted(
    content: PublishedContent,
    culture: string | null,
    request: RenderRequest,
  ): Promise<PublishedContent | undefined> {
    if (!request.access) return content
    let current = content
    for (let step = 0; step < MAX_ACCESS_SUBSTITUTIONS; step++) {
      const decision = await request.access(current)
      if (decision.status === 'allowed') return current
      if (decision.contentKey.toLowerCase() === current.key.toLowerCase()) return undefined
      const next = await this.#cache.byKey(decision.contentKey, culture)
      if (!next) return undefined
      current = next
    }
    return undefined
  }

  /**
   * Renders a given model rather than a routed one: preview renders a draft this
   * way, with the published tree for navigation.
   */
  async renderModel(
    content: PublishedContent,
    culture: string | null,
    request: RenderRequest = {},
  ): Promise<RenderResult> {
    if (!content.componentAlias) return { status: 'noTemplate', content }
    try {
      const html = await this.#renderContent(content, content.componentAlias, culture, request)
      return html === undefined
        ? { status: 'noTemplate', content }
        : { status: 'ok', html, content }
    } catch (error) {
      return { status: 'error', error: error as Error, content }
    }
  }

  async #renderContent(
    content: PublishedContent,
    alias: string,
    culture: string | null,
    request: RenderRequest = {},
  ): Promise<string | undefined> {
    const deadline = new AbortController()
    const signal = request.signal
      ? AbortSignal.any([deadline.signal, request.signal])
      : deadline.signal
    const rendering = { alias }
    const timer =
      this.#renderTimeoutMs > 0
        ? setTimeout(
            () =>
              deadline.abort(
                new Error(
                  `Rendering '${rendering.alias}' took longer than ${this.#renderTimeoutMs}ms.`,
                ),
              ),
            this.#renderTimeoutMs,
          )
        : undefined
    const stopped = new Promise<never>((_, reject) => {
      const fail = () => reject(signal.reason)
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
    stopped.catch(() => {})
    const work = this.#renderChain(content, alias, culture, request, signal, rendering)
    // Once the deadline has answered, a late failure has nobody left to tell.
    work.catch(() => {})
    try {
      return await Promise.race([work, stopped])
    } finally {
      clearTimeout(timer)
    }
  }

  async #renderChain(
    content: PublishedContent,
    alias: string,
    culture: string | null,
    request: RenderRequest,
    signal: AbortSignal,
    rendering: { alias: string },
  ): Promise<string | undefined> {
    const nav = await this.#cache.navigation(culture)
    const snapshot = await this.#cache.snapshot()
    const dictionary = (key: string) => translate(snapshot, key, culture)
    const origin = (request.origin ?? 'http://localhost').replace(/\/$/, '')
    const props: PageProps = {
      model: content,
      nav,
      culture,
      dictionary,
      member: request.member,
      submission: request.submission,
      request: { origin, url: request.url ?? `${origin}/` },
      urls: {
        absolute: (target) => absoluteUrl(target.url, origin),
        alternates: (target) => urlsIn(snapshot, target.key),
      },
      seo: request.seo ?? { siteName: '', indexable: true },
      signal,
    }

    // Inside the page's scope, so any component can ask for it with `usePage()`.
    return renderScope(props, () => this.#renderLayouts(alias, props, rendering))
  }

  async #renderLayouts(
    alias: string,
    props: PageProps,
    rendering: { alias: string },
  ): Promise<string | undefined> {
    let currentAlias: string | undefined = alias
    let body: RawHtml | undefined
    let depth = 0

    // Walk the layout chain outwards: the page renders first, then each layout
    // wraps the result. A cycle would otherwise hang the request.
    while (currentAlias && depth < MAX_LAYOUT_DEPTH) {
      rendering.alias = currentAlias
      const module = await this.#load(currentAlias)
      if (!module) return depth === 0 || body === undefined ? undefined : withDoctype(body.value)
      const rendered =
        body === undefined
          ? module.default(props)
          : module.default({ ...props, children: body } as LayoutProps)
      body = new RawHtml(await renderToString(rendered as Child))
      currentAlias = module.layout
      depth += 1
    }
    if (depth >= MAX_LAYOUT_DEPTH) {
      throw new Error(
        `Layout chain for '${alias}' is longer than ${MAX_LAYOUT_DEPTH}; is it a cycle?`,
      )
    }
    return body === undefined ? undefined : withDoctype(body.value)
  }

  async #load(alias: string): Promise<ComponentModule | undefined> {
    const file = this.componentPath(alias)
    if (!file) return undefined
    // The path carries the generation, so one entry per view per generation and
    // a swap never answers from the generation before it.
    const cached = this.#modules.get(file)
    if (cached) return cached

    const module = (await import(pathToFileURL(file).href)) as ComponentModule
    if (typeof module.default !== 'function') {
      throw new Error(`Template '${alias}' does not export a default function.`)
    }
    this.#modules.set(file, module)
    return module
  }
}
