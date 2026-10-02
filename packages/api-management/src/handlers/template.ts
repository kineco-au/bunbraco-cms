/**
 * Templates. The record holds the alias; the view file on disk holds the markup,
 * and the editor reads and writes it through `content`.
 */
import type { ResponseOf } from '@bunbraco/contracts'
import type { TemplateModel } from '@bunbraco/core'
import { invalidSkipTake, notFound, problemDetails, problemResponse } from '@bunbraco/core'
import type { TemplatePort } from '../ports-content.ts'
import type { ManagementApiRouter } from '../router.ts'
import { created, paging, toTreeItemResponse } from './content-type.ts'

function toResponse(model: TemplateModel): ResponseOf<'GetTemplateById'> {
  return {
    id: model.key,
    name: model.name,
    alias: model.alias,
    content: model.content,
    // The contract keeps the older name beside the one the client reads
    layoutTemplate: model.masterKey ? { id: model.masterKey } : null,
    masterTemplate: model.masterKey ? { id: model.masterKey } : null,
  } as ResponseOf<'GetTemplateById'>
}

export function registerTemplateHandlers(router: ManagementApiRouter, port: TemplatePort): void {
  router.handle('GetTemplateById', async ({ params }) => {
    const model = await port.byKey(params.id as string)
    if (!model) return problemResponse(notFound('The template could not be found'))
    return Response.json(toResponse(model))
  })

  router.handle('PostTemplate', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const name = String(body.name ?? '')
    const alias = String(body.alias ?? name)
    await port.save(
      {
        key,
        name,
        alias,
        content: typeof body.content === 'string' ? body.content : port.scaffold(name, alias),
      },
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    ctx.notifications.push({ message: 'Template created', category: 'Template', type: 'Success' })
    return created(`${ctx.url.origin}/umbraco/management/api/v1/template/${key}`, key)
  })

  router.handle('PutTemplateById', async (ctx) => {
    const key = ctx.params.id as string
    const existing = await port.byKey(key)
    if (!existing) return problemResponse(notFound('The template could not be found'))
    const body = (await ctx.request.json()) as Record<string, unknown>
    await port.save(
      {
        key,
        name: String(body.name ?? existing.name),
        alias: String(body.alias ?? existing.alias),
        content: typeof body.content === 'string' ? body.content : existing.content,
      },
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    ctx.notifications.push({ message: 'Template saved', category: 'Template', type: 'Success' })
    return new Response(null, { status: 200 })
  })

  router.handle('DeleteTemplateById', async (ctx) => {
    const removed = await port.remove(ctx.params.id as string)
    if (!removed) return problemResponse(notFound('The template could not be found'))
    return new Response(null, { status: 200 })
  })

  router.handle('GetTreeTemplateRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.root(page)
    return Response.json({ total: result.total, items: result.items.map(toTreeItemResponse) })
  })

  router.handle('GetTreeTemplateChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    const result = await port.children(parentId, page)
    return Response.json({ total: result.total, items: result.items.map(toTreeItemResponse) })
  })

  router.handle('GetTreeTemplateAncestors', async (ctx) => {
    const descendantId = ctx.url.searchParams.get('descendantId')
    // Umbraco binds a missing id to an empty GUID and answers with no ancestors.
    if (!descendantId) return Response.json([])
    return Response.json((await port.ancestors(descendantId)).map(toTreeItemResponse))
  })

  /** A template's ancestors are its layout chain, outermost first. */
  router.handle('GetItemTemplateAncestors', async (ctx) => {
    const result = []
    for (const id of ctx.url.searchParams.getAll('id')) {
      const ancestors = []
      for (const item of await port.ancestors(id)) {
        const model = await port.byKey(item.key)
        ancestors.push({ id: item.key, name: item.name, alias: model?.alias ?? '', flags: [] })
      }
      result.push({ id, ancestors })
    }
    return Response.json(result)
  })

  router.handle('GetTreeTemplateSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const window = await port.siblings(
      target,
      Number(ctx.url.searchParams.get('before') ?? 0),
      Number(ctx.url.searchParams.get('after') ?? 0),
    )
    if (!window) return problemResponse(notFound('The template could not be found'))
    return Response.json({ ...window, items: window.items.map(toTreeItemResponse) })
  })

  router.handle('GetItemTemplateSearch', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.search(ctx.url.searchParams.get('query') ?? '', page)
    return Response.json({
      total: result.total,
      items: result.items.map((t) => ({ id: t.key, name: t.name, alias: t.alias, flags: [] })),
    })
  })

  router.handle('GetItemTemplate', async (ctx) => {
    const keys = ctx.url.searchParams.getAll('id')
    const items = await port.items(keys)
    // The template editor writes the master template's alias into the view
    const aliases = await Promise.all(
      items.map(async (item) => (await port.byKey(item.key))?.alias),
    )
    return Response.json(
      items.map((item, i) => ({
        id: item.key,
        name: item.name,
        alias: aliases[i] ?? null,
        flags: [],
      })),
    )
  })
}
