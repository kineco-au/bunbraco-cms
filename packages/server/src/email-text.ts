/**
 * The plain-text part of an e-mail, derived from its HTML. `docs/forms.md`.
 *
 * A reader whose client shows text, and every spam filter that weighs an HTML
 * part with no text beside it, read this. It is a reading of the markup, not a
 * rendering: block elements become lines, list items "- ", links "text (url)".
 */
import { decodeEntities } from '@crombolo/data'

const PARAGRAPH =
  /<\/?(p|h[1-6]|table|ul|ol|blockquote|pre|hr|section|article|header|footer)\b[^>]*>/gi
const LINE = /<\/?(div|tr|br|address|dl|dt|dd|figure|figcaption|thead|tbody|tfoot)\b[^>]*\/?>/gi

// Stand-ins for the breaks the markup asks for, kept apart from the source's
// own whitespace, which HTML collapses to a space.
const BLANK = '\u0001'
const BREAK = '\u0002'
const CELL = '\u0003'
/** A run of breaks with the spaces around them: a blank line if any asked for one. */
const BREAKS = new RegExp(`[ \u00a0]*[${BLANK}${BREAK}][${BLANK}${BREAK} \u00a0]*`, 'g')

const attribute = (tag: string, name: string): string | undefined => {
  const found = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return found ? (found[2] ?? found[3] ?? found[4]) : undefined
}

/** The text a reader of `html` would see, as lines. */
export function htmlToText(html: string): string {
  const marked = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_whole, attrs: string, inner: string) => {
      const href = (attribute(attrs, 'href') ?? '').trim()
      if (!href || href.startsWith('#')) return inner
      const address = href.replace(/^mailto:/i, '')
      const label = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim()
      return label && label !== decodeEntities(address) ? `${inner} (${address})` : address
    })
    .replace(/<li\b[^>]*>/gi, `${BREAK}- `)
    .replace(/<\/li>/gi, BREAK)
    .replace(PARAGRAPH, BLANK)
    .replace(LINE, BREAK)
    // A cell is a column: the row stays one line, its cells spaced apart.
    .replace(/<\/t[dh]>/gi, CELL)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')

  return decodeEntities(marked)
    .replace(BREAKS, (run) => (run.includes(BLANK) ? '\n\n' : '\n'))
    .split('\n')
    .map((line) =>
      line
        .split(CELL)
        .map((cell) => cell.replace(/[ \u00a0]+/g, ' ').trim())
        .filter(Boolean)
        .join('  '),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
