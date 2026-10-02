/** Languages, keyed by ISO code. Never deletes: content may reference a language. */
import type { Db } from '../database.ts'
import { fromDbBool } from '../dialect.ts'

export interface LanguageModel {
  isoCode: string
  cultureName: string
  isDefault: boolean
  isMandatory: boolean
  fallbackIsoCode: string | null
}

export class LanguageRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  async all(): Promise<LanguageModel[]> {
    const rows = await this.#db.query(
      `SELECT l.iso_code, l.culture_name, l.is_default, l.is_mandatory, f.iso_code AS fallback
       FROM language l LEFT JOIN language f ON f.id = l.fallback_language_id ORDER BY l.id`,
    )
    return rows.map((row) => ({
      isoCode: String(row.iso_code),
      cultureName: String(row.culture_name),
      isDefault: fromDbBool(row.is_default),
      isMandatory: fromDbBool(row.is_mandatory),
      fallbackIsoCode: (row.fallback as string | null) ?? null,
    }))
  }

  async byIso(isoCode: string): Promise<LanguageModel | undefined> {
    return (await this.all()).find((l) => l.isoCode.toLowerCase() === isoCode.toLowerCase())
  }

  /** Saves one language; making it the default unmakes the previous one. */
  async save(language: LanguageModel): Promise<LanguageModel> {
    const bool = (v: boolean) => this.#db.dialect.boolValue(v)
    if (language.isDefault)
      await this.#db.exec('UPDATE language SET is_default = ? WHERE iso_code <> ?', [
        bool(false),
        language.isoCode,
      ])
    await this.upsertAll([language])
    return (await this.byIso(language.isoCode)) as LanguageModel
  }

  /** Never the default, and never one another language falls back to. */
  async delete(isoCode: string): Promise<'deleted' | 'default' | 'in-use' | 'not-found'> {
    const language = await this.byIso(isoCode)
    if (!language) return 'not-found'
    if (language.isDefault) return 'default'
    if ((await this.all()).some((l) => l.fallbackIsoCode === language.isoCode)) return 'in-use'
    await this.#db.exec('DELETE FROM language WHERE iso_code = ?', [language.isoCode])
    return 'deleted'
  }

  /** Inserts or updates by ISO code; fallbacks are resolved after every row exists. */
  async upsertAll(
    languages: readonly LanguageModel[],
  ): Promise<{ created: number; updated: number }> {
    let created = 0
    let updated = 0
    const bool = (v: boolean) => this.#db.dialect.boolValue(v)
    for (const language of languages) {
      const existing = await this.#db.query<{ id: number }>(
        'SELECT id FROM language WHERE iso_code = ?',
        [language.isoCode],
      )
      if (existing[0]) {
        await this.#db.exec(
          'UPDATE language SET culture_name = ?, is_default = ?, is_mandatory = ? WHERE id = ?',
          [
            language.cultureName,
            bool(language.isDefault),
            bool(language.isMandatory),
            Number(existing[0].id),
          ],
        )
        updated += 1
      } else {
        await this.#db.exec(
          'INSERT INTO language (iso_code, culture_name, is_default, is_mandatory) VALUES (?, ?, ?, ?)',
          [
            language.isoCode,
            language.cultureName,
            bool(language.isDefault),
            bool(language.isMandatory),
          ],
        )
        created += 1
      }
    }
    for (const language of languages) {
      const fallback = language.fallbackIsoCode
        ? await this.#db.query<{ id: number }>('SELECT id FROM language WHERE iso_code = ?', [
            language.fallbackIsoCode,
          ])
        : []
      await this.#db.exec('UPDATE language SET fallback_language_id = ? WHERE iso_code = ?', [
        fallback[0] ? Number(fallback[0].id) : null,
        language.isoCode,
      ])
    }
    return { created, updated }
  }
}
