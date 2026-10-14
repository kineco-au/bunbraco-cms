/**
 * Dynamic roots: a content picker's start node, found from the document being
 * edited by an origin and a list of steps, as Umbraco's are. docs/api-contract.md.
 */
import { normaliseUuid, ObjectTypes } from '@crombolo/core'
import type { Db } from '../database.ts'

export interface DynamicRootQuery {
  /** The document being edited; null while it is being created. */
  currentKey: string | null
  /** Its parent; null at the root of the tree. */
  parentKey: string | null
  origin: { alias: string; key?: string | null }
  steps: Array<{ alias: string; documentTypeKeys: string[] }>
}

interface Node {
  id: number
  key: string
  level: number
  path: string
  typeKey: string
}

/** The virtual root above the tree: ContentRoot's origin, which descendant steps start from. */
const CONTENT_ROOT: Node = { id: -1, key: '', level: 0, path: '-1', typeKey: '' }

const SELECT = `SELECT n.id, n.unique_id, n.level, n.path, t.unique_id AS type_key
  FROM node n
  JOIN content c ON c.node_id = n.id
  JOIN node t ON t.id = c.content_type_id`

export class DynamicRootRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  /** The keys the query lands on, nearest first; empty when it finds nothing. */
  async resolve(query: DynamicRootQuery): Promise<string[]> {
    const origin = await this.#origin(query)
    if (!origin) return []
    let found: Node[] = [origin]
    for (const step of query.steps) {
      const types = new Set(step.documentTypeKeys.map((key) => normaliseUuid(key)))
      const next = new Map<number, Node>()
      for (const node of found)
        for (const hit of await this.#step(node, step.alias, types)) next.set(hit.id, hit)
      found = [...next.values()]
      if (found.length === 0) return []
    }
    return found.filter((node) => node.id !== CONTENT_ROOT.id).map((node) => node.key)
  }

  async #origin(query: DynamicRootQuery): Promise<Node | undefined> {
    const context = query.currentKey ?? query.parentKey
    switch (query.origin.alias) {
      case 'ContentRoot':
        return CONTENT_ROOT
      case 'ByKey':
        return query.origin.key ? this.#byKey(query.origin.key) : undefined
      case 'Current':
        return query.currentKey ? this.#byKey(query.currentKey) : undefined
      case 'Parent':
        return query.parentKey ? this.#byKey(query.parentKey) : undefined
      case 'Root':
        return context ? this.#root(context) : undefined
      case 'Site':
        return context ? ((await this.#site(context)) ?? this.#root(context)) : undefined
      default:
        return undefined
    }
  }

  async #step(node: Node, alias: string, types: Set<string>): Promise<Node[]> {
    const matches = (candidate: Node) => types.size === 0 || types.has(candidate.typeKey)
    switch (alias) {
      case 'NearestAncestorOrSelf':
      case 'FurthestAncestorOrSelf': {
        const line = (await this.#ancestorsOrSelf(node)).filter(matches)
        const pick = alias === 'NearestAncestorOrSelf' ? line.at(-1) : line[0]
        return pick ? [pick] : []
      }
      case 'NearestDescendantOrSelf':
      case 'FurthestDescendantOrSelf': {
        const below = (await this.#descendantsOrSelf(node)).filter(matches)
        if (below.length === 0) return []
        const levels = below.map((candidate) => candidate.level)
        const level =
          alias === 'NearestDescendantOrSelf' ? Math.min(...levels) : Math.max(...levels)
        return below.filter((candidate) => candidate.level === level)
      }
      default:
        return []
    }
  }

  async #query(where: string, params: unknown[]): Promise<Node[]> {
    const rows = await this.#db.query(
      `${SELECT} WHERE n.node_object_type = ? AND n.trashed = ? AND ${where} ORDER BY n.level, n.sort_order`,
      [ObjectTypes.Document, this.#db.dialect.boolValue(false), ...params],
    )
    return rows.map((row) => ({
      id: Number(row.id),
      key: normaliseUuid(String(row.unique_id)),
      level: Number(row.level),
      path: String(row.path),
      typeKey: normaliseUuid(String(row.type_key)),
    }))
  }

  async #byKey(key: string): Promise<Node | undefined> {
    return (await this.#query('n.unique_id = ?', [normaliseUuid(key)]))[0]
  }

  /** Top of the tree first, `node` last. */
  async #ancestorsOrSelf(node: Node): Promise<Node[]> {
    if (node.id === CONTENT_ROOT.id) return []
    const ids = node.path
      .split(',')
      .map(Number)
      .filter((id) => id > 0)
    if (ids.length === 0) return []
    return this.#query(`n.id IN (${ids.map(() => '?').join(', ')})`, ids)
  }

  async #descendantsOrSelf(node: Node): Promise<Node[]> {
    if (node.id === CONTENT_ROOT.id) return this.#query('n.level >= 1', [])
    return this.#query('(n.id = ? OR n.path LIKE ?)', [node.id, `${node.path},%`])
  }

  async #root(key: string): Promise<Node | undefined> {
    const node = await this.#byKey(key)
    return node ? (await this.#ancestorsOrSelf(node))[0] : undefined
  }

  /** The nearest ancestor-or-self that a hostname makes a site root. */
  async #site(key: string): Promise<Node | undefined> {
    const node = await this.#byKey(key)
    if (!node) return undefined
    const line = await this.#ancestorsOrSelf(node)
    if (line.length === 0) return undefined
    const rows = await this.#db.query<{ node_id: number }>(
      `SELECT DISTINCT node_id FROM domain WHERE domain_name NOT LIKE '*%' AND node_id IN (${line.map(() => '?').join(', ')})`,
      line.map((candidate) => candidate.id),
    )
    const sites = new Set(rows.map((row) => Number(row.node_id)))
    return line.filter((candidate) => sites.has(candidate.id)).at(-1)
  }
}
