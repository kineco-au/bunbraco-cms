/**
 * Search and sharing on the server: `/sitemap.xml`, `/robots.txt`, the page an
 * unknown address renders, and the backoffice's settings and page preview.
 *
 * Site-wide settings come from `crombolo.config.ts` and may be overridden in the
 * backoffice; an override is stored in `key_value` as JSON, field by field, so
 * clearing one falls back to the config again.
 */
import type { Principal } from '@crombolo/api-management'
import { hasSection } from '@crombolo/api-management'
import { SYSTEM_CONTENT_TYPE_KEYS } from '@crombolo/core'
import { ContentTypeRepository, type Db, readKeyValue, writeKeyValue } from '@crombolo/data'
import {
  effectiveMeta,
  type PublishedCache,
  type PublishedContent,
  renderSitemap,
  robotsTxt,
  type SeoSiteDefaults,
  sitemapEntries,
  urlsIn,
} from '@crombolo/render'
import type { CromboloConfig, NotFoundRule } from './config.ts'

export const SEO_SETTINGS_KEY = 'Crombolo.Seo.Settings'

export interface SeoSettings {
  sitemap: boolean
  indexable: boolean
  robotsTxt: string
  siteName: string
  titleSuffix: string
  defaultImage: string
  notFoundPage: NotFoundRule[]
}

export type SeoSettingsOverrides = { [K in keyof SeoSettings]?: SeoSettings[K] | null }

export type SettingSource = 'backoffice' | 'config' | 'default'

export const DEFAULT_ROBOTS_TXT = 'User-agent: *\nAllow: /'

const FIELDS = [
  'sitemap',
  'indexable',
  'robotsTxt',
  'siteName',
  'titleSuffix',
  'defaultImage',
  'notFoundPage',
] as const satisfies ReadonlyArray<keyof SeoSettings>

/** How long a node trusts the settings it read; another node's save shows within this. */
const SETTINGS_TTL_MS = 10_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The scheme and host the visitor used: a proxy's forwarded values first, then
 * the request's own, then the configured public address.
 */
export function originOf(request: Request, config: Pick<CromboloConfig, 'applicationUrl'>): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  try {
    const url = new URL(request.url)
    const host = forwardedHost || request.headers.get('host') || url.host
    const proto = forwardedProto || url.protocol.replace(/:$/, '')
    if (host) return `${proto}://${host}`
  } catch {
    // A request without an absolute URL falls through to the configured address.
  }
  return config.applicationUrl.replace(/\/$/, '')
}

/** Refusal text for a settings body, or the overrides it sets. */
export function parseSettingsBody(
  body: unknown,
): { ok: true; overrides: SeoSettingsOverrides } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, message: 'Expected an object of settings.' }
  const input = body as Record<string, unknown>
  const out: SeoSettingsOverrides = {}
  for (const field of FIELDS) {
    if (!(field in input)) continue
    const value = input[field]
    if (value === null) {
      out[field] = null
      continue
    }
    switch (field) {
      case 'sitemap':
      case 'indexable':
        if (typeof value !== 'boolean')
          return { ok: false, message: `${field} must be true or false.` }
        out[field] = value
        break
      case 'notFoundPage': {
        const rules = parseRules(value)
        if (!rules) return { ok: false, message: 'Choose a page for each not-found rule.' }
        out.notFoundPage = rules
        break
      }
      default:
        if (typeof value !== 'string') return { ok: false, message: `${field} must be text.` }
        out[field] = value
    }
  }
  return { ok: true, overrides: out }
}

function parseRules(value: unknown): NotFoundRule[] | undefined {
  if (typeof value === 'string') return UUID.test(value) ? [{ document: value }] : undefined
  if (!Array.isArray(value)) return undefined
  const rules: NotFoundRule[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const { document, host, culture } = item as Record<string, unknown>
    if (typeof document !== 'string' || !UUID.test(document)) return undefined
    const rule: NotFoundRule = { document }
    if (typeof host === 'string' && host.trim()) rule.host = host.trim().toLowerCase()
    if (typeof culture === 'string' && culture.trim()) rule.culture = culture.trim()
    rules.push(rule)
  }
  return rules
}

/** The most specific rule for a request: hostname and language, then either, then neither. */
export function chooseNotFoundRule(
  rules: readonly NotFoundRule[],
  host: string,
  culture: string | null,
): NotFoundRule | undefined {
  const bare = host.toLowerCase().replace(/:\d+$/, '')
  const hostMatches = (r: NotFoundRule) =>
    r.host === undefined || r.host === bare || r.host === host.toLowerCase()
  const cultureMatches = (r: NotFoundRule) =>
    r.culture === undefined || r.culture.toLowerCase() === (culture ?? '').toLowerCase()
  const score = (r: NotFoundRule) => (r.host ? 2 : 0) + (r.culture ? 1 : 0)
  return rules
    .filter((r) => hostMatches(r) && cultureMatches(r))
    .sort((a, b) => score(b) - score(a))[0]
}

export interface DraftModel {
  content: PublishedContent
  contentTypeAlias: string
  published: boolean
  culture: string | null
}

export interface SeoHostOptions {
  db: Db
  config: CromboloConfig
  cache: PublishedCache
  /** Whether a visitor who is not signed in would be turned away from a page. */
  isProtected(content: PublishedContent): Promise<boolean>
  /** A document's latest saved version, as the preview renders it. */
  draft(key: string, culture: string | null): Promise<DraftModel | undefined>
}

export interface SeoHost {
  settings(): Promise<{
    effective: SeoSettings
    overrides: SeoSettingsOverrides
    sources: Record<keyof SeoSettings, SettingSource>
  }>
  siteDefaults(): Promise<SeoSiteDefaults>
  sitemap(request: Request, host: string): Promise<Response>
  robots(request: Request): Promise<Response>
  notFound(
    host: string,
    pathname: string,
  ): Promise<{ content: PublishedContent; culture: string | null } | undefined>
  /** Backoffice routes below `<backoffice>/crombolo/api/seo`. */
  handle(request: Request, subpath: string, principal: Principal): Promise<Response | undefined>
}

export function createSeoHost(options: SeoHostOptions): SeoHost {
  const { db, config, cache } = options
  let memo: { at: number; overrides: SeoSettingsOverrides } | undefined

  const readOverrides = async (): Promise<SeoSettingsOverrides> => {
    if (memo && Date.now() - memo.at < SETTINGS_TTL_MS) return memo.overrides
    const raw = await readKeyValue(db, SEO_SETTINGS_KEY)
    let overrides: SeoSettingsOverrides = {}
    if (raw) {
      const parsed = parseSettingsBody(safeJson(raw))
      if (parsed.ok) overrides = parsed.overrides
    }
    memo = { at: Date.now(), overrides }
    return overrides
  }

  const defaults = (): SeoSettings => ({
    sitemap: true,
    indexable: true,
    robotsTxt: DEFAULT_ROBOTS_TXT,
    siteName: config.siteName,
    titleSuffix: '',
    defaultImage: '',
    notFoundPage: [],
  })

  const fromConfig = (): Partial<SeoSettings> => {
    const seo = config.seo ?? {}
    const out: Partial<SeoSettings> = {}
    for (const field of FIELDS) {
      const value = seo[field]
      if (value === undefined) continue
      if (field === 'notFoundPage') out.notFoundPage = parseRules(value) ?? []
      else (out as Record<string, unknown>)[field] = value
    }
    return out
  }

  const settings: SeoHost['settings'] = async () => {
    const overrides = await readOverrides()
    const configured = fromConfig()
    const effective = defaults()
    const sources = {} as Record<keyof SeoSettings, SettingSource>
    for (const field of FIELDS) {
      const own = overrides[field]
      if (own !== undefined && own !== null) {
        ;(effective as unknown as Record<string, unknown>)[field] = own
        sources[field] = 'backoffice'
      } else if (configured[field] !== undefined) {
        ;(effective as unknown as Record<string, unknown>)[field] = configured[field]
        sources[field] = 'config'
      } else sources[field] = 'default'
    }
    return { effective, overrides, sources }
  }

  /** A media item's address when given its key, else the address as written. */
  const imageAddress = async (value: string): Promise<string | undefined> => {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (!UUID.test(trimmed)) return trimmed
    const snapshot = await cache.snapshot()
    return snapshot.media.get(trimmed.toLowerCase())?.url
  }

  const siteDefaults: SeoHost['siteDefaults'] = async () => {
    const { effective } = await settings()
    return {
      siteName: effective.siteName,
      titleSuffix: effective.titleSuffix || undefined,
      defaultImage: await imageAddress(effective.defaultImage),
      indexable: effective.indexable,
    }
  }

  const cacheControl = config.development ? 'no-cache' : 'public, max-age=3600'

  const sitemap: SeoHost['sitemap'] = async (request, host) => {
    const { effective } = await settings()
    if (!effective.sitemap || !effective.indexable)
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    const snapshot = await cache.snapshot()
    const entries = sitemapEntries(snapshot, { host, origin: originOf(request, config) })
    const open: typeof entries = []
    for (const entry of entries) if (!(await options.isProtected(entry.content))) open.push(entry)
    return new Response(renderSitemap(open), {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': cacheControl },
    })
  }

  const robots: SeoHost['robots'] = async (request) => {
    const { effective } = await settings()
    const text = robotsTxt(effective.robotsTxt, {
      origin: originOf(request, config),
      indexable: effective.indexable,
      sitemap: effective.sitemap,
    })
    return new Response(text, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cacheControl },
    })
  }

  const notFound: SeoHost['notFound'] = async (host, pathname) => {
    const { effective } = await settings()
    if (effective.notFoundPage.length === 0) return undefined
    const culture = await cache.cultureFor(host, pathname)
    const rule = chooseNotFoundRule(effective.notFoundPage, host, culture)
    if (!rule) return undefined
    const content = await cache.byKey(rule.document, culture)
    return content ? { content, culture } : undefined
  }

  /** Whether a content type has the "Search & sharing" fields, itself or by composition. */
  const composesSeoFields = async (alias: string): Promise<boolean> => {
    const repo = new ContentTypeRepository(db)
    const seen = new Set<string>()
    let pending = [(await repo.byAlias(alias))?.key].filter((k): k is string => Boolean(k))
    while (pending.length > 0) {
      const next: string[] = []
      for (const key of pending) {
        const normal = key.toLowerCase()
        if (normal === SYSTEM_CONTENT_TYPE_KEYS.SeoFields) return true
        if (seen.has(normal)) continue
        seen.add(normal)
        const type = await repo.byKey(key)
        for (const c of type?.compositions ?? []) next.push(c.contentTypeKey)
      }
      pending = next
    }
    return false
  }

  const preview = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const key = url.searchParams.get('document') ?? ''
    if (!UUID.test(key)) return Response.json({ message: 'Choose a page.' }, { status: 400 })
    const draft = await options.draft(key, url.searchParams.get('culture') || null)
    if (!draft) return Response.json({ message: 'That page could not be found.' }, { status: 404 })
    const origin = originOf(request, config)
    const snapshot = await cache.snapshot()
    const meta = effectiveMeta(draft.content, {
      origin,
      alternates: urlsIn(snapshot, key),
      site: await siteDefaults(),
    })
    return Response.json({
      hasSeoFields: await composesSeoFields(draft.contentTypeAlias),
      published: draft.published,
      culture: draft.culture,
      meta,
      snippet: {
        title: meta.fullTitle,
        url: meta.canonical.value ?? '',
        description: meta.description.value ?? '',
      },
    })
  }

  const handle: SeoHost['handle'] = async (request, subpath, principal) => {
    if (subpath === '/preview' && request.method === 'GET') return preview(request)
    if (subpath !== '/settings') return undefined
    if (!hasSection(principal, 'settings')) return new Response('Forbidden', { status: 403 })
    if (request.method === 'GET') return Response.json(await settings())
    if (request.method !== 'PUT')
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, PUT' } })
    const parsed = parseSettingsBody(await request.json().catch(() => undefined))
    if (!parsed.ok) return Response.json({ message: parsed.message }, { status: 400 })
    memo = undefined
    const merged: SeoSettingsOverrides = { ...(await readOverrides()) }
    for (const field of FIELDS) {
      if (!(field in parsed.overrides)) continue
      const value = parsed.overrides[field]
      if (value === null) delete merged[field]
      else (merged as Record<string, unknown>)[field] = value
    }
    await writeKeyValue(db, SEO_SETTINGS_KEY, JSON.stringify(merged))
    memo = undefined
    return Response.json(await settings())
  }

  return { settings, siteDefaults, sitemap, robots, notFound, handle }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
