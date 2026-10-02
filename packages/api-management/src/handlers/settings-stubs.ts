/**
 * Trees and lists the backoffice renders for areas not yet built — in the
 * Settings, Media and Library sections. Each answers an honest empty result in
 * the shape its operation declares, so every section loads, expands and
 * deep-links without an error toast; every one is replaced by a real handler
 * when its work package lands (docs/07-roadmap.md, Phase 6). Counted
 * separately by `coverage:api`.
 */
import { invalidSkipTake, notFound, problemResponse } from '@bunbraco/core'
import type { ManagementApiRouter } from '../router.ts'
import { paging } from './content-type.ts'

/** Trees with root, children, ancestors and siblings. */
const STUB_TREES = [] as const
/** Recycle bins for areas that have nothing to trash yet. */
const STUB_BINS = [] as const

/** Paged lists: `{ total, items }`, honouring skip/take validation. */
const PAGED = [
  ...STUB_TREES.flatMap((t) => [`GetTree${t}Root`, `GetTree${t}Children`]),
  ...STUB_BINS.flatMap((b) => [
    `GetRecycleBin${b}Root`,
    `GetRecycleBin${b}Children`,
    `GetRecycleBin${b}ReferencedBy`,
  ]),
  'GetRecycleBinDocumentReferencedBy', // needs relations, WP-6.9
  'GetRecycleBinMediaReferencedBy',
  'GetRecycleBinElementReferencedBy',
  // The recycle bin and the trash and delete dialogs; needs relations, WP-6.9. Until
  // then they cannot warn that other content links to what is being removed.
  'GetTreeStaticFileRoot',
  'GetTreeStaticFileChildren',
  'GetRelationType',
  'GetWebhook',
]
/** Ancestor lookups: a bare array. */
const ANCESTORS = [...STUB_TREES.map((t) => `GetTree${t}Ancestors`), 'GetTreeStaticFileAncestors']
/** Sibling windows: `{ totalBefore, totalAfter, items }`. */
const SIBLINGS = [
  ...STUB_TREES.map((t) => `GetTree${t}Siblings`),
  ...STUB_BINS.map((b) => `GetRecycleBin${b}Siblings`),
]
/** Lookups of one thing in an empty area: there is nothing to find. */
const NOT_FOUND: string[] = []

/** Fixed bodies. Umbraco's news dashboard relays umbraco.com; there is no feed to relay here. */
const FIXED: Record<string, unknown> = {
  GetNewsDashboard: { items: [] },
}

export const EMPTY_SETTINGS_OPERATIONS: readonly string[] = [
  ...PAGED,
  ...ANCESTORS,
  ...SIBLINGS,
  ...NOT_FOUND,
  ...Object.keys(FIXED),
]

export function registerSettingsStubHandlers(router: ManagementApiRouter): void {
  for (const operation of PAGED) {
    router.handle(operation, (ctx) => {
      if (!paging(ctx)) return problemResponse(invalidSkipTake())
      return Response.json({ total: 0, items: [] })
    })
  }
  for (const operation of ANCESTORS) router.handle(operation, () => Response.json([]))
  for (const operation of SIBLINGS) {
    router.handle(operation, () => Response.json({ totalBefore: 0, totalAfter: 0, items: [] }))
  }
  for (const operation of NOT_FOUND) {
    router.handle(operation, () => problemResponse(notFound('The item could not be found')))
  }
  for (const [operation, body] of Object.entries(FIXED)) {
    router.handle(operation, () => Response.json(body))
  }
}
