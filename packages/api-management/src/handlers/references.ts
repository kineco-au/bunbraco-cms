/**
 * "What refers to this?" — the Info tab's list, and the checks the client makes
 * before a delete. These answered an empty page until now, which told an editor
 * that nothing referenced a document they were about to delete.
 */
import { invalidSkipTake, paged, parseSkipTake, problemResponse } from '@bunbraco/core'
import type { ReferencePort } from '../ports-content.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'

type Area = 'Document' | 'Media' | 'Member' | 'Element'

export function registerReferenceHandlers(
  router: ManagementApiRouter,
  area: Area,
  port: ReferencePort,
): void {
  // Umbraco pages these 20 at a time, not the usual 100.
  const paging = (ctx: RequestContext) => parseSkipTake(ctx.url.searchParams, 20)
  const has = (id: string) => router.operations.some((o) => o.operationId === id)
  const handle = (id: string, handler: Parameters<ManagementApiRouter['handle']>[1]) => {
    if (has(id)) router.handle(id, handler)
  }

  handle(`Get${area}ByIdReferencedBy`, async (ctx) => {
    const page = paging(ctx)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await port.referencedBy(ctx.params.id as string, page.value)
    return Response.json(paged(result.items, result.total))
  })

  handle(`Get${area}ByIdReferencedDescendants`, async (ctx) => {
    const page = paging(ctx)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await port.referencedDescendants(ctx.params.id as string, page.value)
    return Response.json(paged(result.items, result.total))
  })

  handle(`Get${area}AreReferenced`, async (ctx) => {
    const page = paging(ctx)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await port.areReferenced(ctx.url.searchParams.getAll('id'), page.value)
    return Response.json(paged(result.items, result.total))
  })
}
