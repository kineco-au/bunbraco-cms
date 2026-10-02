/**
 * The Library section: Umbraco 18's Elements, and the folders they sit in.
 *
 * An element is publishable, versioned content with no URL and no template, so
 * this mirrors the document handlers without the parts a route needs — no URLs,
 * no preview, no schedules, no domains. The contract keys an element's type as
 * `documentType`, because an element type *is* a document type carrying
 * `isElement`; the Library offers the ones that also carry `allowedInLibrary`,
 * which `document-type/allowed-in-library` answers.
 *
 * The tree mixes folders and elements. A folder reports `documentType: null` and a
 * single `NotCreated` variant, which is the contract's way of saying there is no
 * content at that row.
 */
import type { DocumentAggregate, ElementTreeItem } from '@bunbraco/core'
import { invalidSkipTake, notFound, problemDetails, problemResponse } from '@bunbraco/core'
import type { ElementPort, PortFailure, ReferencePort } from '../ports-content.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { created, paging, registerFolderHandlers } from './content-type.ts'
import { auditLogResponse, failureResponse, readBody, toSaveDocument } from './document.ts'

const API = '/umbraco/management/api/v1'

const typeRef = (key: string, icon: string | null, collection?: string | null) => ({
  id: key,
  icon: icon ?? 'icon-document',
  collection: collection ? { id: collection } : null,
})

export function toElementResponse(element: DocumentAggregate) {
  return {
    id: element.key,
    isTrashed: element.isTrashed,
    documentType: typeRef(
      element.contentTypeKey,
      element.contentTypeIcon,
      element.contentTypeCollectionKey,
    ),
    values: element.values.map((v) => ({
      alias: v.alias,
      culture: v.culture,
      segment: v.segment,
      value: v.value,
      editorAlias: v.editorAlias ?? '',
    })),
    variants: element.variants.map((v) => ({
      id: element.key,
      culture: v.culture,
      segment: v.segment,
      name: v.name,
      state: v.state,
      createDate: v.createDate.toISOString(),
      updateDate: v.updateDate.toISOString(),
      publishDate: v.publishDate?.toISOString() ?? null,
      scheduledPublishDate: null,
      scheduledUnpublishDate: null,
      flags: [],
    })),
    flags: [],
  }
}

const variantItems = (item: ElementTreeItem) =>
  item.variants.map((v) => ({
    id: item.key,
    name: v.name,
    culture: v.culture,
    state: v.state,
    flags: [],
  }))

/** One shape serves the tree and the recycle bin; the contract's models match. */
function toElementTreeItem(item: ElementTreeItem, noAccess = false) {
  return {
    id: item.key,
    name: item.name,
    parent: item.parentKey ? { id: item.parentKey } : null,
    hasChildren: item.hasChildren,
    isFolder: item.isFolder,
    noAccess,
    createDate: item.createDate.toISOString(),
    documentType: item.isFolder
      ? null
      : typeRef(item.contentTypeKey, item.icon, item.contentTypeCollectionKey),
    variants: variantItems(item),
    flags: [],
  }
}

function toElementItem(item: ElementTreeItem) {
  return {
    id: item.key,
    isTrashed: item.isTrashed,
    parent: item.parentKey ? { id: item.parentKey } : null,
    hasChildren: item.hasChildren,
    documentType: item.isFolder
      ? null
      : typeRef(item.contentTypeKey, item.icon, item.contentTypeCollectionKey),
    variants: variantItems(item),
    flags: [],
  }
}

const readCultures = (body: Record<string, unknown>): string[] | null => {
  const raw = body.cultures ?? body.culturesToPublish
  if (!Array.isArray(raw)) return null
  const cultures = raw.filter((c): c is string => typeof c === 'string' && c.length > 0)
  return cultures.length > 0 ? cultures : null
}

const refId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : null
}

export function registerElementHandlers(
  router: ManagementApiRouter,
  port: ElementPort,
  /** For the warning a folder delete shows: what points into the branch. */
  references?: ReferencePort,
): void {
  const has = (id: string) => router.operations.some((o) => o.operationId === id)
  const handle = (id: string, handler: Parameters<ManagementApiRouter['handle']>[1]) => {
    if (has(id)) router.handle(id, handler)
  }
  const foldersOnly = (ctx: RequestContext) => ctx.url.searchParams.get('foldersOnly') === 'true'
  const failed = (title: string, result: PortFailure) =>
    problemResponse(problemDetails({ title, status: result.status ?? 400, detail: result.reason }))
  const done = (ctx: RequestContext, message: string) => {
    ctx.notifications.push({ message, category: 'Element', type: 'Success' })
    return new Response(null, { status: 200 })
  }

  registerFolderHandlers(router, 'Element', port.folders)

  // ── the tree ──────────────────────────────────────────────────────────────
  handle('GetTreeElementRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.treeRoot({ ...page, foldersOnly: foldersOnly(ctx) })
    return Response.json({
      total: result.total,
      items: result.items.map((i) => toElementTreeItem(i)),
    })
  })

  handle('GetTreeElementChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    const result = await port.treeChildren(parentId, { ...page, foldersOnly: foldersOnly(ctx) })
    return Response.json({
      total: result.total,
      items: result.items.map((i) => toElementTreeItem(i)),
    })
  })

  handle('GetTreeElementAncestors', async (ctx) => {
    const descendantId = ctx.url.searchParams.get('descendantId')
    if (!descendantId) return Response.json([])
    return Response.json((await port.ancestors(descendantId)).map((i) => toElementTreeItem(i)))
  })

  handle('GetTreeElementSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const before = Number(ctx.url.searchParams.get('before') ?? 0)
    const after = Number(ctx.url.searchParams.get('after') ?? 0)
    const found = await port.treeSiblings(target, before, after)
    if (!found) return problemResponse(notFound('The element could not be found'))
    return Response.json({
      totalBefore: found.totalBefore,
      totalAfter: found.totalAfter,
      items: found.items.map((i) => toElementTreeItem(i)),
    })
  })

  // ── item lookups a picker makes ───────────────────────────────────────────
  handle('GetItemElement', async (ctx) => {
    const keys = ctx.url.searchParams.getAll('id')
    return Response.json((await port.items(keys)).map(toElementItem))
  })

  handle('GetItemElementAncestors', async (ctx) => {
    const descendantId = ctx.url.searchParams.get('descendantId')
    if (!descendantId) return Response.json([])
    return Response.json((await port.ancestors(descendantId)).map(toElementItem))
  })

  handle('GetItemElementSearch', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const query = ctx.url.searchParams.get('query') ?? ''
    const parentId = ctx.url.searchParams.get('parentId')
    const result = await port.search(query, { ...page, parentKey: parentId ?? undefined })
    return Response.json({ total: result.total, items: result.items.map(toElementItem) })
  })

  // ── the editor ────────────────────────────────────────────────────────────
  handle('GetElementConfiguration', () =>
    Response.json({
      disableDeleteWhenReferenced: false,
      disableUnpublishWhenReferenced: false,
      allowEditInvariantFromNonDefault: true,
      allowNonExistingSegmentsCreation: false,
    }),
  )

  handle('GetElementById', async (ctx) => {
    const element = await port.byKey(ctx.params.id as string)
    if (!element) return problemResponse(notFound('The element could not be found'))
    return Response.json(toElementResponse(element))
  })

  handle('GetElementByIdPublished', async (ctx) => {
    const element = await port.byKeyPublished(ctx.params.id as string)
    if (!element) return problemResponse(notFound('The element is not published'))
    return Response.json(toElementResponse(element))
  })

  handle('PostElement', async (ctx) => {
    const body = await readBody(ctx)
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const input = toSaveDocument(key, body)
    const result = await port.create(input, ctx.principal as NonNullable<typeof ctx.principal>)
    if (!result.ok) return failureResponse('Could not create the element', result, input.values)
    ctx.notifications.push({ message: 'Element created', category: 'Element', type: 'Success' })
    return created(`${ctx.url.origin}${API}/element/${result.key}`, result.key)
  })

  handle('PutElementById', async (ctx) => {
    const key = ctx.params.id as string
    const existing = await port.byKey(key)
    if (!existing) return problemResponse(notFound('The element could not be found'))
    const body = await readBody(ctx)
    const input = { ...toSaveDocument(key, body), contentTypeKey: existing.contentTypeKey }
    const result = await port.update(key, input, ctx.principal as NonNullable<typeof ctx.principal>)
    if (!result.ok) return failureResponse('Could not save the element', result, input.values)
    return done(ctx, 'Element saved')
  })

  handle('PostElementCreateAndPublish', async (ctx) => {
    const body = await readBody(ctx)
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const input = toSaveDocument(key, body)
    const result = await port.createAndPublish(
      input,
      readCultures(body),
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) return failureResponse('Could not create the element', result, input.values)
    ctx.notifications.push({ message: 'Element published', category: 'Element', type: 'Success' })
    return created(`${ctx.url.origin}${API}/element/${result.key}`, result.key)
  })

  handle('PutElementByIdUpdateAndPublish', async (ctx) => {
    const key = ctx.params.id as string
    const body = await readBody(ctx)
    const existing = await port.byKey(key)
    if (!existing) return problemResponse(notFound('The element could not be found'))
    const input = { ...toSaveDocument(key, body), contentTypeKey: existing.contentTypeKey }
    const result = await port.updateAndPublish(
      key,
      input,
      readCultures(body),
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) return failureResponse('Could not publish the element', result, input.values)
    return done(ctx, 'Element published')
  })

  const validateHandler = async (ctx: RequestContext) => {
    const body = await readBody(ctx)
    const key = (ctx.params.id as string | undefined) ?? 'validate'
    const input = toSaveDocument(key, body)
    const errors = await port.validate(input, readCultures(body))
    if (errors.length === 0) return new Response(null, { status: 200 })
    return failureResponse(
      'One or more properties did not pass validation',
      { ok: false, reason: 'invalid', status: 400, errors },
      input.values,
    )
  }
  handle('PostElementValidate', validateHandler)
  handle('PutElementByIdValidate', validateHandler)

  handle('PutElementByIdPublish', async (ctx) => {
    const key = ctx.params.id as string
    if (!(await port.byKey(key))) return problemResponse(notFound('The element could not be found'))
    const result = await port.publish(key, readCultures(await readBody(ctx)))
    return result.ok
      ? done(ctx, 'Element published')
      : failed('Could not publish the element', result)
  })

  handle('PutElementByIdUnpublish', async (ctx) => {
    const key = ctx.params.id as string
    if (!(await port.byKey(key))) return problemResponse(notFound('The element could not be found'))
    const result = await port.unpublish(key, readCultures(await readBody(ctx)))
    return result.ok
      ? done(ctx, 'Element unpublished')
      : failed('Could not unpublish the element', result)
  })

  // ── moving, copying and the bin ───────────────────────────────────────────
  handle('PutElementByIdMove', async (ctx) => {
    const result = await port.move(ctx.params.id as string, refId((await readBody(ctx)).target))
    return result.ok ? done(ctx, 'Element moved') : failed('Could not move the element', result)
  })

  handle('PostElementByIdCopy', async (ctx) => {
    const body = await readBody(ctx)
    const result = await port.copy(
      ctx.params.id as string,
      refId(body.target),
      { includeDescendants: body.includeDescendants === true },
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) return failed('Could not copy the element', result)
    ctx.notifications.push({ message: 'Element copied', category: 'Element', type: 'Success' })
    return created(`${ctx.url.origin}${API}/element/${result.key}`, result.key)
  })

  handle('PutElementByIdMoveToRecycleBin', async (ctx) => {
    const moved = await port.moveToRecycleBin(ctx.params.id as string)
    if (!moved) return problemResponse(notFound('The element could not be found'))
    return done(ctx, 'Moved to the recycle bin')
  })

  handle('DeleteElementById', async (ctx) => {
    const removed = await port.remove(ctx.params.id as string)
    if (!removed) return problemResponse(notFound('The element could not be found'))
    return done(ctx, 'Element deleted')
  })

  handle('PutElementFolderByIdMove', async (ctx) => {
    const result = await port.moveFolder(
      ctx.params.id as string,
      refId((await readBody(ctx)).target),
    )
    return result.ok ? done(ctx, 'Folder moved') : failed('Could not move the folder', result)
  })

  handle('PutElementFolderByIdMoveToRecycleBin', async (ctx) => {
    const moved = await port.folderToRecycleBin(ctx.params.id as string)
    if (!moved) return problemResponse(notFound('The folder could not be found'))
    return done(ctx, 'Moved to the recycle bin')
  })

  // The contract scopes this to a folder rather than to an element, so the generic
  // reference handlers (which register `Get<Area>ByIdReferencedDescendants`) do not
  // cover it.
  if (references)
    handle('GetElementFolderByIdReferencedDescendants', async (ctx) => {
      const page = paging(ctx)
      if (!page) return problemResponse(invalidSkipTake())
      const result = await references.referencedDescendants(ctx.params.id as string, page)
      return Response.json({ total: result.total, items: result.items })
    })

  handle('GetItemElementFolder', async (ctx) =>
    Response.json((await port.folderItems(ctx.url.searchParams.getAll('id'))).map(toElementItem)),
  )

  handle('GetRecycleBinElementRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.recycleBin(null, page)
    return Response.json({
      total: result.total,
      items: result.items.map((i) => toElementTreeItem(i)),
    })
  })

  handle('GetRecycleBinElementChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    const result = await port.recycleBin(parentId, page)
    return Response.json({
      total: result.total,
      items: result.items.map((i) => toElementTreeItem(i)),
    })
  })

  handle('GetRecycleBinElementSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const found = await port.recycleBinSiblings(
      target,
      Number(ctx.url.searchParams.get('before') ?? 0),
      Number(ctx.url.searchParams.get('after') ?? 0),
    )
    if (!found) return problemResponse(notFound('The element could not be found'))
    return Response.json({
      totalBefore: found.totalBefore,
      totalAfter: found.totalAfter,
      items: found.items.map((i) => toElementTreeItem(i)),
    })
  })

  for (const operation of [
    'GetRecycleBinElementByIdOriginalParent',
    'GetRecycleBinElementFolderByIdOriginalParent',
  ])
    handle(operation, async (ctx) => {
      const parent = await port.originalParent(ctx.params.id as string)
      if (parent === undefined) return problemResponse(notFound('The item could not be found'))
      return Response.json(parent ? { id: parent } : null)
    })

  for (const operation of [
    'PutRecycleBinElementByIdRestore',
    'PutRecycleBinElementFolderByIdRestore',
  ])
    handle(operation, async (ctx) => {
      const body = await readBody(ctx)
      const result = await port.restore(
        ctx.params.id as string,
        'target' in body ? refId(body.target) : undefined,
      )
      return result.ok
        ? done(ctx, 'Element restored')
        : failed('Could not restore the element', result)
    })

  handle('DeleteRecycleBinElement', async (ctx) => {
    await port.emptyRecycleBin()
    return done(ctx, 'Recycle bin emptied')
  })

  for (const operation of ['DeleteRecycleBinElementById', 'DeleteRecycleBinElementFolderById'])
    handle(operation, async (ctx) => {
      const removed = await port.remove(ctx.params.id as string)
      if (!removed) return problemResponse(notFound('The item could not be found'))
      return done(ctx, 'Element deleted')
    })

  // ── history ───────────────────────────────────────────────────────────────
  handle('GetElementByIdAuditLog', (ctx) => auditLogResponse(ctx, port))

  handle('GetElementVersion', async (ctx) => {
    const elementId = ctx.url.searchParams.get('elementId')
    if (!elementId)
      return problemResponse(problemDetails({ title: 'elementId is required', status: 400 }))
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const versions = await port.versions(elementId)
    const element = await port.byKey(elementId)
    const documentType = { id: element?.contentTypeKey ?? '' }
    const fallbackUser = await port.systemUserKey()
    return Response.json({
      total: versions.length,
      items: versions.slice(page.skip, page.skip + page.take).map((version) => ({
        id: version.id,
        element: { id: version.documentKey },
        documentType,
        user: { id: version.userKey ?? fallbackUser },
        versionDate: version.versionDate.toISOString(),
        isCurrentPublishedVersion: version.isCurrentPublished,
        isCurrentDraftVersion: version.isCurrentDraft,
        preventCleanup: version.preventCleanup,
      })),
    })
  })

  handle('GetElementVersionById', async (ctx) => {
    const found = await port.atVersion(ctx.params.id as string)
    if (!found) return problemResponse(notFound('The version could not be found'))
    return Response.json(toElementResponse(found.document))
  })

  handle('PostElementVersionByIdRollback', async (ctx) => {
    const rolled = await port.rollback(ctx.params.id as string)
    if (!rolled) return problemResponse(notFound('The version could not be found'))
    return done(ctx, 'Element rolled back')
  })

  handle('PutElementVersionByIdPreventCleanup', async (ctx) => {
    const body = await readBody(ctx)
    const set = await port.setPreventCleanup(ctx.params.id as string, body.preventCleanup === true)
    if (!set) return problemResponse(notFound('The version could not be found'))
    return new Response(null, { status: 200 })
  })
}
