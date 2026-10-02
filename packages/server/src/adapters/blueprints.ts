/**
 * Document blueprints ("Document Blueprints" in Settings, "Create Document
 * Blueprint" on a page): stored as documents of their own object type in their
 * own folder tree, never published.
 */
import type { BlueprintPort, Principal } from '@bunbraco/api-management'
import { ObjectTypes, type TreeItem } from '@bunbraco/core'
import {
  type Db,
  DocumentRepository,
  FolderRepository,
  type NodeSchemaState,
  type ValueIntake,
  WriteRejectedError,
} from '@bunbraco/data'
import { createFolderPort, createSettingsTree } from './content.ts'

export function createBlueprintPort(
  db: Db,
  options: { nodeState?: NodeSchemaState; valueIntake?: ValueIntake } = {},
): BlueprintPort {
  const repo = new DocumentRepository(db, {
    nodeState: options.nodeState,
    kind: 'blueprint',
    valueIntake: options.valueIntake,
  })
  const documents = new DocumentRepository(db, { nodeState: options.nodeState })
  const container = ObjectTypes.DocumentBlueprintContainer
  const folders = new FolderRepository(db, container, ObjectTypes.DocumentBlueprint)

  const decorate = async (item: TreeItem) => {
    const blueprint = await repo.byKey(item.key)
    item.icon = blueprint?.contentTypeIcon ?? 'icon-blueprint'
    item.contentTypeKey = blueprint?.contentTypeKey ?? null
  }
  const tree = createSettingsTree(repo.nodes, container, ObjectTypes.DocumentBlueprint, decorate)

  const userIdOf = async (principal: Principal): Promise<number | undefined> => {
    const rows = await db.query<{ id: number }>('SELECT id FROM user_account WHERE key = ?', [
      principal.id,
    ])
    return rows[0] ? Number(rows[0].id) : undefined
  }
  const failure = (error: unknown) => {
    if (error instanceof WriteRejectedError)
      return { ok: false as const, reason: error.message, status: 409 }
    return {
      ok: false as const,
      reason: error instanceof Error ? error.message : String(error),
      status: 400,
    }
  }

  return {
    byKey: (key) => repo.byKey(key),

    async create(input, principal) {
      try {
        await repo.create({ ...input, templateKey: null, userId: await userIdOf(principal) })
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async update(key, input, principal) {
      try {
        const updated = await repo.update({
          ...input,
          key,
          templateKey: null,
          userId: await userIdOf(principal),
        })
        if (!updated)
          return { ok: false as const, reason: 'The blueprint could not be found.', status: 404 }
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async fromDocument(documentKey, init, principal) {
      const document = await documents.byKey(documentKey)
      if (!document)
        return { ok: false as const, reason: 'The document could not be found.', status: 404 }
      try {
        const created = await repo.create({
          key: init.key,
          contentTypeKey: document.contentTypeKey,
          templateKey: null,
          parentKey: init.parentKey,
          values: document.values,
          variants: document.variants.map((v) => ({
            culture: v.culture,
            segment: v.segment,
            name: v.culture === null ? init.name : v.name,
          })),
          userId: await userIdOf(principal),
        })
        return { ok: true as const, key: created.key }
      } catch (error) {
        return failure(error)
      }
    },

    remove: (key) => repo.delete(key),

    async move(key, targetKey) {
      const result = await repo.move(key, targetKey)
      if (result === 'moved') return { ok: true as const }
      return result === 'notFound'
        ? { ok: false as const, reason: 'The blueprint or folder could not be found.', status: 404 }
        : { ok: false as const, reason: 'A blueprint cannot move there.', status: 400 }
    },

    versions: (key) => repo.versions(key),
    async systemUserKey() {
      const rows = await db.query<{ key: string }>(
        'SELECT key FROM user_account ORDER BY id LIMIT 1',
      )
      return rows[0] ? String(rows[0].key).toLowerCase() : null
    },

    async forDocumentType(contentTypeKey, paging) {
      const rows = await db.query(
        `SELECT n.unique_id, n.text FROM node n JOIN content c ON c.node_id = n.id
         JOIN node t ON t.id = c.content_type_id
         WHERE n.node_object_type = ? AND t.unique_id = ? ORDER BY n.text, n.id`,
        [ObjectTypes.DocumentBlueprint, contentTypeKey.toLowerCase()],
      )
      const all = rows.map((row) => ({
        key: String(row.unique_id).toLowerCase(),
        name: String(row.text ?? ''),
      }))
      return { total: all.length, items: all.slice(paging.skip, paging.skip + paging.take) }
    },

    treeRoot: tree.treeRoot,
    treeChildren: tree.treeChildren,
    treeAncestors: tree.ancestors,
    treeSiblings: tree.siblings,

    async items(keys) {
      const found = []
      for (const key of keys) {
        const blueprint = await repo.byKey(key)
        if (!blueprint) continue
        found.push({
          key: blueprint.key,
          name:
            blueprint.variants.find((v) => v.culture === null)?.name ??
            blueprint.variants[0]?.name ??
            '',
          contentTypeKey: blueprint.contentTypeKey,
          icon: blueprint.contentTypeIcon,
        })
      }
      return found
    },

    folders: createFolderPort(folders, tree, async () => {}),
  }
}
