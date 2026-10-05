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
import type { FormSubmissionState } from '@bunbraco/core'
import { RawHtml } from './html.ts'
import { type Child, renderToString } from './jsx-runtime.ts'
import type { PageProps, PublishedContent, RequestMember } from './model.ts'
import { type PublishedCache, translate } from './published-cache.ts'
import type { ViewSnapshots } from './snapshots.ts'

export interface ComponentModule {
  default: (props: PageProps) => Child
  /** Alias of the layout template to wrap this one in. */
  layout?: string
}

export interface LayoutProps extends PageProps {
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
}

export type RenderResult =
  | { status: 'ok'; html: string; content: PublishedContent }
  | { status: 'notFound' }
  | { status: 'noTemplate'; content: PublishedContent }
  | { status: 'error'; error: Error; content: PublishedContent }

const MAX_LAYOUT_DEPTH = 10
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
}

/**
 * Whether an alias is a path that stays inside the components tree.
 *
 * `@bunbraco/server` has the same rule as `isSafeAlias`; it is written again
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

  constructor(options: RenderOptions) {
    this.#cache = options.cache
    // Resolved to an absolute path: a dynamic import of a relative specifier
    // resolves against this module, not the working directory.
    this.#componentsDir = resolve(options.componentsDir)
    this.#snapshots = options.snapshots
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
    const nav = await this.#cache.navigation(culture)
    const snapshot = await this.#cache.snapshot()
    const dictionary = (key: string) => translate(snapshot, key, culture)
    const props: PageProps = {
      model: content,
      nav,
      culture,
      dictionary,
      member: request.member,
      submission: request.submission,
    }

    let currentAlias: string | undefined = alias
    let body: RawHtml | undefined
    let depth = 0

    // Walk the layout chain outwards: the page renders first, then each layout
    // wraps the result. A cycle would otherwise hang the request.
    while (currentAlias && depth < MAX_LAYOUT_DEPTH) {
      const module = await this.#load(currentAlias)
      if (!module) return depth === 0 ? undefined : body?.value
      const rendered =
        body === undefined
          ? module.default(props)
          : module.default({ ...props, children: body } as LayoutProps)
      body = new RawHtml(renderToString(rendered))
      currentAlias = module.layout
      depth += 1
    }
    if (depth >= MAX_LAYOUT_DEPTH) {
      throw new Error(
        `Layout chain for '${alias}' is longer than ${MAX_LAYOUT_DEPTH}; is it a cycle?`,
      )
    }
    return body?.value
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
