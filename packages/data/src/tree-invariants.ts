/**
 * What must hold of the content trees after any mix of concurrent writes: the
 * check is a pure function over rows, and `loadTreeSnapshot` reads those rows.
 */
import { ObjectTypes, SystemNodes } from '@crombolo/core'
import type { Db } from './database.ts'
import { fromDbBool } from './dialect.ts'

export interface TreeNode {
  id: number
  parentId: number
  level: number
  path: string
  sortOrder: number
  trashed: boolean
  objectType: string
}

export interface TreeDocument {
  nodeId: number
  published: boolean
}

export interface TreeVersion {
  id: number
  nodeId: number
  current: boolean
  published: boolean
}

export interface TreeSnapshot {
  nodes: readonly TreeNode[]
  /** Rows of `document`, which media and members share with documents. */
  documents: readonly TreeDocument[]
  versions: readonly TreeVersion[]
  /** Node ids with a `content` row. */
  contentNodeIds: readonly number[]
}

export type TreeRule =
  | 'orphan'
  | 'path'
  | 'level'
  | 'trashed'
  | 'sort-order'
  | 'current-version'
  | 'published-version'
  | 'published-trashed'
  | 'content-row'

export interface TreeViolation {
  nodeId: number
  rule: TreeRule
  detail: string
}

export const TREE_OBJECT_TYPES: readonly string[] = [ObjectTypes.Document, ObjectTypes.Media]

const RECYCLE_BINS: ReadonlySet<number> = new Set([
  SystemNodes.ContentRecycleBin,
  SystemNodes.MediaRecycleBin,
  SystemNodes.ElementRecycleBin,
])

/** Every broken rule in the trees of `objectTypes`; empty when they are consistent. */
export function checkTreeInvariants(
  snapshot: TreeSnapshot,
  objectTypes: readonly string[] = TREE_OBJECT_TYPES,
): TreeViolation[] {
  const checked = new Set(objectTypes)
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const documents = new Map(snapshot.documents.map((doc) => [doc.nodeId, doc]))
  const content = new Set(snapshot.contentNodeIds)
  const versions = new Map<number, TreeVersion[]>()
  for (const version of snapshot.versions) {
    const list = versions.get(version.nodeId)
    if (list) list.push(version)
    else versions.set(version.nodeId, [version])
  }
  const violations: TreeViolation[] = []
  const fail = (nodeId: number, rule: TreeRule, detail: string) =>
    violations.push({ nodeId, rule, detail })
  const siblings = new Map<string, number>()

  for (const node of snapshot.nodes) {
    if (!checked.has(node.objectType)) continue
    const parent = byId.get(node.parentId)
    if (!parent) {
      fail(node.id, 'orphan', `parent ${node.parentId} does not exist`)
      continue
    }
    const inBin = RECYCLE_BINS.has(parent.id)
    const expected = `${parent.path},${node.id}`
    if (node.path !== expected) fail(node.id, 'path', `path ${node.path}, expected ${expected}`)
    if (node.level !== parent.level + 1)
      fail(node.id, 'level', `level ${node.level}, expected ${parent.level + 1}`)
    if ((inBin || parent.trashed) && !node.trashed)
      fail(node.id, 'trashed', 'under the recycle bin but not trashed')
    if (node.trashed && !inBin && !parent.trashed)
      fail(node.id, 'trashed', 'trashed but its parent is not')

    const slot = `${node.parentId}|${node.objectType}|${node.sortOrder}`
    const holder = siblings.get(slot)
    if (holder !== undefined)
      fail(node.id, 'sort-order', `shares sort order ${node.sortOrder} with ${holder}`)
    else siblings.set(slot, node.id)

    const doc = documents.get(node.id)
    if (!doc || !content.has(node.id)) {
      fail(node.id, 'content-row', doc ? 'no content row' : 'no document row')
      continue
    }
    const own = versions.get(node.id) ?? []
    const current = own.filter((v) => v.current).length
    if (own.length > 0 && current !== 1)
      fail(node.id, 'current-version', `${current} current versions`)
    if (doc.published) {
      const published = own.filter((v) => v.published).length
      if (published !== 1) fail(node.id, 'published-version', `${published} published versions`)
      if (node.trashed) fail(node.id, 'published-trashed', 'published while trashed')
    }
  }
  return violations
}

/** The rows `checkTreeInvariants` reads, for the trees of `objectTypes`. */
export async function loadTreeSnapshot(
  db: Db,
  objectTypes: readonly string[] = TREE_OBJECT_TYPES,
): Promise<TreeSnapshot> {
  const marks = objectTypes.map(() => '?').join(', ')
  const scoped = `SELECT id FROM node WHERE node_object_type IN (${marks})`
  const [nodes, documents, versions, content] = await Promise.all([
    db.query('SELECT id, parent_id, level, path, sort_order, trashed, node_object_type FROM node'),
    db.query(`SELECT node_id, published FROM document WHERE node_id IN (${scoped})`, [
      ...objectTypes,
    ]),
    db.query(
      `SELECT cv.id, cv.node_id, cv.current, dv.published FROM content_version cv
       LEFT JOIN document_version dv ON dv.id = cv.id WHERE cv.node_id IN (${scoped})`,
      [...objectTypes],
    ),
    db.query(`SELECT node_id FROM content WHERE node_id IN (${scoped})`, [...objectTypes]),
  ])
  return {
    nodes: nodes.map((row) => ({
      id: Number(row.id),
      parentId: Number(row.parent_id),
      level: Number(row.level),
      path: String(row.path),
      sortOrder: Number(row.sort_order),
      trashed: fromDbBool(row.trashed),
      objectType: String(row.node_object_type).toLowerCase(),
    })),
    documents: documents.map((row) => ({
      nodeId: Number(row.node_id),
      published: fromDbBool(row.published),
    })),
    versions: versions.map((row) => ({
      id: Number(row.id),
      nodeId: Number(row.node_id),
      current: fromDbBool(row.current),
      published: fromDbBool(row.published),
    })),
    contentNodeIds: content.map((row) => Number(row.node_id)),
  }
}
