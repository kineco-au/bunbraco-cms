/**
 * The redirect rows as the backoffice reads them.
 *
 * `destinationUrl` is resolved for display: a rule pointing at a document shows
 * where that document lives now, so the dashboard never shows a stale target. A
 * rule the site configured is reported as such and refuses to be deleted — the
 * config file owns it, and the next boot would put it back.
 */

import type { RedirectListing, RedirectPort } from '@bunbraco/api-management'
import type { Page } from '@bunbraco/core'
import { type Db, RedirectRepository, type RedirectRow } from '@bunbraco/data'
import type { PublishedCache } from '@bunbraco/render'

export function createRedirectPort(
  db: Db,
  cache: PublishedCache | undefined,
  options: { isTracking: boolean; onChange?: () => void },
): RedirectPort {
  const redirects = new RedirectRepository(db)

  /** The pattern as a visitor would type it, hostname included when one scopes it. */
  const originalUrl = async (row: RedirectRow): Promise<string> => {
    const suffix =
      row.matchKind === 'prefix' ? `${row.pattern === '/' ? '' : row.pattern}/*` : row.pattern
    if (row.rootKey === null) return suffix
    const snapshot = await cache?.snapshot()
    const domain = snapshot?.domains.find(
      (d) => !d.isWildcard && snapshot.domainRoots.get(d.nodeId) === row.rootKey,
    )
    return domain ? `//${domain.domainName}${suffix === '/' ? '/' : suffix}` : suffix
  }

  const destinationUrl = async (row: RedirectRow): Promise<string> => {
    if (row.targetKind !== 'document') return row.target
    const content = await cache?.byKey(row.target, row.culture)
    return content && content.url !== '#' ? content.url : ''
  }

  const listing = async (row: RedirectRow): Promise<RedirectListing> => ({
    key: row.key,
    originalUrl: await originalUrl(row),
    destinationUrl: await destinationUrl(row),
    culture: row.culture,
    documentKey: row.targetKind === 'document' ? row.target : null,
    created: row.createDate,
    isConfigured: row.source === 'config',
  })

  const page = async (result: {
    total: number
    items: RedirectRow[]
  }): Promise<Page<RedirectListing>> => ({
    total: result.total,
    items: await Promise.all(result.items.map(listing)),
  })

  return {
    list: async (filter, paging) => page(await redirects.list({ filter, ...paging })),
    byDocument: async (key, paging) => page(await redirects.byDocument(key, paging)),
    async remove(key) {
      const found = await redirects.byKey(key)
      if (!found) return 'notFound'
      if (found.source === 'config') return 'configured'
      await redirects.delete(key)
      // The rules live in the published cache's snapshot, so it has to be dropped
      // for the redirect to stop answering.
      options.onChange?.()
      return 'deleted'
    },
    isTracking: () => options.isTracking,
  }
}
