/**
 * Documents: the tree, the editor's read/write cycle, publishing and versions.
 */

import type {
  DocumentAggregate,
  DocumentTreeItem,
  DocumentValidationError,
  DocumentValue,
  DocumentVersionSummary,
} from '@bunbraco/core'
import {
  invalidSkipTake,
  notFound,
  problemDetails,
  problemResponse,
  ROOT_ACCESS,
} from '@bunbraco/core'
import type { PreviewPort } from '../ports.ts'
import type { DocumentPort, PortFailure, SaveDocument } from '../ports-content.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { created, paging } from './content-type.ts'
import {
  type TreeSource,
  visibleChildren,
  visibleRoot,
  visibleSiblings,
} from './start-node-trees.ts'

const ref = (value: unknown): string | null =>
  value && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : null

function toVariantResponse(aggregate: DocumentAggregate) {
  return aggregate.variants.map((variant) => ({
    id: aggregate.key,
    flags: [],
    state: variant.state,
    publishDate: variant.publishDate?.toISOString() ?? null,
    scheduledPublishDate: variant.scheduledPublishDate?.toISOString() ?? null,
    scheduledUnpublishDate: variant.scheduledUnpublishDate?.toISOString() ?? null,
    createDate: variant.createDate.toISOString(),
    updateDate: variant.updateDate.toISOString(),
    culture: variant.culture,
    segment: variant.segment,
    name: variant.name,
  }))
}

export function toDocumentResponse(aggregate: DocumentAggregate) {
  return {
    id: aggregate.key,
    isTrashed: aggregate.isTrashed,
    documentType: {
      id: aggregate.contentTypeKey,
      icon: aggregate.contentTypeIcon,
      collection: aggregate.contentTypeCollectionKey
        ? { id: aggregate.contentTypeCollectionKey }
        : null,
    },
    template: aggregate.templateKey ? { id: aggregate.templateKey } : null,
    flags: [],
    values: aggregate.values.map((value) => ({
      editorAlias: value.editorAlias ?? '',
      culture: value.culture,
      segment: value.segment,
      alias: value.alias,
      value: value.value,
    })),
    variants: toVariantResponse(aggregate),
  }
}

function toDocumentItemResponse(item: DocumentTreeItem) {
  return {
    id: item.key,
    isTrashed: item.isTrashed,
    isProtected: false,
    hasChildren: item.hasChildren,
    parent: item.parentKey ? { id: item.parentKey } : null,
    documentType: {
      id: item.contentTypeKey,
      icon: item.icon,
      collection: item.contentTypeCollectionKey ? { id: item.contentTypeCollectionKey } : null,
    },
    variants: item.variants.map((v) => ({
      id: item.key,
      name: v.name,
      culture: v.culture,
      state: v.state,
      flags: [],
    })),
    flags: [],
  }
}

function toRecycleBinItemResponse(item: DocumentTreeItem) {
  return {
    id: item.key,
    hasChildren: item.hasChildren,
    parent: item.parentKey ? { id: item.parentKey } : null,
    createDate: item.createDate.toISOString(),
    documentType: {
      id: item.contentTypeKey,
      icon: item.icon,
      collection: item.contentTypeCollectionKey ? { id: item.contentTypeCollectionKey } : null,
    },
    variants: item.variants.map((v) => ({
      id: item.key,
      name: v.name,
      culture: v.culture,
      state: v.state,
      flags: [],
    })),
  }
}

function readValues(body: Record<string, unknown>): DocumentValue[] {
  if (!Array.isArray(body.values)) return []
  return (body.values as Array<Record<string, unknown>>).map((value) => ({
    alias: String(value.alias ?? ''),
    culture: (value.culture as string | null) ?? null,
    segment: (value.segment as string | null) ?? null,
    value: value.value,
  }))
}

function readVariants(
  body: Record<string, unknown>,
): Array<{ culture: string | null; segment: string | null; name: string }> {
  if (!Array.isArray(body.variants)) return []
  return (body.variants as Array<Record<string, unknown>>).map((variant) => ({
    culture: (variant.culture as string | null) ?? null,
    segment: (variant.segment as string | null) ?? null,
    name: String(variant.name ?? ''),
  }))
}

export function toSaveDocument(key: string, body: Record<string, unknown>): SaveDocument {
  return {
    key,
    contentTypeKey: ref(body.documentType) ?? '',
    templateKey: ref(body.template),
    parentKey: ref(body.parent),
    values: readValues(body),
    variants: readVariants(body),
  }
}

/** Cultures named in a publish request; an empty list means every culture. */
function readCultures(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (Array.isArray(record.culturesToPublish)) {
    return (record.culturesToPublish as unknown[]).map(String)
  }
  if (Array.isArray(record.cultures)) return (record.cultures as unknown[]).map(String)
  if (Array.isArray(record.publishSchedules)) {
    const cultures = (record.publishSchedules as Array<Record<string, unknown>>)
      .map((schedule) => schedule.culture)
      .filter((culture): culture is string => typeof culture === 'string')
    return cultures.length > 0 ? cultures : null
  }
  return null
}

/** `publishSchedules` as dates, or 'invalid' when one does not parse. */
function readSchedules(
  body: Record<string, unknown>,
):
  | Array<{ culture: string | null; publishTime: Date | null; unpublishTime: Date | null }>
  | 'invalid' {
  if (!Array.isArray(body.publishSchedules)) return []
  const parse = (value: unknown): Date | null | 'invalid' => {
    if (value === null || value === undefined || value === '') return null
    const date = new Date(String(value))
    return Number.isNaN(date.getTime()) ? 'invalid' : date
  }
  const result = []
  for (const entry of body.publishSchedules as Array<Record<string, unknown>>) {
    const schedule = (entry.schedule ?? null) as Record<string, unknown> | null
    const publishTime = parse(schedule?.publishTime)
    const unpublishTime = parse(schedule?.unpublishTime)
    if (publishTime === 'invalid' || unpublishTime === 'invalid') return 'invalid'
    result.push({
      culture: typeof entry.culture === 'string' ? entry.culture : null,
      publishTime,
      unpublishTime,
    })
  }
  return result
}

export async function readBody(ctx: RequestContext): Promise<Record<string, unknown>> {
  try {
    return (await ctx.request.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Umbraco's validation problem: `errors` keyed by JSON path into the request —
 * the value's index when it was sent, a filter expression when it was not — so
 * the editor can mark the exact field.
 */
export function validationProblem(
  errors: readonly DocumentValidationError[],
  sentValues: readonly DocumentValue[],
) {
  const byPath: Record<string, string[]> = {}
  for (const error of errors) {
    const index = sentValues.findIndex(
      (v) =>
        v.alias === error.alias &&
        (v.culture ?? null) === error.culture &&
        (v.segment ?? null) === error.segment,
    )
    const q = (s: string | null) => (s === null ? 'null' : `'${s}'`)
    const path =
      index >= 0
        ? `$.values[${index}].value`
        : `$.values[?(@.alias == '${error.alias}' && @.culture == ${q(error.culture)} && @.segment == ${q(error.segment)})].value`
    byPath[path] = [...(byPath[path] ?? []), ...error.messages]
  }
  return problemDetails({
    title: 'Validation failed',
    status: 400,
    detail: 'One or more properties did not pass validation',
    operationStatus: 'PropertyValidationError',
    errors: byPath,
  })
}

/** A port failure as a response: its validation errors when it has them, else its reason. */
export function failureResponse(
  title: string,
  result: PortFailure,
  sent: readonly DocumentValue[],
) {
  if (result.errors) return problemResponse(validationProblem(result.errors, sent))
  return problemResponse(
    problemDetails({ title, status: result.status ?? 400, detail: result.reason }),
  )
}

export function toDocumentTreeItemResponse(item: DocumentTreeItem, noAccess = false) {
  return {
    id: item.key,
    parent: item.parentKey ? { id: item.parentKey } : null,
    hasChildren: item.hasChildren,
    noAccess,
    isProtected: false,
    isTrashed: item.isTrashed,
    createDate: item.createDate.toISOString(),
    ancestors: item.ancestorKeys.map((id) => ({ id })),
    documentType: {
      id: item.contentTypeKey,
      icon: item.icon,
      collection: item.contentTypeCollectionKey ? { id: item.contentTypeCollectionKey } : null,
    },
    variants: item.variants.map((v) => ({
      id: item.key,
      name: v.name,
      culture: v.culture,
      state: v.state,
      flags: [],
    })),
    flags: [],
  }
}

export function registerDocumentHandlers(
  router: ManagementApiRouter,
  port: DocumentPort,
  preview?: PreviewPort,
): void {
  const trees: TreeSource = {
    treeRoot: (paging) => port.treeRoot(paging),
    treeChildren: (key, paging) => port.treeChildren(key, paging),
    items: (keys) => port.documentItems(keys),
  }
  const documentStart = (ctx: RequestContext) => ctx.principal?.startNodes.document ?? ROOT_ACCESS

  router.handle('GetDocumentById', async ({ params }) => {
    const aggregate = await port.byKey(params.id as string)
    if (!aggregate) return problemResponse(notFound('The document could not be found'))
    return Response.json(toDocumentResponse(aggregate))
  })

  router.handle('GetDocumentByIdPublished', async ({ params }) => {
    const aggregate = await port.byKeyPublished(params.id as string)
    if (!aggregate) return problemResponse(notFound('The document is not published'))
    return Response.json(toDocumentResponse(aggregate))
  })

  router.handle('GetDocumentConfiguration', () =>
    Response.json({
      disableDeleteWhenReferenced: false,
      disableUnpublishWhenReferenced: false,
      allowEditInvariantFromNonDefault: false,
      allowNonExistingSegmentsCreation: false,
    }),
  )

  router.handle('PostDocumentValidate', async (ctx) => {
    const body = await readBody(ctx)
    const input = toSaveDocument(typeof body.id === 'string' ? body.id : crypto.randomUUID(), body)
    const errors = await port.validate(input, null)
    if (errors.length > 0) return problemResponse(validationProblem(errors, input.values))
    return new Response(null, { status: 200 })
  })

  router.handle('PutDocumentByIdValidate', async (ctx) => {
    const body = await readBody(ctx)
    const key = ctx.params.id as string
    if (!(await port.byKey(key)))
      return problemResponse(notFound('The document could not be found'))
    const input = toSaveDocument(key, body)
    const cultures = Array.isArray(body.cultures) ? (body.cultures as unknown[]).map(String) : null
    const errors = await port.validate(input, cultures)
    if (errors.length > 0) return problemResponse(validationProblem(errors, input.values))
    return new Response(null, { status: 200 })
  })

  router.handle('PostDocumentCreateAndPublish', async (ctx) => {
    const body = await readBody(ctx)
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const input = toSaveDocument(key, body)
    const result = await port.createAndPublish(
      input,
      readCultures(body),
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) return failureResponse('Could not create the document', result, input.values)
    return created(
      `${ctx.url.pathname.replace(/\/create-and-publish$/, '')}/${result.key}`,
      result.key,
    )
  })

  router.handle('PutDocumentByIdUpdateAndPublish', async (ctx) => {
    const body = await readBody(ctx)
    const key = ctx.params.id as string
    const input = toSaveDocument(key, body)
    const result = await port.updateAndPublish(
      key,
      input,
      readCultures(body),
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) {
      if (result.reason === 'The document could not be found.')
        return problemResponse(notFound(result.reason))
      return failureResponse('Could not publish the document', result, input.values)
    }
    return new Response(null, { status: 200 })
  })

  router.handle('GetTreeDocumentAncestors', async (ctx) => {
    const descendantId = ctx.url.searchParams.get('descendantId')
    // Umbraco binds a missing id to an empty GUID and answers with no ancestors.
    if (!descendantId) return Response.json([])
    return Response.json(
      (await port.treeAncestors(descendantId)).map((item) => toDocumentTreeItemResponse(item)),
    )
  })

  router.handle('GetTreeDocumentSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const before = Number(ctx.url.searchParams.get('before') ?? 0)
    const after = Number(ctx.url.searchParams.get('after') ?? 0)
    const found = await port.treeSiblings(target, before, after)
    if (!found) return problemResponse(notFound('The document could not be found'))
    const window = await visibleSiblings(documentStart(ctx), trees, found)
    return Response.json({
      totalBefore: window.totalBefore,
      totalAfter: window.totalAfter,
      items: window.items.map((v) => toDocumentTreeItemResponse(v.item, v.noAccess)),
    })
  })

  router.handle('GetItemDocumentSearch', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const query = ctx.url.searchParams.get('query') ?? ''
    const result = await port.search(query, {
      ...page,
      trashed: ctx.url.searchParams.get('trashed') === 'true',
      parentKey: ctx.url.searchParams.get('parentId'),
    })
    return Response.json({ total: result.total, items: result.items.map(toDocumentItemResponse) })
  })

  router.handle('GetRecycleBinDocumentRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    // Only root access reaches the recycle bin
    if (!documentStart(ctx).root) return Response.json({ total: 0, items: [] })
    const result = await port.recycleBin(null, page)
    return Response.json({ total: result.total, items: result.items.map(toRecycleBinItemResponse) })
  })

  router.handle('GetRecycleBinDocumentChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    if (!documentStart(ctx).root) return Response.json({ total: 0, items: [] })
    const result = await port.recycleBin(parentId, page)
    return Response.json({ total: result.total, items: result.items.map(toRecycleBinItemResponse) })
  })

  router.handle('GetRecycleBinDocumentSiblings', async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const window = await port.recycleBinSiblings(
      target,
      Number(ctx.url.searchParams.get('before') ?? 0),
      Number(ctx.url.searchParams.get('after') ?? 0),
    )
    if (!window) return problemResponse(notFound('The document could not be found'))
    return Response.json({ ...window, items: window.items.map(toRecycleBinItemResponse) })
  })

  router.handle('GetRecycleBinDocumentByIdOriginalParent', async ({ params }) => {
    const parent = await port.originalParent(params.id as string)
    if (parent === undefined) return problemResponse(notFound('The document could not be found'))
    return Response.json(parent ? { id: parent } : null)
  })

  router.handle('PostDocument', async (ctx) => {
    const body = await readBody(ctx)
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const result = await port.create(
      toSaveDocument(key, body),
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) {
      return problemResponse(
        problemDetails({
          title: 'Could not create the document',
          status: result.status ?? 400,
          detail: result.reason,
        }),
      )
    }
    ctx.notifications.push({ message: 'Document created', category: 'Content', type: 'Success' })
    return created(`${ctx.url.origin}/umbraco/management/api/v1/document/${result.key}`, result.key)
  })

  router.handle('PutDocumentById', async (ctx) => {
    const key = ctx.params.id as string
    const existing = await port.byKey(key)
    if (!existing) return problemResponse(notFound('The document could not be found'))
    const body = await readBody(ctx)
    const result = await port.update(
      key,
      {
        ...toSaveDocument(key, body),
        // The document type never changes on update.
        contentTypeKey: existing.contentTypeKey,
      },
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) {
      return problemResponse(
        problemDetails({
          title: 'Could not save the document',
          status: result.status ?? 400,
          detail: result.reason,
        }),
      )
    }
    ctx.notifications.push({ message: 'Document saved', category: 'Content', type: 'Success' })
    return new Response(null, { status: 200 })
  })

  router.handle('PutDocumentByIdPublish', async (ctx) => {
    const key = ctx.params.id as string
    if (!(await port.byKey(key)))
      return problemResponse(notFound('The document could not be found'))
    const body = await readBody(ctx)
    const schedules = readSchedules(body)
    if (schedules === 'invalid')
      return problemResponse(
        problemDetails({ title: 'A schedule date is not a valid date', status: 400 }),
      )
    const now = Date.now()
    // A future publish time schedules the variant instead of publishing it now.
    const later = (s: (typeof schedules)[number]) =>
      s.publishTime !== null && s.publishTime.getTime() > now
    if (schedules.length > 0)
      await port.schedule(
        key,
        schedules.map((s) => ({ ...s, publishTime: later(s) ? s.publishTime : null })),
      )
    const immediate = schedules.filter((s) => !later(s))
    if (schedules.length > 0 && immediate.length === 0) {
      ctx.notifications.push({
        message: 'Publishing scheduled',
        category: 'Content',
        type: 'Success',
      })
      return new Response(null, { status: 200 })
    }
    const cultures = immediate.some((s) => s.culture !== null)
      ? immediate.flatMap((s) => (s.culture === null ? [] : [s.culture]))
      : readCultures(body)
    const result = await port.publish(key, cultures)
    if (!result.ok) {
      return problemResponse(
        problemDetails({
          title: 'Could not publish the document',
          status: result.status ?? 400,
          detail: result.reason,
          operationStatus: 'PathNotPublished',
        }),
      )
    }
    return new Response(null, { status: 200 })
  })

  router.handle('PutDocumentByIdUnpublish', async (ctx) => {
    const key = ctx.params.id as string
    if (!(await port.byKey(key)))
      return problemResponse(notFound('The document could not be found'))
    const result = await port.unpublish(key, readCultures(await readBody(ctx)))
    if (!result.ok) {
      return problemResponse(
        problemDetails({
          title: 'Could not unpublish the document',
          status: result.status ?? 400,
          detail: result.reason,
        }),
      )
    }
    return new Response(null, { status: 200 })
  })

  router.handle('PutDocumentByIdMoveToRecycleBin', async (ctx) => {
    const moved = await port.moveToRecycleBin(ctx.params.id as string)
    if (!moved) return problemResponse(notFound('The document could not be found'))
    ctx.notifications.push({
      message: 'Moved to the recycle bin',
      category: 'Content',
      type: 'Success',
    })
    return new Response(null, { status: 200 })
  })

  router.handle('DeleteDocumentById', async (ctx) => {
    const removed = await port.remove(ctx.params.id as string)
    if (!removed) return problemResponse(notFound('The document could not be found'))
    return new Response(null, { status: 200 })
  })

  const refId = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null
    const id = (value as Record<string, unknown>).id
    return typeof id === 'string' && id ? id : null
  }
  const failed = (title: string, result: PortFailure) =>
    problemResponse(problemDetails({ title, status: result.status ?? 400, detail: result.reason }))
  const done = (ctx: RequestContext, message: string) => {
    ctx.notifications.push({ message, category: 'Content', type: 'Success' })
    return new Response(null, { status: 200 })
  }

  router.handle('PutDocumentByIdMove', async (ctx) => {
    const result = await port.move(ctx.params.id as string, refId((await readBody(ctx)).target))
    return result.ok ? done(ctx, 'Document moved') : failed('Could not move the document', result)
  })

  router.handle('PostDocumentByIdCopy', async (ctx) => {
    const body = await readBody(ctx)
    const result = await port.copy(
      ctx.params.id as string,
      refId(body.target),
      { includeDescendants: body.includeDescendants === true },
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) return failed('Could not copy the document', result)
    ctx.notifications.push({ message: 'Document copied', category: 'Content', type: 'Success' })
    return created(`${ctx.url.origin}/umbraco/management/api/v1/document/${result.key}`, result.key)
  })

  router.handle('PutDocumentSort', async (ctx) => {
    const body = await readBody(ctx)
    if (!Array.isArray(body.sorting))
      return problemResponse(problemDetails({ title: 'sorting is required', status: 400 }))
    const sorting = (body.sorting as Array<Record<string, unknown>>).map((item) => ({
      key: String(item.id ?? ''),
      sortOrder: Number(item.sortOrder ?? 0),
    }))
    const result = await port.sort(refId(body.parent), sorting)
    return result.ok ? done(ctx, 'Sort order saved') : failed('Could not sort', result)
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
    return result.ok ? done(ctx, 'Sort order saved') : failed('Could not sort', result)
  }
  router.handle('PutDocumentByIdSortChildren', (ctx) => sortByField(ctx, ctx.params.id as string))
  router.handle('PutDocumentRootSortChildren', (ctx) => sortByField(ctx, null))

  router.handle('PutRecycleBinDocumentByIdRestore', async (ctx) => {
    const body = await readBody(ctx)
    const target = 'target' in body ? refId(body.target) : undefined
    const result = await port.restore(ctx.params.id as string, target ?? undefined)
    return result.ok ? done(ctx, 'Document restored') : failed('Could not restore', result)
  })

  router.handle('DeleteRecycleBinDocumentById', async (ctx) => {
    const key = ctx.params.id as string
    const document = await port.byKey(key)
    if (!document) return problemResponse(notFound('The document could not be found'))
    if (!document.isTrashed)
      return problemResponse(
        problemDetails({ title: 'The document is not in the recycle bin', status: 400 }),
      )
    await port.remove(key)
    return done(ctx, 'Document deleted')
  })

  router.handle('DeleteRecycleBinDocument', async (ctx) => {
    await port.emptyRecycleBin()
    return done(ctx, 'Recycle bin emptied')
  })

  /** Branch publishing runs inline, so its task is complete when it is first reported. */
  const branchTasks = new Map<string, { documentKey: string }>()
  router.handle('PutDocumentByIdPublishWithDescendants', async (ctx) => {
    const key = ctx.params.id as string
    const body = await readBody(ctx)
    const cultures = Array.isArray(body.cultures) ? (body.cultures as unknown[]).map(String) : []
    const result = await port.publishBranch(
      key,
      cultures.length > 0 ? cultures : null,
      body.includeUnpublishedDescendants === true,
    )
    if (!result.ok) return failed('Could not publish the branch', result)
    const taskId = crypto.randomUUID()
    branchTasks.set(taskId, { documentKey: key })
    ctx.notifications.push({
      message: `${result.published.length} published`,
      category: 'Content',
      type: 'Success',
    })
    for (const failure of result.failed)
      ctx.notifications.push({ message: failure.reason, category: 'Content', type: 'Warning' })
    return Response.json({ taskId, isComplete: true })
  })

  router.handle('GetDocumentByIdPublishWithDescendantsResultByTaskId', (ctx) => {
    const taskId = ctx.params.taskId as string
    const task = branchTasks.get(taskId)
    if (!task || task.documentKey.toLowerCase() !== String(ctx.params.id).toLowerCase())
      return problemResponse(notFound('The task could not be found'))
    return Response.json({ taskId, isComplete: true })
  })

  router.handle('GetDocumentByIdDomains', async (ctx) => {
    const found = await port.domains(ctx.params.id as string)
    if (!found) return problemResponse(notFound('The document could not be found'))
    return Response.json(found)
  })

  router.handle('PutDocumentByIdDomains', async (ctx) => {
    const body = await readBody(ctx)
    const domains = Array.isArray(body.domains)
      ? (body.domains as Array<Record<string, unknown>>).map((d) => ({
          domainName: String(d.domainName ?? ''),
          isoCode: String(d.isoCode ?? ''),
        }))
      : []
    const result = await port.setDomains(ctx.params.id as string, {
      defaultIsoCode: typeof body.defaultIsoCode === 'string' ? body.defaultIsoCode : null,
      domains,
    })
    switch (result.status) {
      case 'ok':
        // A site that deploys its hostnames from a file has had that file
        // written too, and it is worth saying: the change outlives this node
        // only if the file is committed.
        return done(
          ctx,
          result.file
            ? // ASCII only: this goes out as an HTTP header, which rejects the
              // punctuation the rest of the codebase writes freely.
              `Culture and hostnames saved, and written to ${result.file}. Commit it to keep them.`
            : 'Culture and hostnames saved',
        )
      case 'notFound':
        return problemResponse(notFound('The document could not be found'))
      case 'conflict':
        return problemResponse(
          problemDetails({
            title: 'Duplicate domain name detected',
            detail: `The domain '${result.domainName}' is already assigned.`,
            status: 409,
            operationStatus: 'DuplicateDomainName',
          }),
        )
      case 'invalidLanguage':
        return problemResponse(
          problemDetails({
            title: 'Invalid language',
            detail: `No language with the ISO code '${result.isoCode}' exists.`,
            status: 400,
            operationStatus: 'LanguageNotFound',
          }),
        )
      default:
        return problemResponse(
          problemDetails({
            title: 'Invalid domain name',
            detail: `'${result.domainName}' is not a valid domain name.`,
            status: 400,
            operationStatus: 'InvalidDomainName',
          }),
        )
    }
  })

  router.handle('GetDocumentByIdNotifications', async (ctx) => {
    const found = await port.notifications(
      ctx.params.id as string,
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!found) return problemResponse(notFound('The document could not be found'))
    return Response.json(found)
  })

  router.handle('PutDocumentByIdNotifications', async (ctx) => {
    const body = await readBody(ctx)
    const ids = Array.isArray(body.subscribedActionIds)
      ? (body.subscribedActionIds as unknown[]).map(String)
      : []
    const saved = await port.setNotifications(
      ctx.params.id as string,
      ctx.principal as NonNullable<typeof ctx.principal>,
      ids,
    )
    if (!saved) return problemResponse(notFound('The document could not be found'))
    return done(ctx, 'Notification settings saved')
  })

  if (preview) {
    /**
     * Umbraco's default provider: the backoffice's own preview app at
     * `preview?id=…`, relative to the backoffice, which frames the page. Asking
     * for it enters preview for this editor.
     */
    router.handle('GetDocumentByIdPreviewUrl', async (ctx) => {
      const key = ctx.params.id as string
      if (!(await port.byKey(key)))
        return problemResponse(
          notFound('Document not found', 'The requested document did not exist.'),
        )
      const culture = ctx.url.searchParams.get('culture') || null
      const segment = ctx.url.searchParams.get('segment') || null
      const query = new URLSearchParams({ id: key, culture: culture ?? '', segment: segment ?? '' })
      const headers = new Headers({ 'content-type': 'application/json' })
      for (const cookie of preview.enter()) headers.append('set-cookie', cookie)
      return new Response(
        JSON.stringify({
          url: `preview?${query.toString()}`,
          provider: ctx.url.searchParams.get('providerAlias') || 'umbDocumentUrlProvider',
          isExternal: false,
          culture,
          message: null,
        }),
        { headers },
      )
    })

    router.handle('DeletePreview', () => {
      const headers = new Headers()
      for (const cookie of preview.exit()) headers.append('set-cookie', cookie)
      return new Response(null, { status: 200, headers })
    })
  }

  router.handle('GetDocumentVersionById', async (ctx) => {
    const found = await port.atVersion(ctx.params.id as string)
    if (!found) return problemResponse(notFound('The version could not be found'))
    const document = toDocumentResponse(found.document)
    return Response.json({
      id: found.versionId,
      document: { id: found.document.key },
      documentType: document.documentType,
      values: document.values,
      variants: document.variants,
      flags: [],
    })
  })

  router.handle('GetItemDocumentAncestors', async (ctx) => {
    const ids = ctx.url.searchParams.getAll('id')
    const result = []
    for (const id of ids) {
      const ancestors = await port.treeAncestors(id)
      result.push({ id, ancestors: ancestors.map(toDocumentItemResponse) })
    }
    return Response.json(result)
  })

  router.handle('GetTreeDocumentRoot', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await visibleRoot(documentStart(ctx), trees, page)
    return Response.json({
      total: result.total,
      items: result.items.map((v) => toDocumentTreeItemResponse(v.item, v.noAccess)),
    })
  })

  router.handle('GetTreeDocumentChildren', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    const result = await visibleChildren(documentStart(ctx), trees, parentId, page)
    return Response.json({
      total: result.total,
      items: result.items.map((v) => toDocumentTreeItemResponse(v.item, v.noAccess)),
    })
  })

  router.handle('GetItemDocument', async (ctx) => {
    const items = await port.documentItems(ctx.url.searchParams.getAll('id'))
    return Response.json(items.map(toDocumentItemResponse))
  })

  /** The page's history, from its versions: who saved, published or rolled back, and when. */
  router.handle('GetDocumentByIdAuditLog', (ctx) => auditLogResponse(ctx, port))

  router.handle('GetDocumentVersion', async (ctx) => {
    const documentId = ctx.url.searchParams.get('documentId')
    if (!documentId) {
      return problemResponse(problemDetails({ title: 'documentId is required', status: 400 }))
    }
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const versions = await port.versions(documentId)
    const window = versions.slice(page.skip, page.skip + page.take)
    const document = await port.byKey(documentId)
    const documentType = document
      ? toDocumentResponse(document).documentType
      : { id: '', icon: null, collection: null }
    return Response.json({
      total: versions.length,
      items: window.map((version) => ({
        id: version.id,
        document: { id: version.documentKey },
        documentType,
        user: version.userKey ? { id: version.userKey } : null,
        versionDate: version.versionDate.toISOString(),
        isCurrentPublishedVersion: version.isCurrentPublished,
        isCurrentDraftVersion: version.isCurrentDraft,
        preventCleanup: version.preventCleanup,
      })),
    })
  })

  router.handle('PostDocumentVersionByIdRollback', async (ctx) => {
    const rolled = await port.rollback(ctx.params.id as string)
    if (!rolled) return problemResponse(notFound('The version could not be found'))
    return new Response(null, { status: 200 })
  })

  router.handle('PutDocumentVersionByIdPreventCleanup', async (ctx) => {
    const prevent = ctx.url.searchParams.get('preventCleanup') !== 'false'
    const updated = await port.setPreventCleanup(ctx.params.id as string, prevent)
    if (!updated) return problemResponse(notFound('The version could not be found'))
    return new Response(null, { status: 200 })
  })

  router.handle('GetDocumentUrls', async (ctx) => {
    const keys = ctx.url.searchParams.getAll('id')
    const result = []
    for (const key of keys) {
      result.push({
        id: key,
        urlInfos: (await port.urls(key)).map((url) => ({ culture: url.culture, url: url.url })),
      })
    }
    return Response.json(result)
  })

  router.handle('GetCollectionDocumentById', async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.collection(ctx.params.id as string, page)
    return Response.json({
      total: result.total,
      items: result.items.map((aggregate) => ({
        ...toDocumentResponse(aggregate),
        creator: null,
        sortOrder: aggregate.sortOrder,
        hasChildren: false,
        updater: null,
        isProtected: false,
        ancestors: [],
      })),
    })
  })
}

const AUDIT_TYPE = {
  save: 'Save',
  publish: 'Publish',
  rollback: 'RollBack',
  migrate: 'System',
} as const

/** An audit log built from an item's versions, paged and filtered as the contract asks. */
export async function auditLogResponse(
  ctx: RequestContext,
  port: {
    versions(key: string): Promise<DocumentVersionSummary[]>
    systemUserKey(): Promise<string | null>
  },
): Promise<Response> {
  const page = paging(ctx)
  if (!page) return problemResponse(invalidSkipTake())
  const since = ctx.url.searchParams.get('sinceDate')
  const sinceTime = since ? Date.parse(since) : Number.NaN
  let versions = await port.versions(ctx.params.id as string)
  if (!Number.isNaN(sinceTime))
    versions = versions.filter((v) => v.versionDate.getTime() >= sinceTime)
  if (ctx.url.searchParams.get('orderDirection') === 'Ascending') versions = versions.reverse()
  const fallbackUser = await port.systemUserKey()
  const window = versions.slice(page.skip, page.skip + page.take)
  return Response.json({
    total: versions.length,
    items: window.map((version) => ({
      user: { id: version.userKey ?? fallbackUser },
      timestamp: version.versionDate.toISOString(),
      logType: AUDIT_TYPE[version.kind ?? 'save'],
      comment: null,
      parameters: null,
    })),
  })
}
