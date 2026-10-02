/**
 * The Media section: items stored as documents of the media object type (the
 * repository takes a kind), never published. An item's file is the path its
 * `umbracoFile` holds, served from the media root; deleting an item for good
 * deletes its file too.
 */
import type { MediaPort, Principal } from '@bunbraco/api-management'
import {
  type ContentTypeAggregate,
  DEFAULT_UPLOAD_SETTINGS,
  type DocumentAggregate,
  IMAGE_CROPPER_EDITOR_ALIAS,
  normaliseUuid,
  ObjectTypes,
} from '@bunbraco/core'
import {
  appendCacheInstruction,
  ContentTypeRepository,
  DataTypeRepository,
  type Db,
  DocumentRepository,
  type NodeRow,
  type NodeSchemaState,
  type ValueIntake,
  WriteRejectedError,
} from '@bunbraco/data'
import { TemporaryFileMissingError } from '../file-intake.ts'
import type { MediaFileStore } from '../media-files.ts'

/** The file path an item's `umbracoFile` holds, whether an upload or a cropper value. */
export function mediaFileOf(media: DocumentAggregate): string | null {
  const value = media.values.find((v) => v.alias === 'umbracoFile')?.value
  if (typeof value === 'string') return value || null
  const src = (value as { src?: unknown } | null | undefined)?.src
  return typeof src === 'string' && src ? src : null
}

export function createMediaPort(
  db: Db,
  files: MediaFileStore,
  options: {
    nodeState?: NodeSchemaState
    nodeId?: string
    valueIntake?: ValueIntake
    /** Told after every change, so pages that show media refresh. */
    onChange?: () => void | Promise<void>
  } = {},
): MediaPort {
  const changed = async () => {
    await appendCacheInstruction(db, {
      kind: 'content',
      payload: { media: true },
      by: options.nodeId,
    })
    await options.onChange?.()
  }
  const repo = new DocumentRepository(db, { ...options, kind: 'media' })

  const userIdOf = async (principal: Principal): Promise<number | undefined> => {
    const rows = await db.query<{ id: number }>('SELECT id FROM user_account WHERE key = ?', [
      principal.id,
    ])
    return rows[0] ? Number(rows[0].id) : undefined
  }
  const failure = (error: unknown) => {
    if (error instanceof WriteRejectedError)
      return { ok: false as const, reason: error.message, status: 409 }
    if (error instanceof TemporaryFileMissingError)
      return { ok: false as const, reason: error.message, status: 400 }
    throw error
  }
  const notFound = (what = 'The media item could not be found.') => ({
    ok: false as const,
    reason: what,
    status: 404,
  })
  const tree = async (rows: readonly NodeRow[]) => repo.treeItems(rows)
  const mediaTypes = new ContentTypeRepository(db, { kind: 'media' })
  const dataTypes = new DataTypeRepository(db)

  /** Every media type with the data type of its `umbracoFile`, compositions included. */
  const mediaTypesWithFile = async () => {
    const all = await mediaTypes.all()
    const byKey = new Map(all.map((t) => [t.key, t]))
    const fileOf = (type: ContentTypeAggregate, seen = new Set<string>()): string | undefined => {
      if (seen.has(type.key)) return undefined
      seen.add(type.key)
      const own = type.properties.find((p) => p.alias === 'umbracoFile')?.dataTypeKey
      if (own) return own
      for (const c of type.compositions) {
        const composed = byKey.get(c.contentTypeKey)
        const found = composed ? fileOf(composed, seen) : undefined
        if (found) return found
      }
      return undefined
    }
    const result = []
    for (const type of all) {
      const dataTypeKey = fileOf(type)
      result.push({ type, file: dataTypeKey ? await dataTypes.byKey(dataTypeKey) : undefined })
    }
    return result
  }
  const allowedExtensions = (values: ReadonlyArray<{ alias: string; value: unknown }>) => {
    const raw = values.find((v) => v.alias === 'fileExtensions')?.value
    if (!Array.isArray(raw)) return []
    return raw
      .map((e) => (typeof e === 'string' ? e : (e as { value?: unknown })?.value))
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.replace(/^\./, '').toLowerCase())
  }

  /** Every file in a branch, gathered before the branch is deleted. */
  const filesIn = async (key: string): Promise<string[]> => {
    const root = await repo.nodes.byKey(key)
    if (!root) return []
    const rows = await db.query<{ unique_id: string }>(
      'SELECT unique_id FROM node WHERE (id = ? OR path LIKE ?) AND node_object_type = ?',
      [root.id, `${root.path},%`, ObjectTypes.Media],
    )
    const found: string[] = []
    for (const row of rows) {
      const media = await repo.byKey(normaliseUuid(String(row.unique_id)))
      const file = media ? mediaFileOf(media) : null
      if (file) found.push(file)
    }
    return found
  }
  const removeBranch = async (key: string) => {
    const paths = await filesIn(key)
    const removed = await repo.delete(key)
    if (removed) {
      for (const path of paths) await files.remove(path)
      await changed()
    }
    return removed
  }

  return {
    byKey: (key) => repo.byKey(key),
    validate: (input) => repo.validate(input, null),

    async create(input, principal) {
      try {
        const created = await repo.create({
          ...input,
          templateKey: null,
          userId: await userIdOf(principal),
        })
        await changed()
        return { ok: true as const, key: created.key }
      } catch (error) {
        return failure(error)
      }
    },

    async update(key, input, principal) {
      try {
        const before = await repo.byKey(key)
        const updated = await repo.update({
          ...input,
          key,
          templateKey: null,
          userId: await userIdOf(principal),
        })
        if (!updated) return notFound()
        // A replaced file is no longer anyone's: Umbraco deletes it too.
        const was = before ? mediaFileOf(before) : null
        if (was && was !== mediaFileOf(updated)) await files.remove(was)
        await changed()
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    remove: removeBranch,
    async moveToRecycleBin(key) {
      const moved = await repo.moveToRecycleBin(key)
      if (moved) await changed()
      return moved
    },

    async move(key, targetKey) {
      const result = await repo.move(key, targetKey)
      if (result === 'moved') {
        await changed()
        return { ok: true as const }
      }
      return result === 'notFound'
        ? notFound('The media item or target could not be found.')
        : { ok: false as const, reason: 'A media item cannot move below itself.', status: 400 }
    },

    async sort(parentKey, sorting) {
      return (await repo.sort(parentKey, sorting)) === 'sorted'
        ? { ok: true as const }
        : notFound('The parent, or one of the items, could not be found under it.')
    },

    async sortChildrenBy(parentKey, field, direction) {
      return (await repo.sortChildrenBy(parentKey, field, direction)) === 'sorted'
        ? { ok: true as const }
        : notFound()
    },

    async restore(key, targetKey) {
      const result = await repo.restore(key, targetKey)
      if (result === 'restored') {
        await changed()
        return { ok: true as const }
      }
      return result === 'notFound'
        ? notFound('The media item is not in the recycle bin.')
        : {
            ok: false as const,
            reason: 'The restore target does not exist or is in the recycle bin.',
            status: 400,
          }
    },

    async emptyRecycleBin() {
      for (const node of await repo.trashedRoots()) await removeBranch(node.key)
    },

    originalParent: (key) => repo.originalParent(key),
    versions: (key) => repo.versions(key),
    async systemUserKey() {
      const rows = await db.query<{ key: string }>(
        'SELECT key FROM user_account ORDER BY id LIMIT 1',
      )
      return rows[0] ? normaliseUuid(String(rows[0].key)) : null
    },

    async treeRoot(paging) {
      const page = await repo.children(null, paging.skip, paging.take)
      return { total: page.total, items: await tree(page.items) }
    },
    async treeChildren(parentKey, paging) {
      const page = await repo.children(parentKey, paging.skip, paging.take)
      return { total: page.total, items: await tree(page.items) }
    },
    treeAncestors: async (key) =>
      tree((await repo.nodes.ancestors(key)).filter((row) => row.objectType === ObjectTypes.Media)),
    async treeSiblings(target, before, after) {
      const window = await repo.siblings(target, before, after)
      if (!window) return undefined
      return { ...window, items: await tree(window.items) }
    },
    async recycleBin(parentKey, paging) {
      const page = await repo.trashed(parentKey, paging.skip, paging.take)
      return { total: page.total, items: await tree(page.items) }
    },
    async items(keys) {
      const rows = await Promise.all(keys.map((key) => repo.nodes.byKey(key)))
      return tree(rows.filter((row): row is NodeRow => row?.objectType === ObjectTypes.Media))
    },
    async search(query, options) {
      const page = await repo.search(query, options)
      return { total: page.total, items: await tree(page.items) }
    },

    async collection(parentKey, options) {
      const children = await repo.children(parentKey, 0, Number.MAX_SAFE_INTEGER)
      const filter = options.filter?.trim().toLowerCase()
      const loaded: Array<DocumentAggregate & { sortOrder: number; creator: string | null }> = []
      for (const node of children.items) {
        const media = await repo.load(node)
        if (!media) continue
        const name = media.variants[0]?.name ?? node.text ?? ''
        if (filter && !name.toLowerCase().includes(filter)) continue
        const latest = (await repo.versions(node.key))[0]
        const creator = latest?.userKey
          ? ((
              await db.query<{ user_name: string }>(
                'SELECT user_name FROM user_account WHERE key = ?',
                [latest.userKey],
              )
            )[0]?.user_name ?? null)
          : null
        loaded.push({ ...media, sortOrder: node.sortOrder, creator })
      }
      const keyOf = (m: (typeof loaded)[number]): string | number => {
        const variant = m.variants[0]
        switch (options.orderBy) {
          case 'name':
            return (variant?.name ?? '').toLowerCase()
          case 'createDate':
            return variant?.createDate.getTime() ?? 0
          case 'updateDate':
            return variant?.updateDate.getTime() ?? 0
          default:
            return m.sortOrder
        }
      }
      loaded.sort((a, b) => {
        const x = keyOf(a)
        const y = keyOf(b)
        const order = x < y ? -1 : x > y ? 1 : 0
        return options.orderDirection === 'Descending' ? -order : order
      })
      return {
        total: loaded.length,
        items: loaded.slice(options.skip, options.skip + options.take),
      }
    },

    async typesForExtension(raw) {
      const extension = raw.replace(/^\./, '').toLowerCase()
      const results: Array<{ key: string; name: string; icon: string; matched: boolean }> = []
      const catchAll: typeof results = []
      for (const { type, file } of await mediaTypesWithFile()) {
        if (!file) continue
        const allowed = allowedExtensions(file.values)
        const entry = { key: type.key, name: type.name, icon: type.icon }
        if (file.editorAlias === IMAGE_CROPPER_EDITOR_ALIAS) {
          if (DEFAULT_UPLOAD_SETTINGS.imageFileTypes.includes(extension))
            results.push({ ...entry, matched: true })
        } else if (allowed.includes(extension)) results.push({ ...entry, matched: true })
        else if (allowed.length === 0) catchAll.push({ ...entry, matched: false })
      }
      const seen = new Set(results.map((r) => r.key))
      return [...results, ...catchAll.filter((c) => !seen.has(c.key))]
    },

    async folderTypes() {
      const all = await mediaTypesWithFile()
      const folders = all
        .filter(({ type, file }) => !file && type.allowedContentTypes.length > 0)
        .map(({ type }) => type)
      if (!folders.some((t) => t.alias === 'Folder')) {
        const folder = all.find(({ type }) => type.alias === 'Folder')?.type
        if (folder) folders.push(folder)
      }
      return folders.map((t) => ({ key: t.key, name: t.name, icon: t.icon }))
    },

    async urls(keys) {
      const result = []
      for (const key of keys) {
        const media = await repo.byKey(key)
        if (media) result.push({ key: media.key, url: mediaFileOf(media) })
      }
      return result
    },
  }
}
