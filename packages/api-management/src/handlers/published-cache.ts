/**
 * The Published Status dashboard's three buttons. Reload and rebuild answer 200
 * with no body, and the client polls the rebuild status until it reports it has
 * finished — which, since a rebuild here completes before the response, it
 * already has by the first poll.
 */
import type { PublishedCachePort } from '../ports.ts'
import type { ManagementApiRouter } from '../router.ts'

export function registerPublishedCacheHandlers(
  router: ManagementApiRouter,
  cache: PublishedCachePort,
): void {
  router.handle('PostPublishedCacheReload', () => {
    cache.reload()
    return new Response(null, { status: 200 })
  })

  router.handle('PostPublishedCacheRebuild', async () => {
    await cache.rebuild()
    return new Response(null, { status: 200 })
  })

  router.handle('GetPublishedCacheRebuildStatus', () =>
    Response.json({ isRebuilding: cache.isRebuilding() }),
  )
}
