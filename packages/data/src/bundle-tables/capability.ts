/**
 * The `tables` capability: a bundle's runtime access to its own tables, and
 * nothing else. `docs/bundles.md`, Part 4.
 *
 * Three things keep it inside the bundle's tables:
 *
 * - **No identifier comes from the caller.** Every table and column name is
 *   looked up in the bundle's resolved schema and quoted from there, and an
 *   unknown one is refused before any SQL is built. Values are always bound.
 * - **No `Db` is reachable.** The capability, each table handle and the
 *   transaction handle are frozen, null-prototype objects whose members are
 *   closures; the connection is never a property of any of them.
 * - **Every statement passes the guard**, which refuses one naming any table
 *   that is not this bundle's.
 */
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'
import type { ColumnSpec, Columns, InsertOf, JsonValue, RowOf, TablesShape } from './builder.ts'
import { guardStatement } from './guard.ts'
import type { ResolvedSchema, ResolvedTable } from './schema.ts'

/** A request the capability refused: nothing reached the database. */
export class BundleQueryError extends Error {
  constructor(
    readonly bundle: string,
    reason: string,
  ) {
    super(`Bundle "${bundle}": ${reason}.`)
  }
}

type Scalar<V> = Exclude<V, null>

/** A condition on one column. A bare value means equality, and `null` means `isNull`. */
export type Condition<V> =
  | V
  | {
      eq?: Scalar<V>
      in?: readonly Scalar<V>[]
      lt?: Scalar<V>
      lte?: Scalar<V>
      gt?: Scalar<V>
      gte?: Scalar<V>
      isNull?: true
      notNull?: true
    }

export type Where<R> = { [K in keyof R]?: Condition<R[K]> } & {
  and?: readonly Where<R>[]
  or?: readonly Where<R>[]
}

export interface SelectQuery<R> {
  where?: Where<R>
  orderBy?: { [K in keyof R]?: 'asc' | 'desc' }
  /** At most 10,000; 1,000 when not given. */
  limit?: number
  offset?: number
}

export interface TableHandle<C extends Columns> {
  select(query?: SelectQuery<RowOf<C>>): Promise<RowOf<C>[]>
  count(query?: { where?: Where<RowOf<C>> }): Promise<number>
  insert(rows: InsertOf<C> | readonly InsertOf<C>[]): Promise<void>
  /** A `where` is required; an unfiltered write is `truncate`. */
  update(query: { where: Where<RowOf<C>>; set: Partial<RowOf<C>> }): Promise<void>
  delete(query: { where: Where<RowOf<C>> }): Promise<void>
  /** Every row, gone. */
  truncate(): Promise<void>
}

export type TableHandles<S extends TablesShape> = { readonly [T in keyof S]: TableHandle<S[T]> }

export type BundleTablesCapability<S extends TablesShape = TablesShape> = TableHandles<S> & {
  /** Runs `fn` in one transaction, handing it the same tables bound to it. */
  transaction<R>(fn: (tables: TableHandles<S>) => Promise<R>): Promise<R>
}

const MAX_LIMIT = 10_000
const DEFAULT_LIMIT = 1_000
const MAX_DEPTH = 8
const MAX_IN = 1_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATORS = new Set(['eq', 'in', 'lt', 'lte', 'gt', 'gte', 'isNull', 'notNull'])
const COMPARISONS: Record<string, string> = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }

/** A plain object, and not a class instance or an array, read by its own keys only. */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function frozen<T extends object>(members: T): T {
  return Object.freeze(Object.assign(Object.create(null), members)) as T
}

interface Compiler {
  bundle: string
  dialectName: Db['dialect']['name']
  boolValue: Db['dialect']['boolValue']
  quote: Db['dialect']['quote']
}

function refuse(bundle: string, reason: string): never {
  throw new BundleQueryError(bundle, reason)
}

/** A value as the column stores it, or a refusal. */
function toDb(
  c: Compiler,
  table: ResolvedTable,
  column: string,
  spec: ColumnSpec,
  value: unknown,
): unknown {
  const where = `"${table.name}.${column}"`
  if (value === null || value === undefined) {
    if (!spec.nullable) refuse(c.bundle, `${where} cannot be null`)
    return null
  }
  switch (spec.type) {
    case 'uuid':
      // Lowercased, so a key compares equal however it was written, on both dialects.
      if (typeof value !== 'string' || !UUID.test(value)) refuse(c.bundle, `${where} takes a uuid`)
      return value.toLowerCase()
    case 'text':
      if (typeof value !== 'string') refuse(c.bundle, `${where} takes a string`)
      return value
    case 'varchar':
      if (typeof value !== 'string') refuse(c.bundle, `${where} takes a string`)
      if (value.length > (spec.length ?? 0))
        refuse(c.bundle, `${where} holds at most ${spec.length} characters`)
      return value
    case 'integer':
    case 'bigint':
      if (typeof value !== 'number' || !Number.isSafeInteger(value))
        refuse(c.bundle, `${where} takes a whole number`)
      if (spec.type === 'integer' && Math.abs(value) > 2_147_483_647)
        refuse(c.bundle, `${where} is an integer, and ${value} needs a bigint`)
      return value
    case 'boolean':
      if (typeof value !== 'boolean') refuse(c.bundle, `${where} takes true or false`)
      return c.boolValue(value)
    case 'timestamp': {
      const date =
        value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined
      if (!date || Number.isNaN(date.getTime())) refuse(c.bundle, `${where} takes a date`)
      return DbDate.toDb(date)
    }
    case 'json':
      try {
        return JSON.stringify(value)
      } catch {
        return refuse(c.bundle, `${where} takes a value JSON can hold`)
      }
  }
}

function fromDb(spec: ColumnSpec, value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (spec.type) {
    case 'uuid':
      return String(value).toLowerCase()
    case 'varchar':
    case 'text':
      return String(value)
    case 'integer':
    case 'bigint':
      return Number(value)
    case 'boolean':
      return fromDbBool(value)
    case 'timestamp':
      return DbDate.fromDb(value) ?? null
    case 'json':
      return JSON.parse(String(value)) as JsonValue
  }
}

/** The column a caller named, from the schema, or a refusal. */
function columnOf(c: Compiler, table: ResolvedTable, name: string): ColumnSpec {
  const column = table.columns.get(name)
  if (!column) refuse(c.bundle, `"${table.name}" has no column ${JSON.stringify(name)}`)
  return column.spec
}

function compileWhere(
  c: Compiler,
  table: ResolvedTable,
  where: unknown,
  params: unknown[],
  depth: number,
): string {
  if (depth > MAX_DEPTH) refuse(c.bundle, `a filter is nested more than ${MAX_DEPTH} deep`)
  if (!isPlain(where)) refuse(c.bundle, 'a filter must be a plain object')
  const parts: string[] = []
  for (const key of Object.keys(where)) {
    const value = where[key]
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(value) || value.length === 0)
        refuse(c.bundle, `"${key}" takes a non-empty list of filters`)
      const inner = value.map((item) => compileWhere(c, table, item, params, depth + 1))
      parts.push(`(${inner.join(key === 'and' ? ' AND ' : ' OR ')})`)
      continue
    }
    const spec = columnOf(c, table, key)
    const col = c.quote(key)
    if (value === null) {
      parts.push(`${col} IS NULL`)
      continue
    }
    if (isPlain(value)) {
      const ops = Object.keys(value)
      if (ops.length === 0) refuse(c.bundle, `the condition on "${key}" is empty`)
      for (const op of ops) {
        if (!OPERATORS.has(op)) refuse(c.bundle, `${JSON.stringify(op)} is not a condition`)
        const operand = value[op]
        if (op === 'isNull' || op === 'notNull') {
          if (operand !== true) refuse(c.bundle, `"${op}" takes true`)
          parts.push(`${col} ${op === 'isNull' ? 'IS NULL' : 'IS NOT NULL'}`)
          continue
        }
        if (spec.type === 'json')
          refuse(c.bundle, `"${key}" is json, which can only be tested for null`)
        if (op === 'in') {
          if (!Array.isArray(operand) || operand.length === 0 || operand.length > MAX_IN)
            refuse(c.bundle, `"in" takes a list of 1 to ${MAX_IN} values`)
          for (const item of operand)
            params.push(toDb(c, table, key, { ...spec, nullable: false }, item))
          parts.push(`${col} IN (${operand.map(() => '?').join(', ')})`)
          continue
        }
        params.push(toDb(c, table, key, { ...spec, nullable: false }, operand))
        parts.push(`${col} ${COMPARISONS[op]} ?`)
      }
      continue
    }
    if (spec.type === 'json')
      refuse(c.bundle, `"${key}" is json, which can only be tested for null`)
    params.push(toDb(c, table, key, { ...spec, nullable: false }, value))
    parts.push(`${col} = ?`)
  }
  if (parts.length === 0) refuse(c.bundle, 'a filter names no condition')
  return parts.join(' AND ')
}

function readRow(table: ResolvedTable, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, column] of table.columns) out[name] = fromDb(column.spec, row[name])
  return out
}

function tableHandle(db: Db, schema: ResolvedSchema, table: ResolvedTable): TableHandle<Columns> {
  const c: Compiler = {
    bundle: schema.id,
    dialectName: db.dialect.name,
    boolValue: (value) => db.dialect.boolValue(value),
    quote: (identifier) => db.dialect.quote(identifier),
  }
  const name = c.quote(table.physical)
  const guard = (sql: string) => guardStatement(schema.id, schema.prefix, sql)
  const columnList = [...table.columns.keys()].map(c.quote).join(', ')

  const whereClause = (where: unknown, params: unknown[], required: boolean): string => {
    if (where === undefined) {
      if (required)
        refuse(c.bundle, 'an update or a delete needs a "where"; use truncate to empty a table')
      return ''
    }
    return ` WHERE ${compileWhere(c, table, where, params, 0)}`
  }

  return frozen({
    async select(query: SelectQuery<Record<string, unknown>> = {}) {
      if (!isPlain(query)) refuse(c.bundle, 'a query must be a plain object')
      const params: unknown[] = []
      let sql = `SELECT ${columnList} FROM ${name}${whereClause(query.where, params, false)}`
      if (query.orderBy !== undefined) {
        if (!isPlain(query.orderBy)) refuse(c.bundle, '"orderBy" must be a plain object')
        const order = Object.keys(query.orderBy).map((key) => {
          columnOf(c, table, key)
          const direction = (query.orderBy as Record<string, unknown>)[key]
          if (direction !== 'asc' && direction !== 'desc')
            refuse(c.bundle, `the order of "${key}" is "asc" or "desc"`)
          return `${c.quote(key)} ${direction === 'asc' ? 'ASC' : 'DESC'}`
        })
        if (order.length > 0) sql += ` ORDER BY ${order.join(', ')}`
      }
      const limit: unknown = query.limit ?? DEFAULT_LIMIT
      const offset: unknown = query.offset ?? 0
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT)
        refuse(c.bundle, `"limit" is a whole number from 0 to ${MAX_LIMIT}`)
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0)
        refuse(c.bundle, '"offset" is a whole number from 0')
      sql += ' LIMIT ? OFFSET ?'
      params.push(limit, offset)
      const rows = await db.query<Record<string, unknown>>(guard(sql), params)
      return rows.map((row) => readRow(table, row))
    },

    async count(query: { where?: unknown } = {}) {
      if (!isPlain(query)) refuse(c.bundle, 'a query must be a plain object')
      const params: unknown[] = []
      const sql = `SELECT COUNT(*) AS ${c.quote('n')} FROM ${name}${whereClause(query.where, params, false)}`
      const rows = await db.query<{ n: unknown }>(guard(sql), params)
      return Number(rows[0]?.n ?? 0)
    },

    async insert(input: unknown) {
      const rows = Array.isArray(input) ? input : [input]
      if (rows.length === 0) return
      for (const row of rows) {
        if (!isPlain(row)) refuse(c.bundle, 'a row must be a plain object')
        for (const key of Object.keys(row)) columnOf(c, table, key)
        const names: string[] = []
        const params: unknown[] = []
        for (const [column, resolved] of table.columns) {
          const given = Object.hasOwn(row, column)
          if (!given) {
            if (resolved.spec.default !== undefined || resolved.spec.nullable) continue
            refuse(c.bundle, `a row of "${table.name}" needs "${column}"`)
          }
          names.push(c.quote(column))
          params.push(toDb(c, table, column, resolved.spec, row[column]))
        }
        await db.exec(
          guard(
            `INSERT INTO ${name} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
          ),
          params,
        )
      }
    },

    async update(query: { where?: unknown; set?: unknown }) {
      if (!isPlain(query)) refuse(c.bundle, 'an update must be a plain object')
      if (!isPlain(query.set) || Object.keys(query.set).length === 0)
        refuse(c.bundle, 'an update needs a "set" naming at least one column')
      const set = query.set
      const params: unknown[] = []
      const assignments = Object.keys(set).map((column) => {
        params.push(toDb(c, table, column, columnOf(c, table, column), set[column]))
        return `${c.quote(column)} = ?`
      })
      const where = whereClause(query.where, params, true)
      await db.exec(guard(`UPDATE ${name} SET ${assignments.join(', ')}${where}`), params)
    },

    async delete(query: { where?: unknown }) {
      if (!isPlain(query)) refuse(c.bundle, 'a delete must be a plain object')
      const params: unknown[] = []
      await db.exec(guard(`DELETE FROM ${name}${whereClause(query.where, params, true)}`), params)
    },

    async truncate() {
      await db.exec(guard(`DELETE FROM ${name}`))
    },
  }) as TableHandle<Columns>
}

function handlesOver(db: Db, schema: ResolvedSchema): TableHandles<TablesShape> {
  const handles: Record<string, TableHandle<Columns>> = {}
  for (const [name, table] of schema.tables) handles[name] = tableHandle(db, schema, table)
  return frozen(handles) as TableHandles<TablesShape>
}

/** The capability over a bundle's resolved schema, bound to a connection it never exposes. */
export function createTablesCapability<S extends TablesShape = TablesShape>(
  db: Db,
  schema: ResolvedSchema,
): BundleTablesCapability<S> {
  return frozen({
    ...handlesOver(db, schema),
    transaction: <R>(fn: (tables: TableHandles<TablesShape>) => Promise<R>) =>
      db.transaction((tx) => fn(handlesOver(tx, schema))),
  }) as unknown as BundleTablesCapability<S>
}
