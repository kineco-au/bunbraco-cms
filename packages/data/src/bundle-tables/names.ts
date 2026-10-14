/**
 * The names a bundle's tables are stored under. `docs/bundles.md`, Part 4.
 *
 * Every physical name is `bundle_<id>__<name>`, with the id's hyphens written
 * as underscores. An id may not contain `--` and a logical name may not contain
 * `__`, so the double underscore is an unambiguous separator and no two bundles
 * can produce the same physical name. Core reserves the `bundle_` prefix, so a
 * match on a bundle's own prefix can only ever be that bundle's table.
 */

/** Postgres truncates a longer identifier silently, so a longer one is refused. */
export const MAX_IDENTIFIER = 63

/** Table and column names, as a bundle writes them. */
export const LOGICAL_NAME = /^[a-z][a-z0-9_]*$/

/** The prefix every one of this bundle's objects carries. */
export function bundlePrefix(id: string): string {
  return `bundle_${id.replaceAll('-', '_')}__`
}

export const physicalTable = (id: string, table: string): string => `${bundlePrefix(id)}${table}`

/**
 * An index's name, generated rather than chosen, from what it covers. The
 * `ix_` that follows the prefix is a namespace a table may not enter, because
 * Postgres keeps tables and indexes in one.
 */
export function indexName(id: string, table: string, columns: readonly string[]): string {
  const hash = new Bun.CryptoHasher('sha256').update(`${table}(${columns.join(',')})`).digest('hex')
  return `${bundlePrefix(id)}ix_${hash.slice(0, 12)}`
}

/** Why an id cannot own tables, or undefined when it can. */
export function bundleIdProblem(id: string): string | undefined {
  if (id.includes('--'))
    return `the id "${id}" contains "--", which would make its table names ambiguous`
  if (id.endsWith('-'))
    return `the id "${id}" ends with "-", which would make its table names ambiguous`
  return undefined
}

/** Why a table or column name is not allowed, or undefined when it is. */
export function logicalNameProblem(kind: 'table' | 'column', name: string): string | undefined {
  if (typeof name !== 'string' || !LOGICAL_NAME.test(name))
    return `the ${kind} name "${String(name)}" is not lowercase letters, digits and underscores starting with a letter`
  if (name.includes('__')) return `the ${kind} name "${name}" contains "__", the separator`
  if (kind === 'table' && name.startsWith('ix_'))
    return `the table name "${name}" starts with "ix_", which index names use`
  return undefined
}

/** Why a physical name is too long for Postgres, or undefined when it fits. */
export function lengthProblem(physical: string): string | undefined {
  return physical.length > MAX_IDENTIFIER
    ? `"${physical}" is ${physical.length} characters, past the ${MAX_IDENTIFIER} Postgres keeps`
    : undefined
}
