/**
 * Document blueprints: their tree and folders in Settings, the editor, "Create
 * Document Blueprint" from a page, and the scaffold a new page starts from.
 */
import type { DocumentAggregate, TreeItem } from '@bunbraco/core'
import { invalidSkipTake, notFound, problemDetails, problemResponse } from '@bunbraco/core'
import type { BlueprintPort, PortFailure } from '../ports-content.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { created, paging, registerFolderHandlers } from './content-type.ts'
import { auditLogResponse, readBody, toDocumentResponse, toSaveDocument } from './document.ts'

const API = '/umbraco/management/api/v1'

function toBlueprintResponse(aggregate: DocumentAggregate, id = aggregate.key) {
  const document = toDocumentResponse(aggregate)
  return {
    id,
    documentType: document.documentType,
    values: document.values,
    variants: document.variants.map((variant) => ({ ...variant, id, state: 'Draft' })),
    flags: [],
  }
}

function toBlueprintTreeItem(item: TreeItem) {
  return {
    id: item.key,
    name: item.name,
    isFolder: item.isFolder,
    noAccess: false,
    hasChildren: item.hasChildren,
    parent: item.parentKey ? { id: item.parentKey } : null,
    documentType: item.isFolder
      ? null
      : { id: item.contentTypeKey ?? '', icon: item.icon ?? 'icon-blueprint', collection: null },
    flags: [],
  }
}

const refId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : null
}

const failed = (title: string, result: PortFailure) =>
  problemResponse(problemDetails({ title, status: result.status ?? 400, detail: result.reason }))

export function registerDocumentBlueprintHandlers(
  router: ManagementApiRouter,
  port: BlueprintPort,
): void {
  const principal = (ctx: RequestContext) => ctx.principal as NonNullable<typeof ctx.principal>
  const notifyDone = (ctx: RequestContext, message: string) =>
    ctx.notifications.push({ message, category: 'Document Blueprint', type: 'Success' })

  router.handle('GetDocumentBlueprintById', async ({ params }) => {
    const blueprint = await port.byKey(params.id as string)
    if (!blueprint) return problemResponse(notFound('The blueprint could not be found'))
    return Response.json(toBlueprintResponse(blueprint))
  })

  /** A fresh copy to start a page from: the blueprint's values under a new id. */
  router.handle('GetDocumentBlueprintByIdScaffold', async ({ params }) => {
    const blueprint = await port.byKey(params.id as string)
    if (!blueprint) return problemResponse(notFound('The blueprint could not be found'))
    return Response.json(toBlueprintResponse(blueprint, crypto.randomUUID()))
  })

  router.handle('PostDocumentBlueprint', async (ctx) => {
    const body = await readBody(ctx)
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const result = await port.create(toSaveDocument(key, body), principal(ctx))
    if (!result.ok) return failed('Could not create the blueprint', result)
    notifyDone(ctx, 'Document Blueprint saved')
    return created(`${ctx.url.origin}${API}/document-blueprint/${key}`, key)
  })

  router.handle('PutDocumentBlueprintById', async (ctx) => {
    const key = ctx.params.id as string
    const existing = await port.byKey(key)
    if (!existing) return problemResponse(notFound('The blueprint could not be found'))
    const body = await readBody(ctx)
    const result = await port.update(
      key,
      {
        ...toSaveDocument(key, body),
        contentTypeKey: existing.contentTypeKey,
        parentKey: existing.parentKey,
      },
      principal(ctx),
    )
    if (!result.ok) return failed('Could not save the blueprint', result)
    notifyDone(ctx, 'Document Blueprint saved')
    return new Response(null, { status: 200 })
  })

  router.handle('DeleteDocumentBlueprintById', async (ctx) => {
    const removed = await port.remove(ctx.params.id as string)
    if (!removed) return problemResponse(notFound('The blueprint could not be found'))
    return new Response(null, { status: 200 })
  })

  router.handle('PostDocumentBlueprintFromDocument', async (ctx) => {
    const body = await readBody(ctx)
    const documentKey = refId(body.document)
    const name = String(body.name ?? '').trim()
    if (!documentKey || !name)
      return problemResponse(
        problemDetails({ title: 'A document and a name are required', status: 400 }),
      )
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const result = await port.fromDocument(
      documentKey,
      { key, name, parentKey: refId(body.parent) },
      principal(ctx),
    )
    if (!result.ok) return failed('Could not create the blueprint', result)
    notifyDone(ctx, 'Document Blueprint created')
    return created(`${ctx.url.origin}${API}/document-blueprint/${result.key}`, result.key)
  })

  router.handle('PutDocumentBlueprintByIdMove', async (ctx) => {
    const result = await port.move(ctx.params.id as string, refId((await readBody(ctx)).target))
    if (!result.ok) return failed('Could not move the blueprint', result)
    return new Response(null, { status: 200 })
  })

  router.handle('GetDocumentBlueprintByIdAuditLog', (ctx) => auditLogResponse(ctx, port))

  router.handle('GetDocumentTypeByIdBlueprint', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.forDocumentType(ctx.params.id as string, page)
    return Response.json({
      total: result.total,
      items: result.items.map((b) => ({ id: b.key, name: b.name, flags: [] })),
    })
  })

  router.handle('GetItemDocumentBlueprint', async (ctx) => {
    const found = await port.items(ctx.url.searchParams.getAll('id'))
    return Response.json(
      found.map((b) => ({
        id: b.key,
        name: b.name,
        documentType: { id: b.contentTypeKey, icon: b.icon, collection: null },
        flags: [],
      })),
    )
  })

  const foldersOnly = (ctx: RequestContext) => ctx.url.searchParams.get('foldersOnly') === 'true'
  router.handle('GetTreeDocumentBlueprintRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.treeRoot({ ...page, foldersOnly: foldersOnly(ctx) })
    return Response.json({ total: result.total, items: result.items.map(toBlueprintTreeItem) })
  })
  router.handle('GetTreeDocumentBlueprintChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    const result = await port.treeChildren(parentId, { ...page, foldersOnly: foldersOnly(ctx) })
    return Response.json({ total: result.total, items: result.items.map(toBlueprintTreeItem) })
  })
  router.handle('GetTreeDocumentBlueprintAncestors', async (ctx) => {
    const descendantId = ctx.url.searchParams.get('descendantId')
    if (!descendantId) return Response.json([])
    return Response.json((await port.treeAncestors(descendantId)).map(toBlueprintTreeItem))
  })
  router.handle('GetTreeDocumentBlueprintSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const window = await port.treeSiblings(
      target,
      Number(ctx.url.searchParams.get('before') ?? 0),
      Number(ctx.url.searchParams.get('after') ?? 0),
      foldersOnly(ctx),
    )
    if (!window) return problemResponse(notFound('The item could not be found'))
    return Response.json({
      totalBefore: window.totalBefore,
      totalAfter: window.totalAfter,
      items: window.items.map(toBlueprintTreeItem),
    })
  })

  registerFolderHandlers(router, 'DocumentBlueprint', port.folders, toBlueprintTreeItem)
}
