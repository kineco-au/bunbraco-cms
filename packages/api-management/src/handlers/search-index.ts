/**
 * The Examine dashboard: the indexes, their health, rebuilding one, and searching
 * one directly. An index with items still waiting reports itself rebuilding, which
 * is what makes the dashboard poll until they are done. docs/search.md.
 */
import { invalidSkipTake, problemDetails, problemResponse } from '@crombolo/core'
import type { SearchIndexInfo, SearchIndexPort } from '../ports.ts'
import type { ManagementApiRouter } from '../router.ts'
import { paging } from './content-type.ts'

const waiting = (n: number) => `${n} ${n === 1 ? 'item is' : 'items are'} waiting to be indexed`

function toIndexResponse(index: SearchIndexInfo) {
  return {
    name: index.name,
    healthStatus:
      index.pending > 0
        ? { status: 'Rebuilding', message: waiting(index.pending) }
        : { status: 'Healthy', message: null },
    canRebuild: true,
    searcherName: index.searcherName,
    documentCount: index.documentCount,
    fieldCount: index.fieldCount,
    providerProperties: null,
    uniqueKeyFieldName: '__Key',
  }
}

const indexNotFound = (name: string) =>
  problemResponse(
    problemDetails({
      title: 'Index Not Found',
      detail: `No index found with name = ${name}`,
      status: 400,
    }),
  )

export function registerSearchIndexHandlers(
  router: ManagementApiRouter,
  port: SearchIndexPort,
): void {
  router.handle('GetIndexer', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const indexes = await port.indexes()
    return Response.json({
      total: indexes.length,
      items: indexes.slice(page.skip, page.skip + page.take).map(toIndexResponse),
    })
  })

  router.handle('GetIndexerByIndexName', async ({ params }) => {
    const name = params.indexName as string
    const index = await port.index(name)
    return index ? Response.json(toIndexResponse(index)) : indexNotFound(name)
  })

  router.handle('PostIndexerByIndexNameRebuild', async ({ params }) => {
    const name = params.indexName as string
    return (await port.rebuild(name)) ? new Response(null, { status: 200 }) : indexNotFound(name)
  })

  router.handle('GetSearcher', (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const names = port.searchers()
    return Response.json({
      total: names.length,
      items: names.slice(page.skip, page.skip + page.take).map((name) => ({ name })),
    })
  })

  router.handle('GetSearcherBySearcherNameQuery', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const name = ctx.params.searcherName as string
    const result = await port.query(name, ctx.url.searchParams.get('term') ?? '', page)
    if (!result)
      return problemResponse(
        problemDetails({
          title: 'Searcher Not Found',
          detail: `No searcher found with name = ${name}`,
          status: 404,
        }),
      )
    return Response.json({
      total: result.total,
      items: result.items.map((hit) => ({
        id: hit.key,
        score: hit.score,
        fieldCount: hit.fields.length,
        fields: hit.fields,
      })),
    })
  })
}
