/**
 * The TSX a view gets in place of the Razor Umbraco's template editor inserts.
 *
 * Umbraco's snippet builders (`templating/utils`) are module-private, so they
 * cannot be replaced; what they produce is translated instead, on its way into a
 * view's editor. Each builder has one fixed output shape, matched exactly here,
 * and anything that does not match is returned as it came.
 */

const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const FALLBACKS = {
  'Fallback.To(Fallback.Ancestors, Fallback.DefaultValue)': 'ancestors',
  'Fallback.ToAncestors': 'ancestors',
  'Fallback.ToDefaultValue': 'defaultValue',
}

const FIELD =
  /^@Model\.Value\("([^"]*)"(?:, fallback: (Fallback\.To\(Fallback\.Ancestors, Fallback\.DefaultValue\)|Fallback\.ToAncestors|Fallback\.ToDefaultValue))?(?:, defaultValue: \(object\)"([\s\S]*)")?\)$/

const DICTIONARY = /^@Umbraco\.GetDictionaryValue\("([\s\S]*)"\)$/

const QUERY =
  /^\n@\{\n\tvar selection = ([\s\S]*);\n\}\n<ul>\n\t@foreach \(var item in selection\)[\s\S]*<\/ul>\n\n$/

/** `@Model.Value(…)` as `{model.text(…)}`, with its fallback and default. */
function field(match) {
  const [, alias, fallback, defaultValue] = match
  const options = []
  if (fallback) options.push(`fallback: '${FALLBACKS[fallback]}'`)
  if (defaultValue !== undefined) options.push(`default: ${quote(defaultValue)}`)
  const args = options.length ? `${quote(alias)}, { ${options.join(', ')} }` : quote(alias)
  return `{model.text(${args})}`
}

/** The query builder's selection, listed as links the way Umbraco's snippet lists them. */
function query(match) {
  const chain = match[1].replace(/^const selection = /, '').split('\n')
  return [
    '<ul>',
    `  {${chain[0]}`,
    ...chain.slice(1).map((line) => `  ${line}`),
    '    .map((item) => (',
    '      <li>',
    '        <a href={item.url}>{item.name}</a>',
    '      </li>',
    '    ))}',
    '</ul>',
    '',
  ].join('\n')
}

/** `snippet` as TSX when it is one of Umbraco's Razor snippets; otherwise unchanged. */
export function toTsxSnippet(snippet) {
  if (typeof snippet !== 'string') return snippet
  const fieldMatch = FIELD.exec(snippet)
  if (fieldMatch) return field(fieldMatch)
  const dictionaryMatch = DICTIONARY.exec(snippet)
  if (dictionaryMatch) return `{dictionary(${quote(dictionaryMatch[1])})}`
  const queryMatch = QUERY.exec(snippet)
  if (queryMatch) return query(queryMatch)
  return snippet
}
