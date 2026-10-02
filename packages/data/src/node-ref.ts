/**
 * A node named on a command line: either its uuid, or a path through the tree
 * by name.
 *
 * Paths exist because nobody hand-types `9a1f3c2e-…`, and the person running a
 * transfer knows where content sits, not what its key is. One resolver serves
 * `content export --root` and `content import --under` so the two cannot drift
 * in what they accept.
 *
 * Three rules keep the convenience from becoming ambiguity:
 *
 * - a uuid-shaped argument is always a uuid, never a path, so a path can never
 *   be mistaken for a key or the other way round;
 * - a path matches case-insensitively by node name, from the content root, with
 *   a leading slash optional;
 * - a path matching nothing, or more than one node, is an error that names the
 *   candidates. Guessing here would place content somewhere nobody chose.
 */
import { SystemNodes } from '@bunbraco/core'
import type { Db } from './database.ts'
import { NodeRepository, type NodeRow } from './repositories/nodes.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type NodeRefResolution =
  | { ok: true; node: NodeRow }
  | {
      ok: false
      reason: 'not-found' | 'ambiguous'
      /** The segment that failed, or the whole reference when it was a key. */
      at: string
      /** What was there instead, to print alongside the failure. */
      candidates: string[]
    }

export const looksLikeKey = (ref: string): boolean => UUID.test(ref.trim())

/** `/Campaigns/Autumn 2026` → `['Campaigns', 'Autumn 2026']` */
export function pathSegments(ref: string): string[] {
  return ref
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

/**
 * Resolves a reference against the tree of `objectTypes`. Pass every object type
 * a segment could name — a media path runs through media folders, and a document
 * path through documents only.
 */
export async function resolveNodeRef(
  db: Db,
  objectTypes: readonly string[],
  ref: string,
): Promise<NodeRefResolution> {
  const nodes = new NodeRepository(db)
  const trimmed = ref.trim()
  if (looksLikeKey(trimmed)) {
    const node = await nodes.byKey(trimmed)
    return node
      ? { ok: true, node }
      : { ok: false, reason: 'not-found', at: trimmed, candidates: [] }
  }

  const segments = pathSegments(trimmed)
  if (segments.length === 0) return { ok: false, reason: 'not-found', at: trimmed, candidates: [] }

  let parentId: number = SystemNodes.Root
  let resolved: NodeRow | undefined
  for (const segment of segments) {
    const matches = await nodes.childrenNamed(parentId, objectTypes, segment)
    if (matches.length === 0)
      return {
        ok: false,
        reason: 'not-found',
        at: segment,
        candidates: await nodes.childNames(parentId, objectTypes),
      }
    if (matches.length > 1)
      return {
        ok: false,
        reason: 'ambiguous',
        at: segment,
        // Two siblings of one name: the keys are the only way to tell them apart.
        candidates: matches.map((m) => m.key),
      }
    resolved = matches[0] as NodeRow
    parentId = resolved.id
  }
  return resolved
    ? { ok: true, node: resolved }
    : { ok: false, reason: 'not-found', at: trimmed, candidates: [] }
}

/** The message a CLI or a finding prints for a failed resolution. */
export function describeRefFailure(ref: string, failure: NodeRefResolution): string {
  if (failure.ok) return ''
  if (failure.reason === 'ambiguous')
    return `"${ref}": more than one node is named "${failure.at}" here — name one by key: ${failure.candidates.join(', ')}`
  const there =
    failure.candidates.length > 0
      ? ` — there is ${failure.candidates.map((c) => `"${c}"`).join(', ')}`
      : ''
  return looksLikeKey(ref)
    ? `"${ref}": no node with that key here`
    : `"${ref}": nothing named "${failure.at}"${there}`
}
