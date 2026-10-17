/**
 * Background jobs, as Umbraco runs them: scheduled publishing every minute and
 * version cleanup every hour when it is enabled, plus the search indexer
 * draining its queue, the audit log ageing out old entries hourly, and the
 * form, webhook and content notification queues. Each run can also be called
 * directly, which is how tests drive them. Every node that owns writes (`all`
 * and `api`) runs them; each schedule and queued item is claimed atomically, so
 * it runs once.
 */

import type { NodeSchemaState } from '@crombolo/data'
import {
  AuditLog,
  type Db,
  DocumentRepository,
  PublishBlockedError,
  SearchIndex,
} from '@crombolo/data'
import type { PublishedCache } from '@crombolo/render'
import { auditRetainedSince, recordAudit } from './adapters/audit.ts'
import type {
  ContentNotificationRunner,
  ContentNotificationRunReport,
  ContentNotifier,
} from './content-notifications.ts'
import type { WorkflowRunner, WorkflowRunReport } from './form-workflows.ts'
import { logger } from './logging.ts'
import type { MediaFileStore } from './media-files.ts'
import type { WebhookService } from './webhooks.ts'

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
  /** Raises the publishes scheduled publishing makes, and drains the delivery queue. */
  webhooks?: Pick<WebhookService, 'raise' | 'runDue'>
  webhooksMs?: number
  /** How often the search indexer looks for queued items; a write here also starts it at once. */
  searchIndexingMs?: number
  /** Days the audit log keeps an entry; 0 or absent keeps them forever. */
  auditRetentionDays?: number
  /** Content notifications (story 045): queued by changes, sent here. Absent without e-mail. */
  contentNotifications?: ContentNotificationRunner
  contentNotificationsMs?: number
  /** Queues the notifications scheduled publishing makes, as an editor's publish does. */
  notifier?: ContentNotifier
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
  /** Delivers the webhook and bundle events that are due. */
  runWebhooks(now?: Date): Promise<WorkflowRunReport>
  /** Sends the content notifications that are due (story 045). */
  runContentNotifications(now?: Date): Promise<ContentNotificationRunReport>
  /** Indexes every queued item, and returns how many. docs/search.md. */
  runSearchIndexing(): Promise<number>
  /** Something was queued here: index it shortly, rather than at the next tick. */
  kickSearchIndexing(): void
  /** Deletes audit entries older than the retention period, and returns how many. */
  runAuditRetention(now?: Date): Promise<number>
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
  const search = new SearchIndex(options.db)
  let indexing: Promise<number> | undefined
  let kicked: ReturnType<typeof setTimeout> | undefined

  async function runScheduledPublishing(now = new Date()): Promise<ScheduledRun> {
    const run: ScheduledRun = { published: [], unpublished: [], failed: [] }
    for (const due of await documents.dueSchedules(now)) {
      if (!(await documents.claimSchedule(due.id))) continue
      const cultures = due.culture ? [due.culture] : null
      try {
        const release = due.action === 'Release'
        const changed = release
          ? await documents.publish(due.key, cultures)
          : await documents.unpublish(due.key, cultures)
        ;(release ? run.published : run.unpublished).push(due.key)
        await recordAudit(options.db, {
          category: 'content',
          action: release ? 'Publish' : 'Unpublish',
          source: 'job',
          entityType: 'Document',
          entityKey: due.key,
          entityName: changed?.variants[0]?.name ?? null,
          detail: `Scheduled${due.culture ? ` (${due.culture})` : ''}`,
        })
        options.onDocumentChanged?.(due.key)
      } catch (error) {
        if (!(error instanceof PublishBlockedError)) throw error
        run.failed.push({ key: due.key, reason: error.message })
      }
    }
    if (run.published.length + run.unpublished.length > 0) options.cache.invalidate()
    for (const key of run.published) {
      await options.webhooks?.raise({ alias: 'Umbraco.ContentPublish', key })
      await options.notifier?.raise(
        { actions: ['Umb.Document.Publish'], key, keyKind: 'document' },
        { key: null, name: 'The schedule' },
        'scheduled',
      )
    }
    for (const key of run.unpublished)
      await options.webhooks?.raise({ alias: 'Umbraco.ContentUnpublish', key })
    return run
  }

  async function runContentNotifications(now = new Date()): Promise<ContentNotificationRunReport> {
    const runner = options.contentNotifications
    return runner ? runner.runDue(now) : { claimed: 0, sent: 0, skipped: 0, retrying: 0, failed: 0 }
  }

  async function runAuditRetention(now = new Date()): Promise<number> {
    const before = auditRetainedSince(options.auditRetentionDays ?? 0, now)
    return before ? new AuditLog(options.db).prune(before) : 0
  }

  async function runVersionCleanup(now = new Date()) {
    return documents.cleanupVersions(now, options.versionCleanup)
  }

  async function runWebhooks(now = new Date()): Promise<WorkflowRunReport> {
    return (await options.webhooks?.runDue(now)) ?? { claimed: 0, done: 0, retrying: 0, failed: 0 }
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

  // Its own guard rather than `guarded`: indexing a big rebuild must not hold up
  // a scheduled publish, and a kick while it runs joins the run in progress.
  function runSearchIndexing(): Promise<number> {
    indexing ??= search.indexAll().finally(() => {
      indexing = undefined
    })
    return indexing
  }

  const indexQuietly = () =>
    runSearchIndexing().catch((error: unknown) => {
      logger('jobs').error('Search indexing failed', { error })
    })

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
    runAuditRetention,
    runFormWorkflows,
    runWebhooks,
    runContentNotifications,
    runSearchIndexing,
    kickSearchIndexing() {
      if (timers.length === 0 || kicked) return
      kicked = setTimeout(() => {
        kicked = undefined
        void indexQuietly()
      }, 250)
      kicked.unref()
    },
    start() {
      every(options.scheduledPublishingMs ?? 60_000, runScheduledPublishing)
      // The queue is shared, so this also picks up what other nodes wrote.
      const searchTimer = setInterval(indexQuietly, options.searchIndexingMs ?? 5_000)
      searchTimer.unref()
      timers.push(searchTimer)
      // More often than the other jobs: somebody waiting on a form notification
      // notices a minute, and a queue row is cheap to look for.
      if (options.formWorkflows) every(options.formWorkflowsMs ?? 15_000, runFormWorkflows)
      // As often, for the same reason: a receiver that is waiting notices a minute.
      if (options.webhooks) every(options.webhooksMs ?? 15_000, runWebhooks)
      // A digest waits a minute anyway; this is how soon after that it goes.
      const notifications = options.contentNotifications
      if (notifications) {
        every(options.contentNotificationsMs ?? 15_000, runContentNotifications)
        every(60 * 60_000, () => notifications.prune(new Date(Date.now() - 30 * 86_400_000)))
      }
      if (options.versionCleanup.enabled) every(60 * 60_000, runVersionCleanup)
      if (options.auditRetentionDays) every(60 * 60_000, runAuditRetention)
      const files = options.mediaFiles
      if (files) every(60 * 60_000, () => files.cleanupExpired())
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer)
      if (kicked) clearTimeout(kicked)
      kicked = undefined
    },
    started() {
      return timers.length > 0
    },
  }
}
