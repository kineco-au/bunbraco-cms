/**
 * Approval requests (story 028): a page sent for approval, the stages it has
 * reached, and its history. What the rules decide is the engine's
 * (`packages/server/src/approvals.ts`); this only keeps the record.
 * docs/workflows.md.
 */
import { normaliseUuid, type SchemaWorkflow } from '@crombolo/core'
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export type ApprovalAction = 'publish' | 'unpublish'
export type ApprovalState = 'waiting' | 'approved' | 'sent-back' | 'withdrawn'
export type ApprovalStepState = 'waiting' | 'approved' | 'sent-back' | 'discarded'
export type ApprovalHistoryKind =
  | 'sent'
  | 'approved'
  | 'sent-back'
  | 'withdrawn'
  | 'edited'
  | 'restarted'
  | 'published'
  | 'unpublished'

export interface ApprovalRequest {
  id: number
  key: string
  nodeKey: string
  /** Null for the invariant variant, or the whole page. */
  cultures: string[] | null
  action: ApprovalAction
  /** The page's head event when it was sent, or after the last edit the workflow let through. */
  eventId: number | null
  workflowKey: string
  workflowVersion: string
  /** The workflow as it stood when the request started, or was restarted. */
  workflow: SchemaWorkflow
  state: ApprovalState
  /** The user's key. */
  requestedBy: string
  requestedAt: Date
  finishedAt: Date | null
}

export interface ApprovalStep {
  id: number
  requestId: number
  stage: string
  state: ApprovalStepState
  reachedAt: Date
  doneAt: Date | null
}

export interface ApprovalHistoryEntry {
  id: number
  requestId: number
  /** The stage visit it belongs to: approvals count only toward the visit they were given in. */
  stepId: number | null
  stage: string | null
  kind: ApprovalHistoryKind
  userKey: string | null
  comment: string | null
  createDate: Date
}

const requestFrom = (row: Record<string, unknown>): ApprovalRequest => ({
  id: Number(row.id),
  key: normaliseUuid(String(row.key)),
  nodeKey: normaliseUuid(String(row.node_key)),
  cultures: row.cultures ? (JSON.parse(String(row.cultures)) as string[]) : null,
  action: row.action === 'unpublish' ? 'unpublish' : 'publish',
  eventId: row.event_id === null || row.event_id === undefined ? null : Number(row.event_id),
  workflowKey: String(row.workflow_key),
  workflowVersion: String(row.workflow_version),
  workflow: JSON.parse(String(row.workflow)) as SchemaWorkflow,
  state: String(row.state) as ApprovalState,
  requestedBy: normaliseUuid(String(row.requested_by)),
  requestedAt: DbDate.fromDb(row.requested_at) ?? new Date(0),
  finishedAt: DbDate.fromDb(row.finished_at) ?? null,
})

const stepFrom = (row: Record<string, unknown>): ApprovalStep => ({
  id: Number(row.id),
  requestId: Number(row.request_id),
  stage: String(row.stage),
  state: String(row.state) as ApprovalStepState,
  reachedAt: DbDate.fromDb(row.reached_at) ?? new Date(0),
  doneAt: DbDate.fromDb(row.done_at) ?? null,
})

const historyFrom = (row: Record<string, unknown>): ApprovalHistoryEntry => ({
  id: Number(row.id),
  requestId: Number(row.request_id),
  stepId: row.step_id === null || row.step_id === undefined ? null : Number(row.step_id),
  stage: row.stage === null || row.stage === undefined ? null : String(row.stage),
  kind: String(row.kind) as ApprovalHistoryKind,
  userKey:
    row.user_key === null || row.user_key === undefined
      ? null
      : normaliseUuid(String(row.user_key)),
  comment: row.comment === null || row.comment === undefined ? null : String(row.comment),
  createDate: DbDate.fromDb(row.create_date) ?? new Date(0),
})

/** The workflow's identity on a request: its key, or its alias when it has none. Pure. */
export const workflowIdentity = (workflow: SchemaWorkflow): string => workflow.key ?? workflow.alias

export class ApprovalRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  async create(input: {
    nodeKey: string
    cultures: string[] | null
    action: ApprovalAction
    eventId: number | null
    workflow: SchemaWorkflow
    workflowVersion: string
    /** The user's key. */
    requestedBy: string
  }): Promise<ApprovalRequest> {
    const key = crypto.randomUUID()
    await this.#db.exec(
      `INSERT INTO approval_request (key, node_key, cultures, action, event_id, workflow_key,
         workflow_version, workflow, state, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
      [
        key,
        normaliseUuid(input.nodeKey),
        input.cultures ? JSON.stringify(input.cultures) : null,
        input.action,
        input.eventId,
        workflowIdentity(input.workflow),
        input.workflowVersion,
        JSON.stringify(input.workflow),
        normaliseUuid(input.requestedBy),
        DbDate.toDb(new Date()),
      ],
    )
    return (await this.byKey(key)) as ApprovalRequest
  }

  async byKey(key: string): Promise<ApprovalRequest | undefined> {
    const rows = await this.#db.query('SELECT * FROM approval_request WHERE key = ?', [
      normaliseUuid(key),
    ])
    return rows[0] ? requestFrom(rows[0]) : undefined
  }

  /** The request a page is waiting on, if any: at most one at a time. */
  async waitingFor(nodeKey: string): Promise<ApprovalRequest | undefined> {
    const rows = await this.#db.query(
      "SELECT * FROM approval_request WHERE node_key = ? AND state = 'waiting' ORDER BY id DESC",
      [normaliseUuid(nodeKey)],
    )
    return rows[0] ? requestFrom(rows[0]) : undefined
  }

  /** A page's requests, newest first. */
  async forNode(nodeKey: string, limit = 20): Promise<ApprovalRequest[]> {
    const rows = await this.#db.query(
      'SELECT * FROM approval_request WHERE node_key = ? ORDER BY id DESC LIMIT ?',
      [normaliseUuid(nodeKey), limit],
    )
    return rows.map(requestFrom)
  }

  /** Every request still waiting, oldest first. */
  async waiting(): Promise<ApprovalRequest[]> {
    const rows = await this.#db.query(
      "SELECT * FROM approval_request WHERE state = 'waiting' ORDER BY id",
    )
    return rows.map(requestFrom)
  }

  /** Requests that have finished, newest first. */
  async finished(skip: number, take: number): Promise<{ total: number; items: ApprovalRequest[] }> {
    const counted = await this.#db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM approval_request WHERE state <> 'waiting'",
    )
    const rows = await this.#db.query(
      "SELECT * FROM approval_request WHERE state <> 'waiting' ORDER BY id DESC LIMIT ? OFFSET ?",
      [take, skip],
    )
    return { total: Number(counted[0]?.n ?? 0), items: rows.map(requestFrom) }
  }

  async waitingUnder(workflowKey: string): Promise<ApprovalRequest[]> {
    const rows = await this.#db.query(
      "SELECT * FROM approval_request WHERE workflow_key = ? AND state = 'waiting' ORDER BY id",
      [workflowKey],
    )
    return rows.map(requestFrom)
  }

  async setState(id: number, state: ApprovalState): Promise<void> {
    await this.#db.exec('UPDATE approval_request SET state = ?, finished_at = ? WHERE id = ?', [
      state,
      state === 'waiting' ? null : DbDate.toDb(new Date()),
      id,
    ])
  }

  async setEvent(id: number, eventId: number | null): Promise<void> {
    await this.#db.exec('UPDATE approval_request SET event_id = ? WHERE id = ?', [eventId, id])
  }

  /**
   * Puts a request under another version of its workflow, starting over: its
   * stage visits are cleared, and its history keeps what happened.
   */
  async rebase(id: number, workflow: SchemaWorkflow, version: string): Promise<void> {
    await this.#db.exec(
      'UPDATE approval_request SET workflow = ?, workflow_version = ? WHERE id = ?',
      [JSON.stringify(workflow), version, id],
    )
    await this.#db.exec('DELETE FROM approval_step WHERE request_id = ?', [id])
  }

  async steps(requestId: number): Promise<ApprovalStep[]> {
    const rows = await this.#db.query(
      'SELECT * FROM approval_step WHERE request_id = ? ORDER BY id',
      [requestId],
    )
    return rows.map(stepFrom)
  }

  async addStep(requestId: number, stage: string): Promise<number> {
    const rows = await this.#db.query<{ id: number }>(
      "INSERT INTO approval_step (request_id, stage, state, reached_at) VALUES (?, ?, 'waiting', ?) RETURNING id",
      [requestId, stage, DbDate.toDb(new Date())],
    )
    return Number(rows[0]?.id)
  }

  async setStepState(id: number, state: ApprovalStepState): Promise<void> {
    await this.#db.exec('UPDATE approval_step SET state = ?, done_at = ? WHERE id = ?', [
      state,
      state === 'waiting' ? null : DbDate.toDb(new Date()),
      id,
    ])
  }

  async record(
    requestId: number,
    entry: {
      kind: ApprovalHistoryKind
      stepId?: number | null
      stage?: string | null
      userKey?: string | null
      comment?: string | null
    },
  ): Promise<void> {
    await this.#db.exec(
      `INSERT INTO approval_history (request_id, step_id, stage, kind, user_key, comment, create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        requestId,
        entry.stepId ?? null,
        entry.stage ?? null,
        entry.kind,
        entry.userKey ? normaliseUuid(entry.userKey) : null,
        entry.comment ?? null,
        DbDate.toDb(new Date()),
      ],
    )
  }

  async history(requestId: number): Promise<ApprovalHistoryEntry[]> {
    const rows = await this.#db.query(
      'SELECT * FROM approval_history WHERE request_id = ? ORDER BY id',
      [requestId],
    )
    return rows.map(historyFrom)
  }
}
