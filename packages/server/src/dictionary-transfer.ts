/**
 * Dictionary items as a `.udt` file, for seeding one environment from another.
 *
 * `09-schema-as-code.md` leaves the dictionary in the database rather than in
 * `schema/`, because translators work in production where the schema files are
 * read-only — and promises this pair of commands as the way a lower environment
 * gets the translations.
 *
 * The logic was already in the Management API adapter, tied to a temporary
 * upload. It lives here so the endpoint and the CLI share one implementation:
 * the same `.udt` format Umbraco uses, the same upsert by key, and the same rule
 * that translations for languages this site does not have are skipped.
 */
import { type Db, DictionaryRepository } from '@bunbraco/data'
import { readUdt, type UdtItem, writeUdtAll } from './udt.ts'

export interface DictionaryImportOutcome {
  ok: boolean
  reason?: string
  /** Items written, counting nested children. */
  imported: number
  /** Translations dropped because this environment has no such language. */
  skipped: string[]
}

/**
 * One item and its children as `.udt`, or the whole dictionary when no key is
 * given. `children()` returns a lighter row than the item itself, so each one
 * is read back for its translations.
 */
export async function dictionaryToUdt(
  repo: DictionaryRepository,
  key?: string,
): Promise<UdtItem[]> {
  const toUdt = async (itemKey: string): Promise<UdtItem | undefined> => {
    const item = await repo.get(itemKey)
    if (!item) return undefined
    const children: UdtItem[] = []
    for (const child of await repo.children(item.key)) {
      const nested = await toUdt(child.key)
      if (nested) children.push(nested)
    }
    return { key: item.key, name: item.name, translations: item.translations, children }
  }
  if (key) {
    const item = await toUdt(key)
    return item ? [item] : []
  }
  const roots: UdtItem[] = []
  for (const root of await repo.children(null)) {
    const item = await toUdt(root.key)
    if (item) roots.push(item)
  }
  return roots
}

export const writeDictionaryUdt = writeUdtAll

/**
 * Applies a `.udt` file. Items are upserted by key, so running it twice is a
 * no-op and an item translated here keeps any language the file does not carry.
 */
export async function importDictionaryUdt(
  db: Db,
  text: string,
  parentKey: string | null = null,
): Promise<DictionaryImportOutcome> {
  const repo = new DictionaryRepository(db)
  const items = readUdt(text)
  if (!items) return { ok: false, reason: 'not a dictionary export', imported: 0, skipped: [] }
  if (parentKey && !(await repo.get(parentKey)))
    return { ok: false, reason: 'the parent item does not exist', imported: 0, skipped: [] }

  const languages = new Set(
    (await db.query<{ iso_code: string }>('SELECT iso_code FROM language')).map((row) =>
      String(row.iso_code).toLowerCase(),
    ),
  )
  const skipped = new Set<string>()
  // As Umbraco does: a translation for a language this site has not got is
  // dropped rather than refused, so a partial language set still imports.
  const known = (item: UdtItem) =>
    item.translations.filter((t) => {
      if (languages.has(t.isoCode.toLowerCase())) return true
      skipped.add(t.isoCode)
      return false
    })

  let imported = 0
  const save = async (item: UdtItem, parent: string | null): Promise<void> => {
    const existing = await repo.get(item.key)
    const mine = known(item)
    const result = existing
      ? await repo.update(item.key, {
          name: existing.name,
          translations: [
            ...existing.translations.filter(
              (t) => !mine.some((n) => n.isoCode.toLowerCase() === t.isoCode.toLowerCase()),
            ),
            ...mine,
          ],
        })
      : await repo.create({
          key: item.key,
          name: item.name,
          parentKey: parent,
          translations: mine,
        })
    if (result !== 'Success') return
    imported += 1
    for (const child of item.children) await save(child, item.key)
  }

  for (const item of items) await save(item, parentKey)
  return imported > 0
    ? { ok: true, imported, skipped: [...skipped] }
    : {
        ok: false,
        reason: 'nothing in the file could be imported: a name is already in use',
        imported: 0,
        skipped: [...skipped],
      }
}
