/**
 * An item's audit log, for the Info tab of pages, media, elements and
 * blueprints. It answers from the audit log; for the time before the log
 * began, the item's versions stand in, as they did before there was one.
 * docs/audit-log.md.
 */
import type { DocumentVersionSummary } from '@crombolo/core'
import { invalidSkipTake, problemResponse } from '@crombolo/core'
import type { AuditHistoryPort } from '../ports.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { paging } from './content-type.ts'

interface VersionSource {
  versions(key: string): Promise<DocumentVersionSummary[]>
  systemUserKey(): Promise<string | null>
}

const VERSION_TYPE = {
  save: 'Save',
  publish: 'Publish',
  rollback: 'RollBack',
  migrate: 'System',
} as const

/** The Info tab's names for what an entry records; anything else is `Custom`, with the action as its comment. */
const ACTION_TYPE: Record<string, string> = {
  Create: 'New',
  CreateAndPublish: 'Publish',
  Save: 'Save',
  Publish: 'Publish',
  SaveAndPublish: 'Publish',
  PublishWithDescendants: 'Publish',
  Unpublish: 'Unpublish',
  Move: 'Move',
  Trash: 'Move',
  Restore: 'Move',
  Copy: 'Copy',
  Sort: 'Sort',
  Delete: 'Delete',
  AssignDomains: 'AssignDomain',
  SetPublicAccess: 'PublicAccess',
  AddPublicAccess: 'PublicAccess',
  RemovePublicAccess: 'PublicAccess',
  SetNotifications: 'Notify',
  Rollback: 'RollBack',
  PreventCleanup: 'ContentVersionPreventCleanup',
}

const COMMENT: Record<string, string> = {
  Trash: 'Moved to the recycle bin',
  Restore: 'Restored from the recycle bin',
  PublishWithDescendants: 'Published with its descendants',
}

interface Line {
  user: string | null
  timestamp: Date
  logType: string
  comment: string | null
}

/** The log for one item, paged and filtered as the contract asks. */
export async function auditLogResponse(
  ctx: RequestContext,
  source: VersionSource,
  history: AuditHistoryPort | undefined,
): Promise<Response> {
  const page = paging(ctx)
  if (!page) return problemResponse(invalidSkipTake())
  const key = ctx.params.id as string
  const since = ctx.url.searchParams.get('sinceDate')
  const sinceTime = since ? Date.parse(since) : Number.NaN
  const fallbackUser = await source.systemUserKey()

  const started = await history?.startedAt()
  const retained = history?.retainedSince()
  const lines: Line[] = (await source.versions(key))
    .filter((v) => !started || v.versionDate < started)
    .filter((v) => !retained || v.versionDate >= retained)
    .map((v) => ({
      user: v.userKey,
      timestamp: v.versionDate,
      logType: VERSION_TYPE[v.kind ?? 'save'],
      comment: null,
    }))
  for (const entry of (await history?.forItem(key)) ?? [])
    lines.push({
      user: entry.userKey,
      timestamp: entry.occurredAt,
      logType: ACTION_TYPE[entry.action] ?? 'Custom',
      comment: COMMENT[entry.action] ?? (ACTION_TYPE[entry.action] ? entry.detail : entry.action),
    })

  let shown = Number.isNaN(sinceTime)
    ? lines
    : lines.filter((l) => l.timestamp.getTime() >= sinceTime)
  shown = shown.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  if (ctx.url.searchParams.get('orderDirection') === 'Ascending') shown = shown.reverse()
  return Response.json({
    total: shown.length,
    items: shown.slice(page.skip, page.skip + page.take).map((line) => ({
      user: { id: line.user ?? fallbackUser },
      timestamp: line.timestamp.toISOString(),
      logType: line.logType,
      comment: line.comment,
      parameters: null,
    })),
  })
}

export function registerAuditLogHandlers(
  router: ManagementApiRouter,
  sources: {
    documents?: VersionSource
    media?: VersionSource
    elements?: VersionSource
    blueprints?: VersionSource
  },
  history: AuditHistoryPort | undefined,
): void {
  const { documents, media, elements, blueprints } = sources
  if (documents)
    router.handle('GetDocumentByIdAuditLog', (ctx) => auditLogResponse(ctx, documents, history))
  if (media) router.handle('GetMediaByIdAuditLog', (ctx) => auditLogResponse(ctx, media, history))
  if (elements)
    router.handle('GetElementByIdAuditLog', (ctx) => auditLogResponse(ctx, elements, history))
  if (blueprints)
    router.handle('GetDocumentBlueprintByIdAuditLog', (ctx) =>
      auditLogResponse(ctx, blueprints, history),
    )
}
