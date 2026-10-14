/**
 * The audit log's ports: where the router writes, what an item's Info tab reads,
 * and the Settings dashboard's endpoint. docs/audit-log.md.
 */
import type { AuditHistoryPort, AuditSink } from '@crombolo/api-management'
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditEntry,
  type AuditEntryInput,
  AuditLog,
  type Db,
} from '@crombolo/data'
import { logger } from '../logging.ts'

const log = logger('Audit')

/** The oldest moment the log still keeps, or undefined when it keeps everything. */
export function auditRetainedSince(retentionDays: number, now = new Date()): Date | undefined {
  return retentionDays > 0 ? new Date(now.getTime() - retentionDays * 86_400_000) : undefined
}

/**
 * Writes an entry without ever failing what it records: the change has already
 * been made by the time it is written, so a failure here is logged, not raised.
 */
export async function recordAudit(
  db: Db,
  entries: AuditEntryInput | readonly AuditEntryInput[],
): Promise<void> {
  try {
    await new AuditLog(db).record(entries)
  } catch (error) {
    log.error('Could not write to the audit log: {error}', { error })
  }
}

export function createAuditSink(db: Db): AuditSink {
  const audit = new AuditLog(db)
  return {
    async describe(entityType, key) {
      try {
        return await audit.describe(entityType, key)
      } catch (error) {
        log.warning('Could not name {entityType} {key} for the audit log: {error}', {
          entityType,
          key,
          error,
        })
        return { entityType, entityKey: key, entityName: null }
      }
    },
    record: (entries) =>
      recordAudit(
        db,
        entries.map((entry) => ({ ...entry, source: 'request' as const })),
      ),
  }
}

export function createAuditHistory(db: Db, retentionDays: number): AuditHistoryPort {
  const audit = new AuditLog(db)
  let started: Date | undefined
  return {
    async forItem(key) {
      const { items } = await audit.query({ entityKey: key }, { skip: 0, take: 10_000 })
      return items
    },
    async startedAt() {
      started ??= await audit.startedAt()
      return started
    },
    retainedSince: () => auditRetainedSince(retentionDays),
  }
}

function toResponse(entry: AuditEntry) {
  return {
    id: entry.id,
    occurredAt: entry.occurredAt.toISOString(),
    category: entry.category,
    action: entry.action,
    source: entry.source,
    user: entry.userKey || entry.userName ? { key: entry.userKey, name: entry.userName } : null,
    item: entry.entityType
      ? { type: entry.entityType, key: entry.entityKey, name: entry.entityName }
      : null,
    ipAddress: entry.ipAddress,
    forwardedFor: entry.forwardedFor,
    detail: entry.detail,
  }
}

function dateParam(value: string | null): Date | undefined | null {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const badRequest = (detail: string) =>
  Response.json({ title: 'Invalid request', status: 400, detail }, { status: 400 })

/**
 * The Settings dashboard's reads: `GET /` lists entries, newest first, filtered
 * by user, item, category, action, date and text; `GET /users` names everyone in
 * the log. Nothing here writes, so an entry cannot be changed through it.
 */
export function createAuditHost(db: Db, retentionDays: number) {
  const audit = new AuditLog(db)
  return {
    async handle(request: Request, pathname: string): Promise<Response | undefined> {
      if (pathname !== '' && pathname !== '/' && pathname !== '/users') return undefined
      if (request.method !== 'GET')
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } })
      if (pathname === '/users') return Response.json({ items: await audit.users() })

      const search = new URL(request.url).searchParams
      const skip = Number(search.get('skip') ?? 0)
      const take = Number(search.get('take') ?? 50)
      if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(take) || take < 1 || take > 500)
        return badRequest('skip must be 0 or more, and take between 1 and 500.')
      const category = search.get('category') ?? undefined
      if (category && !AUDIT_CATEGORIES.includes(category as AuditCategory))
        return badRequest(`There is no category "${category}".`)
      const since = dateParam(search.get('since'))
      const until = dateParam(search.get('until'))
      if (since === null || until === null) return badRequest('since and until must be dates.')
      const result = await audit.query(
        {
          userKey: search.get('user') ?? undefined,
          entityKey: search.get('item') ?? undefined,
          category: category as AuditCategory | undefined,
          action: search.get('action') ?? undefined,
          since,
          until,
          text: search.get('text') ?? undefined,
        },
        { skip, take },
      )
      return Response.json({
        total: result.total,
        retentionDays,
        items: result.items.map(toResponse),
      })
    },
  }
}

const VERB: Record<string, string> = {
  POST: 'Create',
  PUT: 'Save',
  PATCH: 'Save',
  DELETE: 'Delete',
}

/** Crombolo's own endpoints that change something, by their first segment. */
const PLUGIN_AREAS: Record<string, { category: AuditCategory; entityType: string }> = {
  'schema-import': { category: 'schema', entityType: 'Schema' },
  git: { category: 'schema', entityType: 'Schema' },
  seo: { category: 'settings', entityType: 'SeoSettings' },
  bundles: { category: 'system', entityType: 'Bundle' },
  forms: { category: 'content', entityType: 'Form' },
}

const PLUGIN_ACTIONS: Record<string, string> = {
  'schema-import': 'Import',
  'git/commit': 'Commit',
  'bundles/install': 'Install',
  'bundles/uninstall': 'Uninstall',
}

/** The entry for a write to `<plugin>/api/<subpath>`: the area it is in, and what it did there. */
export function pluginAuditPlan(
  method: string,
  subpath: string,
): Pick<AuditEntryInput, 'category' | 'action' | 'entityType' | 'entityKey' | 'detail'> {
  const [area = '', ...rest] = subpath.split('/')
  const known = PLUGIN_AREAS[area]
  return {
    category: known?.category ?? 'settings',
    entityType: known?.entityType ?? area,
    action: PLUGIN_ACTIONS[subpath] ?? VERB[method] ?? method,
    entityKey: rest.length > 0 ? rest.join('/') : null,
    detail: `${method} ${subpath}`,
  }
}
