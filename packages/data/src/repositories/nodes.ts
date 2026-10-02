/**
 * Shared access to `node`, the universal tree.
 *
 * Every tree in the backoffice — documents, content types, data types, templates —
 * is the same query with a different object type, so it lives here once.
 */
import { normaliseUuid, ObjectTypes, type Page, SystemNodes } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'

export interface NodeRow {
  id: number
  key: string
  parentId: number
  level: number
  path: string
  sortOrder: number
  trashed: boolean
  text: string | null
  objectType: string | null
  createDate: Date | undefined
}

export function mapNode(row: Record<string, unknown>): NodeRow {
  return {
    id: Number(row.id),
    key: normaliseUuid(String(row.unique_id)),
    parentId: Number(row.parent_id),
    level: Number(row.level),
    path: String(row.path),
    sortOrder: Number(row.sort_order),
    trashed: fromDbBool(row.trashed),
    text: (row.text as string | null) ?? null,
    objectType: row.node_object_type ? normaliseUuid(String(row.node_object_type)) : null,
    createDate: DbDate.fromDb(row.create_date),
  }
}

const NODE_COLUMNS =
  'id, unique_id, parent_id, level, path, sort_order, trashed, text, node_object_type, create_date'

export interface CreateNodeInit {
  key?: string
  parentId: number
  objectType: string
  text: string
  userId?: number
  sortOrder?: number
}

export class NodeRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async byKey(key: string): Promise<NodeRow | undefined> {
    const rows = await this.#db.query(`SELECT ${NODE_COLUMNS} FROM node WHERE unique_id = ?`, [
      normaliseUuid(key),
    ])
    return rows[0] ? mapNode(rows[0]) : undefined
  }

  async byId(id: number): Promise<NodeRow | undefined> {
    const rows = await this.#db.query(`SELECT ${NODE_COLUMNS} FROM node WHERE id = ?`, [id])
    return rows[0] ? mapNode(rows[0]) : undefined
  }

  async byKeys(keys: readonly string[]): Promise<NodeRow[]> {
    if (keys.length === 0) return []
    const placeholders = keys.map(() => '?').join(', ')
    const rows = await this.#db.query(
      `SELECT ${NODE_COLUMNS} FROM node WHERE unique_id IN (${placeholders})`,
      keys.map(normaliseUuid),
    )
    return rows.map(mapNode)
  }

  /**
   * Creates a node, computing `level` and the materialised `path` from the
   * parent. The path is what makes descendant queries a prefix match.
   */
  async create(init: CreateNodeInit): Promise<NodeRow> {
    const key = normaliseUuid(init.key ?? crypto.randomUUID())
    const parent = init.parentId === SystemNodes.Root ? undefined : await this.byId(init.parentId)
    const level = parent ? parent.level + 1 : 1
    const sortOrder = init.sortOrder ?? (await this.#nextSortOrder(init.parentId, init.objectType))
    const now = DbDate.toDb(new Date())

    await this.#db.exec(
      `INSERT INTO node
         (unique_id, parent_id, level, path, sort_order, trashed, node_user, text, node_object_type, create_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        init.parentId,
        level,
        '',
        sortOrder,
        this.#db.dialect.boolValue(false),
        init.userId ?? null,
        init.text,
        init.objectType,
        now,
      ],
    )
    const created = await this.byKey(key)
    if (!created) throw new Error('Node insert did not produce a row.')

    const path = parent ? `${parent.path},${created.id}` : `${SystemNodes.Root},${created.id}`
    await this.#db.exec('UPDATE node SET path = ? WHERE id = ?', [path, created.id])
    return { ...created, path }
  }

  async rename(id: number, text: string): Promise<void> {
    await this.#db.exec('UPDATE node SET text = ? WHERE id = ?', [text, id])
  }

  async delete(id: number): Promise<void> {
    await this.#db.exec('DELETE FROM node WHERE id = ?', [id])
  }

  /** Root-level items of a type, i.e. those parented to the system root. */
  async roots(objectType: string, skip: number, take: number): Promise<Page<NodeRow>> {
    return this.children(SystemNodes.Root, objectType, skip, take)
  }

  async children(
    parentId: number,
    objectType: string,
    skip: number,
    take: number,
    trashed = false,
  ): Promise<Page<NodeRow>> {
    const totals = await this.#db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM node WHERE parent_id = ? AND node_object_type = ? AND trashed = ?',
      [parentId, objectType, this.#db.dialect.boolValue(trashed)],
    )
    const rows = await this.#db.query(
      `SELECT ${NODE_COLUMNS} FROM node
       WHERE parent_id = ? AND node_object_type = ? AND trashed = ?
       ORDER BY sort_order, id
       LIMIT ? OFFSET ?`,
      [parentId, objectType, this.#db.dialect.boolValue(trashed), take, skip],
    )
    return { total: Number(totals[0]?.n ?? 0), items: rows.map(mapNode) }
  }

  /** Children of several object types at once: a settings tree with folders first, then by name. */
  async childrenOf(
    parentId: number,
    objectTypes: readonly string[],
    skip: number,
    take: number,
  ): Promise<Page<NodeRow>> {
    if (objectTypes.length === 0) return { total: 0, items: [] }
    const marks = objectTypes.map(() => '?').join(', ')
    const f = this.#db.dialect.boolValue(false)
    const totals = await this.#db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM node WHERE parent_id = ? AND node_object_type IN (${marks}) AND trashed = ?`,
      [parentId, ...objectTypes, f],
    )
    const rows = await this.#db.query(
      `SELECT ${NODE_COLUMNS} FROM node
       WHERE parent_id = ? AND node_object_type IN (${marks}) AND trashed = ?
       ORDER BY CASE WHEN node_object_type = ? THEN 0 ELSE 1 END, text, id
       LIMIT ? OFFSET ?`,
      [parentId, ...objectTypes, f, objectTypes[0], take, skip],
    )
    return { total: Number(totals[0]?.n ?? 0), items: rows.map(mapNode) }
  }

  /** Re-parents a node and its descendants, keeping levels and paths true. */
  async move(id: number, newParentId: number): Promise<void> {
    const node = await this.byId(id)
    if (!node) return
    const parent = newParentId === SystemNodes.Root ? undefined : await this.byId(newParentId)
    const newPath = parent ? `${parent.path},${node.id}` : `${SystemNodes.Root},${node.id}`
    const newLevel = parent ? parent.level + 1 : 1
    const delta = newLevel - node.level
    const oldPath = node.path
    await this.#db.exec('UPDATE node SET parent_id = ?, level = ?, path = ? WHERE id = ?', [
      newParentId,
      newLevel,
      newPath,
      node.id,
    ])
    const descendants = await this.#db.query<{ id: number; path: string; level: number }>(
      'SELECT id, path, level FROM node WHERE path LIKE ?',
      [`${oldPath},%`],
    )
    for (const d of descendants) {
      await this.#db.exec('UPDATE node SET path = ?, level = ? WHERE id = ?', [
        `${newPath}${String(d.path).slice(oldPath.length)}`,
        Number(d.level) + delta,
        Number(d.id),
      ])
    }
  }

  /** A window of a node's siblings around it: `before` above, `after` below, the node itself included. */
  async siblings(
    key: string,
    objectType: string | readonly string[],
    before: number,
    after: number,
  ): Promise<{ items: NodeRow[]; totalBefore: number; totalAfter: number } | undefined> {
    const target = await this.byKey(key)
    if (!target) return undefined
    const types = typeof objectType === 'string' ? [objectType] : [...objectType]
    const marks = types.map(() => '?').join(', ')
    const order =
      types.length > 1
        ? 'CASE WHEN node_object_type = ? THEN 0 ELSE 1 END, text, id'
        : 'sort_order, id'
    const all = await this.#db.query(
      `SELECT ${NODE_COLUMNS} FROM node WHERE parent_id = ? AND node_object_type IN (${marks}) AND trashed = ?
       ORDER BY ${order}`,
      [
        target.parentId,
        ...types,
        this.#db.dialect.boolValue(target.trashed),
        ...(types.length > 1 ? [types[0]] : []),
      ],
    )
    const rows = all.map(mapNode)
    const index = rows.findIndex((row) => row.id === target.id)
    const start = Math.max(0, index - before)
    const end = Math.min(rows.length, index + after + 1)
    return { items: rows.slice(start, end), totalBefore: start, totalAfter: rows.length - end }
  }

  /** Name search, case-insensitive, optionally under a parent. */
  async search(
    objectType: string,
    query: string,
    options: { trashed?: boolean; parentId?: number; skip: number; take: number },
  ): Promise<Page<NodeRow>> {
    const conditions = ['node_object_type = ?', 'trashed = ?', 'LOWER(text) LIKE ?']
    const params: unknown[] = [
      objectType,
      this.#db.dialect.boolValue(options.trashed ?? false),
      `%${query.toLowerCase().replaceAll('%', '').replaceAll('_', '')}%`,
    ]
    if (options.parentId !== undefined) {
      conditions.push('parent_id = ?')
      params.push(options.parentId)
    }
    const where = conditions.join(' AND ')
    const totals = await this.#db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM node WHERE ${where}`,
      params,
    )
    const rows = await this.#db.query(
      `SELECT ${NODE_COLUMNS} FROM node WHERE ${where} ORDER BY text, id LIMIT ? OFFSET ?`,
      [...params, options.take, options.skip],
    )
    return { total: Number(totals[0]?.n ?? 0), items: rows.map(mapNode) }
  }

  /** Ancestors of a node, root first, excluding the node itself. */
  async ancestors(key: string): Promise<NodeRow[]> {
    const node = await this.byKey(key)
    if (!node) return []
    const ids = node.path
      .split(',')
      .map((part) => Number(part))
      .filter((id) => id > 0 && id !== node.id)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = await this.#db.query(
      `SELECT ${NODE_COLUMNS} FROM node WHERE id IN (${placeholders}) ORDER BY level`,
      ids,
    )
    return rows.map(mapNode)
  }

  /**
   * Every descendant of a node, parents before children. The materialised
   * `path` makes this one prefix query rather than a walk — the same trick
   * `move` uses to re-parent a branch.
   *
   * Trashed nodes are excluded: a bundle of a subtree should not carry what
   * somebody deleted out of it.
   */
  async descendants(node: NodeRow, objectTypes: readonly string[]): Promise<NodeRow[]> {
    if (objectTypes.length === 0) return []
    const marks = objectTypes.map(() => '?').join(', ')
    const rows = await this.#db.query(
      `SELECT ${NODE_COLUMNS} FROM node
       WHERE path LIKE ? AND node_object_type IN (${marks}) AND trashed = ?
       ORDER BY level, sort_order, id`,
      [`${node.path},%`, ...objectTypes, this.#db.dialect.boolValue(false)],
    )
    return rows.map(mapNode)
  }

  /** The children of a node with a given name, for resolving a content path a segment at a time. */
  async childrenNamed(
    parentId: number,
    objectTypes: readonly string[],
    name: string,
  ): Promise<NodeRow[]> {
    if (objectTypes.length === 0) return []
    const marks = objectTypes.map(() => '?').join(', ')
    const rows = await this.#db.query(
      `SELECT ${NODE_COLUMNS} FROM node
       WHERE parent_id = ? AND node_object_type IN (${marks}) AND trashed = ?
         AND LOWER(text) = LOWER(?)
       ORDER BY sort_order, id`,
      [parentId, ...objectTypes, this.#db.dialect.boolValue(false), name],
    )
    return rows.map(mapNode)
  }

  /** The names under a node, so a failed path resolution can say what was there. */
  async childNames(parentId: number, objectTypes: readonly string[]): Promise<string[]> {
    if (objectTypes.length === 0) return []
    const marks = objectTypes.map(() => '?').join(', ')
    const rows = await this.#db.query<{ text: string | null }>(
      `SELECT text FROM node
       WHERE parent_id = ? AND node_object_type IN (${marks}) AND trashed = ?
       ORDER BY sort_order, id`,
      [parentId, ...objectTypes, this.#db.dialect.boolValue(false)],
    )
    return rows.flatMap((row) => (row.text ? [String(row.text)] : []))
  }

  async hasChildren(id: number, objectType: string): Promise<boolean> {
    const rows = await this.#db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM node WHERE parent_id = ? AND node_object_type = ?',
      [id, objectType],
    )
    return Number(rows[0]?.n ?? 0) > 0
  }

  /** Bulk `hasChildren`, so a tree page costs one query instead of one per row. */
  async childCounts(ids: readonly number[], objectType: string): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(', ')
    const rows = await this.#db.query<{ parent_id: number; n: number }>(
      `SELECT parent_id, COUNT(*) AS n FROM node
       WHERE parent_id IN (${placeholders}) AND node_object_type = ?
       GROUP BY parent_id`,
      [...ids, objectType],
    )
    return new Map(rows.map((row) => [Number(row.parent_id), Number(row.n)]))
  }

  async #nextSortOrder(parentId: number, objectType: string): Promise<number> {
    const rows = await this.#db.query<{ next: number | null }>(
      'SELECT MAX(sort_order) AS next FROM node WHERE parent_id = ? AND node_object_type = ?',
      [parentId, objectType],
    )
    const current = rows[0]?.next
    return current === null || current === undefined ? 0 : Number(current) + 1
  }
}

export { ObjectTypes, SystemNodes }
