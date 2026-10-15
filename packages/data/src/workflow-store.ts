/**
 * The approval workflows as last synced from `schema/workflows/` (story 028),
 * each with its version, so a running node reads them without the files and a
 * sync can tell which changed. docs/workflows.md.
 */
import { type SchemaWorkflow, startStages } from '@crombolo/core'
import type { Db } from './database.ts'
import { ApprovalRepository } from './repositories/approvals.ts'

export const WORKFLOWS_KEY = 'crombolo:workflows'

export interface StoredWorkflow {
  workflow: SchemaWorkflow
  version: string
}

/** Stored workflows read leniently: anything unreadable is none. Pure. */
export function parseStoredWorkflows(value: string | undefined): StoredWorkflow[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (w): w is StoredWorkflow =>
            !!w && typeof w === 'object' && 'workflow' in w && 'version' in w,
        )
      : []
  } catch {
    return []
  }
}

export async function readWorkflows(db: Db): Promise<StoredWorkflow[]> {
  const rows = await db.query<{ value: string }>('SELECT value FROM key_value WHERE key = ?', [
    WORKFLOWS_KEY,
  ])
  return parseStoredWorkflows(rows[0]?.value)
}

/** Stores the workflows; answers what was there before. */
export async function writeWorkflows(
  db: Db,
  workflows: readonly StoredWorkflow[],
): Promise<StoredWorkflow[]> {
  return db.transaction(async (tx) => {
    const before = await readWorkflows(tx)
    const value = JSON.stringify(workflows)
    const now = tx.dialect.now()
    const updated = await tx.query<{ key: string }>(
      `UPDATE key_value SET value = ?, update_date = ${now} WHERE key = ? RETURNING key`,
      [value, WORKFLOWS_KEY],
    )
    if (updated.length === 0)
      await tx.exec(`INSERT INTO key_value (key, value, update_date) VALUES (?, ?, ${now})`, [
        WORKFLOWS_KEY,
        value,
      ])
    return before
  })
}

export interface WorkflowSyncReport {
  /** Aliases whose meaning changed, or that are new or gone. */
  changed: string[]
  /** What `on-change` did to requests in flight, by request key. */
  requests: Array<{ key: string; workflow: string; outcome: 'kept' | 'restarted' | 'withdrawn' }>
}

/**
 * Stores the workflows and applies each changed one's `on-change` to the
 * requests in flight under it: `keep` leaves them on the version they started
 * with, `restart` starts them again from the first stage of the new one, and
 * `withdraw` ends them. A workflow that is gone cannot be restarted under, so
 * its requests are kept or withdrawn as it said.
 */
export async function syncWorkflows(
  db: Db,
  workflows: readonly StoredWorkflow[],
): Promise<WorkflowSyncReport> {
  const report: WorkflowSyncReport = { changed: [], requests: [] }
  const before = await writeWorkflows(db, workflows)
  const identity = (w: SchemaWorkflow) => w.key ?? w.alias
  const previous = new Map(before.map((s) => [identity(s.workflow), s]))
  const current = new Map(workflows.map((s) => [identity(s.workflow), s]))
  const requests = new ApprovalRepository(db)
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const was = previous.get(id)
    const now = current.get(id)
    if (was && now && was.version === now.version) continue
    report.changed.push((now ?? was)?.workflow.alias ?? id)
    const rule = (now ?? was)?.workflow.onChange ?? 'keep'
    for (const request of await requests.waitingUnder(id)) {
      if (request.workflowVersion === now?.version) continue
      if (rule === 'keep') {
        report.requests.push({ key: request.key, workflow: id, outcome: 'kept' })
        continue
      }
      if (rule === 'restart' && now) {
        await requests.rebase(request.id, now.workflow, now.version)
        for (const stage of startStages(now.workflow)) await requests.addStep(request.id, stage)
        await requests.record(request.id, { kind: 'restarted', comment: 'the workflow changed' })
        report.requests.push({ key: request.key, workflow: id, outcome: 'restarted' })
        continue
      }
      await requests.setState(request.id, 'withdrawn')
      await requests.record(request.id, {
        kind: 'withdrawn',
        comment: now ? 'the workflow changed' : 'the workflow was removed',
      })
      report.requests.push({ key: request.key, workflow: id, outcome: 'withdrawn' })
    }
  }
  return report
}
