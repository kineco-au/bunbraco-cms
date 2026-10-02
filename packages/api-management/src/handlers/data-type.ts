/** Data types: the property editor behind each property, plus its configuration. */
import type { ResponseOf } from '@bunbraco/contracts'
import type { DataTypeModel, TreeItem } from '@bunbraco/core'
import { invalidSkipTake, notFound, problemDetails, problemResponse } from '@bunbraco/core'
import type { DataTypePort } from '../ports-content.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import {
  created,
  paging,
  refOf,
  registerFolderHandlers,
  toTreeItemResponse,
} from './content-type.ts'

function toResponse(model: DataTypeModel): ResponseOf<'GetDataTypeById'> {
  return {
    id: model.key,
    name: model.name,
    editorAlias: model.editorAlias,
    editorUiAlias: model.editorUiAlias,
    values: model.values.map((value) => ({ alias: value.alias, value: value.value })),
    isDeletable: true,
    canIgnoreStartNodes: false,
  } as ResponseOf<'GetDataTypeById'>
}

function fromRequest(key: string, body: Record<string, unknown>): DataTypeModel {
  const values = Array.isArray(body.values)
    ? (body.values as Array<{ alias?: unknown; value?: unknown }>).map((value) => ({
        alias: String(value.alias ?? ''),
        value: value.value,
      }))
    : []
  return {
    key,
    alias: null,
    name: String(body.name ?? ''),
    editorAlias: String(body.editorAlias ?? ''),
    editorUiAlias: (body.editorUiAlias as string | null) ?? null,
    // The storage type is a property of the editor, not of the request.
    dbType: 'Ntext',
    values,
    parentKey:
      body.parent && typeof body.parent === 'object' && 'id' in body.parent
        ? String((body.parent as { id: unknown }).id)
        : null,
  }
}

export function registerDataTypeHandlers(router: ManagementApiRouter, port: DataTypePort): void {
  router.handle('GetDataTypeByIdSchema', async (ctx) => {
    const schema = await port.valueSchema(ctx.params.id as string)
    if (!schema) return problemResponse(notFound('The data type could not be found'))
    return Response.json(schema)
  })

  router.handle('GetDataTypeSchemasBatch', async (ctx) => {
    const ids = ctx.url.searchParams.getAll('id')
    const items = []
    for (const id of ids) {
      const schema = await port.valueSchema(id)
      // Umbraco reports a missing one in the row rather than failing the batch.
      items.push(
        schema
          ? { id, ...schema, error: null }
          : { id, valueTypeName: null, jsonSchema: null, error: 'Not found' },
      )
    }
    return Response.json({ total: items.length, items })
  })

  router.handle('GetDataTypeById', async ({ params }) => {
    const model = await port.byKey(params.id as string)
    if (!model) return problemResponse(notFound('The data type could not be found'))
    return Response.json(toResponse(model))
  })

  router.handle('GetDataTypeBatch', async (ctx) => {
    const keys = ctx.url.searchParams.getAll('id')
    const models = await port.byKeys(keys)
    return Response.json({ total: models.length, items: models.map(toResponse) })
  })

  router.handle('PostDataType', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    await port.save(fromRequest(key, body), ctx.principal as NonNullable<typeof ctx.principal>)
    ctx.notifications.push({ message: 'Data type created', category: 'Data Type', type: 'Success' })
    return created(`${ctx.url.origin}/umbraco/management/api/v1/data-type/${key}`, key)
  })

  router.handle('PutDataTypeById', async (ctx) => {
    const key = ctx.params.id as string
    const existing = await port.byKey(key)
    if (!existing) return problemResponse(notFound('The data type could not be found'))
    const body = (await ctx.request.json()) as Record<string, unknown>
    // Keep the storage type the editor was created with.
    await port.save(
      { ...fromRequest(key, body), dbType: existing.dbType },
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    ctx.notifications.push({ message: 'Data type saved', category: 'Data Type', type: 'Success' })
    return new Response(null, { status: 200 })
  })

  router.handle('DeleteDataTypeById', async (ctx) => {
    const removed = await port.remove(ctx.params.id as string)
    if (removed === 'in-use')
      return problemResponse(
        problemDetails({
          title: 'The data type is in use',
          status: 400,
          detail: 'Remove it from every document type that uses it first.',
          operationStatus: 'InUse',
        }),
      )
    if (!removed) return problemResponse(notFound('The data type could not be found'))
    return new Response(null, { status: 200 })
  })

  const foldersOnly = (ctx: RequestContext) => ctx.url.searchParams.get('foldersOnly') === 'true'
  const toDataTypeTreeItem = (item: TreeItem) => ({
    ...toTreeItemResponse(item),
    editorUiAlias: item.editorUiAlias ?? null,
    isDeletable: true,
    noAccess: false,
  })

  router.handle('GetTreeDataTypeRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.treeRoot({ ...page, foldersOnly: foldersOnly(ctx) })
    return Response.json({ total: result.total, items: result.items.map(toDataTypeTreeItem) })
  })

  router.handle('GetTreeDataTypeChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    const result = await port.treeChildren(parentId, { ...page, foldersOnly: foldersOnly(ctx) })
    return Response.json({ total: result.total, items: result.items.map(toDataTypeTreeItem) })
  })

  router.handle('GetTreeDataTypeAncestors', async (ctx) => {
    const descendantId = ctx.url.searchParams.get('descendantId')
    // Umbraco binds a missing id to an empty GUID and answers with no ancestors.
    if (!descendantId) return Response.json([])
    return Response.json((await port.ancestors(descendantId)).map(toDataTypeTreeItem))
  })

  router.handle('GetItemDataTypeAncestors', async (ctx) => {
    const result = []
    for (const id of ctx.url.searchParams.getAll('id'))
      result.push({
        id,
        ancestors: (await port.ancestors(id)).map((a) => ({ id: a.key, name: a.name, flags: [] })),
      })
    return Response.json(result)
  })

  router.handle('GetTreeDataTypeSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const window = await port.folders.siblings(
      target,
      Number(ctx.url.searchParams.get('before') ?? 0),
      Number(ctx.url.searchParams.get('after') ?? 0),
      foldersOnly(ctx),
    )
    if (!window) return problemResponse(notFound('The data type could not be found'))
    return Response.json({ ...window, items: window.items.map(toDataTypeTreeItem) })
  })

  const toItem = (model: DataTypeModel) => ({
    id: model.key,
    name: model.name,
    editorAlias: model.editorAlias,
    editorUiAlias: model.editorUiAlias,
    isDeletable: true,
    flags: [],
  })

  router.handle('GetFilterDataType', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const q = ctx.url.searchParams
    const result = await port.filter(
      {
        name: q.get('name') ?? undefined,
        editorAlias: q.get('editorAlias') ?? undefined,
        editorUiAlias: q.get('editorUiAlias') ?? undefined,
      },
      page,
    )
    return Response.json({ total: result.total, items: result.items.map(toItem) })
  })

  router.handle('GetItemDataTypeSearch', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.search(ctx.url.searchParams.get('query') ?? '', page)
    return Response.json({ total: result.total, items: result.items.map(toItem) })
  })

  router.handle('GetDataTypeByIdReferencedBy', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const refs = await port.referencedBy(ctx.params.id as string)
    return Response.json({
      total: refs.length,
      items: refs.slice(page.skip, page.skip + page.take).map((r) => ({
        $type: 'DocumentTypePropertyTypeReferenceResponseModel',
        id: r.propertyKey,
        alias: r.alias,
        name: r.name,
        documentType: {
          id: r.contentType.key,
          alias: r.contentType.alias,
          name: r.contentType.name,
          icon: r.contentType.icon,
        },
      })),
    })
  })

  router.handle('GetDataTypeConfiguration', () =>
    Response.json({
      canBeChanged: 'True',
      documentListViewId: 'c0808dd3-8133-4e4b-8ce8-e2bea84a96a4',
      mediaListViewId: '3a0156c4-3b8c-4803-bdc1-6871faa83fff',
    }),
  )

  router.handle('PutDataTypeByIdMove', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const moved = await port.move(ctx.params.id as string, refOf(body.target))
    if (!moved) return problemResponse(notFound('The data type could not be found'))
    return new Response(null, { status: 200 })
  })

  router.handle('PostDataTypeByIdCopy', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const copy = await port.copy(ctx.params.id as string, refOf(body.target))
    if (!copy) return problemResponse(notFound('The data type could not be found'))
    return created(`${ctx.url.origin}/umbraco/management/api/v1/data-type/${copy.key}`, copy.key)
  })

  registerFolderHandlers(router, 'DataType', port.folders, toDataTypeTreeItem)

  router.handle('GetItemDataType', async (ctx) => {
    const keys = ctx.url.searchParams.getAll('id')
    const models = await port.byKeys(keys)
    return Response.json(
      models.map((model) => ({
        id: model.key,
        name: model.name,
        editorAlias: model.editorAlias,
        editorUiAlias: model.editorUiAlias,
        isDeletable: true,
        flags: [],
      })),
    )
  })
}
