/**
 * The form workflow queue. `docs/18-forms.md`.
 *
 * Claimed with `UPDATE … WHERE state = 'pending' … RETURNING`, which is atomic
 * on both dialects: on a multi-node Postgres site every node polls, and exactly
 * one of them wins each row. Without that, two nodes would send the same email.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export type FormWorkflowState = 'pending' | 'running' | 'done' | 'failed'

export interface FormWorkflowRun {
  id: string
  formKey: string
  formAlias: string
  workflowName: string
  workflowType: string
  runOn: string
  /** The entry this came from; absent for a form that stores none. */
  entryId: string | null
  /** The submitted values, as the workflow needs them. */
  payload: { fieldAlias: string; values: string[] }[]
  state: FormWorkflowState
  attempts: number
  lastError: string | null
  runAfter: Date
  createDate: Date
  updateDate: Date
}

export type FormWorkflowEnqueue = Pick<
  FormWorkflowRun,
  'formKey' | 'formAlias' | 'workflowName' | 'workflowType' | 'runOn' | 'entryId' | 'payload'
>

interface Row {
  id: string
  form_key: string
  form_alias: string
  workflow_name: string
  workflow_type: string
  run_on: string
  entry_id: string | null
  payload: string
  state: string
  attempts: number
  last_error: string | null
  run_after: unknown
  create_date: unknown
  update_date: unknown
}

const SELECT = `SELECT id, form_key, form_alias, workflow_name, workflow_type, run_on,
                       entry_id, payload, state, attempts, last_error, run_after,
                       create_date, update_date
                  FROM form_workflow_run`

const STATES: readonly FormWorkflowState[] = ['pending', 'running', 'done', 'failed']

const payloadOf = (value: string): FormWorkflowRun['payload'] => {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as FormWorkflowRun['payload']) : []
  } catch {
    // A row edited by hand should still be visible and still be deletable.
    return []
  }
}

const hydrate = (row: Row): FormWorkflowRun => ({
  id: row.id,
  formKey: row.form_key,
  formAlias: row.form_alias,
  workflowName: row.workflow_name,
  workflowType: row.workflow_type,
  runOn: row.run_on,
  entryId: row.entry_id,
  payload: payloadOf(row.payload),
  state: STATES.includes(row.state as FormWorkflowState)
    ? (row.state as FormWorkflowState)
    : 'pending',
  attempts: Number(row.attempts),
  lastError: row.last_error,
  runAfter: DbDate.fromDb(row.run_after) ?? new Date(0),
  createDate: DbDate.fromDb(row.create_date) ?? new Date(0),
  updateDate: DbDate.fromDb(row.update_date) ?? new Date(0),
})

export class FormWorkflowRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  /** Queues the workflows a submission triggered, in the order they are declared. */
  async enqueue(runs: readonly FormWorkflowEnqueue[], now = new Date()): Promise<string[]> {
    const ids: string[] = []
    for (const run of runs) {
      const id = randomUUID()
      await this.#db.exec(
        `INSERT INTO form_workflow_run
           (id, form_key, form_alias, workflow_name, workflow_type, run_on, entry_id,
            payload, state, attempts, last_error, run_after, create_date, update_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          run.formKey,
          run.formAlias,
          run.workflowName,
          run.workflowType,
          run.runOn,
          run.entryId,
          JSON.stringify(run.payload),
          'pending',
          0,
          null,
          DbDate.toDb(now),
          DbDate.toDb(now),
          DbDate.toDb(now),
        ],
      )
      ids.push(id)
    }
    return ids
  }

  /** What is ready to run, oldest first so a backlog drains in order. */
  async due(now = new Date(), limit = 25): Promise<FormWorkflowRun[]> {
    const rows = await this.#db.query<Row>(
      `${SELECT} WHERE state = ? AND run_after <= ? ORDER BY run_after, create_date LIMIT ?`,
      ['pending', DbDate.toDb(now), limit],
    )
    return rows.map(hydrate)
  }

  /**
   * Takes a row, or finds somebody else already has.
   *
   * The `state = 'pending'` in the WHERE is the whole mechanism: two nodes issue
   * the same UPDATE, and only the first one changes a row.
   */
  async claim(id: string): Promise<FormWorkflowRun | undefined> {
    const rows = await this.#db.query<Row>(
      `UPDATE form_workflow_run
          SET state = ?, attempts = attempts + 1, update_date = ?
        WHERE id = ? AND state = ?
        RETURNING id, form_key, form_alias, workflow_name, workflow_type, run_on,
                  entry_id, payload, state, attempts, last_error, run_after,
                  create_date, update_date`,
      ['running', DbDate.toDb(new Date()), id, 'pending'],
    )
    const row = rows[0]
    return row ? hydrate(row) : undefined
  }

  async succeed(id: string): Promise<void> {
    await this.#db.exec(
      'UPDATE form_workflow_run SET state = ?, last_error = NULL, update_date = ? WHERE id = ?',
      ['done', DbDate.toDb(new Date()), id],
    )
  }

  /**
   * Records a failure. `retryAt` puts it back in the queue; without one it is
   * finished and a person has to look.
   */
  async fail(id: string, error: string, retryAt?: Date): Promise<void> {
    await this.#db.exec(
      'UPDATE form_workflow_run SET state = ?, last_error = ?, run_after = ?, update_date = ? WHERE id = ?',
      [
        retryAt ? 'pending' : 'failed',
        error.slice(0, 2000),
        DbDate.toDb(retryAt ?? new Date()),
        DbDate.toDb(new Date()),
        id,
      ],
    )
  }

  async byId(id: string): Promise<FormWorkflowRun | undefined> {
    const rows = await this.#db.query<Row>(`${SELECT} WHERE id = ?`, [id])
    const row = rows[0]
    return row ? hydrate(row) : undefined
  }

  /** Every run for a form, newest first; what the backoffice would show. */
  async forForm(formKey: string, limit = 100): Promise<FormWorkflowRun[]> {
    const rows = await this.#db.query<Row>(
      `${SELECT} WHERE form_key = ? ORDER BY create_date DESC LIMIT ?`,
      [formKey, limit],
    )
    return rows.map(hydrate)
  }

  /** How many runs sit in each state, for a status line. */
  async counts(): Promise<Record<FormWorkflowState, number>> {
    const rows = await this.#db.query<{ state: string; n: number }>(
      'SELECT state, COUNT(*) AS n FROM form_workflow_run GROUP BY state',
    )
    const out: Record<FormWorkflowState, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
    }
    for (const row of rows)
      if (STATES.includes(row.state as FormWorkflowState))
        out[row.state as FormWorkflowState] = Number(row.n)
    return out
  }
}
