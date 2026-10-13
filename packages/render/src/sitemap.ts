/**
 * `/sitemap.xml` and `/robots.txt`: the pages a hostname offers search engines,
 * and the file that points them at the list.
 */
import { escapeHtml } from './html.ts'
import type { PublishedContent } from './model.ts'
import type { CacheSnapshot } from './published-cache.ts'
import { absoluteUrl, SEO_ALIASES } from './seo.ts'

export interface SitemapEntry {
  content: PublishedContent
  url: string
  lastmod: Date
  /** The page's other language versions, absolute, when it has more than one. */
  alternates: Array<{ culture: string; url: string }>
}

/** The hostname part of a `//host/route` address. */
const hostOf = (url: string): string => url.slice(2).split('/')[0]?.toLowerCase() ?? ''

const hidden = (content: PublishedContent): boolean => {
  const value = content.value(SEO_ALIASES.sitemapHide)
  return value === true || value === 1 || value === '1' || value === 'true'
}

/**
 * Every page a request to `host` can reach, once, with its language versions.
 * Pages without a template, without an address in a culture, or marked hidden
 * are left out; so is anything rooted at another hostname.
 */
export function sitemapEntries(
  snapshot: CacheSnapshot,
  options: { host: string; origin: string },
): SitemapEntry[] {
  const host = options.host.toLowerCase()
  const bare = host.replace(/:\d+$/, '')
  const hostnames = new Set(snapshot.domains.map((d) => d.domainName.split('/')[0]?.toLowerCase()))
  const onThisHost = hostnames.has(host) || hostnames.has(bare)
  const belongs = (url: string): boolean =>
    url.startsWith('//') ? [host, bare].includes(hostOf(url)) : url !== '#' && !onThisHost

  const versionsOf = new Map<string, Array<{ culture: string | null; url: string }>>()
  for (const view of snapshot.views.values())
    for (const content of view.byId.values()) {
      const versions = versionsOf.get(content.key) ?? []
      versions.push({ culture: view.culture, url: content.url })
      versionsOf.set(content.key, versions)
    }

  const entries: SitemapEntry[] = []
  const seen = new Set<string>()
  for (const view of snapshot.views.values())
    for (const content of view.byId.values()) {
      if (!content.componentAlias || !belongs(content.url) || hidden(content)) continue
      const url = absoluteUrl(content.url, options.origin)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const alternates = (versionsOf.get(content.key) ?? []).flatMap((v) => {
        const absolute = absoluteUrl(v.url, options.origin)
        return v.culture && absolute ? [{ culture: v.culture, url: absolute }] : []
      })
      entries.push({
        content,
        url,
        lastmod: content.updateDate,
        alternates: alternates.length > 1 ? alternates : [],
      })
    }
  return entries
}

export function renderSitemap(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const links = entry.alternates
      .map(
        (a) =>
          `<xhtml:link rel="alternate" hreflang="${escapeHtml(a.culture)}" href="${escapeHtml(a.url)}"/>`,
      )
      .join('')
    return `<url><loc>${escapeHtml(entry.url)}</loc><lastmod>${entry.lastmod.toISOString()}</lastmod>${links}</url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`
}

/**
 * The robots file: the site's own rules, refusing everything on a site that
 * should stay out of search, and the sitemap's address when there is one to offer.
 */
export function robotsTxt(
  text: string,
  options: { origin: string; indexable: boolean; sitemap: boolean },
): string {
  const rules = options.indexable ? text.trim() : 'User-agent: *\nDisallow: /'
  const sitemap =
    options.sitemap && options.indexable
      ? `\n\nSitemap: ${options.origin.replace(/\/$/, '')}/sitemap.xml`
      : ''
  return `${rules}${sitemap}\n`
}
