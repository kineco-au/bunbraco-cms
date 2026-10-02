/**
 * The boundary. Everything the assistant can reach is named here: the areas it
 * may read, the handful of non-GET operations that are provably non-mutating,
 * and the five operations an approved proposal is applied through.
 *
 * Nothing that publishes, deletes, moves, copies or trashes appears in any of
 * them, and `FORBIDDEN` is asserted disjoint from the readable and apply sets by
 * tests/assistant-boundary.test.ts — so widening one of these lists without
 * meaning to fails the suite rather than the site.
 */
import { listOperations, loadSpec, type OperationInfo } from '@bunbraco/contracts'

/**
 * Areas the assistant may read. An allowlist, not a denylist: an area added to
 * the contract by a future Umbraco release is unreachable until it is named here.
 *
 * Users, members and their types are absent by choice. They are backoffice
 * management too, but reading them discloses people's data and the assistant
 * does not need it to build pages, and proposing them would put privilege
 * escalation inside a review queue.
 */
export const READABLE_AREAS: ReadonlySet<string> = new Set([
  'collection',
  'culture',
  'data-type',
  'dictionary',
  'document',
  'document-blueprint',
  'document-type',
  'document-version',
  'dynamic-root',
  'element',
  'element-version',
  'filter',
  'item',
  'language',
  'manifest',
  'media',
  'media-type',
  'object-types',
  'partial-view',
  'property-type',
  'relation-type',
  'script',
  'searcher',
  'segment',
  'server',
  'stylesheet',
  'template',
  'tree',
])

/**
 * Operations that change nothing despite their method: Umbraco validates a
 * document by POSTing it, and asks which compositions are available the same
 * way. Each one is asserted against `FORBIDDEN` and against a hand-checked list
 * in the boundary test, because a mistake here is the one way a write could
 * reach the database without an approval.
 */
export const NON_MUTATING_WRITES: ReadonlySet<string> = new Set([
  'PostDocumentValidate',
  'PutDocumentByIdValidate',
  'PostDocumentTypeAvailableCompositions',
])

/**
 * Path fragments that mark an operation as out of bounds, whatever its area.
 * Publishing is here rather than behind an approval: making content live is a
 * person's act, performed in the backoffice as themselves.
 */
const FORBIDDEN_FRAGMENTS = [
  'publish',
  'unpublish',
  'recycle-bin',
  'move',
  'copy',
  'sort',
  'public-access',
  'domains',
  'notifications',
  'import',
  'export',
  'folder',
  'patch',
  'template/query',
] as const

export function isForbidden(operation: OperationInfo): boolean {
  if (operation.method === 'delete') return true
  const path = operation.path.toLowerCase()
  return FORBIDDEN_FRAGMENTS.some((fragment) => path.includes(`/${fragment}`))
}

/** Whether the assistant may dispatch this operation to answer a question. */
export function isReadable(operation: OperationInfo): boolean {
  if (!operation.area || !READABLE_AREAS.has(operation.area)) return false
  if (isForbidden(operation)) return false
  return operation.method === 'get' || NON_MUTATING_WRITES.has(operation.operationId)
}

/** What a proposal changes. Each kind has one apply operation and one reviewable form. */
export type ChangeKind =
  | 'document'
  | 'document-create'
  | 'document-type'
  | 'document-type-create'
  | 'data-type'
  | 'data-type-create'
  | 'template'
  | 'template-create'

/**
 * Kinds applied by writing their schema file and importing it, rather than by
 * dispatching a Management API operation.
 *
 * Schema is TOML on disk and the database is a view of it, so a type change that
 * went through the API would write the database and derive the file from it —
 * the wrong way round, and the reason the version could never be classified.
 * Writing the file and importing keeps one writer and one direction.
 *
 * The trade is that these do not pass through `authorization.ts`, so the apply
 * path checks the caller's Settings access itself, the way that file would for a
 * `document-type` operation. See `docs/12-schema-at-runtime.md`.
 */
export const SCHEMA_KINDS: ReadonlySet<ChangeKind> = new Set([
  'document-type',
  'document-type-create',
  'data-type',
  'data-type-create',
])

/**
 * The operation an approved proposal is dispatched through. `document-create`
 * uses `PostDocument`, never `PostDocumentCreateAndPublish`: an applied proposal
 * always lands as a draft. Schema kinds have none — see `SCHEMA_KINDS`.
 */
export const APPLY_OPERATIONS: Readonly<Partial<Record<ChangeKind, string>>> = {
  document: 'PutDocumentById',
  'document-create': 'PostDocument',
  template: 'PutTemplateById',
  'template-create': 'PostTemplate',
}

export const CHANGE_KINDS: ChangeKind[] = [
  'document',
  'document-create',
  'document-type',
  'document-type-create',
  'data-type',
  'data-type-create',
  'template',
  'template-create',
]

/** Which schema file a kind writes, and the TOML table it carries. */
export const SCHEMA_KIND_FILES: Readonly<Record<string, 'document' | 'data'>> = {
  'document-type': 'document',
  'document-type-create': 'document',
  'data-type': 'data',
  'data-type-create': 'data',
}

/** Every operation the assistant may dispatch to read, contract order. */
export function readableOperations(
  operations: readonly OperationInfo[] = listOperations(loadSpec()),
): OperationInfo[] {
  return operations.filter(isReadable)
}

/**
 * What a person may change about a proposal, per kind. Anything not named here is
 * fixed at proposal time.
 *
 * The rule is that you edit the thing in the form you would have written it: a
 * template's TSX, a page's markup, a type's TOML. You do not edit the prepared
 * request — which type a page is, which parent it sits under, which operation it
 * dispatches — because that is not reviewing a change, it is writing a different
 * one, and none of it is legible as JSON anyway.
 *
 * Enforced on the way in rather than by hiding a button, so an edit that reaches
 * the endpoint by some other route is refused the same way.
 */
export const EDITABLE_FIELDS: Readonly<Record<ChangeKind, readonly string[]>> = {
  document: ['values'],
  'document-create': ['values'],
  'document-type': ['toml'],
  'document-type-create': ['toml'],
  'data-type': ['toml'],
  'data-type-create': ['toml'],
  template: ['content'],
  'template-create': ['content'],
}
