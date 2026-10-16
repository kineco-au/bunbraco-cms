/**
 * Site search for visitors (story 140): what a page puts in the index, from
 * its published values only, and the query a results page runs. The indexer
 * that writes backoffice search rows writes these too (`search.ts`), from the
 * same queue. docs/search.md.
 */
import { ObjectTypes, type SiteSearchLevel } from '@crombolo/core'
import type { Db } from './database.ts'
import { DbDate, fromDbBool } from './dialect.ts'
import { publishedValueRows } from './repositories/documents.ts'
import { hiddenElementProperties } from './search.ts'
import { searchTerms, searchWords, valueText } from './search-text.ts'

/** A page's text as written, by weight: what an excerpt is cut from. */
export interface SiteSearchText {
  name: string
  high: string[]
  normal: string[]
  low: string[]
}

/** One row of `site_search_document`: a page in one culture, '' when invariant. */
export interface SiteSearchEntry {
  culture: string
  text: SiteSearchText
}

export interface SiteSearchOptions {
  /** The culture searched, lowercase; an invariant page matches every culture. */
  culture: string
  /** Content type aliases; every searchable type when empty or absent. */
  types?: readonly string[]
  skip: number
  take: number
  /**
   * Protected nodes, by id, that the person searching may not open and may:
   * `branchAccess` in `@crombolo/core`. A page is left out when the nearest
   * protected node on its path is denied.
   */
  access?: { denied: readonly number[]; allowed: readonly number[] }
}

export interface SiteSearchHit {
  key: string
  culture: string
  score: number
  text: SiteSearchText
}

const LEVELS: readonly SiteSearchLevel[] = ['high', 'normal', 'low']

const folded = (texts: readonly string[]) => texts.flatMap(searchWords).join(' ')

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

/**
 * What the site-search index holds for a page: a row per published culture,
 * or one invariant row, from the values that culture shows visitors. Nothing
 * for a page that is unpublished or trashed, whose type has no component (it
 * has no address) or is left out of site search, or for anything not a page.
 * A property marked `site-search = false` or `searchable = false` is left out,
 * here and inside blocks.
 */
export async function siteEntriesFor(db: Db, nodeId: number): Promise<SiteSearchEntry[]> {
  const [node] = await db.query<Record<string, unknown>>(
    `SELECT n.node_object_type, n.trashed, c.content_type_id, ct.site_search, ct.is_element, d.published,
            (SELECT COUNT(*) FROM content_type_template t WHERE t.content_type_node_id = ct.node_id) AS components
     FROM node n JOIN content c ON c.node_id = n.id JOIN content_type ct ON ct.node_id = c.content_type_id
     JOIN document d ON d.node_id = n.id
     WHERE n.id = ?`,
    [nodeId],
  )
  if (
    !node ||
    String(node.node_object_type) !== ObjectTypes.Document ||
    fromDbBool(node.trashed) ||
    !fromDbBool(node.published) ||
    !fromDbBool(node.site_search) ||
    fromDbBool(node.is_element) ||
    Number(node.components) === 0
  )
    return []

  const [invariant] = await db.query<{ id: number; text: string | null }>(
    `SELECT cv.id, cv.text FROM content_version cv JOIN document_version dv ON dv.id = cv.id
     WHERE cv.node_id = ? AND dv.published = ? ORDER BY cv.id DESC LIMIT 1`,
    [nodeId, db.dialect.boolValue(true)],
  )
  if (!invariant) return []
  const cultures = (
    await db.query<Record<string, unknown>>(
      `SELECT dcv.language_id, l.iso_code, dcv.published_event_id, dcv.published_name, dcv.name
       FROM document_culture_variation dcv JOIN language l ON l.id = dcv.language_id
       WHERE dcv.node_id = ? AND dcv.published = ?`,
      [nodeId, db.dialect.boolValue(true)],
    )
  ).map((row) => ({
    languageId: Number(row.language_id),
    culture: String(row.iso_code).toLowerCase(),
    eventId: Number(row.published_event_id ?? 0),
    name: String(row.published_name ?? row.name ?? ''),
  }))

  const latest = Math.max(Number(invariant.id), ...cultures.map((c) => c.eventId))
  const history = (
    await db.query<Record<string, unknown>>(
      `SELECT pv.id, pv.event_id, pv.property_type_id, pv.language_id, pv.segment,
              pv.varchar_value, pv.text_value, p.alias, p.site_search
       FROM property_value pv JOIN property_type p ON p.id = pv.property_type_id
       WHERE pv.node_id = ? AND pv.event_id <= ? AND p.retired_at IS NULL
         AND p.searchable = ? AND p.site_search <> 'off'
       ORDER BY pv.id`,
      [nodeId, latest, db.dialect.boolValue(true)],
    )
  ).map((row) => ({
    eventId: Number(row.event_id),
    propertyTypeId: Number(row.property_type_id),
    languageId: row.language_id === null ? null : Number(row.language_id),
    segment: (row.segment as string | null) ?? null,
    raw: row.text_value ?? row.varchar_value,
    level: (LEVELS as readonly string[]).includes(String(row.site_search))
      ? (String(row.site_search) as SiteSearchLevel)
      : 'normal',
  }))
  const shown = publishedValueRows(history, Number(invariant.id), cultures).filter(
    (row) => row.segment === null,
  )
  const hidden = await hiddenElementProperties(db, "p.searchable = ? OR p.site_search = 'off'", [
    db.dialect.boolValue(false),
  ])

  const entry = (culture: string, languageId: number | null, name: string): SiteSearchEntry => {
    const text: SiteSearchText = { name, high: [], normal: [], low: [] }
    for (const row of shown) {
      if (row.languageId !== null && row.languageId !== languageId) continue
      text[row.level].push(...valueText(row.raw, hidden))
    }
    return { culture, text }
  }
  if (cultures.length === 0) return [entry('', null, String(invariant.text ?? ''))]
  return cultures.map((c) => entry(c.culture, c.languageId, c.name))
}

/** Replaces a page's site-search rows. */
export async function writeSiteEntries(
  tx: Db,
  nodeId: number,
  entries: readonly SiteSearchEntry[],
): Promise<void> {
  await tx.exec('DELETE FROM site_search_document WHERE node_id = ?', [nodeId])
  const now = DbDate.toDb(new Date())
  for (const entry of entries)
    await tx.exec(
      `INSERT INTO site_search_document (node_id, culture, name, high, normal, low, text, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nodeId,
        entry.culture,
        folded([entry.text.name]),
        folded(entry.text.high),
        folded(entry.text.normal),
        folded(entry.text.low),
        JSON.stringify(entry.text),
        now,
      ],
    )
}

/**
 * The visitor search over published pages. Every word of the query must be in
 * a page as a word prefix; the name counts most, then the high, normal and low
 * properties. Pages the person searching may not open are left out in the query
 * itself, so `total` counts only what they may see.
 */
export class SiteSearch {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async query(
    term: string,
    options: SiteSearchOptions,
  ): Promise<{ total: number; items: SiteSearchHit[] }> {
    const terms = searchTerms(term)
    if (terms.length === 0) return { total: 0, items: [] }
    const where = ['s.culture IN (?, ?)', 'n.trashed = ?']
    const params: unknown[] = [
      this.#db.dialect.fullTextQuery(terms),
      options.culture.toLowerCase(),
      '',
      this.#db.dialect.boolValue(false),
    ]
    const types = options.types?.filter(Boolean) ?? []
    if (types.length > 0) {
      where.push(`ct.alias IN (${marks(types.length)})`)
      params.push(...types)
    }
    const denied = options.access?.denied ?? []
    const allowed = options.access?.allowed ?? []
    if (denied.length > 0) {
      // Closed: under a denied node, with no allowed node between it and the page.
      const opened =
        allowed.length === 0
          ? ''
          : `AND NOT EXISTS (SELECT 1 FROM node q WHERE q.id IN (${marks(allowed.length)})
               AND (q.id = n.id OR n.path LIKE q.path || ',%') AND q.path LIKE p.path || ',%')`
      where.push(
        `NOT EXISTS (SELECT 1 FROM node p WHERE p.id IN (${marks(denied.length)})
           AND (p.id = n.id OR n.path LIKE p.path || ',%') ${opened})`,
      )
      params.push(...denied, ...allowed)
    }
    const from = `FROM (${this.#db.dialect.siteSearchHits}) h
      JOIN site_search_document s ON s.id = h.row_id
      JOIN node n ON n.id = s.node_id
      JOIN content c ON c.node_id = n.id
      JOIN content_type ct ON ct.node_id = c.content_type_id
      WHERE ${where.join(' AND ')}`
    const [count] = await this.#db.query<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, params)
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT n.unique_id AS key, s.culture, s.text, h.score ${from}
       ORDER BY h.score DESC, n.id LIMIT ? OFFSET ?`,
      [...params, options.take, options.skip],
    )
    return {
      total: Number(count?.n ?? 0),
      items: rows.map((row) => ({
        key: String(row.key).toLowerCase(),
        culture: String(row.culture),
        score: Number(row.score),
        text: JSON.parse(String(row.text)) as SiteSearchText,
      })),
    }
  }
}
