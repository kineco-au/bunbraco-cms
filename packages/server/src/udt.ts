/**
 * Umbraco's dictionary export format (`.udt`): nested `<DictionaryItem Key Name>`
 * elements, each with a `<Value LanguageCultureAlias>` per translation in CDATA.
 * The reader understands only the XML this format uses: elements, attributes,
 * text, CDATA, comments and the prolog.
 */

export interface UdtItem {
  key: string
  name: string
  translations: Array<{ isoCode: string; translation: string }>
  children: UdtItem[]
}

export interface XmlElement {
  name: string
  attributes: Record<string, string>
  children: XmlElement[]
  text: string
}

/** XML text content: the three characters that cannot appear raw. */
export const escapeText = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const cdata = (value: string) => `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

function writeItem(item: UdtItem, indent: string): string {
  const inner = [
    ...item.translations.map(
      (t) =>
        `${indent}  <Value LanguageCultureAlias="${escapeAttribute(t.isoCode)}">${cdata(t.translation)}</Value>`,
    ),
    ...item.children.map((child) => writeItem(child, `${indent}  `)),
  ]
  const open = `${indent}<DictionaryItem Key="${escapeAttribute(item.key)}" Name="${escapeAttribute(item.name)}"`
  return inner.length === 0
    ? `${open} />`
    : `${open}>\n${inner.join('\n')}\n${indent}</DictionaryItem>`
}

/** One item, and its descendants when they are included, as a `.udt` document. */
export function writeUdt(item: UdtItem): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n${writeItem(item, '')}`
}

/**
 * Several items as one `.udt` document, under the `<DictionaryItems>` wrapper
 * `readUdt` already accepts — which is what a whole-dictionary export needs,
 * since the tree has more than one root.
 */
export function writeUdtAll(items: readonly UdtItem[]): string {
  if (items.length === 1) return writeUdt(items[0] as UdtItem)
  const inner = items.map((item) => writeItem(item, '  ')).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<DictionaryItems>\n${inner}\n</DictionaryItems>`
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const decode = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return ENTITIES[entity.toLowerCase()] ?? whole
  })

/** Parses a document into its root element; undefined when it is not well formed. */
export function parseXml(source: string): XmlElement | undefined {
  const root: XmlElement = { name: '#document', attributes: {}, children: [], text: '' }
  const stack: XmlElement[] = [root]
  let i = 0
  const top = () => stack[stack.length - 1] as XmlElement
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) {
      top().text += decode(source.slice(i))
      break
    }
    top().text += decode(source.slice(i, lt))
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt)
      if (end === -1) return undefined
      top().text += source.slice(lt + 9, end)
      i = end + 3
    } else if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt)
      if (end === -1) return undefined
      i = end + 3
    } else if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt)
      if (end === -1) return undefined
      i = end + 1
    } else if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt)
      if (end === -1) return undefined
      const name = source.slice(lt + 2, end).trim()
      const closing = stack.pop()
      if (!closing || closing.name !== name) return undefined
      i = end + 1
    } else {
      const tag = /^<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(
        source.slice(lt),
      )
      if (!tag) return undefined
      const element: XmlElement = {
        name: tag[1] as string,
        attributes: {},
        children: [],
        text: '',
      }
      for (const a of (tag[2] ?? '').matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
        element.attributes[a[1] as string] = decode(a[2] ?? a[3] ?? '')
      top().children.push(element)
      if (tag[3] !== '/') stack.push(element)
      i = lt + tag[0].length
    }
  }
  if (stack.length !== 1) return undefined
  return root.children[0]
}

function readItem(element: XmlElement): UdtItem | undefined {
  const key = element.attributes.Key
  const name = element.attributes.Name
  if (!key || !name) return undefined
  const children: UdtItem[] = []
  for (const child of element.children.filter((c) => c.name === 'DictionaryItem')) {
    const item = readItem(child)
    if (!item) return undefined
    children.push(item)
  }
  return {
    key,
    name,
    translations: element.children
      .filter((c) => c.name === 'Value' && c.attributes.LanguageCultureAlias)
      .map((c) => ({ isoCode: c.attributes.LanguageCultureAlias as string, translation: c.text })),
    children,
  }
}

/** The items a `.udt` holds: one root item, or several under `<DictionaryItems>`. */
export function readUdt(source: string): UdtItem[] | undefined {
  const root = parseXml(source)
  if (!root) return undefined
  const elements =
    root.name === 'DictionaryItems'
      ? root.children.filter((c) => c.name === 'DictionaryItem')
      : root.name === 'DictionaryItem'
        ? [root]
        : []
  if (elements.length === 0) return undefined
  const items: UdtItem[] = []
  for (const element of elements) {
    const item = readItem(element)
    if (!item) return undefined
    items.push(item)
  }
  return items
}
