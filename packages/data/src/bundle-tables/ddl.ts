/**
 * A step's operations as SQL, per dialect. Every identifier comes from the
 * resolved schema and is quoted here, every default is a literal the builder
 * already checked, and every statement passes the guard before it is returned.
 */
import type { Dialect } from '../dialect.ts'
import type { ColumnSpec, Operation } from './builder.ts'
import { guardStatement } from './guard.ts'
import type { ResolvedSchema } from './schema.ts'

/** The column type, from the dialect seam. Text compares case-sensitively on both. */
export function columnType(dialect: Dialect, spec: ColumnSpec): string {
  const t = dialect.types
  switch (spec.type) {
    case 'uuid':
      return t.uuid
    case 'varchar':
      return t.varcharExact(spec.length ?? 1)
    case 'text':
      return t.text
    case 'integer':
      return t.integer
    case 'bigint':
      return t.bigint
    case 'boolean':
      return t.boolean
    case 'timestamp':
      return t.timestamp
    case 'json':
      return t.json
  }
}

function literal(dialect: Dialect, value: string | number | boolean): string {
  if (typeof value === 'boolean')
    return dialect.name === 'postgres' ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0'
  if (typeof value === 'number') return String(value)
  return `'${value.replaceAll("'", "''")}'`
}

function columnDefinition(dialect: Dialect, name: string, spec: ColumnSpec): string {
  const parts = [dialect.quote(name), columnType(dialect, spec)]
  if (!spec.nullable) parts.push('NOT NULL')
  if (spec.default !== undefined) parts.push(`DEFAULT ${literal(dialect, spec.default)}`)
  return parts.join(' ')
}

/** The statements one operation runs, against the schema as it stood before it. */
export function renderOperation(
  dialect: Dialect,
  before: ResolvedSchema,
  after: ResolvedSchema,
  op: Operation,
): string[] {
  const q = (identifier: string) => dialect.quote(identifier)
  const guard = (sql: string) => guardStatement(before.id, before.prefix, sql)
  const table = after.tables.get(op.table) ?? before.tables.get(op.table)
  if (!table) throw new Error(`no table "${op.table}" to render ${op.op} against`)
  const statements: string[] = []
  const indexFor = (columns: readonly string[]) => {
    const index = (after.tables.get(op.table) ?? table).indexes.get(columns.join(','))
    if (!index) throw new Error(`no index on "${op.table}" (${columns.join(',')})`)
    return index
  }
  const createIndex = (columns: readonly string[]) => {
    const index = indexFor(columns)
    statements.push(
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(index.name)} ON ${q(table.physical)} (${index.columns.map(q).join(', ')})`,
    )
  }

  switch (op.op) {
    case 'createTable': {
      const columns = Object.entries(op.columns).map(([name, spec]) =>
        columnDefinition(dialect, name, spec),
      )
      const key = Object.entries(op.columns).find(([, spec]) => spec.primaryKey)?.[0] as string
      statements.push(
        `CREATE TABLE ${q(table.physical)} (${columns.join(', ')}, PRIMARY KEY (${q(key)}))`,
      )
      for (const [name, spec] of Object.entries(op.columns))
        if (spec.indexed && !spec.primaryKey) createIndex([name])
      break
    }
    case 'addColumn':
      statements.push(
        `ALTER TABLE ${q(table.physical)} ADD COLUMN ${columnDefinition(dialect, op.column, op.spec)}`,
      )
      if (op.spec.indexed) createIndex([op.column])
      break
    case 'addIndex':
      createIndex(op.columns)
      break
    case 'widenColumn':
      // SQLite stores by affinity and enforces no length, so a wider type is
      // already what it holds; only Postgres has anything to change.
      if (dialect.name === 'postgres')
        statements.push(
          `ALTER TABLE ${q(table.physical)} ALTER COLUMN ${q(op.column)} TYPE ${columnType(dialect, op.spec)}`,
        )
      break
    case 'dropTable':
      statements.push(`DROP TABLE ${q(table.physical)}`)
      break
    case 'dropColumn':
      statements.push(`ALTER TABLE ${q(table.physical)} DROP COLUMN ${q(op.column)}`)
      break
    case 'dropIndex': {
      const index = before.tables.get(op.table)?.indexes.get(op.columns.join(','))
      if (!index) throw new Error(`no index on "${op.table}" (${op.columns.join(',')})`)
      statements.push(`DROP INDEX ${q(index.name)}`)
      break
    }
  }
  return statements.map(guard)
}

/** Every statement a step runs, in order. */
export function renderStep(
  dialect: Dialect,
  step: { before: ResolvedSchema; after: ResolvedSchema; operations: readonly Operation[] },
): string[] {
  return step.operations.flatMap((op) => renderOperation(dialect, step.before, step.after, op))
}
