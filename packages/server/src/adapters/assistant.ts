/**
 * Changeset persistence for the assistant, over the tables migration 017 adds.
 *
 * A proposal has to outlive the conversation that produced it: one raised over
 * MCP by an agent in a terminal is reviewed in the backoffice by a person in a
 * browser, in another process. `body` and `params` are stored as JSON because
 * they are a prepared Management API request and nothing here inspects them —
 * only the approval path, which dispatches them.
 */
import type {
  ChangeOrigin,
  ChangeStatus,
  Changeset,
  ChangesetStore,
  ProposedChange,
} from '@bunbraco/assistant'
import { normaliseUuid } from '@bunbraco/core'
import { type Db, DbDate } from '@bunbraco/data'

interface ChangesetRow {
  key: string
  user_key: string
  title: string
  origin: string
  create_date: unknown
  update_date: unknown
}

interface ChangeRow {
  key: string
  kind: string
  summary: string
  status: string
  params: string
  body: string
  baseline: string | null
  problems: string
  error: string | null
  create_date: unknown
}

const iso = (value: unknown): string => (DbDate.fromDb(value) ?? new Date(0)).toISOString()

const parse = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const hydrateChange = (row: ChangeRow): ProposedChange => ({
  key: normaliseUuid(String(row.key)),
  kind: String(row.kind) as ProposedChange['kind'],
  summary: String(row.summary),
  params: parse<Record<string, string>>(String(row.params), {}),
  body: parse<unknown>(String(row.body), null),
  baseline: row.baseline === null ? undefined : String(row.baseline),
  problems: parse<ProposedChange['problems']>(String(row.problems), []),
  status: String(row.status) as ChangeStatus,
  error: row.error === null ? undefined : String(row.error),
  createDate: iso(row.create_date),
})

export function createChangesetStore(db: Db): ChangesetStore {
  const changesOf = async (changesetKey: string): Promise<ProposedChange[]> => {
    const rows = await db.query<ChangeRow>(
      `SELECT key, kind, summary, status, params, body, baseline, problems, error, create_date
         FROM assistant_change WHERE changeset_key = ? ORDER BY sort_order, id`,
      [changesetKey],
    )
    return rows.map(hydrateChange)
  }

  const hydrate = async (row: ChangesetRow): Promise<Changeset> => ({
    key: normaliseUuid(String(row.key)),
    userKey: normaliseUuid(String(row.user_key)),
    title: String(row.title),
    origin: String(row.origin) as ChangeOrigin,
    changes: await changesOf(normaliseUuid(String(row.key))),
    createDate: iso(row.create_date),
    updateDate: iso(row.update_date),
  })

  const touch = (key: string) =>
    db.exec('UPDATE assistant_changeset SET update_date = ? WHERE key = ?', [
      DbDate.toDb(new Date()),
      key,
    ])

  return {
    async create(input) {
      const key = normaliseUuid(crypto.randomUUID())
      const now = new Date()
      await db.exec(
        `INSERT INTO assistant_changeset (key, user_key, title, origin, create_date, update_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          key,
          normaliseUuid(input.userKey),
          input.title,
          input.origin,
          DbDate.toDb(now),
          DbDate.toDb(now),
        ],
      )
      return {
        key,
        userKey: normaliseUuid(input.userKey),
        title: input.title,
        origin: input.origin,
        changes: [],
        createDate: now.toISOString(),
        updateDate: now.toISOString(),
      }
    },

    async load(key) {
      const rows = await db.query<ChangesetRow>(
        `SELECT key, user_key, title, origin, create_date, update_date
           FROM assistant_changeset WHERE key = ?`,
        [normaliseUuid(key)],
      )
      return rows[0] ? await hydrate(rows[0]) : undefined
    },

    async listFor(userKey, limit = 20) {
      const rows = await db.query<ChangesetRow>(
        `SELECT key, user_key, title, origin, create_date, update_date
           FROM assistant_changeset WHERE user_key = ?
          ORDER BY update_date DESC, id DESC LIMIT ?`,
        [normaliseUuid(userKey), limit],
      )
      const out: Changeset[] = []
      for (const row of rows) out.push(await hydrate(row))
      return out
    },

    async changeFor(userKey, changeKey) {
      const rows = await db.query<ChangeRow>(
        `SELECT c.key, c.kind, c.summary, c.status, c.params, c.body, c.baseline, c.problems,
                c.error, c.create_date
           FROM assistant_change c
           JOIN assistant_changeset s ON s.key = c.changeset_key
          WHERE c.key = ? AND s.user_key = ?`,
        [normaliseUuid(changeKey), normaliseUuid(userKey)],
      )
      return rows[0] ? hydrateChange(rows[0]) : undefined
    },

    async openFor(userKey, origin) {
      const rows = await db.query<ChangesetRow>(
        `SELECT s.key, s.user_key, s.title, s.origin, s.create_date, s.update_date
           FROM assistant_changeset s
          WHERE s.user_key = ? AND s.origin = ?
            AND EXISTS (SELECT 1 FROM assistant_change c
                         WHERE c.changeset_key = s.key AND c.status = 'proposed')
          ORDER BY s.update_date DESC, s.id DESC LIMIT 1`,
        [normaliseUuid(userKey), origin],
      )
      return rows[0] ? await hydrate(rows[0]) : undefined
    },

    async append(changesetKey, change) {
      const key = normaliseUuid(changesetKey)
      const counted = await db.query<{ next: number | null }>(
        'SELECT MAX(sort_order) AS next FROM assistant_change WHERE changeset_key = ?',
        [key],
      )
      const sortOrder = (counted[0]?.next ?? -1) + 1
      await db.exec(
        `INSERT INTO assistant_change
           (key, changeset_key, sort_order, kind, summary, status, params, body, baseline, problems, error, create_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normaliseUuid(change.key),
          key,
          sortOrder,
          change.kind,
          change.summary,
          change.status,
          JSON.stringify(change.params),
          JSON.stringify(change.body ?? null),
          change.baseline ?? null,
          JSON.stringify(change.problems),
          change.error ?? null,
          DbDate.toDb(new Date(change.createDate)),
        ],
      )
      await touch(key)
    },

    async replaceBody(changeKey, body, problems) {
      const key = normaliseUuid(changeKey)
      await db.exec('UPDATE assistant_change SET body = ?, problems = ? WHERE key = ?', [
        JSON.stringify(body ?? null),
        JSON.stringify(problems),
        key,
      ])
      const rows = await db.query<{ changeset_key: string }>(
        'SELECT changeset_key FROM assistant_change WHERE key = ?',
        [key],
      )
      const owner = rows[0]?.changeset_key
      if (owner) await touch(String(owner))
    },

    async settle(changeKey, outcome) {
      const key = normaliseUuid(changeKey)
      await db.exec('UPDATE assistant_change SET status = ?, error = ? WHERE key = ?', [
        outcome.status,
        outcome.error ?? null,
        key,
      ])
      const rows = await db.query<{ changeset_key: string }>(
        'SELECT changeset_key FROM assistant_change WHERE key = ?',
        [key],
      )
      const owner = rows[0]?.changeset_key
      if (owner) await touch(String(owner))
    },

    async remove(key) {
      const owner = normaliseUuid(key)
      await db.exec('DELETE FROM assistant_change WHERE changeset_key = ?', [owner])
      await db.exec('DELETE FROM assistant_changeset WHERE key = ?', [owner])
    },
  }
}
