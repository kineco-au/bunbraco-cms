/**
 * Form entries: what visitors submitted. `docs/18-forms.md`.
 *
 * Keyed by the form's UUID rather than a foreign key, because the definition is
 * a file. An entry outlives its definition on purpose.
 *
 * Values are stored as text whatever the field collects — a number as its
 * decimal string, a checkbox as `true`/`false`, a multiple choice as one row
 * per selection. The field type in the definition says how to read it back,
 * which keeps this table free of a type column that could disagree with the
 * file.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'

/** Where an entry is in its life: approval is the only transition. */
export type FormEntryState = 'submitted' | 'approved' | 'rejected'

export const FORM_ENTRY_STATES: readonly FormEntryState[] = ['submitted', 'approved', 'rejected']

export interface FormEntryValue {
  fieldAlias: string
  /** One row per selection for a multi-value field, in the order submitted. */
  values: string[]
}

export interface FormEntry {
  id: string
  formKey: string
  /** The alias the form had when this was submitted, for an orphaned entry. */
  formAlias: string
  state: FormEntryState
  culture: string | null
  /** The page the form was submitted from, when it was on one. */
  pageKey: string | null
  /** A salted hash, never an address: enough to rate-limit, not a liability. */
  ipHash: string | null
  userAgent: string | null
  spam: boolean
  createDate: Date
  updateDate: Date
  values: FormEntryValue[]
}

export type FormEntryInput = Omit<
  FormEntry,
  'id' | 'createDate' | 'updateDate' | 'state' | 'spam'
> & {
  state?: FormEntryState
  spam?: boolean
}

export interface FormEntryQuery {
  formKey: string
  state?: FormEntryState
  /** Inclusive; the entries view defaults to the last month. */
  from?: Date
  to?: Date
  /** Matched against any value, which is what the list's search box does. */
  search?: string
  includeSpam?: boolean
  skip?: number
  take?: number
}

interface EntryRow {
  id: string
  form_key: string
  form_alias: string
  state: string
  culture: string | null
  page_key: string | null
  ip_hash: string | null
  user_agent: string | null
  spam: unknown
  create_date: unknown
  update_date: unknown
}

interface ValueRow {
  entry_id: string
  field_alias: string
  sort_order: number
  value: string | null
}

const SELECT = `SELECT id, form_key, form_alias, state, culture, page_key, ip_hash,
                       user_agent, spam, create_date, update_date
                  FROM form_entry`

const state = (value: string): FormEntryState =>
  FORM_ENTRY_STATES.includes(value as FormEntryState) ? (value as FormEntryState) : 'submitted'

const hydrate = (row: EntryRow, values: FormEntryValue[]): FormEntry => ({
  id: row.id,
  formKey: row.form_key,
  formAlias: row.form_alias,
  state: state(row.state),
  culture: row.culture,
  pageKey: row.page_key,
  ipHash: row.ip_hash,
  userAgent: row.user_agent,
  spam: fromDbBool(row.spam),
  createDate: DbDate.fromDb(row.create_date) ?? new Date(0),
  updateDate: DbDate.fromDb(row.update_date) ?? new Date(0),
  values,
})

/** Value rows into one entry per id, each field's selections in order. */
function group(rows: readonly ValueRow[]): Map<string, FormEntryValue[]> {
  const byEntry = new Map<string, Map<string, string[]>>()
  for (const row of rows) {
    const fields = byEntry.get(row.entry_id) ?? new Map<string, string[]>()
    byEntry.set(row.entry_id, fields)
    const values = fields.get(row.field_alias) ?? []
    fields.set(row.field_alias, values)
    values.push(row.value ?? '')
  }
  const out = new Map<string, FormEntryValue[]>()
  for (const [id, fields] of byEntry)
    out.set(
      id,
      [...fields].map(([fieldAlias, values]) => ({ fieldAlias, values })),
    )
  return out
}

export class FormEntryRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  /** The values for a page of entries, in one query rather than one each. */
  async #valuesFor(ids: readonly string[]): Promise<Map<string, FormEntryValue[]>> {
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(', ')
    const rows = await this.#db.query<ValueRow>(
      `SELECT entry_id, field_alias, sort_order, value
         FROM form_entry_value
        WHERE entry_id IN (${placeholders})
        ORDER BY field_alias, sort_order`,
      [...ids],
    )
    return group(rows)
  }

  async byId(id: string): Promise<FormEntry | undefined> {
    const rows = await this.#db.query<EntryRow>(`${SELECT} WHERE id = ?`, [id])
    const row = rows[0]
    if (!row) return undefined
    return hydrate(row, (await this.#valuesFor([id])).get(id) ?? [])
  }

  async list(query: FormEntryQuery): Promise<{ total: number; items: FormEntry[] }> {
    const where: string[] = ['form_key = ?']
    const params: unknown[] = [query.formKey]
    if (query.state) {
      where.push('state = ?')
      params.push(query.state)
    }
    if (query.from) {
      where.push('create_date >= ?')
      params.push(DbDate.toDb(query.from))
    }
    if (query.to) {
      where.push('create_date <= ?')
      params.push(DbDate.toDb(query.to))
    }
    // Spam is stored and flagged rather than dropped — a false positive that
    // silently discarded an enquiry is worse than one to review — so it is
    // hidden from the list by default rather than absent from the table.
    if (!query.includeSpam) {
      where.push('spam = ?')
      params.push(this.#db.dialect.boolValue(false))
    }
    if (query.search) {
      where.push(`id IN (SELECT entry_id FROM form_entry_value WHERE LOWER(value) LIKE ?)`)
      params.push(`%${query.search.toLowerCase()}%`)
    }
    const clause = `WHERE ${where.join(' AND ')}`

    const counted = await this.#db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM form_entry ${clause}`,
      params,
    )
    const rows = await this.#db.query<EntryRow>(
      `${SELECT} ${clause} ORDER BY create_date DESC, id LIMIT ? OFFSET ?`,
      [...params, query.take ?? 100, query.skip ?? 0],
    )
    const values = await this.#valuesFor(rows.map((row) => row.id))
    return {
      total: Number(counted[0]?.total ?? 0),
      items: rows.map((row) => hydrate(row, values.get(row.id) ?? [])),
    }
  }

  /** How many entries a form has, for a form with a hard cap. */
  async count(formKey: string, options: { includeSpam?: boolean } = {}): Promise<number> {
    const rows = options.includeSpam
      ? await this.#db.query<{ total: number }>(
          'SELECT COUNT(*) AS total FROM form_entry WHERE form_key = ?',
          [formKey],
        )
      : await this.#db.query<{ total: number }>(
          'SELECT COUNT(*) AS total FROM form_entry WHERE form_key = ? AND spam = ?',
          [formKey, this.#db.dialect.boolValue(false)],
        )
    return Number(rows[0]?.total ?? 0)
  }

  async create(input: FormEntryInput, id: string = randomUUID()): Promise<FormEntry> {
    const now = new Date()
    await this.#db.exec(
      `INSERT INTO form_entry
         (id, form_key, form_alias, state, culture, page_key, ip_hash, user_agent,
          spam, create_date, update_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.formKey,
        input.formAlias,
        input.state ?? 'submitted',
        input.culture,
        input.pageKey,
        input.ipHash,
        input.userAgent,
        this.#db.dialect.boolValue(input.spam ?? false),
        DbDate.toDb(now),
        DbDate.toDb(now),
      ],
    )
    await this.#writeValues(id, input.values)
    return (await this.byId(id)) as FormEntry
  }

  async #writeValues(id: string, values: readonly FormEntryValue[]): Promise<void> {
    for (const value of values) {
      // An empty list still means "this field was answered with nothing", which
      // is different from the field being absent; one empty row records it.
      const list = value.values.length === 0 ? [''] : value.values
      for (const [sort, text] of list.entries())
        await this.#db.exec(
          `INSERT INTO form_entry_value (entry_id, field_alias, sort_order, value)
           VALUES (?, ?, ?, ?)`,
          [id, value.fieldAlias, sort, text],
        )
    }
  }

  /**
   * Approve or reject. Returns undefined when there is no such entry, so a
   * caller can tell "gone" from "done".
   */
  async setState(id: string, next: FormEntryState): Promise<FormEntry | undefined> {
    const existing = await this.byId(id)
    if (!existing) return undefined
    await this.#db.exec('UPDATE form_entry SET state = ?, update_date = ? WHERE id = ?', [
      next,
      DbDate.toDb(new Date()),
      id,
    ])
    return this.byId(id)
  }

  /** Marks an entry as spam, or clears the mark after a person looked. */
  async setSpam(id: string, spam: boolean): Promise<FormEntry | undefined> {
    const existing = await this.byId(id)
    if (!existing) return undefined
    await this.#db.exec('UPDATE form_entry SET spam = ?, update_date = ? WHERE id = ?', [
      this.#db.dialect.boolValue(spam),
      DbDate.toDb(new Date()),
      id,
    ])
    return this.byId(id)
  }

  /** Replaces an entry's values, for the backoffice's edit of one. */
  async setValues(id: string, values: readonly FormEntryValue[]): Promise<FormEntry | undefined> {
    const existing = await this.byId(id)
    if (!existing) return undefined
    await this.#db.exec('DELETE FROM form_entry_value WHERE entry_id = ?', [id])
    await this.#writeValues(id, values)
    await this.#db.exec('UPDATE form_entry SET update_date = ? WHERE id = ?', [
      DbDate.toDb(new Date()),
      id,
    ])
    return this.byId(id)
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.byId(id)
    if (!existing) return false
    // Explicit rather than relying on the cascade: SQLite enforces foreign keys
    // only when the pragma is on, and this must not depend on that.
    await this.#db.exec('DELETE FROM form_entry_value WHERE entry_id = ?', [id])
    await this.#db.exec('DELETE FROM form_entry WHERE id = ?', [id])
    return true
  }

  /** Every form that has entries, with how many — including orphaned ones. */
  async forms(): Promise<{ formKey: string; formAlias: string; total: number }[]> {
    const rows = await this.#db.query<{ form_key: string; form_alias: string; total: number }>(
      `SELECT form_key, MAX(form_alias) AS form_alias, COUNT(*) AS total
         FROM form_entry GROUP BY form_key ORDER BY MAX(form_alias)`,
    )
    return rows.map((row) => ({
      formKey: row.form_key,
      formAlias: row.form_alias,
      total: Number(row.total),
    }))
  }
}
