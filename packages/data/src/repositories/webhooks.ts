/**
 * Webhooks kept in this environment, and the delivery queue and log every
 * webhook and bundle event handler shares. docs/webhooks.md.
 *
 * A delivery is claimed with `UPDATE … WHERE state = 'pending' … RETURNING`, as
 * form workflows are, so on a cluster exactly one node delivers each.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'

export interface WebhookRow {
  key: string
  name: string | null
  description: string | null
  url: string
  enabled: boolean
  events: string[]
  contentTypeKeys: string[]
  /** The headers as one sealed value; the server holds the key that opens it. */
  sealedHeaders: string | null
}

const parseList = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

export class WebhookRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  async all(): Promise<WebhookRow[]> {
    const rows = await this.#db.query(
      'SELECT key, name, description, url, enabled, events, content_type_keys, headers FROM webhook ORDER BY create_date, key',
    )
    return rows.map((row) => ({
      key: String(row.key),
      name: (row.name as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      url: String(row.url),
      enabled: fromDbBool(row.enabled),
      events: parseList(row.events),
      contentTypeKeys: parseList(row.content_type_keys),
      sealedHeaders: (row.headers as string | null) ?? null,
    }))
  }

  async byKey(key: string): Promise<WebhookRow | undefined> {
    return (await this.all()).find((row) => row.key === key.toLowerCase())
  }

  async save(webhook: WebhookRow): Promise<void> {
    const now = DbDate.toDb(new Date())
    const values = [
      webhook.name,
      webhook.description,
      webhook.url,
      this.#db.dialect.boolValue(webhook.enabled),
      JSON.stringify(webhook.events),
      JSON.stringify(webhook.contentTypeKeys),
      webhook.sealedHeaders,
      now,
    ]
    const updated = await this.#db.query(
      `UPDATE webhook SET name = ?, description = ?, url = ?, enabled = ?, events = ?,
              content_type_keys = ?, headers = ?, update_date = ?
        WHERE key = ? RETURNING key`,
      [...values, webhook.key.toLowerCase()],
    )
    if (updated.length > 0) return
    await this.#db.exec(
      `INSERT INTO webhook (name, description, url, enabled, events, content_type_keys, headers,
                            update_date, key, create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, webhook.key.toLowerCase(), now],
    )
  }

  async remove(key: string): Promise<boolean> {
    const rows = await this.#db.query('DELETE FROM webhook WHERE key = ? RETURNING key', [
      key.toLowerCase(),
    ])
    return rows.length > 0
  }
}

export type WebhookDeliveryState = 'pending' | 'running' | 'done' | 'failed'

export interface WebhookDelivery {
  id: string
  /** A webhook's key, or `bundle:<id>` for a bundle's handler. */
  subscriber: string
  eventAlias: string
  payload: unknown
  state: WebhookDeliveryState
  attempts: number
  lastError: string | null
  runAfter: Date
  createDate: Date
}

export interface WebhookLogEntry {
  key: string
  deliveryId: string
  subscriber: string
  eventAlias: string
  url: string
  statusCode: number | null
  success: boolean
  exception: boolean
  retryCount: number
  requestHeaders: string
  requestBody: string
  responseHeaders: string
  responseBody: string
  date: Date
}

const DELIVERY_COLUMNS =
  'id, subscriber, event_alias, payload, state, attempts, last_error, run_after, create_date'

const hydrateDelivery = (row: Record<string, unknown>): WebhookDelivery => {
  let payload: unknown = null
  try {
    payload = JSON.parse(String(row.payload))
  } catch {
    payload = null
  }
  return {
    id: String(row.id),
    subscriber: String(row.subscriber),
    eventAlias: String(row.event_alias),
    payload,
    state: String(row.state) as WebhookDeliveryState,
    attempts: Number(row.attempts),
    lastError: (row.last_error as string | null) ?? null,
    runAfter: DbDate.fromDb(row.run_after) ?? new Date(0),
    createDate: DbDate.fromDb(row.create_date) ?? new Date(0),
  }
}

/** Bodies and headers are kept to what a person will read, not what a server sent. */
const clip = (value: string) => value.slice(0, 10_000)

export class WebhookDeliveryRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  async enqueue(
    deliveries: ReadonlyArray<{ subscriber: string; eventAlias: string; payload: unknown }>,
    now = new Date(),
  ): Promise<string[]> {
    const ids: string[] = []
    for (const delivery of deliveries) {
      const id = randomUUID()
      await this.#db.exec(
        `INSERT INTO webhook_delivery (${DELIVERY_COLUMNS}, update_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          delivery.subscriber,
          delivery.eventAlias,
          JSON.stringify(delivery.payload),
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

  async due(now = new Date(), limit = 25): Promise<WebhookDelivery[]> {
    const rows = await this.#db.query(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_delivery WHERE state = ? AND run_after <= ?
        ORDER BY run_after, create_date LIMIT ?`,
      ['pending', DbDate.toDb(now), limit],
    )
    return rows.map(hydrateDelivery)
  }

  /** Takes a delivery, or finds another node already has. */
  async claim(id: string): Promise<WebhookDelivery | undefined> {
    const rows = await this.#db.query(
      `UPDATE webhook_delivery SET state = ?, attempts = attempts + 1, update_date = ?
        WHERE id = ? AND state = ? RETURNING ${DELIVERY_COLUMNS}`,
      ['running', DbDate.toDb(new Date()), id, 'pending'],
    )
    return rows[0] ? hydrateDelivery(rows[0]) : undefined
  }

  async succeed(id: string): Promise<void> {
    await this.#db.exec(
      'UPDATE webhook_delivery SET state = ?, last_error = NULL, update_date = ? WHERE id = ?',
      ['done', DbDate.toDb(new Date()), id],
    )
  }

  /** `retryAt` puts it back in the queue; without one it has failed for good. */
  async fail(id: string, error: string, retryAt?: Date): Promise<void> {
    await this.#db.exec(
      'UPDATE webhook_delivery SET state = ?, last_error = ?, run_after = ?, update_date = ? WHERE id = ?',
      [
        retryAt ? 'pending' : 'failed',
        error.slice(0, 2000),
        DbDate.toDb(retryAt ?? new Date()),
        DbDate.toDb(new Date()),
        id,
      ],
    )
  }

  async byId(id: string): Promise<WebhookDelivery | undefined> {
    const rows = await this.#db.query(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_delivery WHERE id = ?`,
      [id],
    )
    return rows[0] ? hydrateDelivery(rows[0]) : undefined
  }

  async log(entry: Omit<WebhookLogEntry, 'key' | 'date'>, date = new Date()): Promise<void> {
    await this.#db.exec(
      `INSERT INTO webhook_log (key, delivery_id, subscriber, event_alias, url, status_code, success,
         exception, retry_count, request_headers, request_body, response_headers, response_body, log_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        entry.deliveryId,
        entry.subscriber,
        entry.eventAlias,
        entry.url,
        entry.statusCode,
        this.#db.dialect.boolValue(entry.success),
        this.#db.dialect.boolValue(entry.exception),
        entry.retryCount,
        clip(entry.requestHeaders),
        clip(entry.requestBody),
        clip(entry.responseHeaders),
        clip(entry.responseBody),
        DbDate.toDb(date),
      ],
    )
  }

  /** The log, newest first; one subscriber's when named. */
  async logs(options: {
    subscriber?: string
    skip: number
    take: number
  }): Promise<{ total: number; items: WebhookLogEntry[] }> {
    const where = options.subscriber ? 'WHERE subscriber = ?' : ''
    const params = options.subscriber ? [options.subscriber] : []
    const total = await this.#db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM webhook_log ${where}`,
      params,
    )
    const rows = await this.#db.query(
      `SELECT key, delivery_id, subscriber, event_alias, url, status_code, success, exception,
              retry_count, request_headers, request_body, response_headers, response_body, log_date
         FROM webhook_log ${where} ORDER BY log_date DESC, retry_count DESC, key LIMIT ? OFFSET ?`,
      [...params, options.take, options.skip],
    )
    return {
      total: Number(total[0]?.n ?? 0),
      items: rows.map((row) => ({
        key: String(row.key),
        deliveryId: String(row.delivery_id),
        subscriber: String(row.subscriber),
        eventAlias: String(row.event_alias),
        url: String(row.url),
        statusCode:
          row.status_code === null || row.status_code === undefined
            ? null
            : Number(row.status_code),
        success: fromDbBool(row.success),
        exception: fromDbBool(row.exception),
        retryCount: Number(row.retry_count),
        requestHeaders: String(row.request_headers),
        requestBody: String(row.request_body),
        responseHeaders: String(row.response_headers),
        responseBody: String(row.response_body),
        date: DbDate.fromDb(row.log_date) ?? new Date(0),
      })),
    }
  }
}
