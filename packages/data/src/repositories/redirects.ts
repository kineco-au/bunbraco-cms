/**
 * Redirects: the routes a page used to answer on, and the rules a site declares.
 *
 * Tracking writes a rule per route a publish or a move retired; the site's own
 * `redirects` config is synced into the same table so the backoffice can list
 * everything in force, and those rows are marked `config` and refuse to be
 * deleted through the API — the file owns them. A rule an administrator wrote in
 * the backoffice is `manual`, and is the only kind this repository will let a
 * bundle touch (`server/src/bundles.ts`).
 *
 * A rule is identified by what it matches (kind, pattern, hostname root and
 * culture), so re-registering a route replaces where it points instead of
 * stacking another row behind it, which is how Umbraco's "most recent wins"
 * ends up behaving without the duplicates.
 */
import { normaliseUuid } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export type RedirectMatchKind = 'exact' | 'prefix' | 'regex'
export type RedirectTargetKind = 'document' | 'path' | 'url'
/**
 * Where a rule came from, and — because `ORDER` sorts on this column — its
 * precedence: `config` before `manual` before `tracked`, which is alphabetical
 * and so needs no CASE expression. That order is the intent, not a coincidence:
 * a rule in the site's code outranks one an administrator typed, which outranks
 * one a rename recorded by itself.
 */
export type RedirectSource = 'tracked' | 'config' | 'manual'

export interface RedirectRow {
  key: string
  source: RedirectSource
  matchKind: RedirectMatchKind
  pattern: string
  rootKey: string | null
  culture: string | null
  targetKind: RedirectTargetKind
  target: string
  statusCode: number
  sortOrder: number
  createDate: Date
}

/** A rule to store; `key` and `createDate` are assigned when it is new. */
export type RedirectInput = Omit<RedirectRow, 'key' | 'createDate'>

interface Row {
  key: string
  source: string
  match_kind: string
  pattern: string
  root_key: string | null
  culture: string | null
  target_kind: string
  target: string
  status_code: number
  sort_order: number
  create_date: unknown
}

const SELECT = `SELECT key, source, match_kind, pattern, root_key, culture,
                       target_kind, target, status_code, sort_order, create_date
                  FROM redirect_url`

/** By source — see `RedirectSource` — then by the rule's own order, newest first. */
const ORDER = 'ORDER BY source, sort_order, create_date DESC, id DESC'

const hydrate = (row: Row): RedirectRow => ({
  key: normaliseUuid(String(row.key)),
  source: String(row.source) as RedirectSource,
  matchKind: String(row.match_kind) as RedirectMatchKind,
  pattern: String(row.pattern),
  rootKey: row.root_key === null ? null : String(row.root_key),
  culture: row.culture === null ? null : String(row.culture),
  targetKind: String(row.target_kind) as RedirectTargetKind,
  target: String(row.target),
  statusCode: Number(row.status_code),
  sortOrder: Number(row.sort_order),
  createDate: DbDate.fromDb(row.create_date) ?? new Date(0),
})

/** A digest of everything a rule matches on; see migration 015. */
export function matchHash(input: {
  source: RedirectSource
  matchKind: RedirectMatchKind
  pattern: string
  rootKey: string | null
  culture: string | null
}): string {
  const parts = [
    input.source,
    input.matchKind,
    input.pattern,
    input.rootKey ?? '',
    (input.culture ?? '').toLowerCase(),
  ]
  return new Bun.CryptoHasher('sha256').update(parts.join('\u0000')).digest('hex')
}

export class RedirectRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  /** Every rule, in the order they are matched. */
  async all(): Promise<RedirectRow[]> {
    const rows = await this.#db.query<Row>(`${SELECT} ${ORDER}`)
    return rows.map(hydrate)
  }

  async byKey(key: string): Promise<RedirectRow | undefined> {
    const rows = await this.#db.query<Row>(`${SELECT} WHERE key = ?`, [normaliseUuid(key)])
    return rows[0] ? hydrate(rows[0]) : undefined
  }

  /**
   * A page of rules, newest first, optionally filtered on either URL. Umbraco's
   * dashboard searches the original URL; matching the destination too costs
   * nothing and is what someone auditing "where does this page get traffic
   * from" actually wants.
   */
  async list(options: { filter?: string; skip?: number; take?: number } = {}): Promise<{
    total: number
    items: RedirectRow[]
  }> {
    const filter = options.filter?.trim().toLowerCase()
    const where = filter ? 'WHERE LOWER(pattern) LIKE ? OR LOWER(target) LIKE ?' : ''
    const params = filter ? [`%${filter}%`, `%${filter}%`] : []
    const counted = await this.#db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM redirect_url ${where}`,
      params,
    )
    const rows = await this.#db.query<Row>(`${SELECT} ${where} ${ORDER} LIMIT ? OFFSET ?`, [
      ...params,
      options.take ?? 100,
      options.skip ?? 0,
    ])
    return { total: Number(counted[0]?.total ?? 0), items: rows.map(hydrate) }
  }

  /** The rules pointing at one document, newest first. */
  async byDocument(
    documentKey: string,
    options: { skip?: number; take?: number } = {},
  ): Promise<{ total: number; items: RedirectRow[] }> {
    const target = normaliseUuid(documentKey)
    const where = "WHERE target_kind = 'document' AND LOWER(target) = ?"
    const counted = await this.#db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM redirect_url ${where}`,
      [target],
    )
    const rows = await this.#db.query<Row>(`${SELECT} ${where} ${ORDER} LIMIT ? OFFSET ?`, [
      target,
      options.take ?? 100,
      options.skip ?? 0,
    ])
    return { total: Number(counted[0]?.total ?? 0), items: rows.map(hydrate) }
  }

  /**
   * Stores a rule, replacing any existing one matching the same thing. The
   * returned row carries the key, which is a fresh one only when the rule is new.
   */
  async save(input: RedirectInput): Promise<RedirectRow> {
    const hash = matchHash(input)
    const now = new Date()
    return this.#db.transaction(async (tx) => {
      const existing = await tx.query<{ key: string }>(
        'SELECT key FROM redirect_url WHERE match_hash = ?',
        [hash],
      )
      if (existing[0]) {
        const key = normaliseUuid(String(existing[0].key))
        await tx.exec(
          `UPDATE redirect_url
              SET target_kind = ?, target = ?, status_code = ?, sort_order = ?, create_date = ?
            WHERE key = ?`,
          [
            input.targetKind,
            input.target,
            input.statusCode,
            input.sortOrder,
            DbDate.toDb(now),
            key,
          ],
        )
        return { ...input, key, createDate: now }
      }
      const key = crypto.randomUUID()
      await tx.exec(
        `INSERT INTO redirect_url
           (key, source, match_kind, pattern, root_key, culture,
            target_kind, target, status_code, sort_order, match_hash, create_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          input.source,
          input.matchKind,
          input.pattern,
          input.rootKey,
          input.culture,
          input.targetKind,
          input.target,
          input.statusCode,
          input.sortOrder,
          hash,
          DbDate.toDb(now),
        ],
      )
      return { ...input, key, createDate: now }
    })
  }

  /** Deletes one rule. `false` means there was nothing with that key. */
  async delete(key: string): Promise<boolean> {
    const found = await this.byKey(key)
    if (!found) return false
    await this.#db.exec('DELETE FROM redirect_url WHERE key = ?', [normaliseUuid(key)])
    return true
  }

  /**
   * Drops any rule that matches `path` under `rootKey` and points at this
   * document — the case where a page was renamed and then renamed back, which
   * would otherwise leave a rule redirecting a live URL to itself.
   */
  async removeSelfReferencing(
    documentKey: string,
    rootKey: string | null,
    path: string,
  ): Promise<void> {
    await this.#db.exec(
      `DELETE FROM redirect_url
        WHERE source = 'tracked' AND target_kind = 'document'
          AND LOWER(target) = ? AND match_kind = 'exact' AND LOWER(pattern) = ?
          AND ${rootKey === null ? 'root_key IS NULL' : 'root_key = ?'}`,
      rootKey === null
        ? [normaliseUuid(documentKey), path.toLowerCase()]
        : [normaliseUuid(documentKey), path.toLowerCase(), rootKey],
    )
  }

  /**
   * Brings the `config` rows into line with the site's configuration: the ones
   * it still declares are stored in order, and any left over from a previous
   * boot are removed. Tracked rows are untouched.
   */
  async syncConfigured(inputs: readonly Omit<RedirectInput, 'source' | 'sortOrder'>[]): Promise<{
    stored: number
    removed: number
  }> {
    const kept = new Set<string>()
    let sortOrder = 0
    for (const input of inputs) {
      const rule: RedirectInput = { ...input, source: 'config', sortOrder: sortOrder++ }
      kept.add(matchHash(rule))
      await this.save(rule)
    }
    const stale = await this.#db.query<{ match_hash: string }>(
      "SELECT match_hash FROM redirect_url WHERE source = 'config'",
    )
    let removed = 0
    for (const row of stale) {
      const hash = String(row.match_hash)
      if (kept.has(hash)) continue
      await this.#db.exec('DELETE FROM redirect_url WHERE match_hash = ?', [hash])
      removed += 1
    }
    return { stored: kept.size, removed }
  }
}
