/**
 * Folders in the settings trees: nodes of a container object type whose only
 * data is a name. Files place types in them by `folder = "A/B"`; the sync makes
 * the path exist; the backoffice's folder actions rewrite the files.
 */
import type { Page } from '@bunbraco/core'
import { SystemNodes } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { NodeRepository, type NodeRow } from './nodes.ts'

export interface FolderModel {
  key: string
  name: string
  parentKey: string | null
}

export class FolderRepository {
  #db: Db
  #nodes: NodeRepository
  #objectType: string
  /** The object type of the things the folders hold, for emptiness checks. */
  #itemType: string

  constructor(db: Db, containerObjectType: string, itemObjectType: string) {
    this.#db = db
    this.#nodes = new NodeRepository(db)
    this.#objectType = containerObjectType
    this.#itemType = itemObjectType
  }

  async byKey(key: string): Promise<FolderModel | undefined> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.#objectType) return undefined
    return this.#toModel(node)
  }

  async #toModel(node: NodeRow): Promise<FolderModel> {
    const parent = node.parentId > 0 ? await this.#nodes.byId(node.parentId) : undefined
    return {
      key: node.key,
      name: node.text ?? '',
      parentKey: parent && parent.objectType === this.#objectType ? parent.key : null,
    }
  }

  async create(init: {
    key?: string
    name: string
    parentKey: string | null
  }): Promise<FolderModel> {
    const parentId = init.parentKey
      ? ((await this.#nodes.byKey(init.parentKey))?.id ?? SystemNodes.Root)
      : SystemNodes.Root
    const node = await this.#nodes.create({
      key: init.key,
      parentId,
      objectType: this.#objectType,
      text: init.name,
    })
    return this.#toModel(node)
  }

  async rename(key: string, name: string): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.#objectType) return false
    await this.#nodes.rename(node.id, name)
    return true
  }

  /** Deletes an empty folder; 'not-empty' when anything is still inside. */
  async delete(key: string): Promise<'deleted' | 'not-empty' | 'not-found'> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.#objectType) return 'not-found'
    const inside = await this.#nodes.childrenOf(node.id, [this.#objectType, this.#itemType], 0, 1)
    if (inside.total > 0) return 'not-empty'
    await this.#nodes.delete(node.id)
    return 'deleted'
  }

  /** Makes `A/B/C` exist, creating what is missing; returns the leaf's key, or null for an empty path. */
  async ensurePath(names: readonly string[]): Promise<string | null> {
    let parentId: number = SystemNodes.Root
    let key: string | null = null
    for (const name of names) {
      const found = await this.#db.query<{ unique_id: string; id: number }>(
        'SELECT unique_id, id FROM node WHERE parent_id = ? AND node_object_type = ? AND text = ?',
        [parentId, this.#objectType, name],
      )
      if (found[0]) {
        parentId = Number(found[0].id)
        key = String(found[0].unique_id).toLowerCase()
      } else {
        const created = await this.#nodes.create({
          parentId,
          objectType: this.#objectType,
          text: name,
        })
        parentId = created.id
        key = created.key
      }
    }
    return key
  }

  /** The folder names above a node, outermost first. */
  async pathOf(nodeKey: string): Promise<string[]> {
    const ancestors = await this.#nodes.ancestors(nodeKey)
    return ancestors.filter((a) => a.objectType === this.#objectType).map((a) => a.text ?? '')
  }

  children(parentKey: string | null, skip: number, take: number): Promise<Page<NodeRow>> {
    return this.#childrenWhere(parentKey, [this.#objectType], skip, take)
  }

  async #childrenWhere(parentKey: string | null, types: string[], skip: number, take: number) {
    const parentId = parentKey ? (await this.#nodes.byKey(parentKey))?.id : SystemNodes.Root
    if (parentId === undefined) return { total: 0, items: [] }
    return this.#nodes.childrenOf(parentId, types, skip, take)
  }
}
