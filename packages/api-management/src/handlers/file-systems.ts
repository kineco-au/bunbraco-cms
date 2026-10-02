/**
 * Partial views, stylesheets and scripts: one file-system area each, served by
 * the same handlers — the tree, items, the file and its folders — keyed by path.
 */
import {
  invalidSkipTake,
  notFound,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type { FileEntry, FileResult, FileStatus, FileSystemPort, Snippet } from '../ports-files.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'

export type FileArea = 'PartialView' | 'Stylesheet' | 'Script'

const LABEL: Record<FileArea, string> = {
  PartialView: 'Partial view',
  Stylesheet: 'Stylesheet',
  Script: 'Script',
}
const ROUTE: Record<FileArea, string> = {
  PartialView: 'partial-view',
  Stylesheet: 'stylesheet',
  Script: 'script',
}

const parentRef = (parentPath: string | null) => (parentPath ? { path: parentPath } : null)

const treeItem = (entry: FileEntry) => ({
  name: entry.name,
  path: entry.path,
  parent: parentRef(entry.parentPath),
  isFolder: entry.isFolder,
  hasChildren: entry.hasChildren,
})

function failure(area: FileArea, status: FileStatus, folder = false): Response {
  const thing = folder ? 'Folder' : LABEL[area]
  const [code, title] = (
    {
      AlreadyExists: [400, `${thing} already exists`],
      NotFound: [404, `${thing} not found`],
      ParentNotFound: [404, 'Parent not found'],
      InvalidName: [400, 'Invalid name'],
      InvalidFileExtension: [400, 'Invalid file extension'],
      NotEmpty: [400, 'Folder is not empty'],
    } as const
  )[status]
  return problemResponse(problemDetails({ title, status: code, operationStatus: status }))
}

async function body(ctx: RequestContext): Promise<Record<string, unknown>> {
  return ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
}

const parentPathOf = (value: unknown): string | null => {
  const path = (value as { path?: unknown } | null | undefined)?.path
  return typeof path === 'string' && path !== '' && path !== '/' ? path : null
}

export function registerFileSystemHandlers(
  router: ManagementApiRouter,
  area: FileArea,
  port: FileSystemPort,
  snippets: readonly Snippet[] = [],
): void {
  const base = `/umbraco/management/api/v1/${ROUTE[area]}`
  const created = (ctx: RequestContext, path: string, folder = false) =>
    new Response(null, {
      status: 201,
      headers: {
        location: `${ctx.url.origin}${base}${folder ? '/folder' : ''}/${encodeURIComponent(path)}`,
        'umb-generated-resource': encodeURIComponent(path),
      },
    })
  const result = (ctx: RequestContext, outcome: FileResult, create: boolean, folder = false) => {
    if (!outcome.ok) return failure(area, outcome.status, folder)
    return create ? created(ctx, outcome.path, folder) : new Response(null, { status: 200 })
  }
  const page = (ctx: RequestContext, entries: readonly FileEntry[] | undefined) => {
    const parsed = parseSkipTake(ctx.url.searchParams)
    if (!parsed.ok) return problemResponse(invalidSkipTake())
    const all = (entries ?? []).map(treeItem)
    const { skip, take } = parsed.value
    return Response.json(paged(all.slice(skip, skip + take), all.length))
  }

  router.handle(`GetTree${area}Root`, async (ctx) => page(ctx, await port.children(null)))
  router.handle(`GetTree${area}Children`, async (ctx) =>
    page(ctx, await port.children(ctx.url.searchParams.get('parentPath') || null)),
  )
  router.handle(`GetTree${area}Ancestors`, async (ctx) => {
    const path = ctx.url.searchParams.get('descendantPath')
    const chain: FileEntry[] = []
    let current = path ? await port.entry(path) : undefined
    while (current) {
      chain.unshift(current)
      current = current.parentPath ? await port.entry(current.parentPath) : undefined
    }
    return Response.json(chain.map(treeItem))
  })
  router.handle(`GetTree${area}Siblings`, async (ctx) => {
    const path = ctx.url.searchParams.get('path') ?? ''
    const target = await port.entry(path)
    // As the tree answers for a path it cannot find: no siblings
    if (!target) return Response.json({ totalBefore: 0, totalAfter: 0, items: [] })
    const siblings = (await port.children(target.parentPath)) ?? []
    const index = siblings.findIndex((s) => s.path === target.path)
    const before = Math.max(0, Number(ctx.url.searchParams.get('before') ?? 0))
    const after = Math.max(0, Number(ctx.url.searchParams.get('after') ?? 0))
    const from = Math.max(0, index - before)
    return Response.json({
      totalBefore: from,
      totalAfter: Math.max(0, siblings.length - (index + after + 1)),
      items: siblings.slice(from, index + after + 1).map(treeItem),
    })
  })

  router.handle(`GetItem${area}`, async (ctx) => {
    const items = []
    for (const path of ctx.url.searchParams.getAll('path')) {
      const entry = await port.entry(path)
      if (entry)
        items.push({
          isFolder: entry.isFolder,
          name: entry.name,
          parent: parentRef(entry.parentPath),
          path: entry.path,
        })
    }
    return Response.json(items)
  })

  router.handle(`Get${area}ByPath`, async (ctx) => {
    const file = await port.read(ctx.params.path as string)
    if (!file) return failure(area, 'NotFound')
    return Response.json({
      name: file.name,
      path: file.path,
      parent: parentRef(file.parentPath),
      content: file.content,
    })
  })
  router.handle(`Post${area}`, async (ctx) => {
    const b = await body(ctx)
    const outcome = await port.create(
      parentPathOf(b.parent),
      String(b.name ?? ''),
      typeof b.content === 'string' ? b.content : '',
    )
    return result(ctx, outcome, true)
  })
  router.handle(`Put${area}ByPath`, async (ctx) => {
    const b = await body(ctx)
    const content = typeof b.content === 'string' ? b.content : ''
    return result(ctx, await port.update(ctx.params.path as string, content), false)
  })
  router.handle(`Put${area}ByPathRename`, async (ctx) => {
    const b = await body(ctx)
    return result(ctx, await port.rename(ctx.params.path as string, String(b.name ?? '')), true)
  })
  router.handle(`Delete${area}ByPath`, async (ctx) =>
    result(ctx, await port.delete(ctx.params.path as string), false),
  )

  router.handle(`Post${area}Folder`, async (ctx) => {
    const b = await body(ctx)
    return result(
      ctx,
      await port.createFolder(parentPathOf(b.parent), String(b.name ?? '')),
      true,
      true,
    )
  })
  router.handle(`Get${area}FolderByPath`, async (ctx) => {
    const entry = await port.entry(ctx.params.path as string)
    if (!entry?.isFolder) return failure(area, 'NotFound', true)
    return Response.json({
      name: entry.name,
      path: entry.path,
      parent: parentRef(entry.parentPath),
    })
  })
  router.handle(`Delete${area}FolderByPath`, async (ctx) =>
    result(ctx, await port.deleteFolder(ctx.params.path as string), false, true),
  )

  if (area !== 'PartialView') return
  router.handle('GetPartialViewSnippet', (ctx) => {
    const parsed = parseSkipTake(ctx.url.searchParams)
    if (!parsed.ok) return problemResponse(invalidSkipTake())
    const { skip, take } = parsed.value
    return Response.json(
      paged(
        snippets.slice(skip, skip + take).map((s) => ({ id: s.id, name: s.name })),
        snippets.length,
      ),
    )
  })
  router.handle('GetPartialViewSnippetById', (ctx) => {
    const snippet = snippets.find((s) => s.id === ctx.params.id)
    if (!snippet) return problemResponse(notFound('Snippet not found'))
    return Response.json(snippet)
  })
}
