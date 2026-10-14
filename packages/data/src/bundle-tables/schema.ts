/**
 * A bundle's declaration, compiled: its steps in order, each with the schema it
 * starts from and the one it leaves, its kind, and its checksum. And the rules
 * a declaration is held to, which core's own plan is held to as well — a
 * contract only in a major, and only removing what an earlier release added.
 * `docs/bundles.md`, Part 4.
 */
import { isMajorRelease } from '../migrations.ts'
import {
  type ColumnSpec,
  type Op,
  type Operation,
  type SchemaBuilder,
  type ShapeOf,
  schemaBuilder,
  type TablesShape,
} from './builder.ts'
import {
  bundleIdProblem,
  bundlePrefix,
  indexName,
  lengthProblem,
  logicalNameProblem,
  physicalTable,
} from './names.ts'

/** One step of a bundle's chain, as the bundle writes it. */
export interface BundleStep {
  /** Unique within the bundle; what the ledger records and a refusal names. */
  name: string
  /** The bundle's own release that ships this step. */
  release: string
  up(s: SchemaBuilder): Op<unknown> | readonly Op<unknown>[]
  /**
   * Writes data once `up` has run, in the same transaction, over the tables as
   * they now are. Untyped, because a step's shape is only known once the steps
   * before it are; every name is still checked against that shape when it runs.
   */
  backfill?(data: BackfillTables): Promise<void>
}

// biome-ignore lint/suspicious/noExplicitAny: the shape at a step is not known to the step's own type
export type BackfillTables = any

/** A bundle's declared tables: what `ServerBundle.tables` holds. */
export interface BundleTables<S extends TablesShape = TablesShape> {
  readonly id: string
  readonly steps: readonly BundleStep[]
  /** Type-level only: the shape after every step. */
  readonly __shape?: S
}

/**
 * Declares a bundle's tables. Nothing is checked or run here: the declaration
 * is checked when the bundle is wired, so every problem is reported at once.
 */
export function defineBundleTables<const Steps extends readonly BundleStep[]>(
  id: string,
  steps: Steps,
): BundleTables<ShapeOf<Steps>> {
  return Object.freeze({ id, steps: Object.freeze([...steps]) })
}

export interface ResolvedColumn {
  name: string
  spec: ColumnSpec
  /** The release of the step that added it, for the contract rule. */
  addedIn: { step: string; release: string }
}

export interface ResolvedIndex {
  name: string
  columns: string[]
  unique: boolean
  addedIn: { step: string; release: string }
}

export interface ResolvedTable {
  name: string
  physical: string
  columns: Map<string, ResolvedColumn>
  /** By the columns they cover, joined with commas. */
  indexes: Map<string, ResolvedIndex>
  addedIn: { step: string; release: string }
}

/** The bundle's tables at one point in its chain. */
export interface ResolvedSchema {
  id: string
  prefix: string
  tables: Map<string, ResolvedTable>
}

export type StepKind = 'expand' | 'contract'

export interface CompiledStep {
  name: string
  release: string
  position: number
  from: string
  to: string
  kind: StepKind
  operations: Operation[]
  /** A hash of the operations, so a step edited after it shipped is caught. */
  checksum: string
  /** For a contract: the step that added the first thing it removes. */
  contracts: string | undefined
  before: ResolvedSchema
  after: ResolvedSchema
  backfill: BundleStep['backfill']
}

export interface CompiledTables {
  id: string
  stateKey: string
  initialState: string
  steps: CompiledStep[]
  /** The shape after every step: what the capability is resolved against. */
  schema: ResolvedSchema
  problems: string[]
}

export const bundleStateKey = (id: string): string => `Crombolo.Bundle.${id}.State`
export const bundleInitialState = (id: string): string => `bundle:${id}:0`
const stateAt = (id: string, position: number, name: string): string =>
  `bundle:${id}:${position}:${name}`

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const STEP_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/
/** What a string default may hold: it is written into DDL as a literal. */
const SAFE_DEFAULT = /^[A-Za-z0-9 _.:@/-]{0,200}$/
const MAX_VARCHAR = 10_485_760
/** Names that would collide with the capability's own members or filter keys. */
const RESERVED_TABLES = new Set(['transaction'])
const RESERVED_COLUMNS = new Set(['and', 'or'])

export function compareRelease(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map(Number)
  const pb = b.split(/[.+-]/).map(Number)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

/** JSON with keys sorted, so the same operations always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function clone(schema: ResolvedSchema): ResolvedSchema {
  const tables = new Map<string, ResolvedTable>()
  for (const [name, table] of schema.tables)
    tables.set(name, {
      ...table,
      columns: new Map(table.columns),
      indexes: new Map(table.indexes),
    })
  return { ...schema, tables }
}

function specProblem(spec: ColumnSpec, where: string): string | undefined {
  if (spec.type === 'varchar') {
    const length = spec.length ?? 0
    if (!Number.isInteger(length) || length < 1 || length > MAX_VARCHAR)
      return `${where} is a varchar of length ${spec.length}, which must be a whole number from 1`
  }
  if (spec.primaryKey && spec.nullable) return `${where} is a primary key, so it cannot be nullable`
  if (spec.default === undefined) return undefined
  if (spec.type === 'json' || spec.type === 'timestamp')
    return `${where} is ${spec.type}, which cannot have a default`
  const expected =
    spec.type === 'boolean'
      ? 'boolean'
      : spec.type === 'integer' || spec.type === 'bigint'
        ? 'number'
        : 'string'
  if (typeof spec.default !== expected)
    return `${where} has the default ${JSON.stringify(spec.default)}, which is not a ${expected}`
  if (typeof spec.default === 'number' && !Number.isSafeInteger(spec.default))
    return `${where} has the default ${spec.default}, which is not a whole number`
  if (typeof spec.default === 'string' && !SAFE_DEFAULT.test(spec.default))
    return `${where} has a default with characters a default may not hold: letters, digits, spaces and _ . : @ / - only`
  return undefined
}

const WIDER: Record<string, readonly string[]> = {
  varchar: ['varchar', 'text'],
  integer: ['bigint'],
}

/** Applies one operation, or says why it cannot be applied. */
function apply(
  schema: ResolvedSchema,
  op: Operation,
  step: { name: string; release: string },
): string | undefined {
  const at = { step: step.name, release: step.release }
  const table = schema.tables.get(op.table)
  const label = `step "${step.name}"`
  switch (op.op) {
    case 'createTable': {
      const nameProblem = logicalNameProblem('table', op.table)
      if (nameProblem) return `${label}: ${nameProblem}`
      if (RESERVED_TABLES.has(op.table)) return `${label}: the table name "${op.table}" is reserved`
      if (table) return `${label} creates "${op.table}", which already exists`
      const physical = physicalTable(schema.id, op.table)
      const tooLong = lengthProblem(physical)
      if (tooLong) return `${label}: ${tooLong}`
      const columns = new Map<string, ResolvedColumn>()
      const entries = Object.entries(op.columns)
      if (entries.length === 0) return `${label} creates "${op.table}" with no columns`
      for (const [name, spec] of entries) {
        const problem =
          logicalNameProblem('column', name) ??
          (RESERVED_COLUMNS.has(name) ? `the column name "${name}" is reserved` : undefined) ??
          specProblem(spec, `"${op.table}.${name}"`)
        if (problem) return `${label}: ${problem}`
        columns.set(name, { name, spec, addedIn: at })
      }
      const keys = [...columns.values()].filter((column) => column.spec.primaryKey)
      if (keys.length !== 1)
        return `${label} creates "${op.table}" with ${keys.length} primary keys, not one`
      const created: ResolvedTable = {
        name: op.table,
        physical,
        columns,
        indexes: new Map(),
        addedIn: at,
      }
      for (const column of columns.values())
        if (column.spec.indexed && !column.spec.primaryKey)
          created.indexes.set(column.name, {
            name: indexName(schema.id, op.table, [column.name]),
            columns: [column.name],
            unique: false,
            addedIn: at,
          })
      schema.tables.set(op.table, created)
      return undefined
    }
    case 'addColumn': {
      if (!table) return `${label} adds a column to "${op.table}", which does not exist`
      const problem =
        logicalNameProblem('column', op.column) ??
        (RESERVED_COLUMNS.has(op.column)
          ? `the column name "${op.column}" is reserved`
          : undefined) ??
        specProblem(op.spec, `"${op.table}.${op.column}"`)
      if (problem) return `${label}: ${problem}`
      if (table.columns.has(op.column))
        return `${label} adds "${op.table}.${op.column}", which exists`
      if (op.spec.primaryKey)
        return `${label} adds a primary key to "${op.table}", which a table has already`
      if (!op.spec.nullable && op.spec.default === undefined)
        return `${label} adds "${op.table}.${op.column}" neither nullable nor with a default, which the rows already there cannot satisfy`
      table.columns.set(op.column, { name: op.column, spec: op.spec, addedIn: at })
      if (op.spec.indexed)
        table.indexes.set(op.column, {
          name: indexName(schema.id, op.table, [op.column]),
          columns: [op.column],
          unique: false,
          addedIn: at,
        })
      return undefined
    }
    case 'addIndex': {
      if (!table) return `${label} indexes "${op.table}", which does not exist`
      if (op.columns.length === 0) return `${label} adds an index on no columns`
      for (const column of op.columns)
        if (!table.columns.has(column))
          return `${label} indexes "${op.table}.${column}", which does not exist`
      const key = op.columns.join(',')
      if (table.indexes.has(key)) return `${label} indexes "${op.table}" (${key}) twice`
      table.indexes.set(key, {
        name: indexName(schema.id, op.table, op.columns),
        columns: [...op.columns],
        unique: op.unique,
        addedIn: at,
      })
      return undefined
    }
    case 'widenColumn': {
      const column = table?.columns.get(op.column)
      if (!table || !column)
        return `${label} widens "${op.table}.${op.column}", which does not exist`
      const from = column.spec
      const to = op.spec
      const wider =
        (from.type === to.type &&
          from.type === 'varchar' &&
          (to.length ?? 0) > (from.length ?? 0)) ||
        (from.type !== to.type && (WIDER[from.type] ?? []).includes(to.type))
      if (!wider)
        return `${label} changes "${op.table}.${op.column}" from ${from.type}${from.length ? `(${from.length})` : ''} to ${to.type}${to.length ? `(${to.length})` : ''}, which is not wider`
      if (
        to.nullable !== from.nullable ||
        to.default !== from.default ||
        to.primaryKey !== from.primaryKey
      )
        return `${label} widens "${op.table}.${op.column}" and changes more than its type`
      const problem = specProblem(to, `"${op.table}.${op.column}"`)
      if (problem) return `${label}: ${problem}`
      table.columns.set(op.column, { ...column, spec: { ...to, indexed: from.indexed } })
      return undefined
    }
    case 'dropTable':
      if (!table) return `${label} drops "${op.table}", which does not exist`
      schema.tables.delete(op.table)
      return undefined
    case 'dropColumn': {
      const column = table?.columns.get(op.column)
      if (!table || !column)
        return `${label} drops "${op.table}.${op.column}", which does not exist`
      if (column.spec.primaryKey)
        return `${label} drops "${op.table}.${op.column}", the primary key`
      for (const index of table.indexes.values())
        if (index.columns.includes(op.column))
          return `${label} drops "${op.table}.${op.column}" while an index covers it; drop the index first`
      table.columns.delete(op.column)
      return undefined
    }
    case 'dropIndex': {
      const key = op.columns.join(',')
      if (!table?.indexes.has(key))
        return `${label} drops an index on "${op.table}" (${key}), which does not exist`
      table.indexes.delete(key)
      return undefined
    }
  }
}

/** What a drop removes, for the contract rule: when it was added. */
function removedAddedIn(
  schema: ResolvedSchema,
  op: Operation,
): { step: string; release: string } | undefined {
  const table = schema.tables.get(op.table)
  if (op.op === 'dropTable') return table?.addedIn
  if (op.op === 'dropColumn') return table?.columns.get(op.column)?.addedIn
  if (op.op === 'dropIndex') return table?.indexes.get(op.columns.join(','))?.addedIn
  return undefined
}

const DROPS = new Set(['dropTable', 'dropColumn', 'dropIndex'])

/**
 * Compiles a declaration, collecting every problem rather than stopping at the
 * first. `version` is the bundle's own: no step may claim a release after it.
 */
export function compileBundleTables(tables: BundleTables, version?: string): CompiledTables {
  const id = tables.id
  const problems: string[] = []
  const idProblem = bundleIdProblem(id)
  if (idProblem) problems.push(idProblem)
  let schema: ResolvedSchema = { id, prefix: bundlePrefix(id), tables: new Map() }
  const steps: CompiledStep[] = []
  const names = new Set<string>()
  let from = bundleInitialState(id)
  let previous: string | undefined

  for (const [index, step] of tables.steps.entries()) {
    const label = `step "${step.name}"`
    if (typeof step.name !== 'string' || !STEP_NAME.test(step.name))
      problems.push(
        `${label}: a step name is lowercase letters, digits, dots, hyphens and underscores`,
      )
    else if (names.has(step.name)) problems.push(`two steps are named "${step.name}"`)
    names.add(step.name)
    if (typeof step.release !== 'string' || !SEMVER.test(step.release)) {
      problems.push(`${label} declares the release "${step.release}", which is not a version`)
      continue
    }
    if (previous && compareRelease(step.release, previous) < 0)
      problems.push(`${label} ships in ${step.release}, before the step ahead of it (${previous})`)
    if (version && compareRelease(step.release, version) > 0)
      problems.push(
        `${label} ships in ${step.release}, which is later than this release of the bundle (${version})`,
      )
    previous = step.release

    let operations: Operation[]
    try {
      const returned = step.up(schemaBuilder)
      operations = (Array.isArray(returned) ? returned : [returned]) as Operation[]
    } catch (error) {
      problems.push(
        `${label} failed to describe itself: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    if (operations.length === 0) {
      problems.push(`${label} does nothing`)
      continue
    }

    const drops = operations.filter((op) => DROPS.has(op.op))
    const kind: StepKind = drops.length > 0 ? 'contract' : 'expand'
    if (kind === 'contract' && drops.length !== operations.length)
      problems.push(`${label} both adds and removes; a step is an expand or a contract, never both`)

    const before = clone(schema)
    const working = clone(schema)
    let contracts: string | undefined
    for (const op of operations) {
      if (DROPS.has(op.op)) {
        const added = removedAddedIn(working, op)
        if (added) {
          contracts ??= added.step
          if (compareRelease(added.release, step.release) >= 0)
            problems.push(
              `${label} (${step.release}) removes what "${added.step}" added in ${added.release}; a contract may only remove what an earlier release added`,
            )
        }
      }
      const problem = apply(working, op, step)
      if (problem) problems.push(problem)
    }
    if (kind === 'contract' && !isMajorRelease(step.release))
      problems.push(
        `${label} removes something in ${step.release}, but a contract may only ship in a major release of the bundle (x.0.0)`,
      )
    schema = working

    const to = stateAt(id, index + 1, step.name)
    steps.push({
      name: step.name,
      release: step.release,
      position: index + 1,
      from,
      to,
      kind,
      operations,
      // Bare hex: the ledger's checksum column holds 64 characters.
      checksum: new Bun.CryptoHasher('sha256').update(canonical(operations)).digest('hex'),
      contracts,
      before,
      after: clone(schema),
      backfill: step.backfill,
    })
    from = to
  }

  return {
    id,
    stateKey: bundleStateKey(id),
    initialState: bundleInitialState(id),
    steps,
    schema,
    problems,
  }
}

/**
 * Throws when a declaration breaks a rule, naming every problem. For a bundle's
 * own test suite, so it is held to the same rules before it ships as it is when
 * a site wires it.
 */
export function assertBundleTables(tables: BundleTables, version: string): void {
  const { problems } = compileBundleTables(tables, version)
  if (problems.length > 0)
    throw new Error(
      `The bundle "${tables.id}"'s tables break the rules:\n- ${problems.join('\n- ')}`,
    )
}

/** `breaking` exactly when this release of the bundle ships a contract: what its package.json declares. */
export function bundleTablesCompatibility(
  tables: BundleTables,
  version: string,
): 'compatible' | 'breaking' {
  return compileBundleTables(tables).steps.some(
    (step) => step.kind === 'contract' && compareRelease(step.release, version) === 0,
  )
    ? 'breaking'
    : 'compatible'
}
