/**
 * The words a stored value contributes to the search index, and the folding
 * both the index and a query go through so they meet. docs/search.md.
 */

/**
 * Lowercase words without diacritics: letters and digits only, everything else
 * a separator. The index stores text in this form, so the full-text engines on
 * both dialects only ever split on spaces, and match the same way.
 */
export function searchWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
}

/** The distinct words of a query, at most a dozen: what every result must hold by prefix. */
export function searchTerms(query: string): string[] {
  return [...new Set(searchWords(query))].slice(0, 12)
}

const IDENTIFIER =
  /^(?:umb:\/\/\S+|\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?)$/i

/**
 * Keys inside an editor's JSON that hold structure rather than words: block
 * and media references, editor aliases, crops. Their values are never text an
 * editor wrote.
 */
const STRUCTURAL_KEYS = new Set([
  'alias',
  'contentKey',
  'contentTypeKey',
  'crops',
  'culture',
  'editorAlias',
  'expose',
  'focalPoint',
  'icon',
  'key',
  'layout',
  'mediaKey',
  'mediaTypeAlias',
  'segment',
  'settingsKey',
  'settingsTypeKey',
  'udi',
  'unique',
])

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function stripMarkup(text: string): string {
  if (!text.includes('<') && !text.includes('&')) return text
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X'))
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)))
      return ENTITIES[name.toLowerCase()] ?? entity
    })
}

/** Whether an element type's property is kept out of search: `searchable = false`. */
export type UnsearchableProperty = (contentTypeKey: string, alias: string) => boolean

const NOTHING_UNSEARCHABLE: UnsearchableProperty = () => false

function collect(value: unknown, out: string[], unsearchable: UnsearchableProperty): void {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0 || IDENTIFIER.test(trimmed)) return
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        collect(JSON.parse(trimmed), out, unsearchable)
        return
      } catch {
        // Not JSON after all; it is text that happens to start with a bracket.
      }
    }
    const text = stripMarkup(trimmed).replace(/\s+/g, ' ').trim()
    if (text.length > 0) out.push(text)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, unsearchable)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  // A block's element: its values are listed by alias, or (older format) keyed by it.
  const elementType = typeof record.contentTypeKey === 'string' ? record.contentTypeKey : undefined
  for (const [key, item] of Object.entries(record)) {
    if (STRUCTURAL_KEYS.has(key)) continue
    if (elementType && unsearchable(elementType, key)) continue
    if (elementType && key === 'values' && Array.isArray(item)) {
      for (const entry of item) {
        const alias = (entry as { alias?: unknown } | null)?.alias
        if (typeof alias === 'string' && unsearchable(elementType, alias)) continue
        collect(entry, out, unsearchable)
      }
      continue
    }
    collect(item, out, unsearchable)
  }
}

/**
 * The readable text in a stored value: plain strings as they are, markup without
 * its tags, and the strings inside an editor's JSON (blocks, rich text, pickers
 * with captions) without the keys and references that hold it together, or
 * the values of a block's properties marked `searchable = false`.
 */
export function valueText(
  raw: unknown,
  unsearchable: UnsearchableProperty = NOTHING_UNSEARCHABLE,
): string[] {
  const out: string[] = []
  collect(raw, out, unsearchable)
  return out
}
