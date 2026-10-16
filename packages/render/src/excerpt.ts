/**
 * Search excerpts: the stretch of a page's text around the words searched for,
 * with each matching word marked. Words are compared folded — lowercase, no
 * diacritics — exactly as the index matches them, and a word matches a query
 * word it starts with. Pure, so both dialects give the same excerpt.
 */

/** A page's text by weight, as the site-search index keeps it. */
export interface SearchableText {
  name: string
  high: readonly string[]
  normal: readonly string[]
  low: readonly string[]
}

/** A run of excerpt text; `match` when it is a word the query matched. */
export interface ExcerptSegment {
  text: string
  match: boolean
}

const WORD = /[\p{L}\p{N}]+/gu

/** A word as the index stores it: decomposed, diacritics stripped, lowercase. */
export function foldWord(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/** The folded words of a query. */
export function queryWords(query: string): string[] {
  return [...new Set((query.match(WORD) ?? []).map(foldWord).filter(Boolean))]
}

const matches = (word: string, terms: readonly string[]) => {
  const folded = foldWord(word)
  return terms.some((term) => folded.startsWith(term))
}

/**
 * About `length` characters of the page's text around the first matching
 * word, taken from its highest-weighted text that matches, else from the start
 * of its text. Ends that were cut are marked with an ellipsis.
 */
export function excerpt(text: SearchableText, query: string, length = 200): ExcerptSegment[] {
  const terms = queryWords(query)
  const fields = [text.high, text.normal, text.low]
    .map((field) => field.join(' … ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (fields.length === 0) return []
  let source = fields[0] as string
  let first = -1
  for (const field of fields) {
    const hit = [...field.matchAll(WORD)].find((m) => matches(m[0], terms))
    if (hit) {
      source = field
      first = hit.index
      break
    }
  }

  let start = first < 0 ? 0 : Math.max(0, first - Math.floor(length / 3))
  let end = Math.min(source.length, start + length)
  if (end - start < length) start = Math.max(0, end - length)
  // Cut at spaces, so no word is shown in part.
  if (start > 0) {
    const space = source.indexOf(' ', start)
    if (space >= 0 && space < (first < 0 ? end : first)) start = space + 1
  }
  if (end < source.length) {
    const space = source.lastIndexOf(' ', end)
    if (space > start) end = space
  }
  // A cut that lands on the separator between two texts keeps one ellipsis, not two.
  const window = source
    .slice(start, end)
    .replace(/^(?:…\s*)+/, '')
    .replace(/(?:\s*…)+$/, '')

  const segments: ExcerptSegment[] = []
  const push = (value: string, match: boolean) => {
    if (!value) return
    const last = segments[segments.length - 1]
    if (last && last.match === match) last.text += value
    else segments.push({ text: value, match })
  }
  if (start > 0) push('… ', false)
  let at = 0
  for (const word of window.matchAll(WORD)) {
    if (!matches(word[0], terms)) continue
    push(window.slice(at, word.index), false)
    push(word[0], true)
    at = word.index + word[0].length
  }
  push(window.slice(at), false)
  if (end < source.length) push(' …', false)
  return segments
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** An excerpt as HTML: every segment escaped, the matches in `<mark>`. */
export function excerptHtml(segments: readonly ExcerptSegment[]): string {
  return segments
    .map((segment) => {
      const text = segment.text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string)
      return segment.match ? `<mark>${text}</mark>` : text
    })
    .join('')
}
