/**
 * The Media section: the tree, the editor, the collection view, the recycle bin
 * and the file URLs its thumbnails and pickers need.
 */
import type { DocumentAggregate, DocumentTreeItem } from '@bunbraco/core'
import {
  invalidSkipTake,
  notFound,
  problemDetails,
  problemResponse,
  ROOT_ACCESS,
} from '@bunbraco/core'
import type { MediaPort, PortFailure } from '../ports-content.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { created, paging } from './content-type.ts'
import { auditLogResponse, readBody, toSaveDocument, validationProblem } from './document.ts'
import { visibleChildren, visibleRoot, visibleSiblings } from './start-node-trees.ts'

const API = '/umbraco/management/api/v1'

const mediaTypeRef = (key: string, icon: string | null, collection?: string | null) => ({
  id: key,
  icon: icon ?? 'icon-picture',
  collection: collection ? { id: collection } : null,
})

export function toMediaResponse(media: DocumentAggregate) {
  return {
    id: media.key,
    isTrashed: media.isTrashed,
    mediaType: mediaTypeRef(
      media.contentTypeKey,
      media.contentTypeIcon,
      media.contentTypeCollectionKey,
    ),
    values: media.values.map((v) => ({
      alias: v.alias,
      culture: v.culture,
      segment: v.segment,
      value: v.value,
      editorAlias: v.editorAlias ?? '',
    })),
    variants: media.variants.map((v) => ({
      culture: v.culture,
      segment: v.segment,
      name: v.name,
      createDate: v.createDate.toISOString(),
      updateDate: v.updateDate.toISOString(),
    })),
    flags: [],
  }
}

const variantsOf = (item: DocumentTreeItem) =>
  item.variants.map((v) => ({ name: v.name, culture: v.culture }))

function toMediaTreeItem(item: DocumentTreeItem, noAccess = false) {
  return {
    id: item.key,
    parent: item.parentKey ? { id: item.parentKey } : null,
    hasChildren: item.hasChildren,
    noAccess,
    isTrashed: item.isTrashed,
    createDate: item.createDate.toISOString(),
    mediaType: mediaTypeRef(item.contentTypeKey, item.icon, item.contentTypeCollectionKey),
    variants: variantsOf(item),
    flags: [],
  }
}

function toMediaItem(item: DocumentTreeItem) {
  return {
    id: item.key,
    isTrashed: item.isTrashed,
    parent: item.parentKey ? { id: item.parentKey } : null,
    hasChildren: item.hasChildren,
    mediaType: mediaTypeRef(item.contentTypeKey, item.icon, item.contentTypeCollectionKey),
    variants: variantsOf(item),
    flags: [],
  }
}

function toMediaRecycleBinItem(item: DocumentTreeItem) {
  return {
    id: item.key,
    createDate: item.createDate.toISOString(),
    hasChildren: item.hasChildren,
    parent: item.parentKey ? { id: item.parentKey } : null,
    mediaType: mediaTypeRef(item.contentTypeKey, item.icon, item.contentTypeCollectionKey),
    variants: variantsOf(item),
  }
}

const refId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : null
}

const failed = (title: string, result: PortFailure) =>
  problemResponse(problemDetails({ title, status: result.status ?? 400, detail: result.reason }))

/** A media request as the document save shape: `mediaType` names the type. */
function toSaveMedia(key: string, body: Record<string, unknown>) {
  return {
    ...toSaveDocument(key, body),
    contentTypeKey: refId(body.mediaType) ?? '',
    componentKey: null,
  }
}

export function registerMediaHandlers(router: ManagementApiRouter, port: MediaPort): void {
  const mediaStart = (ctx: RequestContext) => ctx.principal?.startNodes.media ?? ROOT_ACCESS

  const principal = (ctx: RequestContext) => ctx.principal as NonNullable<typeof ctx.principal>
  const done = (ctx: RequestContext, message?: string) => {
    if (message) ctx.notifications.push({ message, category: 'Media', type: 'Success' })
    return new Response(null, { status: 200 })
  }

  router.handle('GetItemMediaTypeAllowed', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const found = await port.typesForExtension(ctx.url.searchParams.get('fileExtension') ?? '')
    return Response.json({
      total: found.length,
      items: found.slice(page.skip, page.skip + page.take).map((t) => ({
        id: t.key,
        name: t.name,
        icon: t.icon,
        matchedFileExtension: t.matched,
        flags: [],
      })),
    })
  })

  router.handle('GetItemMediaTypeFolders', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const found = await port.folderTypes()
    return Response.json({
      total: found.length,
      items: found
        .slice(page.skip, page.skip + page.take)
        .map((t) => ({ id: t.key, name: t.name, icon: t.icon, flags: [] })),
    })
  })

  router.handle('GetMediaConfiguration', () =>
    Response.json({ disableDeleteWhenReferenced: false, disableUnpublishWhenReferenced: false }),
  )

  router.handle('GetMediaById', async ({ params }) => {
    const media = await port.byKey(params.id as string)
    if (!media) return problemResponse(notFound('The media item could not be found'))
    return Response.json(toMediaResponse(media))
  })

  router.handle('PostMediaValidate', async (ctx) => {
    const body = await readBody(ctx)
    const input = toSaveMedia(crypto.randomUUID(), body)
    const errors = await port.validate(input)
    if (errors.length > 0) return problemResponse(validationProblem(errors, input.values))
    return new Response(null, { status: 200 })
  })

  router.handle('PutMediaByIdValidate', async (ctx) => {
    const key = ctx.params.id as string
    const existing = await port.byKey(key)
    if (!existing) return problemResponse(notFound('The media item could not be found'))
    const input = {
      ...toSaveMedia(key, await readBody(ctx)),
      contentTypeKey: existing.contentTypeKey,
    }
    const errors = await port.validate(input)
    if (errors.length > 0) return problemResponse(validationProblem(errors, input.values))
    return new Response(null, { status: 200 })
  })

  router.handle('PostMedia', async (ctx) => {
    const body = await readBody(ctx)
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const input = toSaveMedia(key, body)
    const errors = await port.validate(input)
    if (errors.length > 0) return problemResponse(validationProblem(errors, input.values))
    const result = await port.create(input, principal(ctx))
    if (!result.ok) return failed('Could not create the media item', result)
    return created(`${ctx.url.origin}${API}/media/${result.key}`, result.key)
  })

  router.handle('PutMediaById', async (ctx) => {
    const key = ctx.params.id as string
    const existing = await port.byKey(key)
    if (!existing) return problemResponse(notFound('The media item could not be found'))
    const input = {
      ...toSaveMedia(key, await readBody(ctx)),
      contentTypeKey: existing.contentTypeKey,
      parentKey: existing.parentKey,
    }
    const errors = await port.validate(input)
    if (errors.length > 0) return problemResponse(validationProblem(errors, input.values))
    const result = await port.update(key, input, principal(ctx))
    if (!result.ok) return failed('Could not save the media item', result)
    return done(ctx)
  })

  router.handle('DeleteMediaById', async (ctx) => {
    if (!(await port.remove(ctx.params.id as string)))
      return problemResponse(notFound('The media item could not be found'))
    return done(ctx)
  })

  router.handle('PutMediaByIdMoveToRecycleBin', async (ctx) => {
    if (!(await port.moveToRecycleBin(ctx.params.id as string)))
      return problemResponse(notFound('The media item could not be found'))
    return done(ctx)
  })

  router.handle('PutMediaByIdMove', async (ctx) => {
    const result = await port.move(ctx.params.id as string, refId((await readBody(ctx)).target))
    return result.ok ? done(ctx) : failed('Could not move the media item', result)
  })

  router.handle('PutMediaSort', async (ctx) => {
    const body = await readBody(ctx)
    if (!Array.isArray(body.sorting))
      return problemResponse(problemDetails({ title: 'sorting is required', status: 400 }))
    const sorting = (body.sorting as Array<Record<string, unknown>>).map((item) => ({
      key: String(item.id ?? ''),
      sortOrder: Number(item.sortOrder ?? 0),
    }))
    const result = await port.sort(refId(body.parent), sorting)
    return result.ok ? done(ctx) : failed('Could not sort', result)
  })

  const sortByField = async (ctx: RequestContext, parentKey: string | null) => {
    const body = await readBody(ctx)
    const field = String(body.field ?? '')
    const direction = String(body.direction ?? '')
    if (!['Name', 'CreateDate', 'UpdateDate'].includes(field))
      return problemResponse(problemDetails({ title: 'Unknown sort field', status: 400 }))
    if (!['Ascending', 'Descending'].includes(direction))
      return problemResponse(problemDetails({ title: 'Unknown sort direction', status: 400 }))
    const result = await port.sortChildrenBy(
      parentKey,
      field as 'Name' | 'CreateDate' | 'UpdateDate',
      direction as 'Ascending' | 'Descending',
    )
    return result.ok ? done(ctx) : failed('Could not sort', result)
  }
  router.handle('PutMediaByIdSortChildren', (ctx) => sortByField(ctx, ctx.params.id as string))
  router.handle('PutMediaRootSortChildren', (ctx) => sortByField(ctx, null))

  router.handle('GetMediaByIdAuditLog', (ctx) => auditLogResponse(ctx, port))

  /** Thumbnail and crop URLs in the query vocabulary the media route understands. */
  router.handle('GetImagingResizeUrls', async (ctx) => {
    const params = new URLSearchParams()
    const width = ctx.url.searchParams.get('width')
    const height = ctx.url.searchParams.get('height')
    const mode = ctx.url.searchParams.get('mode')
    const format = ctx.url.searchParams.get('format')
    if (width) params.set('width', width)
    if (height) params.set('height', height)
    if (mode) params.set('rmode', mode.toLowerCase())
    if (format) params.set('format', format)
    const query = params.toString()
    const found = await port.urls(ctx.url.searchParams.getAll('id'))
    return Response.json(
      found.map((m) => ({
        id: m.key,
        urlInfos: m.url ? [{ culture: null, url: query ? `${m.url}?${query}` : m.url }] : [],
      })),
    )
  })

  router.handle('GetMediaUrls', async (ctx) => {
    const found = await port.urls(ctx.url.searchParams.getAll('id'))
    return Response.json(
      found.map((m) => ({
        id: m.key,
        urlInfos: m.url ? [{ culture: null, url: m.url }] : [],
      })),
    )
  })

  // The tree and items
  router.handle('GetTreeMediaRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await visibleRoot(mediaStart(ctx), port, page)
    return Response.json({
      total: result.total,
      items: result.items.map((v) => toMediaTreeItem(v.item, v.noAccess)),
    })
  })
  router.handle('GetTreeMediaChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    const result = await visibleChildren(mediaStart(ctx), port, parentId, page)
    return Response.json({
      total: result.total,
      items: result.items.map((v) => toMediaTreeItem(v.item, v.noAccess)),
    })
  })
  router.handle('GetTreeMediaAncestors', async (ctx) => {
    const descendantId = ctx.url.searchParams.get('descendantId')
    if (!descendantId) return Response.json([])
    return Response.json((await port.treeAncestors(descendantId)).map((i) => toMediaTreeItem(i)))
  })
  router.handle('GetTreeMediaSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const found = await port.treeSiblings(
      target,
      Number(ctx.url.searchParams.get('before') ?? 0),
      Number(ctx.url.searchParams.get('after') ?? 0),
    )
    if (!found) return problemResponse(notFound('The media item could not be found'))
    const window = await visibleSiblings(mediaStart(ctx), port, found)
    return Response.json({
      totalBefore: window.totalBefore,
      totalAfter: window.totalAfter,
      items: window.items.map((v) => toMediaTreeItem(v.item, v.noAccess)),
    })
  })
  router.handle('GetItemMedia', async (ctx) =>
    Response.json((await port.items(ctx.url.searchParams.getAll('id'))).map(toMediaItem)),
  )
  router.handle('GetItemMediaAncestors', async (ctx) => {
    const result = []
    for (const id of ctx.url.searchParams.getAll('id'))
      result.push({ id, ancestors: (await port.treeAncestors(id)).map(toMediaItem) })
    return Response.json(result)
  })
  router.handle('GetItemMediaSearch', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    const result = await port.search(ctx.url.searchParams.get('query') ?? '', {
      trashed: ctx.url.searchParams.get('trashed') === 'true',
      parentKey: parentId,
      ...page,
    })
    return Response.json({ total: result.total, items: result.items.map(toMediaItem) })
  })

  router.handle('GetCollectionMedia', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const direction =
      ctx.url.searchParams.get('orderDirection') === 'Descending' ? 'Descending' : 'Ascending'
    const result = await port.collection(ctx.url.searchParams.get('id'), {
      ...page,
      filter: ctx.url.searchParams.get('filter') ?? undefined,
      orderBy: ctx.url.searchParams.get('orderBy') ?? 'sortOrder',
      orderDirection: direction,
    })
    return Response.json({
      total: result.total,
      items: result.items.map((media) => ({
        ...toMediaResponse(media),
        mediaType: {
          ...mediaTypeRef(
            media.contentTypeKey,
            media.contentTypeIcon,
            media.contentTypeCollectionKey,
          ),
          alias: media.contentTypeAlias,
        },
        creator: media.creator,
        sortOrder: media.sortOrder,
      })),
    })
  })

  // The recycle bin
  router.handle('GetRecycleBinMediaRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    // Only root access reaches the recycle bin
    if (!mediaStart(ctx).root) return Response.json({ total: 0, items: [] })
    const result = await port.recycleBin(null, page)
    return Response.json({ total: result.total, items: result.items.map(toMediaRecycleBinItem) })
  })
  router.handle('GetRecycleBinMediaChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    if (!mediaStart(ctx).root) return Response.json({ total: 0, items: [] })
    const result = await port.recycleBin(parentId, page)
    return Response.json({ total: result.total, items: result.items.map(toMediaRecycleBinItem) })
  })
  router.handle('GetRecycleBinMediaSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const window = await port.treeSiblings(
      target,
      Number(ctx.url.searchParams.get('before') ?? 0),
      Number(ctx.url.searchParams.get('after') ?? 0),
    )
    if (!window) return problemResponse(notFound('The media item could not be found'))
    return Response.json({
      totalBefore: window.totalBefore,
      totalAfter: window.totalAfter,
      items: window.items.map(toMediaRecycleBinItem),
    })
  })
  router.handle('GetRecycleBinMediaByIdOriginalParent', async ({ params }) => {
    const parent = await port.originalParent(params.id as string)
    if (parent === undefined) return problemResponse(notFound('The media item could not be found'))
    return Response.json(parent ? { id: parent } : null)
  })
  router.handle('PutRecycleBinMediaByIdRestore', async (ctx) => {
    const body = await readBody(ctx)
    const target = 'target' in body ? refId(body.target) : undefined
    const result = await port.restore(ctx.params.id as string, target ?? undefined)
    return result.ok ? done(ctx) : failed('Could not restore', result)
  })
  router.handle('DeleteRecycleBinMediaById', async (ctx) => {
    const key = ctx.params.id as string
    const media = await port.byKey(key)
    if (!media) return problemResponse(notFound('The media item could not be found'))
    if (!media.isTrashed)
      return problemResponse(
        problemDetails({ title: 'The media item is not in the recycle bin', status: 400 }),
      )
    await port.remove(key)
    return done(ctx)
  })
  router.handle('DeleteRecycleBinMedia', async (ctx) => {
    await port.emptyRecycleBin()
    return done(ctx)
  })

  // References arrive with relations (WP-6.9); nothing is known to refer yet.
  for (const operation of [
    'GetMediaByIdReferencedBy',
    'GetMediaByIdReferencedDescendants',
    'GetMediaAreReferenced',
  ])
    router.handle(operation, (ctx) => {
      if (!paging(ctx)) return problemResponse(invalidSkipTake())
      return Response.json({ total: 0, items: [] })
    })
}
