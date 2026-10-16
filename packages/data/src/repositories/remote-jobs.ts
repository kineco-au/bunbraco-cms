/**
 * Pulls and pushes through the remote protocol (story 107): one row per job,
 * read by whichever node a client polls, written by the node running it.
 */
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export type RemoteJobKind = 'pull' | 'push'
export type RemoteJobState =
  | 'queued'
  | 'running'
  | 'approval-required'
  | 'done'
  | 'failed'
  | 'refused'

export interface RemoteJob {
  id: string
  kind: RemoteJobKind
  environment: string
  requestedBy: string
  requestedByName: string
  options: Record<string, unknown>
  state: RemoteJobState
  stage: string | null
  progress: number | null
  fileKey: string | null
  fileSize: number | null
  sha256: string | null
  problem: { code: string; title: string; detail?: string; items?: string[] } | null
  secret: string | null
  runId: string | null
  decidedBy: string | null
  decidedAt: Date | undefined
  heartbeatAt: Date
  expiresAt: Date
  createdAt: Date
}

const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function mapJob(row: Record<string, unknown>): RemoteJob {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v))
  return {
    id: String(row.id),
    kind: String(row.kind) as RemoteJobKind,
    environment: String(row.environment),
    requestedBy: String(row.requested_by),
    requestedByName: String(row.requested_by_name),
    options: parse(row.options, {}),
    state: String(row.state) as RemoteJobState,
    stage: str(row.stage),
    progress: row.progress === null || row.progress === undefined ? null : Number(row.progress),
    fileKey: str(row.file_key),
    fileSize: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    sha256: str(row.sha256),
    problem: parse(row.problem, null),
    secret: str(row.secret),
    runId: str(row.run_id),
    decidedBy: str(row.decided_by),
    decidedAt: DbDate.fromDb(row.decided_at),
    heartbeatAt: DbDate.fromDb(row.heartbeat_at) ?? new Date(0),
    expiresAt: DbDate.fromDb(row.expires_at) ?? new Date(0),
    createdAt: DbDate.fromDb(row.create_date) ?? new Date(0),
  }
}

export type RemoteJobUpdate = Partial<
  Pick<
    RemoteJob,
    | 'state'
    | 'stage'
    | 'progress'
    | 'fileKey'
    | 'fileSize'
    | 'sha256'
    | 'problem'
    | 'secret'
    | 'runId'
    | 'decidedBy'
    | 'decidedAt'
    | 'expiresAt'
  >
>

const COLUMNS: Record<keyof RemoteJobUpdate, string> = {
  state: 'state',
  stage: 'stage',
  progress: 'progress',
  fileKey: 'file_key',
  fileSize: 'file_size',
  sha256: 'sha256',
  problem: 'problem',
  secret: 'secret',
  runId: 'run_id',
  decidedBy: 'decided_by',
  decidedAt: 'decided_at',
  expiresAt: 'expires_at',
}

export class RemoteJobRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async create(job: {
    id: string
    kind: RemoteJobKind
    environment: string
    requestedBy: string
    requestedByName: string
    options: Record<string, unknown>
    state: RemoteJobState
    expiresAt: Date
  }): Promise<void> {
    const now = DbDate.toDb(new Date())
    await this.#db.exec(
      `INSERT INTO remote_job
         (id, kind, environment, requested_by, requested_by_name, options, state, heartbeat_at, expires_at, create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.kind,
        job.environment,
        job.requestedBy,
        job.requestedByName,
        JSON.stringify(job.options),
        job.state,
        now,
        DbDate.toDb(job.expiresAt),
        now,
      ],
    )
  }

  async get(id: string): Promise<RemoteJob | undefined> {
    const rows = await this.#db.query('SELECT * FROM remote_job WHERE id = ?', [id])
    return rows[0] ? mapJob(rows[0]) : undefined
  }

  /** Records progress, and that the node running it is still alive. */
  async update(id: string, change: RemoteJobUpdate): Promise<void> {
    const sets: string[] = ['heartbeat_at = ?']
    const values: unknown[] = [DbDate.toDb(new Date())]
    for (const [field, value] of Object.entries(change) as [keyof RemoteJobUpdate, unknown][]) {
      sets.push(`${COLUMNS[field]} = ?`)
      values.push(
        field === 'problem'
          ? value === null
            ? null
            : JSON.stringify(value)
          : value instanceof Date
            ? DbDate.toDb(value)
            : value,
      )
    }
    await this.#db.exec(`UPDATE remote_job SET ${sets.join(', ')} WHERE id = ?`, [...values, id])
  }

  /** Moves a job from one state to another only if it is still in the first; true when it moved. */
  async transition(id: string, from: RemoteJobState, change: RemoteJobUpdate): Promise<boolean> {
    const rows = await this.#db.query<{ id: string }>(
      'UPDATE remote_job SET state = ?, heartbeat_at = ? WHERE id = ? AND state = ? RETURNING id',
      [change.state ?? from, DbDate.toDb(new Date()), id, from],
    )
    if (rows.length === 0) return false
    await this.update(id, change)
    return true
  }

  /** Jobs past their expiry, whose files are to be swept. */
  async expired(now = new Date()): Promise<RemoteJob[]> {
    const rows = await this.#db.query('SELECT * FROM remote_job WHERE expires_at < ?', [
      DbDate.toDb(now),
    ])
    return rows.map(mapJob)
  }

  async delete(id: string): Promise<void> {
    await this.#db.exec('DELETE FROM remote_job WHERE id = ?', [id])
  }
}
