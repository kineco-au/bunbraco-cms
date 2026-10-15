/**
 * Relation types and their relations, read-only and derived (story 046), and
 * the recycle bins' "what refers to what is in here" lists.
 */
import { invalidSkipTake, notFound, paged, parseSkipTake, problemResponse } from '@crombolo/core'
import type { ReferencePort, RelationPort } from '../ports-content.ts'
import type { ManagementApiRouter } from '../router.ts'

const missing = () => problemResponse(notFound('The relation type could not be found'))

export function registerRelationHandlers(router: ManagementApiRouter, port: RelationPort): void {
  router.handle('GetRelationType', (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const types = port.types()
    return Response.json(
      paged(types.slice(page.value.skip, page.value.skip + page.value.take), types.length),
    )
  })

  router.handle('GetRelationTypeById', (ctx) => {
    const id = String(ctx.params.id).toLowerCase()
    const type = port.types().find((t) => t.id === id)
    return type ? Response.json(type) : missing()
  })

  router.handle('GetItemRelationType', (ctx) => {
    const ids = new Set(ctx.url.searchParams.getAll('id').map((id) => id.toLowerCase()))
    // Built in, so none of them can be deleted.
    return Response.json(
      port
        .types()
        .filter((t) => ids.has(t.id))
        .map((t) => ({ id: t.id, name: t.name, isDeletable: false, flags: [] })),
    )
  })

  router.handle('GetRelationByRelationTypeId', async (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await port.relations(String(ctx.params.id), page.value)
    return result ? Response.json(paged(result.items, result.total)) : missing()
  })
}

export function registerRecycleBinReferenceHandlers(
  router: ManagementApiRouter,
  port: ReferencePort,
): void {
  const ask = port.recycleBinReferencedBy?.bind(port)
  if (!ask) return
  for (const area of ['Document', 'Media', 'Element'] as const)
    router.handle(`GetRecycleBin${area}ReferencedBy`, async (ctx) => {
      // Umbraco pages these 20 at a time, as it does every references list.
      const page = parseSkipTake(ctx.url.searchParams, 20)
      if (!page.ok) return problemResponse(invalidSkipTake())
      const result = await ask(area, page.value)
      return Response.json(paged(result.items, result.total))
    })
}
