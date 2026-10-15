/**
 * `expand` and `fields` (v2): which pickers are expanded, and which properties
 * are kept, as Umbraco's `ElementOnlyOutputExpansionStrategy` reads them.
 * `properties[a,b[properties[c]]]` is a tree; `$all` matches every alias.
 */

export interface ExpansionNode {
  key: string
  children: ExpansionNode[]
}

export class ExpansionSyntaxError extends Error {}

/** `properties[a,b[properties[c]]]` as a tree under an unnamed root. Pure. */
export function parseExpansion(value: string): ExpansionNode {
  const root: ExpansionNode = { key: '', children: [] }
  const text = value.trim()
  if (!text) return root
  const opens = [...text].filter((c) => c === '[').length
  const closes = [...text].filter((c) => c === ']').length
  if (opens !== closes)
    throw new ExpansionSyntaxError(
      'Value did not contain an equal number of start and end brackets',
    )
  if (text.startsWith('[')) throw new ExpansionSyntaxError('Value cannot start with a bracket')
  if (text.includes('[]')) throw new ExpansionSyntaxError('Value cannot contain empty brackets')

  const stack: ExpansionNode[] = [root]
  let current: ExpansionNode | undefined
  let name = ''
  const flush = () => {
    if (name.trim() && !current) {
      current = { key: name.trim(), children: [] }
      ;(stack[stack.length - 1] as ExpansionNode).children.push(current)
    } else if (name.trim() && current) current.key += name.trim()
    name = ''
  }
  for (const c of text) {
    if (c === '[') {
      flush()
      if (!current) throw new ExpansionSyntaxError('Value cannot contain empty brackets')
      stack.push(current)
      current = undefined
    } else if (c === ']') {
      flush()
      current = stack.pop()
    } else if (c === ',') {
      flush()
      current = undefined
    } else name += c
  }
  flush()
  return root
}

const child = (node: ExpansionNode | undefined, key: string) =>
  node?.children.find((c) => c.key === key)

/**
 * The node governing a property at this level: `$all` here, else
 * `properties[$all]` or `properties[<alias>]`. Pure.
 */
export function nextNode(
  node: ExpansionNode | undefined,
  alias: string,
): ExpansionNode | undefined {
  if (!node) return undefined
  const all = child(node, '$all')
  if (all) return all
  const properties = child(node, 'properties')
  return child(properties, '$all') ?? child(properties, alias)
}

/** Whether `fields` keeps a property: a node with no children keeps everything beneath it. Pure. */
export function keeps(include: ExpansionNode | undefined, alias: string): boolean {
  if (!include || include.children.length === 0) return true
  return nextNode(include, alias) !== undefined
}

/** The default for an absent `fields`: everything. */
export const ALL_FIELDS: ExpansionNode = { key: '', children: [{ key: '$all', children: [] }] }
