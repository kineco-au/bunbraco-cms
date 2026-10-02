/**
 * Multi-node plumbing: node identity in `server`, and the polled
 * `cache_instruction` table that tells other nodes what changed.
 * docs/09-schema-as-code.md, "Cache coherence".
 */
import type { Db } from './database.ts'
import { DbDate } from './dialect.ts'

/**
 * `views` is a code change, not a data one: a template was written, so every
 * node has to look at its views tree again. The other two invalidate the
 * published cache; this one makes a node take a new snapshot.
 */
export type CacheInstructionKind = 'schema' | 'content' | 'views'

export interface CacheInstruction {
  id: number
  kind: CacheInstructionKind
  payload: Record<string, unknown>
  createdBy: string | null
}

export async function appendCacheInstruction(
  db: Db,
  instruction: { kind: CacheInstructionKind; payload?: Record<string, unknown>; by?: string },
): Promise<void> {
  await db.exec(
    'INSERT INTO cache_instruction (kind, payload, created_at, created_by) VALUES (?, ?, ?, ?)',
    [
      instruction.kind,
      JSON.stringify(instruction.payload ?? {}),
      DbDate.toDb(new Date()),
      instruction.by ?? null,
    ],
  )
}

/** The highest instruction id, so a fresh node ignores history. */
export async function latestCacheInstructionId(db: Db): Promise<number> {
  const rows = await db.query<{ n: number | null }>('SELECT MAX(id) AS n FROM cache_instruction')
  return Number(rows[0]?.n ?? 0)
}

export async function cacheInstructionsAfter(db: Db, afterId: number): Promise<CacheInstruction[]> {
  const rows = await db.query(
    'SELECT id, kind, payload, created_by FROM cache_instruction WHERE id > ? ORDER BY id',
    [afterId],
  )
  return rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind) as CacheInstructionKind,
    payload: row.payload ? (JSON.parse(String(row.payload)) as Record<string, unknown>) : {},
    createdBy: (row.created_by as string | null) ?? null,
  }))
}

export interface ServerIdentity {
  nodeId: string
  version: string
  revision: string
}

/** Records this node in `server`; called at boot and on each poll. */
export async function touchServer(db: Db, identity: ServerIdentity): Promise<void> {
  const now = DbDate.toDb(new Date())
  const existing = await db.query<{ node_id: string }>(
    'SELECT node_id FROM server WHERE node_id = ?',
    [identity.nodeId],
  )
  if (existing[0]) {
    await db.exec('UPDATE server SET version = ?, revision = ?, last_seen = ? WHERE node_id = ?', [
      identity.version,
      identity.revision,
      now,
      identity.nodeId,
    ])
  } else {
    await db.exec(
      'INSERT INTO server (node_id, version, revision, last_seen) VALUES (?, ?, ?, ?)',
      [identity.nodeId, identity.version, identity.revision, now],
    )
  }
}
