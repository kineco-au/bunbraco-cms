/**
 * The declarative builder a bundle writes its tables with. `docs/bundles.md`,
 * Part 4.
 *
 * It is the only way a bundle writes schema: there is no SQL in it, and no
 * escape hatch to some. A step's `up` returns the operations it wants, as plain
 * data, which is what makes a step checkable before it runs — linted for
 * expand and contract, hashed for its checksum, rendered for `upgrade --plan` —
 * and what lets the final shape of every table be worked out from the
 * declaration's types alone.
 */

export type ColumnType =
  | 'uuid'
  | 'varchar'
  | 'text'
  | 'integer'
  | 'bigint'
  | 'boolean'
  | 'timestamp'
  | 'json'

/** A scalar a default may be: what DDL can carry as a literal. */
export type DefaultValue = string | number | boolean

export interface ColumnSpec {
  type: ColumnType
  /** For `varchar`. */
  length?: number
  nullable: boolean
  default?: DefaultValue
  primaryKey: boolean
  indexed: boolean
}

/** What a column holds, as the capability reads and writes it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

interface ValueOf {
  uuid: string
  varchar: string
  text: string
  integer: number
  bigint: number
  boolean: boolean
  timestamp: Date
  json: JsonValue
}

/**
 * A column being described. Its type parameters carry what the declaration
 * says, so a table's row type can be read off it.
 */
export interface Column<
  T extends ColumnType = ColumnType,
  N extends boolean = false,
  D extends boolean = false,
> {
  readonly spec: ColumnSpec
  /** Allows null. */
  nullable(): Column<T, true, D>
  /** What a row gets when an insert leaves it out. */
  default(
    value: T extends 'json' ? never : ValueOf[T] extends Date ? never : ValueOf[T],
  ): Column<T, N, true>
  primaryKey(): Column<T, N, D>
  /** Gives the column an index of its own. */
  indexed(): Column<T, N, D>
  /** Type-level only: what the column holds. */
  readonly __value?: ValueOf[T]
  readonly __nullable?: N
  readonly __defaulted?: D
}

function column<T extends ColumnType>(type: T, spec: Partial<ColumnSpec> = {}): Column<T> {
  const make = (s: ColumnSpec): Column<T, boolean, boolean> =>
    Object.freeze({
      spec: Object.freeze(s),
      nullable: () => make({ ...s, nullable: true }),
      default: (value: DefaultValue) => make({ ...s, default: value }),
      primaryKey: () => make({ ...s, primaryKey: true }),
      indexed: () => make({ ...s, indexed: true }),
    }) as Column<T, boolean, boolean>
  return make({ type, nullable: false, primaryKey: false, indexed: false, ...spec }) as Column<T>
}

export type Columns = Record<string, Column<ColumnType, boolean, boolean>>

export type Operation =
  | { op: 'createTable'; table: string; columns: Record<string, ColumnSpec> }
  | { op: 'addColumn'; table: string; column: string; spec: ColumnSpec }
  | { op: 'addIndex'; table: string; columns: string[]; unique: boolean }
  | { op: 'widenColumn'; table: string; column: string; spec: ColumnSpec }
  | { op: 'dropTable'; table: string }
  | { op: 'dropColumn'; table: string; column: string }
  | { op: 'dropIndex'; table: string; columns: string[] }

/** An operation, carrying at the type level what it does to the schema. */
export type Op<Effect = never> = Operation & { readonly __effect?: Effect }

export interface CreateTable<T extends string, C extends Columns> {
  kind: 'create'
  table: T
  columns: C
}
export interface AddColumn<
  T extends string,
  K extends string,
  C extends Column<ColumnType, boolean, boolean>,
> {
  kind: 'add'
  table: T
  column: K
  spec: C
}
export interface DropTable<T extends string> {
  kind: 'dropTable'
  table: T
}
export interface DropColumn<T extends string, K extends string> {
  kind: 'dropColumn'
  table: T
  column: K
}

/** What a step's `up` is handed. */
export interface SchemaBuilder {
  uuid(): Column<'uuid'>
  varchar(length: number): Column<'varchar'>
  text(): Column<'text'>
  integer(): Column<'integer'>
  bigint(): Column<'bigint'>
  boolean(): Column<'boolean'>
  timestamp(): Column<'timestamp'>
  json(): Column<'json'>

  createTable<T extends string, C extends Columns>(table: T, columns: C): Op<CreateTable<T, C>>
  /** A new column must be nullable or have a default, so it adds under live rows. */
  addColumn<T extends string, K extends string, C extends Column<ColumnType, boolean, boolean>>(
    table: T,
    column: K,
    spec: C,
  ): Op<AddColumn<T, K, C>>
  addIndex(table: string, columns: readonly string[], options?: { unique?: boolean }): Op
  /** Longer text, or a wider integer; never narrower, never another kind. */
  widenColumn(table: string, column: string, spec: Column<ColumnType, boolean, boolean>): Op
  dropTable<T extends string>(table: T): Op<DropTable<T>>
  dropColumn<T extends string, K extends string>(table: T, column: K): Op<DropColumn<T, K>>
  dropIndex(table: string, columns: readonly string[]): Op
}

const specs = (columns: Columns): Record<string, ColumnSpec> => {
  const out: Record<string, ColumnSpec> = {}
  for (const [name, col] of Object.entries(columns)) out[name] = col.spec
  return out
}

/** The builder: every method returns plain data. */
export const schemaBuilder: SchemaBuilder = Object.freeze<SchemaBuilder>({
  uuid: () => column('uuid'),
  varchar: (length: number) => column('varchar', { length }),
  text: () => column('text'),
  integer: () => column('integer'),
  bigint: () => column('bigint'),
  boolean: () => column('boolean'),
  timestamp: () => column('timestamp'),
  json: () => column('json'),
  createTable: (table, columns) => ({ op: 'createTable', table, columns: specs(columns) }) as never,
  addColumn: (table, name, spec) =>
    ({ op: 'addColumn', table, column: name, spec: spec.spec }) as never,
  addIndex: (table, columns, options = {}) => ({
    op: 'addIndex',
    table,
    columns: [...columns],
    unique: options.unique ?? false,
  }),
  widenColumn: (table, name, spec) => ({ op: 'widenColumn', table, column: name, spec: spec.spec }),
  dropTable: (table) => ({ op: 'dropTable', table }) as never,
  dropColumn: (table, name) => ({ op: 'dropColumn', table, column: name }) as never,
  dropIndex: (table, columns) => ({ op: 'dropIndex', table, columns: [...columns] }),
})

// ------------------------------------------------------------ the row types

type ColumnValue<C> =
  C extends Column<infer T, infer N, boolean>
    ? N extends true
      ? ValueOf[T] | null
      : ValueOf[T]
    : never

/** A table's row, from its columns. */
export type RowOf<C extends Columns> = { [K in keyof C]: ColumnValue<C[K]> }

type Optional<C extends Columns> = {
  [K in keyof C]: C[K] extends Column<ColumnType, infer N, infer D>
    ? N extends true
      ? K
      : D extends true
        ? K
        : never
    : never
}[keyof C]

/** What an insert must and may supply: a nullable or defaulted column may be left out. */
export type InsertOf<C extends Columns> = Omit<RowOf<C>, Optional<C>> &
  Partial<Pick<RowOf<C>, Optional<C>>>

/** Every table's columns, after a run of operations. */
export type TablesShape = Record<string, Columns>

type Effects<R> = R extends readonly unknown[] ? R[number] : R
type EffectOf<O> = O extends Op<infer E> ? E : never

type Apply<S extends TablesShape, E> =
  E extends CreateTable<infer T, infer C>
    ? Omit<S, T> & { [K in T]: C }
    : E extends AddColumn<infer T, infer K, infer C>
      ? T extends keyof S
        ? Omit<S, T> & { [P in T]: S[T] & { [Q in K]: C } }
        : S
      : E extends DropTable<infer T>
        ? Omit<S, T>
        : E extends DropColumn<infer T, infer K>
          ? T extends keyof S
            ? Omit<S, T> & { [P in T]: Omit<S[T], K> }
            : S
          : S

type ApplyAll<S extends TablesShape, E> = [E] extends [never]
  ? S
  : // A union of effects within one step is applied one member at a time.
    UnionToTuple<E> extends infer L
    ? L extends readonly [infer H, ...infer Rest]
      ? ApplyAll<Flatten<Apply<S, H>>, Rest[number]>
      : S
    : S

type Flatten<T> = { [K in keyof T]: T[K] } & {}

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never
type LastOf<U> =
  UnionToIntersection<U extends unknown ? () => U : never> extends () => infer R ? R : never
type UnionToTuple<U, L = LastOf<U>> = [U] extends [never] ? [] : [...UnionToTuple<Exclude<U, L>>, L]

/** The shape after every step, in order: what `context.host.tables` is typed from. */
export type ShapeOf<
  Steps extends readonly unknown[],
  S extends TablesShape = Record<never, never>,
> = Steps extends readonly [infer First, ...infer Rest]
  ? First extends { up: (s: SchemaBuilder) => infer R }
    ? ShapeOf<Rest, Flatten<ApplyAll<S, EffectOf<Effects<R>>>>>
    : ShapeOf<Rest, S>
  : S
