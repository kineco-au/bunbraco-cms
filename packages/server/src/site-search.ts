/**
 * Site search for a render (story 140): the published-only index, narrowed to
 * what the person asking may open, each hit read back from the published cache
 * so a page unpublished since it was indexed is never shown. docs/search.md.
 */
import { branchAccess } from '@crombolo/core'
import { type Db, PublicAccessRepository, SiteSearch } from '@crombolo/data'
import {
  excerpt,
  type PublishedCache,
  type RequestMember,
  type SearchResult,
  type SiteSearchPort,
} from '@crombolo/render'

/** The search `search()` calls during one render, for `member` or for nobody signed in. */
export function siteSearchFor(
  db: Db,
  cache: PublishedCache,
  member: RequestMember | undefined,
): SiteSearchPort {
  return async (query, options) => {
    const rules = await new PublicAccessRepository(db).allRules()
    const access = branchAccess(
      rules,
      member ? { username: member.username, groups: member.roles } : undefined,
    )
    const culture = options.culture ?? (await cache.defaultCulture())
    const hits = await new SiteSearch(db).query(query, {
      culture: culture ?? '',
      types: options.types,
      skip: options.skip,
      take: options.take,
      access,
    })
    const nav = await cache.navigation(culture)
    const items: SearchResult[] = []
    for (const hit of hits.items) {
      const content = nav.byKey(hit.key)
      if (!content) continue
      items.push({
        content,
        url: content.url,
        name: content.name,
        score: hit.score,
        excerpt: excerpt(hit.text, query),
      })
    }
    return { total: hits.total, items }
  }
}
