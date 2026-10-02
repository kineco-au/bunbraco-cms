/**
 * Document types: the tree, item lookups, and the aggregate CRUD the editor uses.
 */

import type { ResponseOf } from '@bunbraco/contracts'
import {
  type ContentTypeAggregate,
  invalidSkipTake,
  isSystemMediaType,
  notFound,
  parseSkipTake,
  pendingLabel,
  problemDetails,
  problemResponse,
  type TreeItem,
} from '@bunbraco/core'
import type { ContentTypeKind, ContentTypePort, FolderPort, SkipTake } from '../ports-content.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'

type DocumentTypeResponse = ResponseOf<'GetDocumentTypeById'>

/** Umbraco returns 201 with an empty body, `Location`, and the new id. */
export function created(location: string, id: string): Response {
  return new Response(null, {
    status: 201,
    headers: { location, 'umb-generated-resource': id },
  })
}

export function paging(ctx: RequestContext): SkipTake | undefined {
  const parsed = parseSkipTake(ctx.url.searchParams)
  return parsed.ok ? parsed.value : undefined
}

export function toTreeItemResponse(item: TreeItem) {
  return {
    hasChildren: item.hasChildren,
    id: item.key,
    parent: item.parentKey ? { id: item.parentKey } : null,
    name: item.name,
    icon: item.icon,
    isFolder: item.isFolder,
    isElement: item.isElement ?? false,
    flags: [],
  }
}

export function toDocumentTypeResponse(aggregate: ContentTypeAggregate): DocumentTypeResponse {
  return {
    id: aggregate.key,
    alias: aggregate.alias,
    name: aggregate.name,
    description: aggregate.description,
    icon: aggregate.icon,
    allowedAsRoot: aggregate.allowedAsRoot,
    variesByCulture: aggregate.variesByCulture,
    variesBySegment: aggregate.variesBySegment,
    isElement: aggregate.isElement,
    allowedInLibrary: aggregate.allowedInLibrary,
    collection: aggregate.collectionKey ? { id: aggregate.collectionKey } : null,
    cleanup: {
      preventCleanup: aggregate.cleanup.preventCleanup,
      keepAllVersionsNewerThanDays: aggregate.cleanup.keepAllVersionsNewerThanDays,
      keepLatestVersionPerDayForDays: aggregate.cleanup.keepLatestVersionPerDayForDays,
    },
    properties: aggregate.properties.map((property) => ({
      id: property.key,
      container: property.containerKey ? { id: property.containerKey } : null,
      sortOrder: property.sortOrder,
      alias: property.alias,
      name: property.pending
        ? `${property.name} (${pendingLabel(property.pending)})`
        : property.name,
      description: property.pending
        ? `${pendingLabel(property.pending).replace(/^g/, 'G')}: editable now, not required or rendered until then.${property.description ? ` ${property.description}` : ''}`
        : property.description,
      dataType: { id: property.dataTypeKey },
      variesByCulture: property.variesByCulture,
      variesBySegment: property.variesBySegment,
      validation: {
        mandatory: property.mandatory,
        mandatoryMessage: property.mandatoryMessage,
        regEx: property.regEx,
        regExMessage: property.regExMessage,
      },
      appearance: { labelOnTop: property.labelOnTop },
    })),
    containers: aggregate.containers.map((container) => ({
      id: container.key,
      parent: container.parentKey ? { id: container.parentKey } : null,
      name: container.name,
      type: container.type,
      sortOrder: container.sortOrder,
    })),
    compositions: aggregate.compositions.map((composition) => ({
      documentType: { id: composition.contentTypeKey },
      compositionType: composition.compositionType,
    })),
    allowedDocumentTypes: aggregate.allowedContentTypes.map((allowed) => ({
      documentType: { id: allowed.contentTypeKey },
      sortOrder: allowed.sortOrder,
    })),
    allowedTemplates: aggregate.allowedTemplateKeys.map((id) => ({ id })),
    defaultTemplate: aggregate.defaultTemplateKey ? { id: aggregate.defaultTemplateKey } : null,
  } as DocumentTypeResponse
}

/** The media-type wire shape: no templates or cleanup, references keyed `mediaType`. */
export function toMediaTypeResponse(aggregate: ContentTypeAggregate) {
  const {
    allowedTemplates: _templates,
    defaultTemplate: _default,
    cleanup: _cleanup,
    allowedDocumentTypes,
    compositions,
    ...rest
  } = toDocumentTypeResponse(aggregate) as DocumentTypeResponse & Record<string, unknown>
  return {
    ...rest,
    compositions: (
      compositions as Array<{ documentType: { id: string }; compositionType: string }>
    ).map((c) => ({ mediaType: c.documentType, compositionType: c.compositionType })),
    allowedMediaTypes: (
      allowedDocumentTypes as Array<{ documentType: { id: string }; sortOrder: number }>
    ).map((a) => ({ mediaType: a.documentType, sortOrder: a.sortOrder })),
    isDeletable: !isSystemMediaType(aggregate.key),
    aliasCanBeChanged: !isSystemMediaType(aggregate.key),
  }
}

/**
 * The member-type wire shape: no allowed list, templates or cleanup,
 * references keyed `memberType`, and each property's sensitivity and what the
 * member may see and edit of it.
 */
export function toMemberTypeResponse(aggregate: ContentTypeAggregate) {
  const {
    allowedTemplates: _templates,
    defaultTemplate: _default,
    cleanup: _cleanup,
    allowedDocumentTypes: _allowed,
    compositions,
    properties,
    ...rest
  } = toDocumentTypeResponse(aggregate) as DocumentTypeResponse & Record<string, unknown>
  const flags = new Map(aggregate.properties.map((p) => [p.key, p]))
  return {
    ...rest,
    compositions: (
      compositions as Array<{ documentType: { id: string }; compositionType: string }>
    ).map((c) => ({ memberType: c.documentType, compositionType: c.compositionType })),
    properties: (properties as Array<Record<string, unknown> & { id: string }>).map((p) => ({
      ...p,
      isSensitive: flags.get(p.id)?.isSensitive === true,
      visibility: {
        memberCanView: flags.get(p.id)?.memberCanView === true,
        memberCanEdit: flags.get(p.id)?.memberCanEdit === true,
      },
    })),
  }
}

/** Maps a create/update request body onto the domain aggregate. */
export function fromDocumentTypeRequest(
  key: string,
  body: Record<string, unknown>,
  kind: ContentTypeKind = 'document',
): ContentTypeAggregate {
  // References are `{ documentType: { id } }`, `{ mediaType: … }` or `{ memberType: … }`.
  const refKey = { document: 'documentType', media: 'mediaType', member: 'memberType' }[kind]
  // Member types allow no children, so the field is absent and the list empty.
  const allowedKey = { document: 'allowedDocumentTypes', media: 'allowedMediaTypes', member: '' }[
    kind
  ]
  const ref = (value: unknown): string | null =>
    value && typeof value === 'object' && 'id' in value
      ? String((value as { id: unknown }).id)
      : null
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  /**
   * An element type is never routed and never sits in the content tree, so the
   * fields a route needs are dropped rather than stored. The editor disables those
   * controls for an element type, but a type flipped to one keeps whatever it had —
   * and a file written with them would then be refused at boot by the schema
   * validation that says an element type has no template.
   */
  const isElement = body.isElement === true

  return {
    key,
    alias: String(body.alias ?? ''),
    name: String(body.name ?? ''),
    description: (body.description as string | null) ?? null,
    icon: String(body.icon ?? 'icon-document'),
    allowedAsRoot: !isElement && body.allowedAsRoot === true,
    variesByCulture: body.variesByCulture === true,
    variesBySegment: body.variesBySegment === true,
    isElement,
    allowedInLibrary: body.allowedInLibrary === true,
    collectionKey: ref(body.collection),
    cleanup: {
      preventCleanup:
        (body.cleanup as { preventCleanup?: unknown } | undefined)?.preventCleanup === true,
      keepAllVersionsNewerThanDays: ((
        body.cleanup as { keepAllVersionsNewerThanDays?: number | null } | undefined
      )?.keepAllVersionsNewerThanDays ?? null) as number | null,
      keepLatestVersionPerDayForDays: ((
        body.cleanup as { keepLatestVersionPerDayForDays?: number | null } | undefined
      )?.keepLatestVersionPerDayForDays ?? null) as number | null,
    },
    containers: list(body.containers).map((raw) => {
      const container = raw as Record<string, unknown>
      return {
        key: String(container.id ?? crypto.randomUUID()),
        name: (container.name as string | null) ?? null,
        alias: (container.alias as string | null) ?? null,
        type: String(container.type ?? 'Group'),
        sortOrder: Number(container.sortOrder ?? 0),
        parentKey: ref(container.parent),
      }
    }),
    properties: list(body.properties).map((raw) => {
      const property = raw as Record<string, unknown>
      const validation = (property.validation ?? {}) as Record<string, unknown>
      const appearance = (property.appearance ?? {}) as Record<string, unknown>
      return {
        key: String(property.id ?? crypto.randomUUID()),
        alias: String(property.alias ?? ''),
        name: String(property.name ?? ''),
        description: (property.description as string | null) ?? null,
        dataTypeKey: ref(property.dataType) ?? '',
        containerKey: ref(property.container),
        sortOrder: Number(property.sortOrder ?? 0),
        variesByCulture: property.variesByCulture === true,
        variesBySegment: property.variesBySegment === true,
        mandatory: validation.mandatory === true,
        mandatoryMessage: (validation.mandatoryMessage as string | null) ?? null,
        regEx: (validation.regEx as string | null) ?? null,
        regExMessage: (validation.regExMessage as string | null) ?? null,
        labelOnTop: appearance.labelOnTop === true,
        ...(kind === 'member'
          ? {
              isSensitive: property.isSensitive === true,
              memberCanView:
                (property.visibility as { memberCanView?: unknown } | undefined)?.memberCanView ===
                true,
              memberCanEdit:
                (property.visibility as { memberCanEdit?: unknown } | undefined)?.memberCanEdit ===
                true,
            }
          : {}),
      }
    }),
    compositions: list(body.compositions).map((raw) => {
      const composition = raw as Record<string, unknown>
      return {
        contentTypeKey: ref(composition[refKey]) ?? '',
        compositionType: (composition.compositionType === 'Inheritance'
          ? 'Inheritance'
          : 'Composition') as 'Composition' | 'Inheritance',
      }
    }),
    allowedContentTypes: (isElement ? [] : list(body[allowedKey])).map((raw) => {
      const allowed = raw as Record<string, unknown>
      return {
        contentTypeKey: ref(allowed[refKey]) ?? '',
        sortOrder: Number(allowed.sortOrder ?? 0),
      }
    }),
    allowedTemplateKeys: (isElement ? [] : list(body.allowedTemplates))
      .map((raw) => ref(raw))
      .filter((id): id is string => id !== null),
    defaultTemplateKey: isElement ? null : ref(body.defaultTemplate),
    parentKey: ref(body.parent),
  }
}

/** Aliases a property may not use: they collide with the document's own fields. */
export const RESERVED_FIELD_NAMES = [
  'id',
  'key',
  'name',
  'level',
  'path',
  'parent',
  'parentId',
  'sortOrder',
  'createDate',
  'updateDate',
  'template',
  'url',
  'children',
  'ancestors',
  'descendants',
  'siblings',
  'content',
  'value',
  'values',
  'creator',
  'writer',
  'published',
]

export const refOf = (value: unknown): string | null =>
  value && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : null

export function toDocumentTypeItem(aggregate: ContentTypeAggregate) {
  return {
    id: aggregate.key,
    name: aggregate.name,
    icon: aggregate.icon,
    description: aggregate.description,
    isElement: aggregate.isElement,
    allowedInLibrary: aggregate.allowedInLibrary,
    flags: [],
  }
}

/** The four folder operations, identical for document types and data types. */
export function registerFolderHandlers(
  router: ManagementApiRouter,
  area: 'DocumentType' | 'MediaType' | 'MemberType' | 'DataType' | 'DocumentBlueprint' | 'Element',
  folders: FolderPort,
  toTree: (item: TreeItem) => unknown = toTreeItemResponse,
): void {
  const path = {
    DocumentType: 'document-type',
    MediaType: 'media-type',
    MemberType: 'member-type',
    DataType: 'data-type',
    DocumentBlueprint: 'document-blueprint',
    Element: 'element',
  }[area]
  // Not every area has tree search in the contract (media types do not).
  const inContract = (id: string) => router.operations.some((o) => o.operationId === id)
  if (inContract(`GetTree${area}Search`))
    router.handle(`GetTree${area}Search`, async (ctx) => {
      const page = paging(ctx)
      if (!page) return problemResponse(invalidSkipTake())
      const kind = ctx.url.searchParams.get('itemKind')
      const result = await folders.search(
        ctx.url.searchParams.get('query') ?? '',
        kind === 'Item' || kind === 'Folder' ? kind : 'All',
        page,
      )
      return Response.json({ total: result.total, items: result.items.map(toTree) })
    })
  router.handle(`Get${area}FolderById`, async ({ params }) => {
    const folder = await folders.folder(params.id as string)
    if (!folder) return problemResponse(notFound('The folder could not be found'))
    return Response.json({ id: folder.key, name: folder.name, isTrashed: false })
  })
  router.handle(`Post${area}Folder`, async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const result = await folders.createFolder({
      key: typeof body.id === 'string' && body.id ? body.id : undefined,
      name: String(body.name ?? ''),
      parentKey: refOf(body.parent),
    })
    return created(
      `${ctx.url.origin}/umbraco/management/api/v1/${path}/folder/${result.key}`,
      result.key,
    )
  })
  router.handle(`Put${area}FolderById`, async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const ok = await folders.renameFolder(ctx.params.id as string, String(body.name ?? ''))
    if (!ok) return problemResponse(notFound('The folder could not be found'))
    return new Response(null, { status: 200 })
  })
  router.handle(`Delete${area}FolderById`, async ({ params }) => {
    const result = await folders.deleteFolder(params.id as string)
    if (result === 'not-found') return problemResponse(notFound('The folder could not be found'))
    if (result === 'not-empty')
      return problemResponse(
        problemDetails({
          title: 'The folder is not empty',
          status: 400,
          operationStatus: 'NotEmpty',
        }),
      )
    return new Response(null, { status: 200 })
  })
}

export function registerContentTypeHandlers(
  router: ManagementApiRouter,
  port: ContentTypePort,
  kind: ContentTypeKind = 'document',
  temporaryFiles?: {
    read(id: string): Promise<{ fileName: string; bytes: Uint8Array } | undefined>
  },
): void {
  const T = ({ document: 'DocumentType', media: 'MediaType', member: 'MemberType' } as const)[kind]
  const segment = { document: 'document-type', media: 'media-type', member: 'member-type' }[kind]
  const noun = { document: 'document type', media: 'media type', member: 'member type' }[kind]
  const title = { document: 'Document Type', media: 'Media Type', member: 'Member Type' }[kind]
  // Registers only what this kind's contract has (member types: no allowed children, …).
  const handle = (operationId: string, handler: Parameters<ManagementApiRouter['handle']>[1]) => {
    if (router.operations.some((o) => o.operationId === operationId))
      router.handle(operationId, handler)
  }
  const toResponse = (a: ContentTypeAggregate) =>
    kind === 'document'
      ? toDocumentTypeResponse(a)
      : kind === 'media'
        ? toMediaTypeResponse(a)
        : toMemberTypeResponse(a)
  const toTree = (item: TreeItem) =>
    kind === 'document'
      ? toTreeItemResponse(item)
      : kind === 'member'
        ? { ...toTreeItemResponse(item), noAccess: false }
        : {
            ...toTreeItemResponse(item),
            isDeletable: item.isFolder || !isSystemMediaType(item.key),
            noAccess: false,
          }
  const toItem = (a: ContentTypeAggregate) =>
    kind === 'document'
      ? toDocumentTypeItem(a)
      : { id: a.key, name: a.name, icon: a.icon, flags: [] }
  handle(`Get${T}ById`, async ({ params }) => {
    const aggregate = await port.byKey(params.id as string)
    if (!aggregate) return problemResponse(notFound(`The ${noun} could not be found`))
    return Response.json(toResponse(aggregate))
  })

  handle(`Post${T}`, async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const key = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID()
    const result = await port.create(
      fromDocumentTypeRequest(key, body, kind),
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) {
      return problemResponse(
        problemDetails({
          title: `Could not create the ${noun}`,
          status: result.status ?? 400,
          detail: result.reason,
        }),
      )
    }
    ctx.notifications.push({
      message: `${title} created`,
      category: title,
      type: 'Success',
    })
    return created(`${ctx.url.origin}/umbraco/management/api/v1/${segment}/${key}`, key)
  })

  handle(`Put${T}ById`, async (ctx) => {
    const key = ctx.params.id as string
    const existing = await port.byKey(key)
    if (!existing) {
      return problemResponse(notFound(`The ${noun} could not be found`))
    }
    const body = (await ctx.request.json()) as Record<string, unknown>
    if (kind === 'media' && isSystemMediaType(key) && body.alias !== existing.alias)
      return problemResponse(
        problemDetails({
          title: 'The alias of a system media type cannot be changed',
          status: 400,
          operationStatus: 'NotAllowed',
        }),
      )
    const result = await port.update(
      key,
      fromDocumentTypeRequest(key, body, kind),
      ctx.principal as NonNullable<typeof ctx.principal>,
    )
    if (!result.ok) {
      return problemResponse(
        problemDetails({
          title: `Could not save the ${noun}`,
          status: result.status ?? 400,
          detail: result.reason,
        }),
      )
    }
    ctx.notifications.push({
      message: `${title} saved`,
      category: title,
      type: 'Success',
    })
    return new Response(null, { status: 200 })
  })

  handle(`Delete${T}ById`, async (ctx) => {
    if (kind === 'media' && isSystemMediaType(ctx.params.id as string))
      return problemResponse(
        problemDetails({
          title: 'System media types cannot be deleted',
          status: 400,
          detail: 'Folder, Image and File are part of Umbraco and always present.',
          operationStatus: 'NotAllowed',
        }),
      )
    const removed = await port.remove(ctx.params.id as string)
    if (!removed) return problemResponse(notFound(`The ${noun} could not be found`))
    ctx.notifications.push({
      message: `${title} deleted`,
      category: title,
      type: 'Success',
    })
    return new Response(null, { status: 200 })
  })

  const pagedAggregates = async (
    ctx: RequestContext,
    load: (paging: SkipTake) => Promise<{ total: number; items: ContentTypeAggregate[] }>,
  ) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await load(page)
    return Response.json({
      total: result.total,
      items: result.items.map(toResponse),
    })
  }

  handle(`Get${T}AllowedAtRoot`, (ctx) => pagedAggregates(ctx, (page) => port.allowedAtRoot(page)))
  // `parentKey` narrows the result through Umbraco's content type filters, an
  // extensibility point with no implementations in core, so it is accepted and
  // has no effect — as it does there.
  handle(`Get${T}AllowedInLibrary`, (ctx) =>
    pagedAggregates(ctx, (page) => port.allowedInLibrary(page)),
  )
  handle(`Get${T}ByIdAllowedChildren`, (ctx) =>
    pagedAggregates(ctx, (page) => port.allowedChildren(ctx.params.id as string, page)),
  )

  handle(`Get${T}ByIdSchema`, async (ctx) => {
    const schema = await port.jsonSchema(ctx.params.id as string)
    if (!schema) return problemResponse(notFound(`The ${noun} could not be found`))
    return Response.json(schema)
  })

  handle(`Get${T}ByIdExport`, async (ctx) => {
    const xml = await port.exportUdt(ctx.params.id as string)
    if (!xml) return problemResponse(notFound(`The ${noun} could not be found`))
    const aggregate = await port.byKey(ctx.params.id as string)
    return new Response(xml, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${aggregate?.alias ?? 'export'}.udt"`,
      },
    })
  })

  const importFrom = async (ctx: RequestContext, targetKey?: string) => {
    const body = ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    const fileId = refOf(body.file)
    if (!fileId)
      return problemResponse(problemDetails({ title: 'A file is required', status: 400 }))
    const file = await temporaryFiles?.read(fileId)
    if (!file) return problemResponse(notFound('The file could not be found'))
    const result = await port.importUdt(new TextDecoder().decode(file.bytes), targetKey)
    if (result.status === 'not-found')
      return problemResponse(notFound(`The ${noun} could not be found`))
    if (result.status !== 'ok')
      return problemResponse(
        problemDetails({
          title: result.status === 'mismatch' ? 'The file does not match' : 'The file is not valid',
          detail: result.reason,
          status: 400,
        }),
      )
    ctx.notifications.push({ message: `${title} imported`, category: title, type: 'Success' })
    return result
  }

  handle(`Post${T}Import`, async (ctx) => {
    const result = await importFrom(ctx)
    if (result instanceof Response) return result
    return created(
      `${ctx.url.origin}/umbraco/management/api/v1/${segment}/${result.key}`,
      result.key,
    )
  })

  handle(`Put${T}ByIdImport`, async (ctx) => {
    const result = await importFrom(ctx, ctx.params.id as string)
    return result instanceof Response ? result : new Response(null, { status: 200 })
  })

  const foldersOnly = (ctx: RequestContext) => ctx.url.searchParams.get('foldersOnly') === 'true'

  handle(`GetTree${T}Root`, async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const result = await port.treeRoot({ ...page, foldersOnly: foldersOnly(ctx) })
    return Response.json({ total: result.total, items: result.items.map(toTree) })
  })

  handle(`GetTree${T}Children`, async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const parentId = ctx.url.searchParams.get('parentId')
    if (!parentId)
      return problemResponse(problemDetails({ title: 'parentId is required', status: 400 }))
    const result = await port.treeChildren(parentId, { ...page, foldersOnly: foldersOnly(ctx) })
    return Response.json({ total: result.total, items: result.items.map(toTree) })
  })

  handle(`GetTree${T}Siblings`, async (ctx) => {
    const target = ctx.url.searchParams.get('target')
    if (!target)
      return problemResponse(problemDetails({ title: 'target is required', status: 400 }))
    const window = await port.folders.siblings(
      target,
      Number(ctx.url.searchParams.get('before') ?? 0),
      Number(ctx.url.searchParams.get('after') ?? 0),
      foldersOnly(ctx),
    )
    if (!window) return problemResponse(notFound(`The ${noun} could not be found`))
    return Response.json({ ...window, items: window.items.map(toTree) })
  })

  handle(`Get${T}Configuration`, () =>
    Response.json(
      kind === 'document'
        ? {
            dataTypesCanBeChanged: 'True',
            disableTemplates: false,
            useSegments: false,
            reservedFieldNames: RESERVED_FIELD_NAMES,
          }
        : { reservedFieldNames: RESERVED_FIELD_NAMES },
    ),
  )

  handle(`Get${T}Batch`, async (ctx) => {
    const items = await port.byKeys(ctx.url.searchParams.getAll('id'))
    return Response.json({ total: items.length, items: items.map(toResponse) })
  })

  handle(`GetItem${T}Search`, async (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    const isElementParam = ctx.url.searchParams.get('isElement')
    const result = await port.search(ctx.url.searchParams.get('query') ?? '', {
      ...page,
      isElement: isElementParam === null ? undefined : isElementParam === 'true',
    })
    return Response.json({ total: result.total, items: result.items.map(toItem) })
  })

  handle(`Post${T}AvailableCompositions`, async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const available = await port.availableCompositions({
      key: typeof body.id === 'string' ? body.id : null,
      isElement: body.isElement === true,
      currentPropertyAliases: Array.isArray(body.currentPropertyAliases)
        ? (body.currentPropertyAliases as unknown[]).map(String)
        : [],
      currentCompositeKeys: Array.isArray(body.currentCompositeIds)
        ? (body.currentCompositeIds as unknown[]).map(String)
        : [],
    })
    return Response.json(
      available.map((a) => ({
        id: a.type.key,
        name: a.type.name,
        icon: a.type.icon,
        folderPath: a.folderPath,
        isCompatible: a.isCompatible,
      })),
    )
  })

  handle(`Get${T}ByIdCompositionReferences`, async ({ params }) => {
    const refs = await port.compositionReferences(params.id as string)
    return Response.json(refs.map((t) => ({ id: t.key, name: t.name, icon: t.icon })))
  })

  handle(`Get${T}ByIdAllowedParents`, async ({ params }) => {
    const ids = await port.allowedParents(params.id as string)
    return Response.json({ allowedParentIds: ids.map((id) => ({ id })) })
  })

  handle(`Put${T}ByIdMove`, async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const moved = await port.move(ctx.params.id as string, refOf(body.target))
    if (!moved) return problemResponse(notFound(`The ${noun} could not be found`))
    return new Response(null, { status: 200 })
  })

  handle(`Post${T}ByIdCopy`, async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const copy = await port.copy(ctx.params.id as string, refOf(body.target))
    if (!copy) return problemResponse(notFound(`The ${noun} could not be found`))
    return created(`${ctx.url.origin}/umbraco/management/api/v1/${segment}/${copy.key}`, copy.key)
  })

  // Media types have no templates.
  if (kind === 'document')
    router.handle(`Post${T}ByIdTemplate`, async (ctx) => {
      const body = (await ctx.request.json()) as Record<string, unknown>
      const result = await port.createTemplate(
        ctx.params.id as string,
        {
          alias: String(body.alias ?? ''),
          name: String(body.name ?? body.alias ?? ''),
          isDefault: body.isDefault === true,
        },
        ctx.principal as NonNullable<typeof ctx.principal>,
      )
      if (!result.ok)
        return problemResponse(
          problemDetails({
            title: 'Could not create the template',
            status: result.status ?? 400,
            detail: result.reason,
          }),
        )
      return created(
        `${ctx.url.origin}/umbraco/management/api/v1/template/${result.key}`,
        result.key,
      )
    })

  registerFolderHandlers(router, T, port.folders, toTree)

  handle(`GetTree${T}Ancestors`, async (ctx) => {
    const descendantId = ctx.url.searchParams.get('descendantId')
    // Umbraco binds a missing id to an empty GUID and answers with no ancestors.
    if (!descendantId) return Response.json([])
    return Response.json((await port.ancestors(descendantId)).map(toTree))
  })

  handle(`GetItem${T}Ancestors`, async (ctx) => {
    const result = []
    for (const id of ctx.url.searchParams.getAll('id'))
      result.push({
        id,
        ancestors: (await port.ancestors(id)).map((a) => ({ id: a.key, name: a.name, flags: [] })),
      })
    return Response.json(result)
  })

  handle(`GetItem${T}`, async (ctx) => {
    const keys = ctx.url.searchParams.getAll('id')
    const items = await port.items(keys)
    return Response.json(
      items.map((item) =>
        kind === 'document'
          ? {
              id: item.key,
              name: item.name,
              icon: item.icon,
              isElement: item.isElement ?? false,
              description: null,
              flags: [],
            }
          : { id: item.key, name: item.name, icon: item.icon, flags: [] },
      ),
    )
  })
}
