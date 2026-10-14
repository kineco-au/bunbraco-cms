/**
 * The backoffice search index: what a write queues, how the indexer turns a
 * queued item into rows, and the two indexes the Examine dashboard shows.
 * docs/search.md.
 */
import { ObjectTypes } from '@crombolo/core'
import type { Db } from './database.ts'
import { DbDate, fromDbBool } from './dialect.ts'
import { searchTerms, searchWords, type UnsearchableProperty, valueText } from './search-text.ts'

/** Umbraco's names for the two backoffice indexes, which the dashboard shows. */
export type SearchIndexName = 'InternalIndex' | 'MembersIndex'

export interface SearchIndexDefinition {
  name: SearchIndexName
  searcherName: string
  objectTypes: readonly string[]
}

export const SEARCH_INDEXES: readonly SearchIndexDefinition[] = [
  {
    name: 'InternalIndex',
    searcherName: 'InternalSearcher',
    objectTypes: [ObjectTypes.Document, ObjectTypes.Media],
  },
  { name: 'MembersIndex', searcherName: 'MembersSearcher', objectTypes: [ObjectTypes.Member] },
]

const INDEXED_TYPES: readonly string[] = SEARCH_INDEXES.flatMap((index) => index.objectTypes)

const INDEX_TYPE: Record<string, string> = {
  [ObjectTypes.Document]: 'content',
  [ObjectTypes.Media]: 'media',
  [ObjectTypes.Member]: 'member',
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

const ENQUEUE = `INSERT INTO search_index_queue (node_id, generation, queued_at)`
const ON_CONFLICT = `ON CONFLICT (node_id) DO UPDATE
  SET generation = search_index_queue.generation + 1, queued_at = excluded.queued_at`

/**
 * Queues items for the indexer. Called inside the write's own transaction, so
 * the queue row commits with the change or not at all. Ids of anything that is
 * not a page, media item or member are ignored.
 */
export async function queueForSearch(db: Db, nodeIds: Iterable<number>): Promise<void> {
  const ids = [...new Set(nodeIds)]
  if (ids.length === 0) return
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    await db.exec(
      `${ENQUEUE} SELECT id, 1, ${db.dialect.now()} FROM node
       WHERE id IN (${marks(chunk.length)}) AND node_object_type IN (${marks(INDEXED_TYPES.length)})
       ${ON_CONFLICT}`,
      [...chunk, ...INDEXED_TYPES],
    )
  }
}

/** Queues every item of these content types, and of the types composing them. */
export async function queueContentTypesForSearch(
  db: Db,
  contentTypeNodeIds: Iterable<number>,
): Promise<void> {
  const types = new Set(contentTypeNodeIds)
  let frontier = [...types]
  while (frontier.length > 0) {
    const children = await db.query<{ id: number }>(
      `SELECT child_content_type_id AS id FROM content_type_composition
       WHERE parent_content_type_id IN (${marks(frontier.length)})`,
      frontier,
    )
    frontier = children.map((row) => Number(row.id)).filter((id) => !types.has(id))
    for (const id of frontier) types.add(id)
  }
  if (types.size === 0) return
  const ids = [...types]
  await db.exec(
    `${ENQUEUE} SELECT node_id, 1, ${db.dialect.now()} FROM content
     WHERE content_type_id IN (${marks(ids.length)})
     ${ON_CONFLICT}`,
    ids,
  )
}

/**
 * Queues every page, media item and member. An element type's properties are
 * read inside blocks wherever they are used, which no query can narrow.
 */
export async function queueEverythingForSearch(db: Db): Promise<void> {
  await db.exec(
    `${ENQUEUE} SELECT id, 1, ${db.dialect.now()} FROM node
     WHERE node_object_type IN (${marks(INDEXED_TYPES.length)})
     ${ON_CONFLICT}`,
    [...INDEXED_TYPES],
  )
}

/** One row of `search_document`: an item in one culture, '' when invariant. */
export interface SearchEntry {
  culture: string
  name: string
  body: string
  fields: Record<string, string[]>
}

export interface SearchIndexStats {
  documentCount: number
  fieldCount: number
  /** Items queued and not yet indexed. */
  pending: number
}

export interface SearchHit {
  key: string
  score: number
  fields: Array<{ name: string; values: string[] }>
}

export class SearchIndex {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  static definition(name: string): SearchIndexDefinition | undefined {
    return SEARCH_INDEXES.find((index) => index.name.toLowerCase() === name.toLowerCase())
  }

  static bySearcher(name: string): SearchIndexDefinition | undefined {
    return SEARCH_INDEXES.find((index) => index.searcherName.toLowerCase() === name.toLowerCase())
  }

  /**
   * Indexes up to `limit` queued items, oldest first, and returns how many it
   * indexed. Each item is its own transaction, claimed by locking its queue row:
   * a second indexer passes over it, and a write queueing it again bumps the
   * generation, so the row outlives this run and the item is indexed once more.
   */
  async indexQueued(limit = 200): Promise<number> {
    const queued = await this.#db.query<{ node_id: number; generation: number }>(
      'SELECT node_id, generation FROM search_index_queue ORDER BY queued_at, node_id LIMIT ?',
      [limit],
    )
    let indexed = 0
    for (const row of queued) {
      const nodeId = Number(row.node_id)
      const generation = Number(row.generation)
      const done = await this.#db.transaction(async (tx) => {
        const claimed = await tx.query(
          `SELECT node_id FROM search_index_queue WHERE node_id = ? AND generation = ? ${tx.dialect.forUpdateSkipLocked}`,
          [nodeId, generation],
        )
        if (claimed.length === 0) return false
        await writeEntries(tx, nodeId, await entriesFor(tx, nodeId))
        await tx.exec('DELETE FROM search_index_queue WHERE node_id = ? AND generation = ?', [
          nodeId,
          generation,
        ])
        return true
      })
      if (done) indexed++
    }
    return indexed
  }

  /** Indexes until nothing is queued. For tests and the command line. */
  async indexAll(): Promise<number> {
    let total = 0
    for (;;) {
      const indexed = await this.indexQueued()
      total += indexed
      if (indexed === 0) return total
    }
  }

  /** Queues every item the index covers; the index keeps answering meanwhile. */
  async rebuild(index: SearchIndexDefinition): Promise<void> {
    await this.#db.exec(
      `${ENQUEUE} SELECT id, 1, ${this.#db.dialect.now()} FROM node
       WHERE node_object_type IN (${marks(index.objectTypes.length)})
       ${ON_CONFLICT}`,
      [...index.objectTypes],
    )
  }

  async stats(index: SearchIndexDefinition): Promise<SearchIndexStats> {
    const types = index.objectTypes
    const [documents] = await this.#db.query<{ n: number; fields: number | null }>(
      `SELECT COUNT(DISTINCT sd.node_id) AS n, MAX(sd.field_count) AS fields
       FROM search_document sd JOIN node n ON n.id = sd.node_id
       WHERE n.node_object_type IN (${marks(types.length)})`,
      [...types],
    )
    const [pending] = await this.#db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM search_index_queue q JOIN node n ON n.id = q.node_id
       WHERE n.node_object_type IN (${marks(types.length)})`,
      [...types],
    )
    return {
      documentCount: Number(documents?.n ?? 0),
      fieldCount: Number(documents?.fields ?? 0),
      pending: Number(pending?.n ?? 0),
    }
  }

  /** The Examine dashboard's search: every stored field of each matching item, best first. */
  async query(
    index: SearchIndexDefinition,
    term: string,
    paging: { skip: number; take: number },
  ): Promise<{ total: number; items: SearchHit[] }> {
    const terms = searchTerms(term)
    if (terms.length === 0) return { total: 0, items: [] }
    const types = index.objectTypes
    const from = `FROM (${this.#db.dialect.fullTextHits}) h JOIN node n ON n.id = h.node_id
      WHERE n.node_object_type IN (${marks(types.length)})`
    const params = [this.#db.dialect.fullTextQuery(terms), ...types]
    const [count] = await this.#db.query<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, params)
    const rows = await this.#db.query<{ id: number; key: string; score: number }>(
      `SELECT n.id, n.unique_id AS key, h.score ${from} ORDER BY h.score DESC, n.id LIMIT ? OFFSET ?`,
      [...params, paging.take, paging.skip],
    )
    const items: SearchHit[] = []
    for (const row of rows) {
      const stored = await this.#db.query<{ fields: string }>(
        'SELECT fields FROM search_document WHERE node_id = ? ORDER BY culture',
        [Number(row.id)],
      )
      const merged = new Map<string, string[]>()
      for (const entry of stored)
        for (const [name, values] of Object.entries(
          JSON.parse(entry.fields) as Record<string, string[]>,
        ))
          merged.set(name, [...new Set([...(merged.get(name) ?? []), ...values])])
      items.push({
        key: String(row.key),
        score: Number(row.score),
        fields: [...merged].map(([name, values]) => ({ name, values })),
      })
    }
    return { total: Number(count?.n ?? 0), items }
  }
}

async function writeEntries(tx: Db, nodeId: number, entries: readonly SearchEntry[]) {
  await tx.exec('DELETE FROM search_document WHERE node_id = ?', [nodeId])
  const now = DbDate.toDb(new Date())
  for (const entry of entries)
    await tx.exec(
      `INSERT INTO search_document (node_id, culture, name, body, fields, field_count, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        nodeId,
        entry.culture,
        entry.name,
        entry.body,
        JSON.stringify(entry.fields),
        Object.keys(entry.fields).length,
        now,
      ],
    )
}

const folded = (texts: readonly string[]) => texts.flatMap(searchWords).join(' ')

/**
 * The element-type properties marked `searchable = false`, by type key and
 * alias, for the blocks inside a value. A property a composition contributes
 * counts on every type composing it, which is the key a block carries.
 */
async function unsearchableElementProperties(db: Db): Promise<UnsearchableProperty> {
  const rows = await db.query<{ type_id: number; alias: string }>(
    `SELECT p.content_type_id AS type_id, p.alias FROM property_type p
     WHERE p.searchable = ? AND p.retired_at IS NULL`,
    [db.dialect.boolValue(false)],
  )
  if (rows.length === 0) return () => false
  const composedBy = new Map<number, number[]>()
  for (const row of await db.query<{ parent: number; child: number }>(
    'SELECT parent_content_type_id AS parent, child_content_type_id AS child FROM content_type_composition',
  ))
    composedBy.set(Number(row.parent), [
      ...(composedBy.get(Number(row.parent)) ?? []),
      Number(row.child),
    ])
  const keys = new Map<number, string>()
  for (const row of await db.query<{ id: number; unique_id: string }>(
    `SELECT n.id, n.unique_id FROM node n JOIN content_type ct ON ct.node_id = n.id`,
  ))
    keys.set(Number(row.id), String(row.unique_id).toLowerCase())
  const hidden = new Set<string>()
  for (const row of rows) {
    const seen = new Set<number>()
    const pending = [Number(row.type_id)]
    while (pending.length > 0) {
      const id = pending.pop() as number
      if (seen.has(id)) continue
      seen.add(id)
      hidden.add(`${keys.get(id)}|${row.alias}`)
      pending.push(...(composedBy.get(id) ?? []))
    }
  }
  return (typeKey, alias) => hidden.has(`${typeKey.toLowerCase()}|${alias}`)
}

/**
 * What the index holds for an item, from its current (draft) values: a row per
 * culture it has a name in, each carrying the invariant values too, or one
 * invariant row. Retired properties are left out, and so is sensitive member
 * data, which a search must not reveal to somebody who cannot see it. Trashed
 * items are kept and filtered when searched, so the recycle bin is searchable.
 */
export async function entriesFor(db: Db, nodeId: number): Promise<SearchEntry[]> {
  const [node] = await db.query<Record<string, unknown>>(
    `SELECT n.id, n.unique_id, n.text, n.path, n.node_object_type, n.trashed, ct.alias AS type_alias
     FROM node n JOIN content c ON c.node_id = n.id JOIN content_type ct ON ct.node_id = c.content_type_id
     WHERE n.id = ?`,
    [nodeId],
  )
  if (!node || !INDEXED_TYPES.includes(String(node.node_object_type))) return []

  const values = await db.query<Record<string, unknown>>(
    `SELECT p.alias, l.iso_code, pv.varchar_value, pv.text_value
     FROM property_value pv
     JOIN property_type p ON p.id = pv.property_type_id
     LEFT JOIN language l ON l.id = pv.language_id
     LEFT JOIN member_property_type mpt ON mpt.property_type_id = p.id
     WHERE pv.node_id = ? AND pv.is_current = ? AND p.retired_at IS NULL AND p.searchable = ?
       AND (mpt.is_sensitive IS NULL OR mpt.is_sensitive = ?)
     ORDER BY p.sort_order, p.id`,
    [nodeId, db.dialect.boolValue(true), db.dialect.boolValue(true), db.dialect.boolValue(false)],
  )
  const unsearchable = await unsearchableElementProperties(db)
  const names = await db.query<{ iso_code: string; name: string }>(
    `SELECT l.iso_code, cvcv.name FROM content_version cv
     JOIN content_version_culture_variation cvcv ON cvcv.version_id = cv.id
     JOIN language l ON l.id = cvcv.language_id
     WHERE cv.node_id = ? AND cv.current = ?
     ORDER BY l.iso_code`,
    [nodeId, db.dialect.boolValue(true)],
  )
  const extraNames: string[] = []
  const extraFields: Record<string, string[]> = {}
  if (String(node.node_object_type) === ObjectTypes.Member) {
    const [member] = await db.query<{ email: string; login_name: string }>(
      'SELECT email, login_name FROM member WHERE node_id = ?',
      [nodeId],
    )
    if (member) {
      extraNames.push(String(member.email), String(member.login_name))
      extraFields.email = [String(member.email)]
      extraFields.loginName = [String(member.login_name)]
    }
  }

  const textOf = (culture: string | null) => {
    const fields: Record<string, string[]> = {}
    for (const row of values) {
      const iso = row.iso_code === null || row.iso_code === undefined ? null : String(row.iso_code)
      if (iso !== null && iso.toLowerCase() !== culture?.toLowerCase()) continue
      const texts = valueText(row.text_value ?? row.varchar_value, unsearchable)
      if (texts.length === 0) continue
      const name = iso ? `${String(row.alias)}_${iso.toLowerCase()}` : String(row.alias)
      fields[name] = [...(fields[name] ?? []), ...texts]
    }
    return fields
  }

  const base = (culture: string, name: string): SearchEntry => {
    const valueFields = textOf(culture || null)
    const fields: Record<string, string[]> = {
      __NodeId: [String(node.id)],
      __Key: [String(node.unique_id)],
      __IndexType: [INDEX_TYPE[String(node.node_object_type)] ?? 'content'],
      __NodeTypeAlias: [String(node.type_alias)],
      __Path: [String(node.path)],
      ...(fromDbBool(node.trashed) ? { __Trashed: ['true'] } : {}),
      nodeName: [name],
      ...(culture ? { __Culture: [culture] } : {}),
      ...extraFields,
      ...valueFields,
    }
    return {
      culture,
      name: folded([name, ...extraNames]),
      body: folded(Object.values(valueFields).flat()),
      fields,
    }
  }

  if (names.length === 0) return [base('', String(node.text ?? ''))]
  return names.map((row) => base(String(row.iso_code).toLowerCase(), String(row.name)))
}
