/**
 * Fixed reference answers: the node object types a relation type can join, and
 * the help pages. Umbraco relays its help pages from our.umbraco.com; there is
 * nothing to relay here, so the list is honestly empty.
 */
import { invalidSkipTake, ObjectTypes, problemResponse } from '@crombolo/core'
import type { ManagementApiRouter } from '../router.ts'
import { paging } from './content-type.ts'

/** Internal markers rather than things a relation can point at. */
const HIDDEN = new Set<string>(['SystemRoot', 'LockObject'])

/** `DocumentTypeContainer` → `Document Type Container`. */
const spaced = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2')

export const OBJECT_TYPES = Object.entries(ObjectTypes)
  .filter(([name]) => !HIDDEN.has(name))
  .map(([name, id]) => ({ id, name: spaced(name) }))
  .sort((a, b) => a.name.localeCompare(b.name))

export function registerReferenceDataHandlers(router: ManagementApiRouter): void {
  router.handle('GetObjectTypes', (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    return Response.json({
      total: OBJECT_TYPES.length,
      items: OBJECT_TYPES.slice(page.skip, page.skip + page.take),
    })
  })
  router.handle('GetHelp', (ctx) => {
    const page = paging(ctx)
    if (!page) return problemResponse(invalidSkipTake())
    return Response.json({ total: 0, items: [] })
  })
}
