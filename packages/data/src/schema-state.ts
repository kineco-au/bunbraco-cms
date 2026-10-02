/**
 * The schema state a database is at, and the rule that only a node at the
 * current state may write.
 *
 * `(version, revision)` is a deployment's identity: `version` is the human
 * value in `schema/schema.toml`, `revision` a monotonic number supplied at
 * deploy time. See docs/10-packaging-and-upgrades.md.
 */
import type { Db } from './database.ts'
import { DbDate } from './dialect.ts'

export interface SchemaStateRow {
  id: number
  version: string
  revision: string
  hash: string | null
  status: 'prepared' | 'current'
}

export interface NodeSchemaState {
  version: string
  revision: string
}

/** The state a node runs at until schema-as-code supplies one: the install baseline. */
export const BASELINE_NODE_STATE: NodeSchemaState = { version: '0', revision: '0' }

function segments(value: string): number[] {
  return value.split(/[.+-]/).map((part) => {
    const n = Number(part)
    return Number.isFinite(n) ? n : 0
  })
}

/** Numeric per-segment comparison of dotted versions; -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const sa = segments(a)
  const sb = segments(b)
  const length = Math.max(sa.length, sb.length)
  for (let i = 0; i < length; i++) {
    const da = sa[i] ?? 0
    const db = sb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

export function compareStates(a: NodeSchemaState, b: NodeSchemaState): number {
  return compareVersions(a.version, b.version) || compareVersions(a.revision, b.revision)
}

export class WriteRejectedError extends Error {
  constructor(
    readonly node: NodeSchemaState,
    readonly database: NodeSchemaState,
  ) {
    super(
      `This server is at schema ${node.version}+${node.revision} but the database is at ` +
        `${database.version}+${database.revision}; writes are refused until it is upgraded.`,
    )
  }
}

/** The latest current state. Takes a shared lock where the engine has one, so an upgrade cannot slip between the check and the write. */
export async function currentSchemaState(db: Db, lock = false): Promise<SchemaStateRow> {
  const suffix = lock ? db.dialect.forShare : ''
  const rows = await db.query(
    `SELECT id, version, revision, hash, status FROM schema_state
     WHERE status = 'current' ORDER BY id DESC LIMIT 1 ${suffix}`,
  )
  const row = rows[0]
  if (!row) throw new Error('schema_state has no current row; the database is not installed.')
  return {
    id: Number(row.id),
    version: String(row.version),
    revision: String(row.revision),
    hash: (row.hash as string | null) ?? null,
    status: String(row.status) as 'prepared' | 'current',
  }
}

/**
 * Called inside every write transaction. Returns the state to stamp on what is
 * written, or throws when the node is behind the database.
 */
export async function assertNodeMayWrite(db: Db, node: NodeSchemaState): Promise<SchemaStateRow> {
  const current = await currentSchemaState(db, true)
  if (compareStates(node, current) < 0) throw new WriteRejectedError(node, current)
  return current
}

export interface AdvanceOptions {
  version: string
  revision: string
  hash?: string
  status: 'prepared' | 'current'
  by?: string
}

/** Appends a schema state row. Under `FOR UPDATE` on the previous current row, so it serialises against writers. */
export async function appendSchemaState(db: Db, options: AdvanceOptions): Promise<SchemaStateRow> {
  await db.query(
    `SELECT id FROM schema_state WHERE status = 'current' ORDER BY id DESC LIMIT 1 ${db.dialect.forUpdate}`,
  )
  await db.exec(
    `INSERT INTO schema_state (version, revision, hash, status, synced_at, synced_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      options.version,
      options.revision,
      options.hash ?? null,
      options.status,
      DbDate.toDb(new Date()),
      options.by ?? null,
    ],
  )
  const rows = await db.query(
    'SELECT id, version, revision, hash, status FROM schema_state ORDER BY id DESC LIMIT 1',
  )
  const row = rows[0] as Record<string, unknown>
  return {
    id: Number(row.id),
    version: String(row.version),
    revision: String(row.revision),
    hash: (row.hash as string | null) ?? null,
    status: String(row.status) as 'prepared' | 'current',
  }
}

/** Key write-back changes the files after they were hashed; the state records the files as they now are. */
export async function updateSchemaStateHash(db: Db, id: number, hash: string): Promise<void> {
  await db.exec('UPDATE schema_state SET hash = ? WHERE id = ?', [hash, id])
}

/** Every state row, oldest first. The table is small: one row per deployment. */
export async function allSchemaStates(db: Db): Promise<SchemaStateRow[]> {
  const rows = await db.query(
    'SELECT id, version, revision, hash, status FROM schema_state ORDER BY id',
  )
  return rows.map((row) => ({
    id: Number(row.id),
    version: String(row.version),
    revision: String(row.revision),
    hash: (row.hash as string | null) ?? null,
    status: String(row.status) as 'prepared' | 'current',
  }))
}

/** The newest prepared state, if an early fix has created one. */
export async function latestPreparedState(db: Db): Promise<SchemaStateRow | undefined> {
  const states = await allSchemaStates(db)
  return states.filter((s) => s.status === 'prepared').at(-1)
}

/**
 * The highest state id a node may read as-of: the newest row at or below its
 * own `(version, revision)`. Undefined when every row is visible to it.
 */
export async function visibleStateIdFor(
  db: Db,
  node: NodeSchemaState,
): Promise<number | undefined> {
  const states = await allSchemaStates(db)
  if (states.every((s) => compareStates(s, node) <= 0)) return undefined
  const visible = states.filter((s) => compareStates(s, node) <= 0)
  return visible.at(-1)?.id ?? 0
}

/** Marks a prepared state current — the cut-over. */
export async function makeStateCurrent(db: Db, id: number): Promise<void> {
  await db.query(
    `SELECT id FROM schema_state WHERE status = 'current' ORDER BY id DESC LIMIT 1 ${db.dialect.forUpdate}`,
  )
  await db.exec("UPDATE schema_state SET status = 'current' WHERE id = ?", [id])
}
