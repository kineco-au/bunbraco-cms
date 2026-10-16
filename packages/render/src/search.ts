/**
 * Site search from a component (story 140). The server answers it from the
 * published-only index, leaving out pages the signed-in member — or a visitor
 * who is not signed in — may not open, and hands back each page as published
 * content with an excerpt around the words searched for.
 */
import { currentSiteSearch } from './context.ts'
import type { ExcerptSegment } from './excerpt.ts'
import type { PublishedContent } from './model.ts'

export interface SearchOptions {
  /** The culture searched; the page's own when absent. */
  culture?: string | null
  /** Content type aliases to keep to; every searchable type when absent. */
  types?: readonly string[]
  skip?: number
  take?: number
}

export interface SearchResult {
  content: PublishedContent
  url: string
  name: string
  score: number
  /** The text around the words searched for; render `match` segments marked. */
  excerpt: ExcerptSegment[]
}

export interface SearchResults {
  /** Every match the person searching may open, not only this page of them. */
  total: number
  items: SearchResult[]
}

/** What the server provides a render: a search already scoped to the person asking. */
export type SiteSearchPort = (
  query: string,
  options: { culture: string | null; types: readonly string[]; skip: number; take: number },
) => Promise<SearchResults>

/**
 * Searches the site's published pages, best match first:
 *
 * ```tsx
 * const results = await search(q, { take: 10, skip: (page - 1) * 10 })
 * ```
 *
 * Every word of the query must be in a page, by the start of a word; the name
 * counts most, then the properties marked `site-search = "high"`, the rest,
 * and those marked `"low"`.
 */
export async function search(query: string, options: SearchOptions = {}): Promise<SearchResults> {
  const { page, search: port } = currentSiteSearch()
  if (!port) throw new Error('Site search is not available to this render.')
  return port(query, {
    culture: options.culture === undefined ? page.culture : options.culture,
    types: options.types ?? [],
    skip: Math.max(0, Math.floor(options.skip ?? 0)),
    take: Math.min(100, Math.max(1, Math.floor(options.take ?? 10))),
  })
}
