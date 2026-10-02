/** Dictionary items: a tree of keys, each with a translation per language. */
import { normaliseUuid } from '@bunbraco/core'
import type { Db } from '../database.ts'

export interface DictionaryTranslation {
  isoCode: string
  translation: string
}

export interface DictionaryItem {
  key: string
  name: string
  parentKey: string | null
  translations: DictionaryTranslation[]
}

export type DictionaryWriteResult =
  | 'Success'
  | 'DuplicateItemKey'
  | 'DuplicateKey'
  | 'ParentNotFound'
  | 'NotFound'
  | 'InvalidParent'
  | 'InvalidLanguage'

interface Row {
  key: string
  item_key: string
  parent_key: string | null
}

export class DictionaryRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async #rows(where = '', params: unknown[] = []): Promise<Row[]> {
    return this.#db.query<Row>(
      `SELECT key, item_key, parent_key FROM dictionary_item ${where} ORDER BY item_key`,
      params,
    )
  }

  async #withTranslations(rows: Row[]): Promise<DictionaryItem[]> {
    if (rows.length === 0) return []
    const keys = rows.map((r) => normaliseUuid(String(r.key)))
    const texts = await this.#db.query<{ dictionary_key: string; iso_code: string; value: string }>(
      `SELECT t.dictionary_key, l.iso_code, t.value FROM dictionary_text t
       JOIN language l ON l.id = t.language_id
       WHERE t.dictionary_key IN (${keys.map(() => '?').join(', ')})
       ORDER BY l.iso_code`,
      keys,
    )
    return rows.map((row) => {
      const key = normaliseUuid(String(row.key))
      return {
        key,
        name: String(row.item_key),
        parentKey: row.parent_key ? normaliseUuid(String(row.parent_key)) : null,
        translations: texts
          .filter((t) => normaliseUuid(String(t.dictionary_key)) === key)
          .map((t) => ({ isoCode: String(t.iso_code), translation: String(t.value) })),
      }
    })
  }

  async get(key: string): Promise<DictionaryItem | undefined> {
    return (
      await this.#withTranslations(await this.#rows('WHERE key = ?', [normaliseUuid(key)]))
    )[0]
  }

  async byName(name: string): Promise<DictionaryItem | undefined> {
    return (await this.#withTranslations(await this.#rows('WHERE item_key = ?', [name])))[0]
  }

  async many(keys: readonly string[]): Promise<DictionaryItem[]> {
    const wanted = keys.filter((k) => /^[0-9a-f-]{32,36}$/i.test(k)).map(normaliseUuid)
    if (wanted.length === 0) return []
    return this.#withTranslations(
      await this.#rows(`WHERE key IN (${wanted.map(() => '?').join(', ')})`, wanted),
    )
  }

  /** Every item, or those whose key contains `filter`, in tree order by key. */
  async all(filter?: string): Promise<DictionaryItem[]> {
    const rows = filter
      ? await this.#rows('WHERE LOWER(item_key) LIKE ?', [`%${filter.toLowerCase()}%`])
      : await this.#rows()
    return this.#withTranslations(rows)
  }

  async children(
    parentKey: string | null,
  ): Promise<Array<{ key: string; name: string; parentKey: string | null; hasChildren: boolean }>> {
    const rows = parentKey
      ? await this.#rows('WHERE parent_key = ?', [normaliseUuid(parentKey)])
      : await this.#rows('WHERE parent_key IS NULL')
    const parents = new Set(
      (
        await this.#db.query<{ parent_key: string }>(
          'SELECT DISTINCT parent_key FROM dictionary_item WHERE parent_key IS NOT NULL',
        )
      ).map((r) => normaliseUuid(String(r.parent_key))),
    )
    return rows.map((row) => {
      const key = normaliseUuid(String(row.key))
      return {
        key,
        name: String(row.item_key),
        parentKey: row.parent_key ? normaliseUuid(String(row.parent_key)) : null,
        hasChildren: parents.has(key),
      }
    })
  }

  /** The item and its ancestors, root first. */
  async ancestry(key: string): Promise<DictionaryItem[]> {
    const chain: DictionaryItem[] = []
    let current = await this.get(key)
    while (current) {
      chain.unshift(current)
      current = current.parentKey ? await this.get(current.parentKey) : undefined
    }
    return chain
  }

  async #descendantKeys(key: string): Promise<string[]> {
    const out: string[] = []
    const queue = [normaliseUuid(key)]
    while (queue.length > 0) {
      const next = queue.shift() as string
      for (const child of await this.#rows('WHERE parent_key = ?', [next])) {
        const childKey = normaliseUuid(String(child.key))
        out.push(childKey)
        queue.push(childKey)
      }
    }
    return out
  }

  async #languageIds(
    translations: readonly DictionaryTranslation[],
  ): Promise<Map<string, number> | undefined> {
    const languages = await this.#db.query<{ id: number; iso_code: string }>(
      'SELECT id, iso_code FROM language',
    )
    const byIso = new Map(languages.map((l) => [String(l.iso_code).toLowerCase(), Number(l.id)]))
    const ids = new Map<string, number>()
    for (const t of translations) {
      const id = byIso.get(t.isoCode.toLowerCase())
      if (id === undefined) return undefined
      ids.set(t.isoCode, id)
    }
    return ids
  }

  async #writeTranslations(
    key: string,
    translations: readonly DictionaryTranslation[],
    ids: Map<string, number>,
  ): Promise<void> {
    await this.#db.exec('DELETE FROM dictionary_text WHERE dictionary_key = ?', [key])
    for (const t of translations)
      await this.#db.exec(
        'INSERT INTO dictionary_text (dictionary_key, language_id, value) VALUES (?, ?, ?)',
        [key, ids.get(t.isoCode), t.translation],
      )
  }

  async create(item: DictionaryItem): Promise<DictionaryWriteResult> {
    const key = normaliseUuid(item.key)
    return this.#db.transaction(async (tx) => {
      const repo = new DictionaryRepository(tx)
      if (await repo.get(key)) return 'DuplicateKey'
      if (await repo.byName(item.name)) return 'DuplicateItemKey'
      if (item.parentKey && !(await repo.get(item.parentKey))) return 'ParentNotFound'
      const ids = await repo.#languageIds(item.translations)
      if (!ids) return 'InvalidLanguage'
      await tx.exec('INSERT INTO dictionary_item (key, parent_key, item_key) VALUES (?, ?, ?)', [
        key,
        item.parentKey ? normaliseUuid(item.parentKey) : null,
        item.name,
      ])
      await repo.#writeTranslations(key, item.translations, ids)
      return 'Success'
    })
  }

  async update(
    key: string,
    change: { name: string; translations: readonly DictionaryTranslation[] },
  ): Promise<DictionaryWriteResult> {
    const k = normaliseUuid(key)
    return this.#db.transaction(async (tx) => {
      const repo = new DictionaryRepository(tx)
      if (!(await repo.get(k))) return 'NotFound'
      const clash = await repo.byName(change.name)
      if (clash && clash.key !== k) return 'DuplicateItemKey'
      const ids = await repo.#languageIds(change.translations)
      if (!ids) return 'InvalidLanguage'
      await tx.exec('UPDATE dictionary_item SET item_key = ? WHERE key = ?', [change.name, k])
      await repo.#writeTranslations(k, change.translations, ids)
      return 'Success'
    })
  }

  async move(key: string, parentKey: string | null): Promise<DictionaryWriteResult> {
    const k = normaliseUuid(key)
    return this.#db.transaction(async (tx) => {
      const repo = new DictionaryRepository(tx)
      if (!(await repo.get(k))) return 'NotFound'
      if (parentKey) {
        const parent = normaliseUuid(parentKey)
        if (!(await repo.get(parent))) return 'ParentNotFound'
        if (parent === k || (await repo.#descendantKeys(k)).includes(parent)) return 'InvalidParent'
      }
      await tx.exec('UPDATE dictionary_item SET parent_key = ? WHERE key = ?', [
        parentKey ? normaliseUuid(parentKey) : null,
        k,
      ])
      return 'Success'
    })
  }

  /** Deletes the item and everything below it. */
  async delete(key: string): Promise<DictionaryWriteResult> {
    const k = normaliseUuid(key)
    return this.#db.transaction(async (tx) => {
      const repo = new DictionaryRepository(tx)
      if (!(await repo.get(k))) return 'NotFound'
      const doomed = [...(await repo.#descendantKeys(k)).reverse(), k]
      for (const d of doomed) {
        await tx.exec('DELETE FROM dictionary_text WHERE dictionary_key = ?', [d])
        await tx.exec('DELETE FROM dictionary_item WHERE key = ?', [d])
      }
      return 'Success'
    })
  }

  /** Every translation, keyed by item name then iso code, for rendering. */
  async translations(): Promise<Map<string, Map<string, string>>> {
    const rows = await this.#db.query<{ item_key: string; iso_code: string; value: string }>(
      `SELECT d.item_key, l.iso_code, t.value FROM dictionary_item d
       JOIN dictionary_text t ON t.dictionary_key = d.key
       JOIN language l ON l.id = t.language_id`,
    )
    const out = new Map<string, Map<string, string>>()
    for (const row of rows) {
      const name = String(row.item_key)
      const entry = out.get(name) ?? new Map<string, string>()
      entry.set(String(row.iso_code), String(row.value))
      out.set(name, entry)
    }
    return out
  }
}
