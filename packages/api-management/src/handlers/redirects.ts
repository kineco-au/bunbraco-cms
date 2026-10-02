/**
 * The Redirect URL Management dashboard, in the Content section, and the
 * redirects listed on a page's Info tab.
 *
 * Two quirks of the contract are worth naming. `{id}` means the *document* on the
 * GET and the *redirect* on the DELETE. And `document` is a required field on
 * every item although the client's own mapper throws it away — a redirect the
 * site configured towards an external URL names no document, so those report the
 * empty key rather than inventing one.
 *
 * `POST status` is a no-op, as it is in Umbraco since v17: tracking is a
 * configuration setting, not something an editor toggles.
 */
import {
  invalidSkipTake,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type { RedirectListing, RedirectPort } from '../ports-content.ts'
import type { ManagementApiRouter } from '../router.ts'

const NO_DOCUMENT = '00000000-0000-0000-0000-000000000000'

const toResponse = (item: RedirectListing) => ({
  id: item.key,
  originalUrl: item.originalUrl,
  destinationUrl: item.destinationUrl,
  created: item.created.toISOString(),
  document: { id: item.documentKey ?? NO_DOCUMENT },
  culture: item.culture,
})

export function registerRedirectHandlers(router: ManagementApiRouter, port: RedirectPort): void {
  router.handle('GetRedirectManagement', async (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const filter = ctx.url.searchParams.get('filter') ?? undefined
    const result = await port.list(filter, page.value)
    return Response.json(paged(result.items.map(toResponse), result.total))
  })

  router.handle('GetRedirectManagementById', async (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await port.byDocument(ctx.params.id as string, page.value)
    return Response.json(paged(result.items.map(toResponse), result.total))
  })

  router.handle('DeleteRedirectManagementById', async (ctx) => {
    const result = await port.remove(ctx.params.id as string)
    if (result === 'notFound')
      return problemResponse(
        problemDetails({ title: 'The redirect could not be found', status: 404 }),
      )
    if (result === 'configured')
      return problemResponse(
        problemDetails({
          title: 'The redirect is defined in configuration',
          detail: "Remove it from the site's `redirects` configuration instead.",
          status: 409,
        }),
      )
    return new Response(null, { status: 200 })
  })

  router.handle('GetRedirectManagementStatus', (ctx) =>
    Response.json({
      status: port.isTracking() ? 'Enabled' : 'Disabled',
      userIsAdmin: ctx.principal?.isAdmin ?? false,
    }),
  )

  // Umbraco deprecated this in v17 and made it a no-op; reporting success without
  // changing anything is what its own client now expects.
  router.handle('PostRedirectManagementStatus', () => new Response(null, { status: 200 }))
}
