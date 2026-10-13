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

/** SVG presentation attributes React spells in camelCase; each is written hyphenated. */
const HYPHENATED_SVG = [
  'alignmentBaseline',
  'arabicForm',
  'baselineShift',
  'capHeight',
  'clipPath',
  'clipRule',
  'colorInterpolation',
  'colorInterpolationFilters',
  'colorProfile',
  'colorRendering',
  'dominantBaseline',
  'enableBackground',
  'fillOpacity',
  'fillRule',
  'floodColor',
  'floodOpacity',
  'fontFamily',
  'fontSize',
  'fontSizeAdjust',
  'fontStretch',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'glyphName',
  'glyphOrientationHorizontal',
  'glyphOrientationVertical',
  'horizAdvX',
  'horizOriginX',
  'imageRendering',
  'letterSpacing',
  'lightingColor',
  'markerEnd',
  'markerMid',
  'markerStart',
  'overlinePosition',
  'overlineThickness',
  'paintOrder',
  'pointerEvents',
  'renderingIntent',
  'shapeRendering',
  'stopColor',
  'stopOpacity',
  'strikethroughPosition',
  'strikethroughThickness',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
  'textAnchor',
  'textDecoration',
  'textRendering',
  'transformOrigin',
  'underlinePosition',
  'underlineThickness',
  'unicodeBidi',
  'unicodeRange',
  'unitsPerEm',
  'vAlphabetic',
  'vHanging',
  'vIdeographic',
  'vMathematical',
  'vectorEffect',
  'vertAdvY',
  'vertOriginX',
  'vertOriginY',
  'wordSpacing',
  'writingMode',
  'xHeight',
]

const hyphenate = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/**
 * Props whose attribute is spelled differently, as React's server renderer
 * writes them. A camelCase HTML attribute such as `tabIndex` is left alone:
 * HTML attribute names are case-insensitive, so it already works.
 */
const ATTRIBUTE_NAMES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  httpEquiv: 'http-equiv',
  acceptCharset: 'accept-charset',
  panose1: 'panose-1',
  xlinkActuate: 'xlink:actuate',
  xlinkArcrole: 'xlink:arcrole',
  xlinkHref: 'xlink:href',
  xlinkRole: 'xlink:role',
  xlinkShow: 'xlink:show',
  xlinkTitle: 'xlink:title',
  xlinkType: 'xlink:type',
  xmlBase: 'xml:base',
  xmlLang: 'xml:lang',
  xmlSpace: 'xml:space',
  xmlnsXlink: 'xmlns:xlink',
  ...Object.fromEntries(HYPHENATED_SVG.map((name) => [name, hyphenate(name)])),
}

/** Props that are never attributes. */
const NOT_ATTRIBUTES = new Set([
  'children',
  'key',
  'ref',
  'setInnerHTML',
  'dangerouslySetInnerHTML',
])

/** Attributes whose value is the string "true" or "false" rather than presence. */
const BOOLEANISH = new Set([
  'contenteditable',
  'draggable',
  'spellcheck',
  'autoreverse',
  'externalresourcesrequired',
  'focusable',
  'preservealpha',
])

const isBooleanish = (attribute: string) =>
  attribute.startsWith('aria-') ||
  attribute.startsWith('data-') ||
  BOOLEANISH.has(attribute.toLowerCase())

/** The characters an attribute name may hold, as React checks them. */
const NAME_START =
  ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD'
const VALID_ATTRIBUTE_NAME = new RegExp(
  `^[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`,
)

/** CSS properties whose number stays a number rather than gaining `px`. */
const UNITLESS = new Set([
  'animationIterationCount',
  'aspectRatio',
  'borderImageOutset',
  'borderImageSlice',
  'borderImageWidth',
  'boxFlex',
  'boxFlexGroup',
  'boxOrdinalGroup',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexPositive',
  'flexShrink',
  'flexNegative',
  'flexOrder',
  'gridArea',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'fontWeight',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'scale',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
])

const unitless = (property: string) =>
  UNITLESS.has(property) ||
  UNITLESS.has(
    property.replace(/^(Webkit|Moz|ms|O)([A-Z])/, (_, _prefix, first: string) =>
      first.toLowerCase(),
    ),
  )

/** A React style object as CSS: `{ marginTop: 4 }` is `margin-top:4px`. */
export function styleToCss(style: Record<string, unknown>): string {
  const declarations: string[] = []
  for (const [property, value] of Object.entries(style)) {
    if (value === null || value === undefined || typeof value === 'boolean' || value === '')
      continue
    const custom = property.startsWith('--')
    const name = custom ? property : hyphenate(property).replace(/^ms-/, '-ms-')
    const text =
      typeof value === 'number' && value !== 0 && !custom && !unitless(property)
        ? `${value}px`
        : String(value).trim()
    declarations.push(`${name}:${text}`)
  }
  return declarations.join(';')
}

/** Whether a value would print as `[object …]`: something with no text of its own. */
const opaqueObject = (value: object) =>
  !Array.isArray(value) && String(value).startsWith('[object ')

export function serializeAttributes(props: Record<string, unknown>, tag = 'element'): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(props)) {
    if (NOT_ATTRIBUTES.has(name) || value === null || value === undefined) continue
    if (!VALID_ATTRIBUTE_NAME.test(name))
      throw new Error(
        `<${tag}> was given ${JSON.stringify(name)} as an attribute, which is not a valid attribute name.`,
      )
    if (typeof value === 'function')
      throw new Error(
        `The "${name}" attribute of <${tag}> is a function. Pages are rendered to static HTML, so ` +
          'it can never run. Render an element to mount on, and load your client code from /scripts/.',
      )
    const attribute = ATTRIBUTE_NAMES[name] ?? name
    if (typeof value === 'boolean') {
      if (isBooleanish(attribute)) parts.push(`${attribute}="${value}"`)
      else if (value) parts.push(attribute)
      continue
    }
    if (name === 'style' && typeof value === 'object') {
      const css = styleToCss(value as Record<string, unknown>)
      if (css) parts.push(`style="${escapeHtml(css)}"`)
      continue
    }
    if (typeof value === 'symbol' || (typeof value === 'object' && opaqueObject(value)))
      throw new Error(
        `The "${name}" attribute of <${tag}> is ${typeof value === 'symbol' ? 'a symbol' : 'an object'}, which has no text to write. Convert it to a string first.`,
      )
    parts.push(`${attribute}="${escapeHtml(String(value))}"`)
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}
