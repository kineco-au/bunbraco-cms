/**
 * Background jobs, as Umbraco runs them: scheduled publishing every minute and
 * version cleanup every hour when it is enabled. Each run can also be called directly, which is
 * how tests drive them. On a multi-node Postgres site every node runs them;
 * each schedule is claimed atomically, so it runs once.
 */

import type { NodeSchemaState } from '@bunbraco/data'
import { type Db, DocumentRepository, PublishBlockedError } from '@bunbraco/data'
import type { PublishedCache } from '@bunbraco/render'
import type { WorkflowRunner, WorkflowRunReport } from './form-workflows.ts'
import { logger } from './logging.ts'
import type { MediaFileStore } from './media-files.ts'

export interface JobsOptions {
  db: Db
  cache: PublishedCache
  nodeState: NodeSchemaState
  nodeId: string
  /** Told about each document a job changed, for the server event hub. */
  onDocumentChanged?: (key: string) => void
  scheduledPublishingMs?: number
  versionCleanup: {
    enabled: boolean
    keepAllVersionsNewerThanDays: number
    keepLatestVersionPerDayForDays: number
  }
  /** Temporary uploads past their lifetime are dropped hourly. */
  mediaFiles?: MediaFileStore
  /**
   * Drains the form workflow queue. Absent on a node that should not run them,
   * which is the same rule the other jobs follow.
   */
  formWorkflows?: WorkflowRunner
  formWorkflowsMs?: number
}

export interface ScheduledRun {
  published: string[]
  unpublished: string[]
  failed: Array<{ key: string; reason: string }>
}

export interface BackgroundJobs {
  runScheduledPublishing(now?: Date): Promise<ScheduledRun>
  /** Runs the form workflows that are due; a no-op when none are configured. */
  runFormWorkflows(now?: Date): Promise<WorkflowRunReport>
  /** Runs whether or not the hourly job is enabled; the policy decides what goes. */
  runVersionCleanup(now?: Date): Promise<{ nodes: number; versionsDeleted: number }>
  start(): void
  stop(): void
  /** Whether the timers are armed; false on a node whose role is not to run them. */
  started(): boolean
}

export function createBackgroundJobs(options: JobsOptions): BackgroundJobs {
  const documents = new DocumentRepository(options.db, {
    nodeState: options.nodeState,
    nodeId: options.nodeId,
  })
  const timers: Array<ReturnType<typeof setInterval>> = []
  let running = false

  async function runScheduledPublishing(now = new Date()): Promise<ScheduledRun> {
    const run: ScheduledRun = { published: [], unpublished: [], failed: [] }
    for (const due of await documents.dueSchedules(now)) {
      if (!(await documents.claimSchedule(due.id))) continue
      const cultures = due.culture ? [due.culture] : null
      try {
        if (due.action === 'Release') {
          await documents.publish(due.key, cultures)
          run.published.push(due.key)
        } else {
          await documents.unpublish(due.key, cultures)
          run.unpublished.push(due.key)
        }
        options.onDocumentChanged?.(due.key)
      } catch (error) {
        if (!(error instanceof PublishBlockedError)) throw error
        run.failed.push({ key: due.key, reason: error.message })
      }
    }
    if (run.published.length + run.unpublished.length > 0) options.cache.invalidate()
    return run
  }

  async function runVersionCleanup(now = new Date()) {
    return documents.cleanupVersions(now, options.versionCleanup)
  }

  async function runFormWorkflows(now = new Date()): Promise<WorkflowRunReport> {
    return (
      (await options.formWorkflows?.runDue(now)) ?? {
        claimed: 0,
        done: 0,
        retrying: 0,
        failed: 0,
      }
    )
  }

  const guarded = (job: () => Promise<unknown>) => async () => {
    if (running) return
    running = true
    try {
      await job()
    } catch (error) {
      logger('jobs').error('A background job failed', { error })
    } finally {
      running = false
    }
  }

  const every = (ms: number, job: () => Promise<unknown>) => {
    const timer = setInterval(guarded(job), ms)
    timer.unref()
    timers.push(timer)
  }

  return {
    runScheduledPublishing,
    runVersionCleanup,
    runFormWorkflows,
    start() {
      every(options.scheduledPublishingMs ?? 60_000, runScheduledPublishing)
      // More often than the other jobs: somebody waiting on a form notification
      // notices a minute, and a queue row is cheap to look for.
      if (options.formWorkflows) every(options.formWorkflowsMs ?? 15_000, runFormWorkflows)
      if (options.versionCleanup.enabled) every(60 * 60_000, runVersionCleanup)
      const files = options.mediaFiles
      if (files) every(60 * 60_000, () => files.cleanupExpired())
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer)
    },
    started() {
      return timers.length > 0
    },
  }
}
