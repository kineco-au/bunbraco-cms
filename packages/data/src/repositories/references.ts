/**
 * What refers to what, derived from the values themselves.
 *
 * Umbraco keeps a `umbracoRelation` row per reference, written when content is
 * saved. Deriving the answer from the current property values instead cannot go
 * stale — a relation table is only as good as the last save that maintained it —
 * and needs no migration. The cost is a scan of `property_value`, which is
 * acceptable for an editor asking "what breaks if I delete this?".
 *
 * A picker stores its target as `umb://document/<hex>` or a bare uuid, so both
 * spellings are matched.
 */
import { normaliseUuid } from '@bunbraco/core'
import type { Db } from '../database.ts'

export interface ReferencingNode {
  key: string
  name: string | null
  objectType: string | null
  published: boolean | null
  contentTypeKey: string | null
  contentTypeAlias: string | null
  contentTypeIcon: string | null
}

/** The two spellings a key appears in inside a stored value. */
function patterns(key: string): [string, string] {
  const dashed = normaliseUuid(key)
  return [`%${dashed}%`, `%${dashed.replaceAll('-', '')}%`]
}

export class ReferenceRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  /** Node ids whose current values mention any of `keys`, excluding `keys` themselves. */
  async #referencingIds(keys: readonly string[]): Promise<Map<string, number[]>> {
    const found = new Map<string, number[]>()
    for (const key of keys) {
      const [dashed, plain] = patterns(key)
      const rows = await this.#db.query<{ id: number }>(
        `SELECT DISTINCT pv.node_id AS id
           FROM property_value pv
          WHERE pv.is_current = ?
            AND ( LOWER(pv.varchar_value) LIKE ? OR LOWER(pv.text_value) LIKE ?
               OR LOWER(pv.varchar_value) LIKE ? OR LOWER(pv.text_value) LIKE ? )`,
        [this.#db.dialect.boolValue(true), dashed, dashed, plain, plain],
      )
      found.set(
        normaliseUuid(key),
        rows.map((row) => Number(row.id)),
      )
    }
    return found
  }

  async #describe(ids: readonly number[]): Promise<ReferencingNode[]> {
    if (ids.length === 0) return []
    const holes = ids.map(() => '?').join(', ')
    const rows = await this.#db.query<{
      unique_id: string
      text: string | null
      node_object_type: string | null
      published: unknown
      type_key: string | null
      type_alias: string | null
      type_icon: string | null
    }>(
      `SELECT n.unique_id, n.text, n.node_object_type,
              d.published AS published,
              tn.unique_id AS type_key, ct.alias AS type_alias, ct.icon AS type_icon
         FROM node n
         LEFT JOIN content c ON c.node_id = n.id
         LEFT JOIN content_type ct ON ct.node_id = c.content_type_id
         LEFT JOIN node tn ON tn.id = ct.node_id
         LEFT JOIN document d ON d.node_id = n.id
        WHERE n.id IN (${holes})
        ORDER BY n.text`,
      [...ids],
    )
    return rows.map((row) => ({
      key: String(row.unique_id),
      name: row.text,
      objectType: row.node_object_type,
      published: row.published === null || row.published === undefined ? null : !!row.published,
      contentTypeKey: row.type_key ? String(row.type_key) : null,
      contentTypeAlias: row.type_alias,
      contentTypeIcon: row.type_icon,
    }))
  }

  /** What refers to this one, newest name order, paged. */
  async referencedBy(
    key: string,
    skip: number,
    take: number,
  ): Promise<{ total: number; items: ReferencingNode[] }> {
    const self = await this.#db.query<{ id: number }>('SELECT id FROM node WHERE unique_id = ?', [
      normaliseUuid(key),
    ])
    const selfId = self[0]?.id
    const ids = (await this.#referencingIds([key])).get(normaliseUuid(key)) ?? []
    const others = ids.filter((id) => id !== Number(selfId))
    return { total: others.length, items: await this.#describe(others.slice(skip, skip + take)) }
  }

  /**
   * Descendants of this node that something else refers to — what an editor
   * needs before deleting a branch.
   */
  async referencedDescendants(
    key: string,
    skip: number,
    take: number,
  ): Promise<{ total: number; items: string[] }> {
    const self = await this.#db.query<{ id: number; path: string }>(
      'SELECT id, path FROM node WHERE unique_id = ?',
      [normaliseUuid(key)],
    )
    const node = self[0]
    if (!node) return { total: 0, items: [] }
    const descendants = await this.#db.query<{ id: number; unique_id: string }>(
      'SELECT id, unique_id FROM node WHERE path LIKE ? AND id <> ?',
      [`${node.path},%`, node.id],
    )
    const referenced: string[] = []
    for (const descendant of descendants) {
      const ids = (await this.#referencingIds([String(descendant.unique_id)])).values().next()
        .value as number[] | undefined
      // A reference from inside the branch being deleted does not count.
      const outside = (ids ?? []).filter(
        (id) => !descendants.some((d) => Number(d.id) === id) && id !== Number(node.id),
      )
      if (outside.length > 0) referenced.push(String(descendant.unique_id))
    }
    return { total: referenced.length, items: referenced.slice(skip, skip + take) }
  }

  /** Of these keys, the ones something refers to. */
  async areReferenced(
    keys: readonly string[],
    skip: number,
    take: number,
  ): Promise<{ total: number; items: string[] }> {
    const wanted = keys.map(normaliseUuid)
    const found = await this.#referencingIds(wanted)
    const selfIds = new Map<string, number>()
    for (const key of wanted) {
      const rows = await this.#db.query<{ id: number }>('SELECT id FROM node WHERE unique_id = ?', [
        key,
      ])
      if (rows[0]) selfIds.set(key, Number(rows[0].id))
    }
    const referenced = wanted.filter((key) =>
      (found.get(key) ?? []).some((id) => id !== selfIds.get(key)),
    )
    return { total: referenced.length, items: referenced.slice(skip, skip + take) }
  }
}
