/** The dictionary port over the repository, with `.udt` import and export. */
import type { DictionaryPort } from '@bunbraco/api-management'
import { type Db, DictionaryRepository } from '@bunbraco/data'
import { importDictionaryUdt } from '../dictionary-transfer.ts'
import type { MediaFileStore } from '../media-files.ts'
import { readUdt, type UdtItem, writeUdt } from '../udt.ts'

export function createDictionaryPort(
  db: Db,
  files: MediaFileStore,
  options: { onChange?: () => void } = {},
): DictionaryPort {
  const repo = new DictionaryRepository(db)
  const changed = <T>(result: T): T => {
    if (result === 'Success') options.onChange?.()
    return result
  }

  async function toUdt(key: string, includeChildren: boolean): Promise<UdtItem | undefined> {
    const item = await repo.get(key)
    if (!item) return undefined
    const children: UdtItem[] = []
    if (includeChildren)
      for (const child of await repo.children(item.key)) {
        const nested = await toUdt(child.key, true)
        if (nested) children.push(nested)
      }
    return { key: item.key, name: item.name, translations: item.translations, children }
  }

  return {
    all: (filter) => repo.all(filter),
    get: (key) => repo.get(key),
    items: (keys) => repo.many(keys),
    children: (parentKey) => repo.children(parentKey),
    ancestry: (key) => repo.ancestry(key),
    create: async (item) => changed(await repo.create(item)),
    update: async (key, change) => changed(await repo.update(key, change)),
    move: async (key, parentKey) => changed(await repo.move(key, parentKey)),
    delete: async (key) => changed(await repo.delete(key)),

    async export(key, includeChildren) {
      const item = await toUdt(key, includeChildren)
      if (!item) return undefined
      return { fileName: `${item.name}.udt`, content: writeUdt(item) }
    },

    async import(temporaryFileId, parentKey) {
      const upload = await files.readTemporary(temporaryFileId)
      if (!upload)
        return { ok: false, status: 'NotFound', reason: 'The uploaded file has expired.' }
      if (!upload.fileName.toLowerCase().endsWith('.udt'))
        return { ok: false, status: 'Invalid', reason: 'Only .udt files can be imported.' }
      const text = new TextDecoder().decode(upload.bytes)
      // The reader is consulted first only so a malformed file and an absent
      // parent keep the distinct statuses the contract names for them.
      const items = readUdt(text)
      if (!items)
        return { ok: false, status: 'Invalid', reason: 'The file is not a dictionary export.' }
      if (parentKey && !(await repo.get(parentKey)))
        return { ok: false, status: 'ParentNotFound', reason: 'The parent item does not exist.' }

      // The same implementation `bunbraco dictionary import` uses.
      const outcome = await importDictionaryUdt(db, text, parentKey ?? null)
      await files.deleteTemporary(temporaryFileId)
      if (!outcome.ok)
        return {
          ok: false,
          status: 'Invalid',
          reason: 'No item in the file could be imported: its name is already in use.',
        }
      options.onChange?.()
      return { ok: true, key: items[0]?.key as string }
    },
  }
}
