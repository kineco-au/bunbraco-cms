/**
 * Umbraco's built-in relation types, and their relations derived rather than
 * stored. "Related …" comes from the current values, as references do (story
 * 041). "Relate parent … on delete" comes from the original parent a trashed
 * item remembers. Copies record no origin, so "Relate Document On Copy" has none.
 * docs/data-model.md.
 */
import { createHash } from 'node:crypto'
import { normaliseUuid, ObjectTypes } from '@crombolo/core'
import type { Db } from './database.ts'
import { DbDate, fromDbBool } from './dialect.ts'

/** RFC 4122's URL namespace, which Umbraco's `string.ToGuid()` hashes in. */
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

/** A name-based (version 3, MD5) UUID: the same input always gives the same key. */
export function nameBasedUuid(name: string, namespace = URL_NAMESPACE): string {
  const bytes = createHash('md5')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x30
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type RelationDerivation = 'reference' | 'original-parent' | 'none'

export interface RelationType {
  key: string
  alias: string
  name: string
  parentObjectType: string | null
  childObjectType: string | null
  isBidirectional: boolean
  isDependency: boolean
  derivation: RelationDerivation
  /** For a reference type, what is referred to; for an original-parent type, what was trashed. */
  target: string | null
}

const define = (
  alias: string,
  name: string,
  parentObjectType: string | null,
  childObjectType: string | null,
  isBidirectional: boolean,
  isDependency: boolean,
  derivation: RelationDerivation,
  target: string | null,
): RelationType => ({
  // Umbraco's `CreateUniqueRelationTypeId`, so the keys match a real install's.
  key: nameBasedUuid(`${alias}____${name}`),
  alias,
  name,
  parentObjectType,
  childObjectType,
  isBidirectional,
  isDependency,
  derivation,
  target,
})

/** In Umbraco's install order. */
export const RELATION_TYPES: readonly RelationType[] = [
  define(
    'relateDocumentOnCopy',
    'Relate Document On Copy',
    ObjectTypes.Document,
    ObjectTypes.Document,
    true,
    false,
    'none',
    null,
  ),
  define(
    'relateParentDocumentOnDelete',
    'Relate Parent Document On Delete',
    ObjectTypes.Document,
    ObjectTypes.Document,
    false,
    false,
    'original-parent',
    ObjectTypes.Document,
  ),
  define(
    'relateParentMediaFolderOnDelete',
    'Relate Parent Media Folder On Delete',
    ObjectTypes.Media,
    ObjectTypes.Media,
    false,
    false,
    'original-parent',
    ObjectTypes.Media,
  ),
  define('umbMedia', 'Related Media', null, null, false, true, 'reference', ObjectTypes.Media),
  define(
    'umbDocument',
    'Related Document',
    null,
    null,
    false,
    true,
    'reference',
    ObjectTypes.Document,
  ),
  define('umbMember', 'Related Member', null, null, false, true, 'reference', ObjectTypes.Member),
  define(
    'umbElement',
    'Related Element',
    null,
    null,
    false,
    true,
    'reference',
    ObjectTypes.Element,
  ),
  define(
    'relateParentElementContainerOnElementDelete',
    'Relate Parent Element Container On Element Delete',
    ObjectTypes.ElementContainer,
    ObjectTypes.Element,
    false,
    false,
    'original-parent',
    ObjectTypes.Element,
  ),
  define(
    'relateParentElementContainerOnContainerDelete',
    'Relate Parent Element Container On Container Delete',
    ObjectTypes.ElementContainer,
    ObjectTypes.ElementContainer,
    false,
    false,
    'none',
    null,
  ),
]

export function relationTypeByKey(key: string): RelationType | undefined {
  const wanted = normaliseUuid(key)
  return RELATION_TYPES.find((type) => type.key === wanted)
}

const UDI = /umb:\/\/[a-z-]+\/([0-9a-f]{32})/gi
const UUID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi

/** Every key a stored value mentions, as a picker writes it: `umb://<type>/<hex>` or a bare uuid. */
export function referencedKeysIn(text: string): string[] {
  const keys = new Set<string>()
  for (const match of text.matchAll(UDI)) {
    const hex = (match[1] as string).toLowerCase()
    keys.add(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    )
  }
  for (const match of text.matchAll(UUID)) keys.add(normaliseUuid(match[1] as string))
  return [...keys]
}

export interface ValueText {
  nodeId: number
  text: string
}

export interface KnownNode {
  id: number
  key: string
  objectType: string
}

export interface ReferenceEdge {
  fromId: number
  toId: number
  toObjectType: string
}

/** Who refers to whom, once per pair, never a node to itself. Pure. */
export function deriveReferences(
  values: readonly ValueText[],
  nodesByKey: ReadonlyMap<string, KnownNode>,
): ReferenceEdge[] {
  const seen = new Set<string>()
  const edges: ReferenceEdge[] = []
  for (const value of values) {
    for (const key of referencedKeysIn(value.text)) {
      const target = nodesByKey.get(key)
      if (!target || target.id === value.nodeId) continue
      const pair = `${value.nodeId}>${target.id}`
      if (seen.has(pair)) continue
      seen.add(pair)
      edges.push({ fromId: value.nodeId, toId: target.id, toObjectType: target.objectType })
    }
  }
  return edges
}

/** Every reference the current values make. A scan, which is the price of never going stale. */
export async function loadReferences(db: Db): Promise<ReferenceEdge[]> {
  const values = await db.query<{ node_id: number; v: string | null; t: string | null }>(
    `SELECT node_id, varchar_value AS v, text_value AS t FROM property_value
      WHERE is_current = ? AND (varchar_value LIKE '%-%-%-%-%' OR text_value LIKE '%-%-%-%-%'
         OR varchar_value LIKE '%umb://%' OR text_value LIKE '%umb://%')`,
    [db.dialect.boolValue(true)],
  )
  const texts: ValueText[] = []
  for (const row of values) {
    const text = `${row.v ?? ''} ${row.t ?? ''}`
    texts.push({ nodeId: Number(row.node_id), text })
  }
  const wanted = new Set(texts.flatMap((value) => referencedKeysIn(value.text)))
  if (wanted.size === 0) return []
  const nodes = await db.query<{ id: number; unique_id: string; node_object_type: string }>(
    'SELECT id, unique_id, node_object_type FROM node',
  )
  const byKey = new Map<string, KnownNode>()
  for (const node of nodes) {
    const key = normaliseUuid(String(node.unique_id))
    if (wanted.has(key))
      byKey.set(key, {
        id: Number(node.id),
        key,
        objectType: String(node.node_object_type).toLowerCase(),
      })
  }
  return deriveReferences(texts, byKey)
}

export interface Relation {
  key: string
  typeKey: string
  parent: { key: string; name: string | null }
  child: { key: string; name: string | null }
  createDate: Date
}

interface NodeFacts {
  key: string
  name: string | null
  date: Date
}

async function describeNodes(db: Db, ids: readonly number[]): Promise<Map<number, NodeFacts>> {
  const facts = new Map<number, NodeFacts>()
  if (ids.length === 0) return facts
  const holes = ids.map(() => '?').join(', ')
  const rows = await db.query<{ id: number; unique_id: string; text: string | null; d: unknown }>(
    `SELECT n.id, n.unique_id, n.text,
            COALESCE((SELECT MAX(cv.version_date) FROM content_version cv WHERE cv.node_id = n.id), n.create_date) AS d
       FROM node n WHERE n.id IN (${holes})`,
    [...ids],
  )
  for (const row of rows)
    facts.set(Number(row.id), {
      key: normaliseUuid(String(row.unique_id)),
      name: row.text,
      date: DbDate.fromDb(row.d) ?? new Date(0),
    })
  return facts
}

/** A stable key for a derived relation: its type and its two ends. */
export const relationKey = (type: RelationType, parentKey: string, childKey: string) =>
  nameBasedUuid(`${type.alias}|${parentKey}|${childKey}`)

export class RelationRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  /** The relations of one type, ordered by the parent's name then the child's, paged. */
  async relations(
    type: RelationType,
    skip: number,
    take: number,
  ): Promise<{ total: number; items: Relation[] }> {
    const pairs = await this.#pairs(type)
    const facts = await describeNodes(this.#db, [...new Set(pairs.flat())])
    const relations: Relation[] = []
    for (const [parentId, childId] of pairs) {
      const parent = facts.get(parentId)
      const child = facts.get(childId)
      if (!parent || !child) continue
      relations.push({
        key: relationKey(type, parent.key, child.key),
        typeKey: type.key,
        parent: { key: parent.key, name: parent.name },
        child: { key: child.key, name: child.name },
        createDate: type.derivation === 'reference' ? parent.date : child.date,
      })
    }
    relations.sort(
      (a, b) =>
        (a.parent.name ?? '').localeCompare(b.parent.name ?? '') ||
        (a.child.name ?? '').localeCompare(b.child.name ?? ''),
    )
    return { total: relations.length, items: relations.slice(skip, skip + take) }
  }

  async #pairs(type: RelationType): Promise<Array<[number, number]>> {
    if (type.derivation === 'reference')
      return (await loadReferences(this.#db))
        .filter((edge) => edge.toObjectType === type.target)
        .map((edge) => [edge.fromId, edge.toId])
    if (type.derivation === 'original-parent') {
      const rows = await this.#db.query<{ id: number; parent: number; parent_type: string }>(
        `SELECT n.id, d.original_parent_id AS parent, p.node_object_type AS parent_type
           FROM node n
           JOIN document d ON d.node_id = n.id
           JOIN node p ON p.id = d.original_parent_id
          WHERE n.trashed = ? AND n.node_object_type = ?`,
        [this.#db.dialect.boolValue(true), type.target],
      )
      return rows
        .filter(
          (row) =>
            !type.parentObjectType ||
            String(row.parent_type).toLowerCase() === type.parentObjectType,
        )
        .map((row) => [Number(row.parent), Number(row.id)])
    }
    return []
  }

  /** Nodes that refer to anything of `objectType` in the recycle bin: what emptying it breaks. */
  async referencingRecycleBin(objectType: string): Promise<number[]> {
    const trashed = new Set(
      (
        await this.#db.query<{ id: number; trashed: unknown }>(
          'SELECT id, trashed FROM node WHERE node_object_type = ? AND trashed = ?',
          [objectType, this.#db.dialect.boolValue(true)],
        )
      )
        .filter((row) => fromDbBool(row.trashed))
        .map((row) => Number(row.id)),
    )
    if (trashed.size === 0) return []
    const from = new Set<number>()
    for (const edge of await loadReferences(this.#db))
      if (trashed.has(edge.toId)) from.add(edge.fromId)
    return [...from]
  }
}
