/**
 * The one check every statement a bundle's builder or capability emits passes.
 * `docs/bundles.md`, Part 4.
 *
 * It only ever sees SQL this module wrote, which is regular enough to check
 * token by token: every identifier is double-quoted and lowercase, every value
 * is a `?` placeholder or a literal the builder rendered, and there is exactly
 * one statement. What it asserts is that every table or index the statement
 * names carries the bundle's own prefix. A statement that fails is refused
 * before it reaches the database, so a bug in the code above it is a refusal
 * rather than a query against a core table.
 */

/** A refusal: the statement never ran. */
export class BundleStatementError extends Error {
  constructor(
    readonly bundle: string,
    readonly reason: string,
  ) {
    super(`Bundle "${bundle}": a statement was refused before it ran: ${reason}.`)
  }
}

/** Keywords after which the next identifier names a table or an index. */
const OBJECT_POSITIONS = new Set([
  'FROM',
  'INTO',
  'UPDATE',
  'TABLE',
  'JOIN',
  'INDEX',
  'ON',
  'REFERENCES',
])

/** Keywords that may sit between a position keyword and the object it names. */
const FILLERS = new Set(['IF', 'NOT', 'EXISTS', 'ONLY'])

type Token =
  | { kind: 'word'; value: string }
  | { kind: 'identifier'; value: string }
  | { kind: 'other'; value: string }

const QUOTED = /^"([a-z][a-z0-9_]*)"/
const WORD = /^[A-Za-z_][A-Za-z0-9_]*/
const STRING = /^'(?:[^']|'')*'/
const NUMBER = /^-?\d+(?:\.\d+)?/
const PUNCTUATION = /^(?:<=|>=|<>|[(),=<>*?.])/

function tokenize(bundle: string, sql: string): Token[] {
  const tokens: Token[] = []
  let rest = sql
  for (;;) {
    rest = rest.replace(/^\s+/, '')
    if (rest === '') return tokens
    if (rest.startsWith('--') || rest.startsWith('/*'))
      throw new BundleStatementError(bundle, 'it contains a comment')
    if (rest.startsWith(';')) throw new BundleStatementError(bundle, 'it contains a ";"')
    if (rest.startsWith('"')) {
      const match = QUOTED.exec(rest)
      if (!match)
        throw new BundleStatementError(bundle, 'it quotes an identifier no bundle may write')
      tokens.push({ kind: 'identifier', value: match[1] as string })
      rest = rest.slice(match[0].length)
      continue
    }
    const string = STRING.exec(rest)
    if (string) {
      tokens.push({ kind: 'other', value: string[0] })
      rest = rest.slice(string[0].length)
      continue
    }
    const word = WORD.exec(rest)
    if (word) {
      tokens.push({ kind: 'word', value: word[0].toUpperCase() })
      rest = rest.slice(word[0].length)
      continue
    }
    const other = NUMBER.exec(rest) ?? PUNCTUATION.exec(rest)
    if (!other) throw new BundleStatementError(bundle, `it contains "${rest[0]}"`)
    tokens.push({ kind: 'other', value: other[0] })
    rest = rest.slice(other[0].length)
  }
}

/** The tables and indexes a statement names, as the guard sees them. */
export function objectsNamed(bundle: string, sql: string): string[] {
  const tokens = tokenize(bundle, sql)
  const named: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.kind !== 'word' || !OBJECT_POSITIONS.has(token.value)) continue
    // `ON CONFLICT` and `ON DELETE` are not objects; only an index's `ON <table>` is.
    let j = i + 1
    while (tokens[j]?.kind === 'word' && FILLERS.has((tokens[j] as Token).value)) j++
    const next = tokens[j]
    if (token.value === 'ON' && next?.kind !== 'identifier') continue
    if (next?.kind !== 'identifier')
      throw new BundleStatementError(bundle, `"${token.value}" is not followed by a quoted name`)
    named.push(next.value)
  }
  return named
}

/**
 * Refuses a statement unless every table and index it names carries `prefix`,
 * and it names at least one.
 */
export function guardStatement(bundle: string, prefix: string, sql: string): string {
  const named = objectsNamed(bundle, sql)
  if (named.length === 0) throw new BundleStatementError(bundle, 'it names no table')
  for (const name of named)
    if (!name.startsWith(prefix))
      throw new BundleStatementError(bundle, `it names "${name}", which is not this bundle's`)
  return sql
}
