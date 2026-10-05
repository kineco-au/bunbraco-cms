/**
 * The bundle definitions: what a bundle would contain, not a built bundle.
 * `docs/17-bundles.md`.
 *
 * The selection lists travel as JSON text in single columns. A malformed list
 * reads back as empty rather than throwing: a definition whose row was edited
 * by hand should still list and still be deletable.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'

export interface Bundle {
  id: string
  name: string
  contentNodeId: string | null
  contentLoadChildNodes: boolean
  mediaIds: string[]
  mediaLoadChildNodes: boolean
  elementIds: string[] | null
  documentTypes: string[]
  mediaTypes: string[]
  dataTypes: string[]
  templates: string[]
  partialViews: string[]
  stylesheets: string[]
  scripts: string[]
  languages: string[]
  dictionaryItems: string[]
  createDate: Date
  updateDate: Date
}

/** A definition to store; `id` is assigned when it is new, the dates always. */
export type BundleInput = Omit<Bundle, 'id' | 'createDate' | 'updateDate'>

interface Row {
  id: string
  name: string
  content_node_id: string | null
  content_load_child_nodes: unknown
  media_load_child_nodes: unknown
  media_ids: string
  element_ids: string | null
  document_types: string
  media_types: string
  data_types: string
  templates: string
  partial_views: string
  stylesheets: string
  scripts: string
  languages: string
  dictionary_items: string
  create_date: unknown
  update_date: unknown
}

const SELECT = `SELECT id, name, content_node_id, content_load_child_nodes,
                       media_load_child_nodes, media_ids, element_ids, document_types,
                       media_types, data_types, templates, partial_views, stylesheets,
                       scripts, languages, dictionary_items, create_date, update_date
                  FROM bundle`

const list = (value: string | null): string[] => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

const hydrate = (row: Row): Bundle => ({
  id: row.id,
  name: row.name,
  contentNodeId: row.content_node_id,
  contentLoadChildNodes: fromDbBool(row.content_load_child_nodes),
  mediaIds: list(row.media_ids),
  mediaLoadChildNodes: fromDbBool(row.media_load_child_nodes),
  elementIds: row.element_ids === null ? null : list(row.element_ids),
  documentTypes: list(row.document_types),
  mediaTypes: list(row.media_types),
  dataTypes: list(row.data_types),
  templates: list(row.templates),
  partialViews: list(row.partial_views),
  stylesheets: list(row.stylesheets),
  scripts: list(row.scripts),
  languages: list(row.languages),
  dictionaryItems: list(row.dictionary_items),
  createDate: DbDate.fromDb(row.create_date) ?? new Date(0),
  updateDate: DbDate.fromDb(row.update_date) ?? new Date(0),
})

export class BundleRepository {
  #db: Db
  constructor(db: Db) {
    this.#db = db
  }

  /** By name, which is the order the section lists them in. */
  async list(
    options: { skip?: number; take?: number } = {},
  ): Promise<{ total: number; items: Bundle[] }> {
    const counted = await this.#db.query<{ total: number }>('SELECT COUNT(*) AS total FROM bundle')
    const rows = await this.#db.query<Row>(`${SELECT} ORDER BY name LIMIT ? OFFSET ?`, [
      options.take ?? 100,
      options.skip ?? 0,
    ])
    return { total: Number(counted[0]?.total ?? 0), items: rows.map(hydrate) }
  }

  async byId(id: string): Promise<Bundle | undefined> {
    const rows = await this.#db.query<Row>(`${SELECT} WHERE id = ?`, [id])
    const row = rows[0]
    return row ? hydrate(row) : undefined
  }

  async byName(name: string): Promise<Bundle | undefined> {
    const rows = await this.#db.query<Row>(`${SELECT} WHERE LOWER(name) = ?`, [
      name.trim().toLowerCase(),
    ])
    const row = rows[0]
    return row ? hydrate(row) : undefined
  }

  async create(input: BundleInput, id: string = randomUUID()): Promise<Bundle> {
    const now = new Date()
    await this.#db.exec(
      `INSERT INTO bundle
         (id, name, content_node_id, content_load_child_nodes, media_load_child_nodes,
          media_ids, element_ids, document_types, media_types, data_types, templates,
          partial_views, stylesheets, scripts, languages, dictionary_items,
          create_date, update_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.contentNodeId,
        this.#db.dialect.boolValue(input.contentLoadChildNodes),
        this.#db.dialect.boolValue(input.mediaLoadChildNodes),
        JSON.stringify(input.mediaIds),
        input.elementIds === null ? null : JSON.stringify(input.elementIds),
        JSON.stringify(input.documentTypes),
        JSON.stringify(input.mediaTypes),
        JSON.stringify(input.dataTypes),
        JSON.stringify(input.templates),
        JSON.stringify(input.partialViews),
        JSON.stringify(input.stylesheets),
        JSON.stringify(input.scripts),
        JSON.stringify(input.languages),
        JSON.stringify(input.dictionaryItems),
        DbDate.toDb(now),
        DbDate.toDb(now),
      ],
    )
    return { ...input, id, createDate: now, updateDate: now }
  }

  async update(id: string, input: BundleInput): Promise<void> {
    await this.#db.exec(
      `UPDATE bundle
          SET name = ?, content_node_id = ?, content_load_child_nodes = ?,
              media_load_child_nodes = ?, media_ids = ?, element_ids = ?,
              document_types = ?, media_types = ?, data_types = ?, templates = ?,
              partial_views = ?, stylesheets = ?, scripts = ?, languages = ?,
              dictionary_items = ?, update_date = ?
        WHERE id = ?`,
      [
        input.name,
        input.contentNodeId,
        this.#db.dialect.boolValue(input.contentLoadChildNodes),
        this.#db.dialect.boolValue(input.mediaLoadChildNodes),
        JSON.stringify(input.mediaIds),
        input.elementIds === null ? null : JSON.stringify(input.elementIds),
        JSON.stringify(input.documentTypes),
        JSON.stringify(input.mediaTypes),
        JSON.stringify(input.dataTypes),
        JSON.stringify(input.templates),
        JSON.stringify(input.partialViews),
        JSON.stringify(input.stylesheets),
        JSON.stringify(input.scripts),
        JSON.stringify(input.languages),
        JSON.stringify(input.dictionaryItems),
        DbDate.toDb(new Date()),
        id,
      ],
    )
  }

  async delete(id: string): Promise<void> {
    await this.#db.exec('DELETE FROM bundle WHERE id = ?', [id])
  }
}
