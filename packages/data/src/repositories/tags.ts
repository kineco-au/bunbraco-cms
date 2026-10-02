/**
 * Tags, read from the current values of Tags properties rather than kept in a
 * table of their own: what the tags editor's suggestions and `GET /tag` list.
 * A tag's group comes from its data type's configuration, as in Umbraco.
 */
import { createHash } from 'node:crypto'
import type { Db } from '../database.ts'

export interface TagRow {
  id: string
  text: string
  group: string
  culture: string | null
  nodeCount: number
}

/** A stable id for a tag: Umbraco's are rows; these are derived from what identifies one. */
function tagId(group: string, text: string, culture: string | null): string {
  const hex = createHash('sha1')
    .update(`${group}\u0000${text}\u0000${culture ?? ''}`)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // CSV storage
  }
  return raw.split(',')
}

export class TagRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async all(
    filter: { query?: string; group?: string; culture?: string | null } = {},
  ): Promise<TagRow[]> {
    const rows = await this.#db.query(
      `SELECT pv.node_id, pv.text_value, pv.varchar_value, d.config, l.iso_code
       FROM property_value pv
       JOIN property_type p ON p.id = pv.property_type_id
       JOIN data_type d ON d.node_id = p.data_type_id
       JOIN node n ON n.id = pv.node_id
       LEFT JOIN language l ON l.id = pv.language_id
       WHERE pv.is_current = ? AND d.editor_alias = ? AND n.trashed = ?`,
      [this.#db.dialect.boolValue(true), 'Umbraco.Tags', this.#db.dialect.boolValue(false)],
    )
    const tags = new Map<string, TagRow & { nodes: Set<number> }>()
    for (const row of rows) {
      let group = 'default'
      try {
        const config = JSON.parse(String(row.config ?? '{}')) as Record<string, unknown>
        if (typeof config.group === 'string' && config.group) group = config.group
      } catch {
        // an unreadable configuration keeps the default group
      }
      const culture = (row.iso_code as string | null) ?? null
      for (const raw of parseTags(row.text_value ?? row.varchar_value)) {
        const text = raw.trim()
        if (!text) continue
        const id = tagId(group, text.toLowerCase(), culture)
        const tag = tags.get(id) ?? {
          id,
          text,
          group,
          culture,
          nodeCount: 0,
          nodes: new Set<number>(),
        }
        tag.nodes.add(Number(row.node_id))
        tag.nodeCount = tag.nodes.size
        tags.set(id, tag)
      }
    }
    const query = filter.query?.trim().toLowerCase()
    return [...tags.values()]
      .filter((t) => !query || t.text.toLowerCase().includes(query))
      .filter((t) => !filter.group || t.group === filter.group)
      .filter(
        (t) => filter.culture === undefined || (t.culture ?? null) === (filter.culture ?? null),
      )
      .map(({ nodes: _nodes, ...tag }) => tag)
      .sort((a, b) => a.text.localeCompare(b.text))
  }
}
