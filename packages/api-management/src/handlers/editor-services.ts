/**
 * Services property editors call while editing: tag suggestions and embed
 * markup for the rich text editor.
 */
import { invalidSkipTake, problemDetails, problemResponse } from '@bunbraco/core'
import type { OEmbedPort, TagPort } from '../ports.ts'
import type { ManagementApiRouter } from '../router.ts'
import { paging } from './content-type.ts'

export function registerEditorServiceHandlers(
  router: ManagementApiRouter,
  services: { tags?: TagPort; oembed?: OEmbedPort },
): void {
  const { tags, oembed } = services
  if (tags)
    router.handle('GetTag', async (ctx) => {
      const page = paging(ctx)
      if (!page) return problemResponse(invalidSkipTake())
      const culture = ctx.url.searchParams.get('culture')
      const found = await tags.list({
        query: ctx.url.searchParams.get('query') ?? undefined,
        group: ctx.url.searchParams.get('tagGroup') ?? undefined,
        culture: culture === null ? undefined : culture || null,
      })
      return Response.json({
        total: found.length,
        items: found.slice(page.skip, page.skip + page.take).map((t) => ({
          id: t.id,
          text: t.text,
          group: t.group,
          nodeCount: t.nodeCount,
        })),
      })
    })

  if (oembed)
    router.handle('GetOembedQuery', async (ctx) => {
      const url = ctx.url.searchParams.get('url') ?? ''
      const number = (name: string) => {
        const value = Number(ctx.url.searchParams.get(name))
        return Number.isFinite(value) && value > 0 ? value : undefined
      }
      const result = await oembed.markup(url, number('maxWidth'), number('maxHeight'))
      if (result.ok) return Response.json({ markup: result.markup })
      return problemResponse(
        result.status === 'unsupported'
          ? problemDetails({
              title: 'The specified url is not supported.',
              detail: result.reason,
              status: 400,
            })
          : problemDetails({
              title: 'The embed could not be retrieved.',
              detail: result.reason,
              status: 502,
            }),
      )
    })
}
