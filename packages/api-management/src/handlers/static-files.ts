/**
 * The static-file picker's tree: the stylesheets and scripts folders the site
 * serves at `/css/` and `/scripts/`, so every path it offers is one a browser
 * can load as it stands. Read-only; the files are edited in their own areas.
 */
import { invalidSkipTake, paged, parseSkipTake, problemResponse } from '@crombolo/core'
import type { FileEntry, FileSystemPort } from '../ports-files.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'

type Area = Pick<FileSystemPort, 'children' | 'entry'>

/** The two served folders, by the URL segment each is served under. */
export function createStaticFiles(mounts: Record<string, Area>): Area {
  const split = (path: string): [Area, string, string] | undefined => {
    const [, mount = '', ...rest] = path.replace(/\/+$/, '').split('/')
    const area = mounts[mount]
    return area ? [area, mount, `/${rest.join('/')}`] : undefined
  }
  const mounted = (mount: string, entry: FileEntry): FileEntry => ({
    ...entry,
    path: `/${mount}${entry.path}`,
    parentPath: entry.parentPath ? `/${mount}${entry.parentPath}` : `/${mount}`,
  })
  const folder = async (mount: string, area: Area): Promise<FileEntry | undefined> => {
    const children = await area.children(null)
    if (!children || children.length === 0) return undefined
    return { name: mount, path: `/${mount}`, parentPath: null, isFolder: true, hasChildren: true }
  }
  return {
    async children(parentPath) {
      if (!parentPath || parentPath === '/') {
        const roots = await Promise.all(
          Object.entries(mounts).map(([mount, area]) => folder(mount, area)),
        )
        return roots.filter((entry): entry is FileEntry => entry !== undefined)
      }
      const found = split(parentPath)
      if (!found) return undefined
      const [area, mount, inner] = found
      const children = await area.children(inner === '/' ? null : inner)
      return children?.map((entry) => mounted(mount, entry))
    },
    async entry(path) {
      const found = split(path)
      if (!found) return undefined
      const [area, mount, inner] = found
      if (inner === '/') return folder(mount, area)
      const entry = await area.entry(inner)
      return entry ? mounted(mount, entry) : undefined
    },
  }
}

const treeItem = (entry: FileEntry) => ({
  name: entry.name,
  path: entry.path,
  parent: entry.parentPath ? { path: entry.parentPath } : null,
  isFolder: entry.isFolder,
  hasChildren: entry.hasChildren,
})

export function registerStaticFileHandlers(router: ManagementApiRouter, files: Area): void {
  const page = (ctx: RequestContext, entries: readonly FileEntry[] | undefined) => {
    const parsed = parseSkipTake(ctx.url.searchParams)
    if (!parsed.ok) return problemResponse(invalidSkipTake())
    const all = (entries ?? []).map(treeItem)
    const { skip, take } = parsed.value
    return Response.json(paged(all.slice(skip, skip + take), all.length))
  }
  router.handle('GetTreeStaticFileRoot', async (ctx) => page(ctx, await files.children(null)))
  router.handle('GetTreeStaticFileChildren', async (ctx) =>
    page(ctx, await files.children(ctx.url.searchParams.get('parentPath') || null)),
  )
  router.handle('GetTreeStaticFileAncestors', async (ctx) => {
    const path = ctx.url.searchParams.get('descendantPath')
    const chain: FileEntry[] = []
    let current = path ? await files.entry(path) : undefined
    while (current) {
      chain.unshift(current)
      current = current.parentPath ? await files.entry(current.parentPath) : undefined
    }
    return Response.json(chain.map(treeItem))
  })
  router.handle('GetItemStaticFile', async (ctx) => {
    const items = []
    for (const path of ctx.url.searchParams.getAll('path')) {
      const entry = await files.entry(path)
      if (entry)
        items.push({
          isFolder: entry.isFolder,
          name: entry.name,
          parent: entry.parentPath ? { path: entry.parentPath } : null,
          path: entry.path,
        })
    }
    return Response.json(items)
  })
}
