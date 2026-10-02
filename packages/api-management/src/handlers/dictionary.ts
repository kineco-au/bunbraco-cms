/** Dictionary items: the list, tree, item lookups, CRUD, move, and `.udt` import and export. */
import {
  invalidSkipTake,
  notFound,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type { DictionaryItemModel, DictionaryPort, DictionaryWriteStatus } from '../ports.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { created } from './content-type.ts'

const itemNotFound = () => problemResponse(notFound('The dictionary item could not be found'))

function statusResult(status: DictionaryWriteStatus): Response | undefined {
  switch (status) {
    case 'Success':
      return undefined
    case 'NotFound':
      return itemNotFound()
    case 'ParentNotFound':
      return problemResponse(notFound('The dictionary item parent could not be found', undefined))
    case 'DuplicateItemKey':
      return problemResponse(
        problemDetails({
          title: 'Duplicate dictionary item name detected',
          detail:
            'Another dictionary item exists with the same name. Dictionary item names must be unique.',
          status: 409,
          operationStatus: 'DuplicateItemKey',
        }),
      )
    case 'InvalidParent':
      return problemResponse(
        problemDetails({
          title: 'Invalid parent',
          detail:
            'The targeted parent dictionary item is not valid for this dictionary item operation.',
          status: 400,
          operationStatus: 'InvalidParent',
        }),
      )
    case 'DuplicateKey':
      return problemResponse(
        problemDetails({
          title: 'Duplicate key',
          detail: 'A dictionary item with this id already exists.',
          status: 400,
          operationStatus: 'DuplicateKey',
        }),
      )
    case 'InvalidLanguage':
      return problemResponse(
        problemDetails({
          title: 'Invalid language',
          detail: 'A translation names a language the site does not have.',
          status: 400,
          operationStatus: 'InvalidLanguageIsoCode',
        }),
      )
  }
}

function readTranslations(value: unknown): DictionaryItemModel['translations'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const t = raw as Record<string, unknown>
    return typeof t.isoCode === 'string'
      ? [
          {
            isoCode: t.isoCode,
            translation: typeof t.translation === 'string' ? t.translation : '',
          },
        ]
      : []
  })
}

const refId = (value: unknown): string | null => {
  const id = (value as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' ? id : null
}

const treeItem = (item: {
  key: string
  name: string
  parentKey: string | null
  hasChildren: boolean
}) => ({
  id: item.key,
  name: item.name,
  parent: item.parentKey ? { id: item.parentKey } : null,
  hasChildren: item.hasChildren,
  flags: [],
})

function page<T>(ctx: RequestContext, items: readonly T[]): Response {
  const parsed = parseSkipTake(ctx.url.searchParams)
  if (!parsed.ok) return problemResponse(invalidSkipTake())
  const { skip, take } = parsed.value
  return Response.json(paged(items.slice(skip, skip + take), items.length))
}

export function registerDictionaryHandlers(
  router: ManagementApiRouter,
  dictionary: DictionaryPort,
): void {
  router.handle('GetDictionary', async (ctx) => {
    const filter = ctx.url.searchParams.get('filter') ?? undefined
    const all = await dictionary.all(filter || undefined)
    return page(
      ctx,
      all.map((item) => ({
        id: item.key,
        name: item.name,
        parent: item.parentKey ? { id: item.parentKey } : null,
        translatedIsoCodes: item.translations
          .filter((t) => t.translation.trim() !== '')
          .map((t) => t.isoCode),
      })),
    )
  })

  router.handle('GetDictionaryById', async ({ params }) => {
    const item = await dictionary.get(params.id as string)
    if (!item) return itemNotFound()
    return Response.json({ id: item.key, name: item.name, translations: item.translations })
  })

  router.handle('PostDictionary', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const key = typeof body.id === 'string' ? body.id : crypto.randomUUID()
    const failed = statusResult(
      await dictionary.create({
        key,
        name: String(body.name ?? '').trim(),
        parentKey: refId(body.parent),
        translations: readTranslations(body.translations),
      }),
    )
    if (failed) return failed
    return created(`${ctx.url.origin}/umbraco/management/api/v1/dictionary/${key}`, key)
  })

  router.handle('PutDictionaryById', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const failed = statusResult(
      await dictionary.update(ctx.params.id as string, {
        name: String(body.name ?? '').trim(),
        translations: readTranslations(body.translations),
      }),
    )
    return failed ?? new Response(null, { status: 200 })
  })

  router.handle('DeleteDictionaryById', async ({ params }) => {
    return statusResult(await dictionary.delete(params.id as string)) ?? new Response(null)
  })

  router.handle('PutDictionaryByIdMove', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    return (
      statusResult(await dictionary.move(ctx.params.id as string, refId(body.target))) ??
      new Response(null)
    )
  })

  router.handle('GetDictionaryByIdExport', async (ctx) => {
    const file = await dictionary.export(
      ctx.params.id as string,
      ctx.url.searchParams.get('includeChildren') === 'true',
    )
    if (!file) return itemNotFound()
    return new Response(file.content, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${file.fileName.replaceAll('"', '')}"`,
      },
    })
  })

  router.handle('PostDictionaryImport', async (ctx) => {
    const body = (await ctx.request.json()) as Record<string, unknown>
    const fileId = refId(body.temporaryFile)
    if (!fileId)
      return problemResponse(problemDetails({ title: 'A temporary file is required', status: 400 }))
    const result = await dictionary.import(fileId, refId(body.parent))
    if (!result.ok)
      return problemResponse(
        result.status === 'Invalid'
          ? problemDetails({
              title: 'Invalid file',
              detail: result.reason,
              status: 400,
              operationStatus: 'InvalidFileContent',
            })
          : notFound(
              result.status === 'ParentNotFound'
                ? 'The parent dictionary item could not be found'
                : 'The temporary file could not be found',
              result.reason,
            ),
      )
    return created(
      `${ctx.url.origin}/umbraco/management/api/v1/dictionary/${result.key}`,
      result.key,
    )
  })

  router.handle('GetItemDictionary', async (ctx) => {
    const items = await dictionary.items(ctx.url.searchParams.getAll('id'))
    return Response.json(items.map((item) => ({ id: item.key, name: item.name, flags: [] })))
  })

  router.handle('GetTreeDictionaryRoot', async (ctx) =>
    page(ctx, (await dictionary.children(null)).map(treeItem)),
  )

  router.handle('GetTreeDictionaryChildren', async (ctx) => {
    const parentId = ctx.url.searchParams.get('parentId')
    return page(ctx, parentId ? (await dictionary.children(parentId)).map(treeItem) : [])
  })

  router.handle('GetTreeDictionaryAncestors', async (ctx) => {
    const id = ctx.url.searchParams.get('descendantId')
    if (!id) return Response.json([])
    const chain = await dictionary.ancestry(id)
    const withChildren = new Set(
      (await Promise.all(chain.map((item) => dictionary.children(item.key))))
        .map((children, i) => (children.length > 0 ? chain[i]?.key : undefined))
        .filter((key): key is string => key !== undefined),
    )
    return Response.json(
      chain.map((item) =>
        treeItem({
          key: item.key,
          name: item.name,
          parentKey: item.parentKey,
          hasChildren: withChildren.has(item.key),
        }),
      ),
    )
  })
}
