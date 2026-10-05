/**
 * Templates. The database row carries the alias and the tree placement; the view
 * file lives on disk, and the file system is the source of truth for its content.
 */
import {
  type ComponentModel,
  normaliseUuid,
  ObjectTypes,
  type Page,
  SystemNodes,
} from '@bunbraco/core'
import type { Db } from '../database.ts'
import { NodeRepository } from './nodes.ts'

export interface ComponentFileStore {
  read(alias: string): Promise<string | undefined>
  write(alias: string, content: string): Promise<void>
  remove(alias: string): Promise<void>
}

export class ComponentRepository {
  #db: Db
  #nodes: NodeRepository
  #files: ComponentFileStore | undefined

  constructor(db: Db, files?: ComponentFileStore) {
    this.#db = db
    this.#nodes = new NodeRepository(db)
    this.#files = files
  }

  get nodes(): NodeRepository {
    return this.#nodes
  }

  async byKey(key: string): Promise<ComponentModel | undefined> {
    const rows = await this.#db.query(
      `SELECT n.unique_id, n.text, t.alias FROM template t
       JOIN node n ON n.id = t.node_id WHERE n.unique_id = ?`,
      [normaliseUuid(key)],
    )
    const row = rows[0]
    if (!row) return undefined
    const alias = String(row.alias)
    return {
      key: normaliseUuid(String(row.unique_id)),
      name: String(row.text ?? ''),
      alias,
      content: (await this.#files?.read(alias)) ?? null,
    }
  }

  async byAlias(alias: string): Promise<ComponentModel | undefined> {
    const rows = await this.#db.query<{ unique_id: string }>(
      'SELECT n.unique_id FROM template t JOIN node n ON n.id = t.node_id WHERE t.alias = ?',
      [alias],
    )
    return rows[0] ? this.byKey(String(rows[0].unique_id)) : undefined
  }

  async all(): Promise<ComponentModel[]> {
    return (await this.list(0, 10_000)).items
  }

  async list(skip: number, take: number): Promise<Page<ComponentModel>> {
    const page = await this.#nodes.children(SystemNodes.Root, ObjectTypes.Template, skip, take)
    const items: ComponentModel[] = []
    for (const node of page.items) {
      const template = await this.byKey(node.key)
      if (template) items.push(template)
    }
    return { total: page.total, items }
  }

  async save(model: ComponentModel, userId?: number): Promise<ComponentModel> {
    const saved = await this.#db.transaction(async (tx) => {
      const repo = new ComponentRepository(tx, this.#files)
      const existing = await repo.nodes.byKey(model.key)
      if (existing) {
        await repo.nodes.rename(existing.id, model.name)
        await tx.exec('UPDATE template SET alias = ? WHERE node_id = ?', [model.alias, existing.id])
      } else {
        const node = await repo.nodes.create({
          key: model.key,
          parentId: SystemNodes.Root,
          objectType: ObjectTypes.Template,
          text: model.name,
          userId,
        })
        await tx.exec('INSERT INTO template (node_id, alias) VALUES (?, ?)', [node.id, model.alias])
      }
      return model
    })
    if (model.content !== null && model.content !== undefined) {
      await this.#files?.write(model.alias, model.content)
    }
    const result = await this.byKey(saved.key)
    if (!result) throw new Error('Template could not be read back after saving.')
    return result
  }

  async delete(key: string): Promise<boolean> {
    const template = await this.byKey(key)
    const node = await this.#nodes.byKey(key)
    if (!template || !node) return false
    await this.#db.transaction(async (tx) => {
      await tx.exec('DELETE FROM content_type_template WHERE template_node_id = ?', [node.id])
      await tx.exec('DELETE FROM template WHERE node_id = ?', [node.id])
      await tx.exec('DELETE FROM node WHERE id = ?', [node.id])
    })
    await this.#files?.remove(template.alias)
    return true
  }
}
