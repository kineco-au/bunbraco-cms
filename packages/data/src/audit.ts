/**
 * The audit log: who did what, when and from where. Entries are only ever
 * added, read and aged out; nothing edits one. docs/audit-log.md.
 */
import { normaliseUuid } from '@crombolo/core'
import type { Db } from './database.ts'
import { DbDate } from './dialect.ts'
import { STATE_AUDIT_LOG } from './schema/audit-log.ts'

export type AuditCategory =
  | 'content'
  | 'media'
  | 'member'
  | 'schema'
  | 'settings'
  | 'user'
  | 'permission'
  | 'sign-in'
  | 'system'

export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'content',
  'media',
  'member',
  'schema',
  'settings',
  'user',
  'permission',
  'sign-in',
  'system',
]

/** Where an entry came from: a request (with its address), the command line, or a background job. */
export type AuditSource = 'request' | 'cli' | 'job'

export interface AuditEntryInput {
  category: AuditCategory
  action: string
  source: AuditSource
  userKey?: string | null
  /** The user's name when the entry was written; for a failed sign-in, the login tried. */
  userName?: string | null
  entityType?: string | null
  entityKey?: string | null
  entityName?: string | null
  ipAddress?: string | null
  forwardedFor?: string | null
  detail?: string | null
  occurredAt?: Date
}

export interface AuditEntry {
  id: number
  occurredAt: Date
  category: AuditCategory
  action: string
  source: AuditSource
  userKey: string | null
  userName: string | null
  entityType: string | null
  entityKey: string | null
  entityName: string | null
  ipAddress: string | null
  forwardedFor: string | null
  detail: string | null
}

export interface AuditFilter {
  userKey?: string
  entityKey?: string
  category?: AuditCategory
  action?: string
  since?: Date
  until?: Date
  /** Matched anywhere in the item's name or key, or the user's name. */
  text?: string
  ascending?: boolean
}

/** What a key names, for an entry to carry once the thing itself has gone. */
export interface AuditSubject {
  entityType: string
  entityKey: string
  entityName: string | null
}

const UUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i

const LIMITS = {
  action: 64,
  userName: 255,
  entityType: 64,
  entityKey: 255,
  entityName: 255,
  ipAddress: 64,
  forwardedFor: 255,
  detail: 4000,
} as const

function clip(value: string | null | undefined, limit: number): string | null {
  if (value === null || value === undefined || value === '') return null
  return value.length > limit ? value.slice(0, limit) : value
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function toEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: Number(row.id),
    occurredAt: DbDate.fromDb(row.occurred_at) ?? new Date(0),
    category: String(row.category) as AuditCategory,
    action: String(row.action),
    source: String(row.source) as AuditSource,
    userKey: row.user_key ? normaliseUuid(String(row.user_key)) : null,
    userName: text(row.user_name),
    entityType: text(row.entity_type),
    entityKey: text(row.entity_key),
    entityName: text(row.entity_name),
    ipAddress: text(row.ip_address),
    forwardedFor: text(row.forwarded_for),
    detail: text(row.detail),
  }
}

export class AuditLog {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async record(entries: AuditEntryInput | readonly AuditEntryInput[]): Promise<void> {
    const list = Array.isArray(entries) ? entries : [entries as AuditEntryInput]
    for (const entry of list) {
      const userKey =
        entry.userKey && UUID.test(entry.userKey) ? normaliseUuid(entry.userKey) : null
      const entityKey =
        entry.entityKey && UUID.test(entry.entityKey)
          ? normaliseUuid(entry.entityKey)
          : entry.entityKey
      await this.#db.exec(
        `INSERT INTO audit_entry (occurred_at, category, action, user_key, user_name, entity_type,
           entity_key, entity_name, source, ip_address, forwarded_for, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          DbDate.toDb(entry.occurredAt ?? new Date()),
          entry.category,
          clip(entry.action, LIMITS.action),
          userKey,
          clip(entry.userName, LIMITS.userName),
          clip(entry.entityType, LIMITS.entityType),
          clip(entityKey, LIMITS.entityKey),
          clip(entry.entityName, LIMITS.entityName),
          entry.source,
          clip(entry.ipAddress, LIMITS.ipAddress),
          clip(entry.forwardedFor, LIMITS.forwardedFor),
          clip(entry.detail, LIMITS.detail),
        ],
      )
    }
  }

  async query(
    filter: AuditFilter = {},
    page: { skip: number; take: number } = { skip: 0, take: 100 },
  ): Promise<{ total: number; items: AuditEntry[] }> {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.userKey !== undefined) {
      if (!UUID.test(filter.userKey)) return { total: 0, items: [] }
      where.push('user_key = ?')
      params.push(normaliseUuid(filter.userKey))
    }
    if (filter.entityKey !== undefined) {
      where.push('entity_key = ?')
      params.push(UUID.test(filter.entityKey) ? normaliseUuid(filter.entityKey) : filter.entityKey)
    }
    if (filter.category !== undefined) {
      where.push('category = ?')
      params.push(filter.category)
    }
    if (filter.action !== undefined) {
      where.push('action = ?')
      params.push(filter.action)
    }
    if (filter.since !== undefined) {
      where.push('occurred_at >= ?')
      params.push(DbDate.toDb(filter.since))
    }
    if (filter.until !== undefined) {
      where.push('occurred_at < ?')
      params.push(DbDate.toDb(filter.until))
    }
    const needle = filter.text?.trim().toLowerCase()
    if (needle) {
      const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push(
        `(LOWER(entity_name) LIKE ? ESCAPE '\\' OR LOWER(entity_key) LIKE ? ESCAPE '\\' OR LOWER(user_name) LIKE ? ESCAPE '\\')`,
      )
      params.push(like, like, like)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const counted = await this.#db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM audit_entry ${clause}`,
      params,
    )
    const order = filter.ascending ? 'ASC' : 'DESC'
    const rows = await this.#db.query(
      `SELECT * FROM audit_entry ${clause} ORDER BY occurred_at ${order}, id ${order} LIMIT ? OFFSET ?`,
      [...params, page.take, page.skip],
    )
    return { total: Number(counted[0]?.total ?? 0), items: rows.map(toEntry) }
  }

  /** Everyone the log names, by the name they had most recently. */
  async users(): Promise<Array<{ key: string; name: string }>> {
    const rows = await this.#db.query<{ user_key: string; user_name: string | null }>(
      `SELECT e.user_key, e.user_name FROM audit_entry e
       JOIN (SELECT user_key, MAX(id) AS id FROM audit_entry WHERE user_key IS NOT NULL GROUP BY user_key) latest
         ON latest.id = e.id
       ORDER BY e.user_name`,
    )
    return rows.map((row) => ({
      key: normaliseUuid(String(row.user_key)),
      name: row.user_name ? String(row.user_name) : '',
    }))
  }

  /** Deletes entries older than `before`, and returns how many went. */
  async prune(before: Date): Promise<number> {
    const counted = await this.#db.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM audit_entry WHERE occurred_at < ?',
      [DbDate.toDb(before)],
    )
    const total = Number(counted[0]?.total ?? 0)
    if (total > 0)
      await this.#db.exec('DELETE FROM audit_entry WHERE occurred_at < ?', [DbDate.toDb(before)])
    return total
  }

  /** When this database began keeping the log; history before it is in the content versions. */
  async startedAt(): Promise<Date | undefined> {
    const rows = await this.#db.query<{ applied_at: unknown }>(
      'SELECT MIN(applied_at) AS applied_at FROM migration_history WHERE to_state = ?',
      [STATE_AUDIT_LOG],
    )
    return DbDate.fromDb(rows[0]?.applied_at)
  }

  /**
   * What a key names. A version answers for the item it belongs to, so a
   * rollback is filed under the page it rolled back.
   */
  async describe(entityType: string, key: string): Promise<AuditSubject> {
    const named = (entityName: unknown, type = entityType, entityKey = key): AuditSubject => ({
      entityType: type,
      entityKey,
      entityName: entityName === null || entityName === undefined ? null : String(entityName),
    })
    if (entityType.endsWith('Version') && /^\d+$/.test(key)) {
      const rows = await this.#db.query<{ unique_id: string; text: string | null }>(
        'SELECT n.unique_id, n.text FROM content_version cv JOIN node n ON n.id = cv.node_id WHERE cv.id = ?',
        [Number(key)],
      )
      const row = rows[0]
      const owner = entityType.slice(0, -'Version'.length)
      return row ? named(row.text, owner, normaliseUuid(String(row.unique_id))) : named(null)
    }
    if (entityType === 'Language') {
      const rows = await this.#db.query<{ culture_name: string }>(
        'SELECT culture_name FROM language WHERE iso_code = ?',
        [key],
      )
      return named(rows[0]?.culture_name ?? null)
    }
    if (!UUID.test(key)) return named(null)
    const uuid = normaliseUuid(key)
    const sql =
      entityType === 'User'
        ? 'SELECT user_name AS name FROM user_account WHERE key = ?'
        : entityType === 'UserGroup'
          ? 'SELECT name FROM user_group WHERE key = ?'
          : entityType === 'DictionaryItem'
            ? 'SELECT item_key AS name FROM dictionary_item WHERE key = ?'
            : 'SELECT text AS name FROM node WHERE unique_id = ?'
    const rows = await this.#db.query<{ name: string | null }>(sql, [uuid])
    return named(rows[0]?.name ?? null, entityType, uuid)
  }
}
