/**
 * What a stored value refers to.
 *
 * `ReferenceRepository` answers the other direction — what refers to *this* node
 * — by scanning for a known key. Exporting needs the outbound direction, from a
 * value to the keys inside it, and nothing knew how to do that.
 *
 * Two spellings travel, as `references.ts` in `@bunbraco/data` documents: a
 * picker stores `umb://document/<hex>` or a bare uuid, dashed or not. Element
 * pickers store a bare `Guid[]`, and rich text and block editors hold both
 * inside JSON, so the scan goes through structures and through JSON held in a
 * string.
 *
 * **These are candidates, not references.** An undashed 32-hex run is
 * indistinguishable from any other 32 hex characters, so the caller resolves
 * each against `node.unique_id` and discards what does not exist. Being wrong
 * in this direction is cheap; missing a reference is not.
 */
import { keyFromReference } from '@bunbraco/core'

/** Dashed uuids, and 32-hex runs that are not part of a longer hex string. */
const DASHED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const PLAIN = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi

function fromString(text: string, into: Set<string>): void {
  for (const match of text.matchAll(DASHED)) {
    const key = keyFromReference(match[0])
    if (key) into.add(key)
  }
  for (const match of text.matchAll(PLAIN)) {
    const key = keyFromReference(match[0])
    if (key) into.add(key)
  }
}

function walk(value: unknown, into: Set<string>, depth: number): void {
  // Block editors nest, but not deeply; the guard is against a cycle in a
  // structure we did not build, not against legitimate nesting.
  if (depth > 32) return
  if (typeof value === 'string') {
    fromString(value, into)
    // A value is often JSON in a string. Scanning the text already found every
    // key in it, so parsing adds nothing — except where a key is escaped or
    // split across the encoding, which is why the parse is attempted at all.
    if (/^\s*[[{]/.test(value)) {
      try {
        walk(JSON.parse(value), into, depth + 1)
      } catch {
        // Not JSON after all; the text scan above stands.
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, into, depth + 1)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) walk(item, into, depth + 1)
  }
}

/**
 * Every key-shaped candidate inside a value, dashed and lowercased. Resolve
 * them against real nodes before treating any of them as a reference.
 */
export function referenceCandidates(value: unknown): string[] {
  const found = new Set<string>()
  walk(value, found, 0)
  return [...found].sort()
}
