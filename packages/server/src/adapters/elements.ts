/**
 * The Library section: Umbraco 18's Elements.
 *
 * An element is a node facet exactly as a document is — `node` + `content` +
 * `content_version` — so versioning, publishing and the recycle bin are machinery
 * that already exists and the document repository takes `element` as a fifth
 * `kind`. What an element does not have is a URL or a template: it is content
 * something else points at, so there is no route to resolve and no view to pick.
 *
 * Its folders are plain `node` rows with the ElementContainer object type, carried
 * by the generic folder repository, which is why they worked before elements
 * themselves did.
 */
import type { ElementPort, Principal } from '@bunbraco/api-management'
import { type ElementTreeItem, normaliseUuid, ObjectTypes, SystemNodes } from '@bunbraco/core'
import {
  appendCacheInstruction,
  type Db,
  DocumentRepository,
  FolderRepository,
  NodeRepository,
  type NodeRow,
  type NodeSchemaState,
  PublishBlockedError,
  type ValueIntake,
  WriteRejectedError,
} from '@bunbraco/data'
import { TemporaryFileMissingError } from '../file-intake.ts'
import { createFolderPort, createSettingsTree } from './content.ts'

export function createElementPort(
  db: Db,
  options: {
    nodeState?: NodeSchemaState
    nodeId?: string
    valueIntake?: ValueIntake
    /** Told after every change, so pages that resolved an element refresh. */
    onChange?: () => void | Promise<void>
  } = {},
): ElementPort {
  const repo = new DocumentRepository(db, { ...options, kind: 'element' })
  const nodes = new NodeRepository(db)
  const folders = new FolderRepository(db, ObjectTypes.ElementContainer, ObjectTypes.Element)

  const changed = async () => {
    await appendCacheInstruction(db, {
      kind: 'content',
      payload: { elements: true },
      by: options.nodeId,
    })
    await options.onChange?.()
  }
  const tree = createSettingsTree(nodes, ObjectTypes.ElementContainer, ObjectTypes.Element, changed)

  const userIdOf = async (principal: Principal): Promise<number | undefined> => {
    const rows = await db.query<{ id: number }>('SELECT id FROM user_account WHERE key = ?', [
      principal.id,
    ])
    return rows[0] ? Number(rows[0].id) : undefined
  }
  const notFound = (reason = 'The element could not be found.') => ({
    ok: false as const,
    reason,
    status: 404,
  })
  const failure = (error: unknown) => {
    if (error instanceof WriteRejectedError)
      return { ok: false as const, reason: error.message, status: 409 }
    if (error instanceof PublishBlockedError) return { ok: false as const, reason: error.message }
    if (error instanceof TemporaryFileMissingError)
      return { ok: false as const, reason: error.message, status: 400 }
    throw error
  }
  /** An element has no template, whatever a save sends. */
  const saved = <T extends object>(input: T) => ({ ...input, componentKey: null })

  return {
    folders: createFolderPort(folders, tree, changed),

    // The Library tree mixes folders and elements, so these read `node` rows for
    // both object types and shape each accordingly, rather than using the generic
    // settings tree: an element has to carry its type and its variants' publish
    // state, which a folder has none of.
    treeRoot: (paging) => treePage(null, paging),
    treeChildren: (parentKey, paging) => treePage(parentKey, paging),
    async ancestors(descendantKey) {
      const rows = (await nodes.ancestors(descendantKey)).filter(
        (row) =>
          row.objectType === ObjectTypes.Element || row.objectType === ObjectTypes.ElementContainer,
      )
      return shape(rows)
    },
    async items(keys) {
      const rows = await Promise.all(keys.map((key) => nodes.byKey(key)))
      return shape(
        rows.filter(
          (row): row is NodeRow =>
            row?.objectType === ObjectTypes.Element ||
            row?.objectType === ObjectTypes.ElementContainer,
        ),
      )
    },
    async treeSiblings(target, before, after) {
      const window = await nodes.siblings(
        target,
        [ObjectTypes.ElementContainer, ObjectTypes.Element],
        before,
        after,
      )
      if (!window) return undefined
      return { ...window, items: await shape(window.items) }
    },

    byKey: (key) => repo.byKey(key),
    byKeyPublished: (key) => repo.byKeyPublished(key),
    validate: (input, cultures) => repo.validate(input, cultures),

    async create(input, principal) {
      try {
        const created = await repo.create(saved({ ...input, userId: await userIdOf(principal) }))
        await changed()
        return { ok: true as const, key: created.key }
      } catch (error) {
        return failure(error)
      }
    },

    async update(key, input, principal) {
      try {
        const updated = await repo.update(
          saved({ ...input, key, userId: await userIdOf(principal) }),
        )
        if (!updated) return notFound()
        await changed()
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async createAndPublish(input, cultures, principal) {
      try {
        const result = await repo.createAndPublish(
          saved({ ...input, userId: await userIdOf(principal) }),
          cultures,
        )
        if (!result.ok)
          return {
            ok: false as const,
            reason: 'One or more properties did not pass validation',
            status: 400,
            errors: result.errors,
          }
        await changed()
        return { ok: true as const, key: result.document.key }
      } catch (error) {
        return failure(error)
      }
    },

    async updateAndPublish(key, input, cultures, principal) {
      try {
        const result = await repo.updateAndPublish(
          saved({ ...input, key, userId: await userIdOf(principal) }),
          cultures,
        )
        if (!result) return notFound()
        if (!result.ok)
          return {
            ok: false as const,
            reason: 'One or more properties did not pass validation',
            status: 400,
            errors: result.errors,
          }
        await changed()
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async publish(key, cultures) {
      try {
        const published = await repo.publish(key, cultures)
        if (!published) return notFound()
        await changed()
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async unpublish(key, cultures) {
      try {
        const result = await repo.unpublish(key, cultures)
        if (!result) return notFound()
        await changed()
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async copy(key, targetKey, copyOptions, principal) {
      try {
        const copied = await repo.copy(key, targetKey, {
          includeDescendants: copyOptions.includeDescendants,
          userId: await userIdOf(principal),
        })
        // The repository answers the new key, or undefined when either end is missing.
        if (!copied) return notFound('The element or target could not be found.')
        await changed()
        return { ok: true as const, key: copied }
      } catch (error) {
        return failure(error)
      }
    },

    async move(key, targetKey) {
      const result = await repo.move(key, targetKey)
      if (result === 'moved') {
        await changed()
        return { ok: true as const }
      }
      return result === 'notFound'
        ? notFound('The element or target could not be found.')
        : {
            ok: false as const,
            reason: 'An element cannot be moved below itself or into the recycle bin.',
            status: 400,
          }
    },

    async moveToRecycleBin(key) {
      const moved = await repo.moveToRecycleBin(key)
      if (moved) await changed()
      return moved
    },

    async remove(key) {
      const removed = await repo.delete(key)
      if (removed) await changed()
      return removed
    },

    async restore(key, targetKey) {
      const result = await repo.restore(key, targetKey)
      if (result === 'restored') {
        await changed()
        return { ok: true as const }
      }
      return result === 'notFound'
        ? notFound('The element is not in the recycle bin.')
        : {
            ok: false as const,
            reason: 'The restore target does not exist or is in the recycle bin.',
            status: 400,
          }
    },

    async emptyRecycleBin() {
      for (const node of await repo.trashedRoots()) {
        if (await repo.delete(node.key)) await changed()
      }
    },

    originalParent: (key) => repo.originalParent(key),

    async recycleBin(parentKey, paging) {
      const page = await repo.trashed(parentKey, paging.skip, paging.take)
      return { total: page.total, items: await shape(page.items) }
    },

    async recycleBinSiblings(target, before, after) {
      const window = await repo.siblings(target, before, after)
      if (!window) return undefined
      return { ...window, items: await shape(window.items) }
    },

    async search(query, searchOptions) {
      const page = await repo.search(query, searchOptions)
      return { total: page.total, items: await shape(page.items) }
    },

    versions: (key) => repo.versions(key),
    atVersion: (versionId) => repo.atVersion(versionId),
    async rollback(versionId) {
      const result = await repo.rollback(versionId)
      if (result) await changed()
      return result !== undefined
    },
    setPreventCleanup: (versionId, prevent) => repo.setPreventCleanup(versionId, prevent),

    // The document repository's move refuses anything that is not an element, so a
    // folder moves through the node repository instead, with the same two rules:
    // the target must be a folder, and nothing may move inside itself.
    async moveFolder(key, targetKey) {
      const node = await nodes.byKey(key)
      if (!node || node.objectType !== ObjectTypes.ElementContainer)
        return notFound('The folder could not be found.')
      const target = targetKey ? await nodes.byKey(targetKey) : undefined
      if (targetKey && (!target || target.objectType !== ObjectTypes.ElementContainer))
        return notFound('The target folder could not be found.')
      if (target && (target.id === node.id || `${target.path},`.startsWith(`${node.path},`)))
        return {
          ok: false as const,
          reason: 'A folder cannot be moved below itself.',
          status: 400,
        }
      await nodes.move(node.id, target?.id ?? SystemNodes.Root)
      await changed()
      return { ok: true as const }
    },

    async folderToRecycleBin(key) {
      const node = await nodes.byKey(key)
      if (!node || node.objectType !== ObjectTypes.ElementContainer) return false
      await nodes.move(node.id, SystemNodes.ElementRecycleBin)
      // The whole branch is trashed, elements inside it included, and an element
      // stays unpublished while it is in the bin.
      const moved = await nodes.byKey(key)
      await db.exec('UPDATE node SET trashed = ? WHERE id = ? OR path LIKE ?', [
        db.dialect.boolValue(true),
        node.id,
        `${moved?.path ?? node.path},%`,
      ])
      await db.exec(
        `UPDATE document SET published = ?, edited = ?
          WHERE node_id IN (SELECT id FROM node WHERE id = ? OR path LIKE ?)`,
        [
          db.dialect.boolValue(false),
          db.dialect.boolValue(true),
          node.id,
          `${moved?.path ?? node.path},%`,
        ],
      )
      await changed()
      return true
    },

    async folderItems(keys) {
      const rows = await Promise.all(keys.map((key) => nodes.byKey(key)))
      return shape(
        rows.filter((row): row is NodeRow => row?.objectType === ObjectTypes.ElementContainer),
      )
    },
    async systemUserKey() {
      const rows = await db.query<{ key: string }>(
        'SELECT key FROM user_account ORDER BY id LIMIT 1',
      )
      return rows[0] ? normaliseUuid(String(rows[0].key)) : null
    },
  }

  /** Elements and folders as tree rows; a folder reports no type and no content. */
  async function shape(rows: readonly NodeRow[]): Promise<ElementTreeItem[]> {
    const items: ElementTreeItem[] = []
    for (const row of rows) {
      const isFolder = row.objectType === ObjectTypes.ElementContainer
      const parent = row.parentId > 0 ? await nodes.byId(row.parentId) : undefined
      const parentKey =
        parent && parent.objectType !== ObjectTypes.ElementRecycleBin ? parent.key : null
      if (isFolder) {
        const inside = await nodes.childrenOf(
          row.id,
          [ObjectTypes.ElementContainer, ObjectTypes.Element],
          0,
          1,
        )
        items.push({
          key: row.key,
          name: row.text ?? '',
          hasChildren: inside.total > 0,
          parentKey,
          contentTypeKey: '',
          icon: 'icon-folder',
          isTrashed: row.trashed,
          createDate: row.createDate ?? new Date(),
          ancestorKeys: [],
          variants: [{ culture: null, name: row.text ?? '', state: 'NotCreated' }],
          isFolder: true,
        })
        continue
      }
      const [item] = await repo.treeItems([row])
      if (item) items.push({ ...item, parentKey, isFolder: false })
    }
    return items
  }

  async function treePage(
    parentKey: string | null,
    paging: { skip: number; take: number; foldersOnly?: boolean },
  ) {
    const parentId = parentKey ? (await nodes.byKey(parentKey))?.id : SystemNodes.Root
    if (parentId === undefined) return { total: 0, items: [] }
    const types = paging.foldersOnly
      ? [ObjectTypes.ElementContainer]
      : [ObjectTypes.ElementContainer, ObjectTypes.Element]
    const result = await nodes.childrenOf(parentId, types, paging.skip, paging.take)
    return { total: result.total, items: await shape(result.items) }
  }
}
