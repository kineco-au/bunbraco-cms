/** Data types: the property editor plus its configuration. */
import {
  type DataTypeModel,
  normaliseUuid,
  ObjectTypes,
  type Page,
  SystemNodes,
} from '@bunbraco/core'
import type { Db } from '../database.ts'
import { NodeRepository } from './nodes.ts'

function parseValues(config: unknown): Array<{ alias: string; value: unknown }> {
  if (typeof config !== 'string' || config.length === 0) return []
  try {
    const parsed = JSON.parse(config) as unknown
    if (Array.isArray(parsed)) return parsed as Array<{ alias: string; value: unknown }>
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed as Record<string, unknown>).map(([alias, value]) => ({
        alias,
        value,
      }))
    }
  } catch {
    // A malformed configuration should not make the data type unopenable.
  }
  return []
}

export class DataTypeRepository {
  #db: Db
  #nodes: NodeRepository

  constructor(db: Db) {
    this.#db = db
    this.#nodes = new NodeRepository(db)
  }

  get nodes(): NodeRepository {
    return this.#nodes
  }

  async byKey(key: string): Promise<DataTypeModel | undefined> {
    const rows = await this.#db.query(
      `SELECT n.unique_id, n.text, n.parent_id, d.alias, d.editor_alias, d.editor_ui_alias, d.db_type, d.config
       FROM data_type d JOIN node n ON n.id = d.node_id
       WHERE n.unique_id = ?`,
      [normaliseUuid(key)],
    )
    const row = rows[0]
    if (!row) return undefined
    const parent =
      Number(row.parent_id) > 0 ? await this.#nodes.byId(Number(row.parent_id)) : undefined
    return {
      key: normaliseUuid(String(row.unique_id)),
      alias: (row.alias as string | null) ?? null,
      name: String(row.text ?? ''),
      editorAlias: String(row.editor_alias),
      editorUiAlias: (row.editor_ui_alias as string | null) ?? null,
      dbType: String(row.db_type),
      values: parseValues(row.config),
      parentKey: parent?.key ?? null,
    }
  }

  async byAlias(alias: string): Promise<DataTypeModel | undefined> {
    const rows = await this.#db.query<{ unique_id: string }>(
      'SELECT n.unique_id FROM data_type d JOIN node n ON n.id = d.node_id WHERE d.alias = ?',
      [alias],
    )
    return rows[0] ? this.byKey(String(rows[0].unique_id)) : undefined
  }

  async byKeys(keys: readonly string[]): Promise<DataTypeModel[]> {
    const found: DataTypeModel[] = []
    for (const key of keys) {
      const dataType = await this.byKey(key)
      if (dataType) found.push(dataType)
    }
    return found
  }

  /** The storage type, which decides which `property_data` column a value uses. */
  async storageTypeByPropertyTypeId(propertyTypeId: number): Promise<string | undefined> {
    const rows = await this.#db.query<{ db_type: string }>(
      `SELECT d.db_type FROM property_type p JOIN data_type d ON d.node_id = p.data_type_id
       WHERE p.id = ?`,
      [propertyTypeId],
    )
    return rows[0] ? String(rows[0].db_type) : undefined
  }

  async list(skip: number, take: number): Promise<Page<DataTypeModel>> {
    const page = await this.#nodes.children(SystemNodes.Root, ObjectTypes.DataType, skip, take)
    const items: DataTypeModel[] = []
    for (const node of page.items) {
      const dataType = await this.byKey(node.key)
      if (dataType) items.push(dataType)
    }
    return { total: page.total, items }
  }

  async all(): Promise<DataTypeModel[]> {
    const rows = await this.#db.query<{ unique_id: string }>(
      'SELECT n.unique_id FROM data_type d JOIN node n ON n.id = d.node_id ORDER BY n.text',
    )
    return this.byKeys(rows.map((r) => String(r.unique_id)))
  }

  /** The editor picker's filter: by name fragment and editor aliases. */
  async filter(
    criteria: { name?: string; editorAlias?: string; editorUiAlias?: string },
    paging: { skip: number; take: number },
  ): Promise<{ total: number; items: DataTypeModel[] }> {
    const name = criteria.name?.toLowerCase()
    const items = (await this.all()).filter(
      (d) =>
        (!name || d.name.toLowerCase().includes(name)) &&
        (!criteria.editorAlias || d.editorAlias === criteria.editorAlias) &&
        (!criteria.editorUiAlias || d.editorUiAlias === criteria.editorUiAlias),
    )
    return { total: items.length, items: items.slice(paging.skip, paging.skip + paging.take) }
  }

  /** Property types using this data type, with the type each belongs to. */
  async referencedBy(key: string): Promise<
    Array<{
      propertyKey: string
      alias: string
      name: string
      contentType: { key: string; alias: string; name: string; icon: string }
    }>
  > {
    const node = await this.#nodes.byKey(key)
    if (!node) return []
    const rows = await this.#db.query(
      `SELECT p.unique_id, p.alias, p.name, ctn.unique_id AS type_key, ct.alias AS type_alias, ctn.text AS type_name, ct.icon
       FROM property_type p
       JOIN content_type ct ON ct.node_id = p.content_type_id
       JOIN node ctn ON ctn.id = ct.node_id
       WHERE p.data_type_id = ? AND p.retired_at IS NULL AND ct.retired_at IS NULL
       ORDER BY ctn.text, p.sort_order`,
      [node.id],
    )
    return rows.map((row) => ({
      propertyKey: normaliseUuid(String(row.unique_id)),
      alias: String(row.alias),
      name: String(row.name),
      contentType: {
        key: normaliseUuid(String(row.type_key)),
        alias: String(row.type_alias),
        name: String(row.type_name ?? ''),
        icon: String(row.icon ?? 'icon-document'),
      },
    }))
  }

  async move(key: string, parentKey: string | null): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== ObjectTypes.DataType) return false
    const parentId = parentKey ? (await this.#nodes.byKey(parentKey))?.id : SystemNodes.Root
    if (parentId === undefined) return false
    await this.#nodes.move(node.id, parentId)
    return true
  }

  async copy(key: string, parentKey: string | null): Promise<DataTypeModel | undefined> {
    const source = await this.byKey(key)
    if (!source) return undefined
    return this.save({
      ...source,
      key: crypto.randomUUID(),
      alias: null,
      name: `${source.name} (copy)`,
      parentKey,
    })
  }

  async save(model: DataTypeModel, userId?: number): Promise<DataTypeModel> {
    return this.#db.transaction(async (tx) => {
      const repo = new DataTypeRepository(tx)
      const existing = await repo.nodes.byKey(model.key)
      const config = JSON.stringify(
        Object.fromEntries(model.values.map((value) => [value.alias, value.value])),
      )
      if (existing) {
        await repo.nodes.rename(existing.id, model.name)
        await tx.exec(
          'UPDATE data_type SET alias = ?, editor_alias = ?, editor_ui_alias = ?, db_type = ?, config = ? WHERE node_id = ?',
          [model.alias, model.editorAlias, model.editorUiAlias, model.dbType, config, existing.id],
        )
      } else {
        const parentId = model.parentKey
          ? ((await repo.nodes.byKey(model.parentKey))?.id ?? SystemNodes.Root)
          : SystemNodes.Root
        const node = await repo.nodes.create({
          key: model.key,
          parentId,
          objectType: ObjectTypes.DataType,
          text: model.name,
          userId,
        })
        await tx.exec(
          'INSERT INTO data_type (node_id, alias, editor_alias, editor_ui_alias, db_type, config) VALUES (?, ?, ?, ?, ?, ?)',
          [node.id, model.alias, model.editorAlias, model.editorUiAlias, model.dbType, config],
        )
      }
      const saved = await repo.byKey(model.key)
      if (!saved) throw new Error('Data type could not be read back after saving.')
      return saved
    })
  }

  async delete(key: string): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== ObjectTypes.DataType) return false
    return this.#db.transaction(async (tx) => {
      await tx.exec('DELETE FROM data_type WHERE node_id = ?', [node.id])
      await tx.exec('DELETE FROM node WHERE id = ?', [node.id])
      return true
    })
  }
}
