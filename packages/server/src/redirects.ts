/**
 * The URL tracker: a page that is renamed or moved keeps answering on the URL it
 * had.
 *
 * Umbraco does this with a pair of notifications — capture the routes before the
 * write, compare after it — and the same shape applies here, because a route is
 * derived from names and tree position and so cannot be known after the fact.
 * `capture` is called before the operation and `commit` after the published cache
 * has been dropped; a route that changed becomes a 301 to wherever the document
 * now lives.
 *
 * Recycle-bin moves are deliberately not tracked, as in Umbraco: a trashed page
 * has no new URL to point at, and restoring it brings the old one back anyway.
 */
import type { RedirectInput, RedirectRepository } from '@bunbraco/data'
import type { DocumentRoute, PublishedCache, RedirectRule } from '@bunbraco/render'

export interface RedirectTracker {
  /** The routes the branch answers on now; empty when tracking is off. */
  capture(key: string): Promise<DocumentRoute[]>
  /**
   * The routes of every child of `parentKey`, and their branches — what a sort
   * needs, since the node being written is the parent and the URLs that move
   * belong to its children. `null` is the tree root.
   */
  captureChildren(parentKey: string | null): Promise<DocumentRoute[]>
  /** Records a redirect for every captured route the branch no longer answers on. */
  commit(captured: readonly DocumentRoute[]): Promise<void>
}

/** What a port built without tracking, or with it turned off, uses. */
export const NO_REDIRECT_TRACKING: RedirectTracker = {
  capture: async () => [],
  captureChildren: async () => [],
  commit: async () => {},
}

export function createRedirectTracker(options: {
  cache: PublishedCache
  redirects: RedirectRepository
  enabled: boolean
}): RedirectTracker {
  if (!options.enabled) return NO_REDIRECT_TRACKING
  const { cache, redirects } = options

  return {
    capture: (key) => cache.routes(key, true),

    /**
     * Sorting normally changes no URL, because a segment comes from the name. The
     * exception is the tree root: under Umbraco's `HideTopLevelNodeFromPath` the
     * *first* root page is `/` and the others are `/<segment>`, so re-ordering
     * roots moves them. Umbraco does not track that — its handler listens to
     * publish and move only — and this does, since it is the same silent breakage
     * for a site with more than one root.
     */
    async captureChildren(parentKey) {
      const children = await cache.childKeys(parentKey)
      const routes: DocumentRoute[] = []
      for (const key of children) routes.push(...(await cache.routes(key, true)))
      return routes
    },

    async commit(captured) {
      if (captured.length === 0) return
      let wrote = false
      const seen = new Map<string, DocumentRoute[]>()
      for (const route of captured) {
        const existing = seen.get(route.key.toLowerCase())
        if (existing) existing.push(route)
        else seen.set(route.key.toLowerCase(), [route])
      }
      for (const [documentKey, before] of seen) {
        const after = await cache.routes(documentKey)
        for (const old of before) {
          const now = after.find((route) => route.culture === old.culture)
          // A culture that is no longer published has no new URL to point at, so
          // the old one stops working rather than redirecting into nothing.
          if (!now) continue
          if (now.rootKey === old.rootKey && now.path === old.path) continue
          // A rename that was reverted would otherwise leave the live URL
          // redirecting to itself.
          await redirects.removeSelfReferencing(documentKey, now.rootKey, now.path)
          const rule: RedirectInput = {
            source: 'tracked',
            matchKind: 'exact',
            pattern: old.path,
            rootKey: old.rootKey,
            culture: old.culture,
            targetKind: 'document',
            target: documentKey,
            statusCode: 301,
            sortOrder: 0,
          }
          await redirects.save(rule)
          wrote = true
        }
      }
      // The rules are part of the cache's snapshot, and reading the new routes
      // above has just rebuilt it — so without this the redirect just written
      // would not answer until something else dropped the cache.
      if (wrote) cache.invalidate()
    },
  }
}

/**
 * Writes the site's configured redirects into the database, removing any left
 * over from a previous boot — which is what makes deleting one from the config
 * file take effect.
 *
 * Run at boot, per node, and not under a lock: two nodes mid-deploy hold different
 * config, so the rows follow whichever booted last until the deploy finishes.
 * A lock would make each sync atomic without resolving that disagreement, so it
 * would buy nothing but the appearance of safety. Tracked rules are never touched.
 */
export async function syncConfiguredRedirects(
  redirects: RedirectRepository,
  configured: readonly RedirectRule[],
): Promise<{ stored: number; removed: number }> {
  return redirects.syncConfigured(
    configured.map((rule) => ({
      matchKind: rule.matchKind,
      pattern: rule.pattern,
      rootKey: rule.rootKey,
      culture: rule.culture,
      targetKind: rule.targetKind,
      target: rule.target,
      statusCode: rule.statusCode,
    })),
  )
}
