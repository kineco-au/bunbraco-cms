/**
 * Search and sharing: the values a page offers search engines and social
 * previews, and the `<SeoHead>` that writes them.
 *
 * `effectiveMeta` is the one place the fallbacks live. The page's head and the
 * editor's preview both call it, so what an editor is shown is what is served.
 */

import { RawHtml } from './html.ts'
import { element } from './jsx-runtime.ts'
import type { PublishedContent } from './model.ts'

/** The fields of the "Search & sharing" composition, by role. */
export const SEO_ALIASES = {
  title: 'seoTitle',
  description: 'seoDescription',
  image: 'seoImage',
  canonical: 'seoCanonical',
  noindex: 'seoNoindex',
  sitemapHide: 'seoSitemapHide',
} as const

/** Site-wide values a page falls back to. */
export interface SeoSiteDefaults {
  siteName: string
  titleSuffix?: string
  /** An absolute or root-relative image address. */
  defaultImage?: string
  /** False on a site search engines should stay out of entirely, such as staging. */
  indexable: boolean
}

/** What a template supplies when the page itself says nothing. */
export interface SeoOverrides {
  title?: string
  description?: string
  image?: string
  canonical?: string
  /** `og:type`; `website` when absent. */
  type?: string
  /** Appended to the title; null for none even when the site sets one. */
  titleSuffix?: string | null
  noindex?: boolean
}

/** Where a value came from: the page's own field, the template, the site, or the page name. */
export type MetaSource = 'page' | 'template' | 'site' | 'name' | 'none'

export interface MetaValue<T> {
  value: T
  source: MetaSource
}

export interface Alternate {
  culture: string | null
  url: string
  /** The default language's version, offered as `x-default`. */
  isDefault?: boolean
}

export interface EffectiveMeta {
  /** The title as written, before any suffix. */
  title: MetaValue<string>
  /** The `<title>`: the title plus the suffix. */
  fullTitle: string
  description: MetaValue<string | undefined>
  image: MetaValue<string | undefined>
  canonical: MetaValue<string | undefined>
  noindex: MetaValue<boolean>
  /** Language versions with an address, absolute; empty unless there are two or more. */
  alternates: Array<{ culture: string; url: string }>
  xDefault: string | undefined
  siteName: string
  type: string
}

export interface MetaContext {
  origin: string
  alternates: readonly Alternate[]
  site: SeoSiteDefaults
}

/**
 * An address made absolute against the request's origin. `#` is a page with no
 * address in this culture, so it has no absolute form either.
 */
export function absoluteUrl(url: string | undefined, origin: string): string | undefined {
  if (!url || url === '#') return undefined
  if (/^https?:\/\//i.test(url)) return url
  const base = origin.replace(/\/$/, '')
  if (url.startsWith('//')) return `${new URL(base).protocol}${url}`
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

/** The values a page offers, each with where it came from. */
export function effectiveMeta(
  content: PublishedContent,
  context: MetaContext,
  overrides: SeoOverrides = {},
): EffectiveMeta {
  const { origin, site } = context
  const own = (alias: string) => content.text(alias).trim()

  const title: MetaValue<string> = filled(own(SEO_ALIASES.title))
    ? { value: own(SEO_ALIASES.title), source: 'page' }
    : filled(overrides.title)
      ? { value: overrides.title, source: 'template' }
      : { value: content.name, source: 'name' }
  const suffix =
    overrides.titleSuffix === null ? '' : (overrides.titleSuffix ?? site.titleSuffix ?? '')

  const description: MetaValue<string | undefined> = filled(own(SEO_ALIASES.description))
    ? { value: own(SEO_ALIASES.description), source: 'page' }
    : filled(overrides.description)
      ? { value: overrides.description, source: 'template' }
      : { value: undefined, source: 'none' }

  const picked = content.media(SEO_ALIASES.image)[0]?.url
  const image: MetaValue<string | undefined> = filled(picked)
    ? { value: absoluteUrl(picked, origin), source: 'page' }
    : filled(overrides.image)
      ? { value: absoluteUrl(overrides.image, origin), source: 'template' }
      : filled(site.defaultImage)
        ? { value: absoluteUrl(site.defaultImage, origin), source: 'site' }
        : { value: undefined, source: 'none' }

  const canonical: MetaValue<string | undefined> = filled(own(SEO_ALIASES.canonical))
    ? { value: absoluteUrl(own(SEO_ALIASES.canonical), origin), source: 'page' }
    : filled(overrides.canonical)
      ? { value: absoluteUrl(overrides.canonical, origin), source: 'template' }
      : { value: absoluteUrl(content.url, origin), source: 'name' }

  const noindex: MetaValue<boolean> = !site.indexable
    ? { value: true, source: 'site' }
    : truthy(content.value(SEO_ALIASES.noindex))
      ? { value: true, source: 'page' }
      : overrides.noindex
        ? { value: true, source: 'template' }
        : { value: false, source: 'none' }

  const versions = context.alternates.flatMap((a) => {
    const url = absoluteUrl(a.url, origin)
    return a.culture && url ? [{ culture: a.culture, url, isDefault: a.isDefault === true }] : []
  })
  const alternates =
    versions.length > 1 ? versions.map(({ culture, url }) => ({ culture, url })) : []
  const xDefault = alternates.length > 0 ? versions.find((v) => v.isDefault)?.url : undefined

  return {
    title,
    fullTitle: `${title.value}${suffix}`,
    description,
    image,
    canonical,
    noindex,
    alternates,
    xDefault,
    siteName: site.siteName,
    type: overrides.type ?? 'website',
  }
}

/** What `<SeoHead>` needs from the page's props, plus a template's own fallbacks. */
export interface SeoHeadProps extends SeoOverrides {
  model: PublishedContent
  request: { origin: string; url: string }
  urls: { alternates(content: PublishedContent): Alternate[] }
  seo: SeoSiteDefaults
}

/** The head tags for search and sharing. Spread a page's props into it: `<SeoHead {...props} />`. */
export function SeoHead(props: SeoHeadProps): RawHtml {
  const { model, request, urls, seo, ...overrides } = props
  const meta = effectiveMeta(
    model,
    { origin: request.origin, alternates: urls.alternates(model), site: seo },
    overrides,
  )
  const tag = (name: string, attributes: Record<string, string | undefined>) =>
    Object.values(attributes).some((v) => v === undefined) ? '' : element(name, attributes).value
  const property = (name: string, value: string | undefined) =>
    tag('meta', { property: name, content: value })
  const named = (name: string, value: string | undefined) => tag('meta', { name, content: value })
  return new RawHtml(
    [
      element('title', { children: meta.fullTitle }).value,
      named('description', meta.description.value),
      meta.noindex.value ? named('robots', 'noindex') : '',
      tag('link', { rel: 'canonical', href: meta.canonical.value }),
      ...meta.alternates.map((a) =>
        tag('link', { rel: 'alternate', hreflang: a.culture, href: a.url }),
      ),
      tag('link', { rel: 'alternate', hreflang: 'x-default', href: meta.xDefault }),
      property('og:title', meta.title.value),
      property('og:description', meta.description.value),
      property('og:image', meta.image.value),
      property('og:url', meta.canonical.value),
      property('og:type', meta.type),
      meta.siteName ? property('og:site_name', meta.siteName) : '',
      named('twitter:card', meta.image.value ? 'summary_large_image' : 'summary'),
    ].join(''),
  )
}
