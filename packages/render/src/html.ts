/** HTML serialisation primitives for the TSX renderer. */

/** Markup that must not be escaped, for a rich-text property value. */
export class RawHtml {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
}

export const raw = (value: string): RawHtml => new RawHtml(value)

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] as string)
}

/** Elements that must not be given a closing tag. */
export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Attribute names React-style props map to. */
const ATTRIBUTE_NAMES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
}

export function serializeAttributes(props: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || name === 'key' || name === 'setInnerHTML') continue
    if (value === null || value === undefined || value === false) continue
    const attribute = ATTRIBUTE_NAMES[name] ?? name
    if (value === true) {
      parts.push(attribute)
      continue
    }
    parts.push(`${attribute}="${escapeHtml(String(value))}"`)
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}
