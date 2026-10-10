/**
 * The content-type aggregate repository.
 *
 * A content type is saved as one document by the editor, so it is loaded and
 * written as one aggregate here: the type row, its groups, its properties, its
 * compositions, allowed children and templates.
 *
 * Groups and properties are upserted by key and never deleted-and-reinserted:
 * values reference property-type ids, so a delete would orphan every value ever
 * written. A property absent from the aggregate is **retired** — kept, hidden,
 * values intact — and one that reappears is **revived**.
 */
import {
  type ContentTypeAggregate,
  ContentVariation,
  normaliseUuid,
  ObjectTypes,
  type PropertyGroupModel,
  PropertyGroupType,
  type PropertyTypeModel,
  SystemNodes,
  variationFlags,
  variesByCulture,
  variesBySegment,
} from '@bunbraco/core'
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'
import { pendingUntil } from '../pending.ts'
import type { NodeSchemaState } from '../schema-state.ts'
import { NodeRepository } from './nodes.ts'

const GROUP_TYPE_NAMES = ['Group', 'Tab'] as const

export interface SaveContentTypeOptions {
  userId?: number
  /** The schema state that introduced anything created by this save. */
  sinceStateId?: number
}

/** A property removed from its type and kept, with its values, for revival. */
export interface RetiredProperty {
  key: string
  alias: string
  retiredAt: Date
}

/** Document types and media types share one table, told apart by node object type. */
export type ContentTypeKind = 'document' | 'media' | 'member'

export const CONTENT_TYPE_OBJECT_TYPES: Record<
  ContentTypeKind,
  { item: string; container: string }
> = {
  document: { item: ObjectTypes.DocumentType, container: ObjectTypes.DocumentTypeContainer },
  media: { item: ObjectTypes.MediaType, container: ObjectTypes.MediaTypeContainer },
  member: { item: ObjectTypes.MemberType, container: ObjectTypes.MemberTypeContainer },
}

export interface ContentTypeRepositoryOptions {
  /** The state this node runs at; elements newer than it are marked pending. */
  nodeState?: NodeSchemaState
  /** Which kind of type this repository reads and writes. Default document. */
  kind?: ContentTypeKind
}

export class ContentTypeRepository {
  #db: Db
  #nodes: NodeRepository
  #nodeState: NodeSchemaState | undefined
  #objectType: string
  #kind: ContentTypeKind

  constructor(db: Db, options: ContentTypeRepositoryOptions = {}) {
    this.#db = db
    this.#nodes = new NodeRepository(db)
    this.#nodeState = options.nodeState
    this.#kind = options.kind ?? 'document'
    this.#objectType = CONTENT_TYPE_OBJECT_TYPES[this.#kind].item
  }

  /** The node object type this repository's types carry. */
  get objectType(): string {
    return this.#objectType
  }

  #pending(row: Record<string, unknown>): NodeSchemaState | null {
    if (!this.#nodeState) return null
    return pendingUntil(
      {
        since: row.since_v
          ? { version: String(row.since_v), revision: String(row.since_r ?? '0') }
          : null,
        sinceVersion: (row.since_version as string | null) ?? null,
      },
      this.#nodeState,
    )
  }

  get nodes(): NodeRepository {
    return this.#nodes
  }

  async byKey(key: string): Promise<ContentTypeAggregate | undefined> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.#objectType) return undefined
    return this.#load(node.id, node.key, node.text ?? '', node.parentId)
  }

  /** Retired types are hidden unless asked for: schema sync revives them by alias. */
  async byAlias(
    alias: string,
    options: { includeRetired?: boolean } = {},
  ): Promise<ContentTypeAggregate | undefined> {
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT n.unique_id FROM content_type ct JOIN node n ON n.id = ct.node_id
       WHERE ct.alias = ? AND n.node_object_type = ?${options.includeRetired ? '' : ' AND ct.retired_at IS NULL'}`,
      [alias, this.#objectType],
    )
    return rows[0] ? this.byKey(String(rows[0].unique_id)) : undefined
  }

  async aliasExists(alias: string, exceptKey?: string): Promise<boolean> {
    // Built conditionally rather than with `? IS NULL`: Postgres cannot infer a
    // type for a bare parameter used only in a null test.
    const sql = `SELECT COUNT(*) AS n FROM content_type ct
       JOIN node n ON n.id = ct.node_id
       WHERE ct.alias = ?${exceptKey ? ' AND n.unique_id <> ?' : ''}`
    const params = exceptKey ? [alias, normaliseUuid(exceptKey)] : [alias]
    const rows = await this.#db.query<{ n: number }>(sql, params)
    return Number(rows[0]?.n ?? 0) > 0
  }

  /** Content types permitted at the root of the content tree. */
  async allowedAtRoot(
    skip: number,
    take: number,
  ): Promise<{ total: number; items: ContentTypeAggregate[] }> {
    const totals = await this.#db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM content_type ct JOIN node n ON n.id = ct.node_id
       WHERE ct.allow_at_root = ? AND ct.retired_at IS NULL AND n.node_object_type = ?`,
      [this.#db.dialect.boolValue(true), this.#objectType],
    )
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT n.unique_id FROM content_type ct JOIN node n ON n.id = ct.node_id
       WHERE ct.allow_at_root = ? AND ct.retired_at IS NULL AND n.node_object_type = ?
       ORDER BY n.text LIMIT ? OFFSET ?`,
      [this.#db.dialect.boolValue(true), this.#objectType, take, skip],
    )
    const items: ContentTypeAggregate[] = []
    let hidden = 0
    for (const row of rows) {
      const aggregate = await this.byKey(String(row.unique_id))
      if (!aggregate) continue
      // A pending type is not offered for creation until it is live here.
      if (aggregate.pending) hidden += 1
      else items.push(aggregate)
    }
    return { total: Number(totals[0]?.n ?? 0) - hidden, items }
  }

  /**
   * Content types offered in the library, which Umbraco reads as element types
   * carrying the flag — a non-element type is never offered, whatever it holds.
   */
  async allowedInLibrary(
    skip: number,
    take: number,
  ): Promise<{ total: number; items: ContentTypeAggregate[] }> {
    const where = `WHERE ct.is_element = ? AND ct.allow_in_library = ? AND ct.retired_at IS NULL
       AND n.node_object_type = ?`
    const params = [
      this.#db.dialect.boolValue(true),
      this.#db.dialect.boolValue(true),
      this.#objectType,
    ]
    const totals = await this.#db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM content_type ct JOIN node n ON n.id = ct.node_id ${where}`,
      params,
    )
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT n.unique_id FROM content_type ct JOIN node n ON n.id = ct.node_id ${where}
       ORDER BY n.text LIMIT ? OFFSET ?`,
      [...params, take, skip],
    )
    const items: ContentTypeAggregate[] = []
    let hidden = 0
    for (const row of rows) {
      const aggregate = await this.byKey(String(row.unique_id))
      if (!aggregate) continue
      if (aggregate.pending) hidden += 1
      else items.push(aggregate)
    }
    return { total: Number(totals[0]?.n ?? 0) - hidden, items }
  }

  async allowedChildren(
    key: string,
    skip: number,
    take: number,
  ): Promise<{ total: number; items: ContentTypeAggregate[] }> {
    const node = await this.#nodes.byKey(key)
    if (!node) return { total: 0, items: [] }
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT child.unique_id FROM content_type_allowed_child ac
       JOIN node child ON child.id = ac.allowed_content_type_id
       WHERE ac.content_type_id = ? ORDER BY ac.sort_order`,
      [node.id],
    )
    const items: ContentTypeAggregate[] = []
    for (const row of rows.slice(skip, skip + take)) {
      const aggregate = await this.byKey(String(row.unique_id))
      if (aggregate && !aggregate.pending) items.push(aggregate)
    }
    return { total: rows.length, items }
  }

  /** Creates or updates a content type. See the class comment for retirement. */
  async save(
    aggregate: ContentTypeAggregate,
    options: SaveContentTypeOptions = {},
  ): Promise<ContentTypeAggregate> {
    return this.#db.transaction(async (tx) => {
      const repo = new ContentTypeRepository(tx, { nodeState: this.#nodeState, kind: this.#kind })
      const bool = (value: boolean) => tx.dialect.boolValue(value)
      const now = DbDate.toDb(new Date())
      const existing = await repo.nodes.byKey(aggregate.key)
      const parentId = aggregate.parentKey
        ? ((await repo.nodes.byKey(aggregate.parentKey))?.id ?? SystemNodes.Root)
        : SystemNodes.Root

      let nodeId: number
      if (existing) {
        nodeId = existing.id
        await repo.nodes.rename(nodeId, aggregate.name)
      } else {
        nodeId = (
          await repo.nodes.create({
            key: aggregate.key,
            parentId,
            objectType: this.#objectType,
            text: aggregate.name,
            userId: options.userId,
          })
        ).id
      }

      const variations = variationFlags(aggregate.variesByCulture, aggregate.variesBySegment)
      const typeValues = [
        aggregate.alias,
        aggregate.icon,
        aggregate.description,
        aggregate.collectionKey,
        bool(aggregate.isElement),
        bool(aggregate.allowedInLibrary),
        bool(aggregate.allowedAsRoot),
        variations,
        bool(aggregate.cleanup.preventCleanup),
        aggregate.cleanup.keepAllVersionsNewerThanDays,
        aggregate.cleanup.keepLatestVersionPerDayForDays,
        aggregate.sinceVersion ?? null,
      ]
      if (existing) {
        await tx.exec(
          `UPDATE content_type SET alias = ?, icon = ?, description = ?, list_view = ?, is_element = ?,
             allow_in_library = ?, allow_at_root = ?, variations = ?, prevent_cleanup = ?,
             keep_all_versions_newer_than_days = ?, keep_latest_version_per_day_for_days = ?, since_version = ?, retired_at = NULL
           WHERE node_id = ?`,
          [...typeValues, nodeId],
        )
      } else {
        await tx.exec(
          `INSERT INTO content_type
             (node_id, alias, icon, thumbnail, description, list_view, is_element, allow_in_library, allow_at_root,
              variations, prevent_cleanup, keep_all_versions_newer_than_days, keep_latest_version_per_day_for_days, since_version, since_state_id)
           VALUES (?, ?, ?, 'folder.png', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [nodeId, ...typeValues, options.sinceStateId ?? null],
        )
      }

      // ---- groups: upsert by key
      const groupIdByKey = new Map<string, number>()
      for (const container of aggregate.containers) {
        const type = container.type === 'Tab' ? PropertyGroupType.Tab : PropertyGroupType.Group
        const found = await tx.query<{ id: number }>(
          'SELECT id FROM property_type_group WHERE unique_id = ?',
          [container.key],
        )
        if (found[0]) {
          await tx.exec(
            'UPDATE property_type_group SET type = ?, text = ?, alias = ?, sort_order = ? WHERE id = ?',
            [type, container.name, container.alias, container.sortOrder, Number(found[0].id)],
          )
          groupIdByKey.set(container.key, Number(found[0].id))
        } else {
          await tx.exec(
            'INSERT INTO property_type_group (unique_id, content_type_node_id, type, text, alias, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
            [container.key, nodeId, type, container.name, container.alias, container.sortOrder],
          )
          const created = await tx.query<{ id: number }>(
            'SELECT id FROM property_type_group WHERE unique_id = ?',
            [container.key],
          )
          groupIdByKey.set(container.key, Number(created[0]?.id))
        }
      }
      for (const container of aggregate.containers) {
        const parent = container.parentKey ? groupIdByKey.get(container.parentKey) : undefined
        await tx.exec('UPDATE property_type_group SET parent_id = ? WHERE unique_id = ?', [
          parent ?? null,
          container.key,
        ])
      }

      // ---- properties: upsert by key; retire the absent; revive the returning
      const kept = new Set<string>()
      for (const property of aggregate.properties) {
        const dataTypeNode = await repo.nodes.byKey(property.dataTypeKey)
        if (!dataTypeNode)
          throw new Error(
            `Unknown data type '${property.dataTypeKey}' on property '${property.alias}'.`,
          )
        // A key the type has never had, but an alias it has (live or retired), is
        // that property coming back: reuse the row, so its values return with it.
        let key = normaliseUuid(property.key)
        const byKey = await tx.query('SELECT id FROM property_type WHERE unique_id = ?', [key])
        if (byKey.length === 0) {
          const sameAlias = await tx.query<{ unique_id: string }>(
            'SELECT unique_id FROM property_type WHERE content_type_id = ? AND alias = ?',
            [nodeId, property.alias],
          )
          if (sameAlias[0]) key = normaliseUuid(String(sameAlias[0].unique_id))
        }
        kept.add(key)
        const groupId = property.containerKey
          ? (groupIdByKey.get(property.containerKey) ?? null)
          : null
        const columns = [
          dataTypeNode.id,
          groupId,
          property.alias,
          property.name,
          property.description,
          property.sortOrder,
          bool(property.mandatory),
          property.mandatoryMessage,
          property.regEx,
          property.regExMessage,
          bool(property.labelOnTop),
          variationFlags(property.variesByCulture, property.variesBySegment),
          property.sinceVersion ?? null,
        ]
        const found = await tx.query<{ id: number }>(
          'SELECT id FROM property_type WHERE unique_id = ?',
          [key],
        )
        if (found[0]) {
          await tx.exec(
            `UPDATE property_type SET data_type_id = ?, property_type_group_id = ?, alias = ?, name = ?, description = ?,
               sort_order = ?, mandatory = ?, mandatory_message = ?, validation_reg_exp = ?, validation_reg_exp_message = ?,
               label_on_top = ?, variations = ?, since_version = ?, retired_at = NULL
             WHERE id = ?`,
            [...columns, Number(found[0].id)],
          )
        } else {
          await tx.exec(
            `INSERT INTO property_type
               (unique_id, content_type_id, data_type_id, property_type_group_id, alias, name, description, sort_order,
                mandatory, mandatory_message, validation_reg_exp, validation_reg_exp_message, label_on_top, variations, since_version, since_state_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [key, nodeId, ...columns, options.sinceStateId ?? null],
          )
        }
      }
      if (this.#kind === 'member') {
        const bool = (v: boolean) => tx.dialect.boolValue(v)
        for (const property of aggregate.properties) {
          // By alias: the row may have been reused under its old key above.
          const row = await tx.query<{ id: number }>(
            'SELECT id FROM property_type WHERE content_type_id = ? AND alias = ?',
            [nodeId, property.alias],
          )
          const id = Number(row[0]?.id)
          if (!id) continue
          await tx.exec('DELETE FROM member_property_type WHERE property_type_id = ?', [id])
          await tx.exec(
            'INSERT INTO member_property_type (property_type_id, member_can_edit, member_can_view, is_sensitive) VALUES (?, ?, ?, ?)',
            [
              id,
              bool(property.memberCanEdit === true),
              bool(property.memberCanView === true),
              bool(property.isSensitive === true),
            ],
          )
        }
      }
      const present = await tx.query(
        'SELECT id, unique_id, retired_at FROM property_type WHERE content_type_id = ?',
        [nodeId],
      )
      for (const row of present) {
        if (kept.has(normaliseUuid(String(row.unique_id)))) continue
        if (row.retired_at !== null && row.retired_at !== undefined) continue
        // Retired: hidden and detached from its group; every value stays.
        await tx.exec(
          'UPDATE property_type SET retired_at = ?, property_type_group_id = NULL WHERE id = ?',
          [now, Number(row.id)],
        )
      }
      const containerKeys = new Set(aggregate.containers.map((c) => c.key))
      for (const group of await tx.query(
        'SELECT id, unique_id FROM property_type_group WHERE content_type_node_id = ?',
        [nodeId],
      )) {
        if (containerKeys.has(String(group.unique_id))) continue
        const inUse = await tx.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM property_type WHERE property_type_group_id = ?',
          [Number(group.id)],
        )
        if (Number(inUse[0]?.n ?? 0) === 0)
          await tx.exec('DELETE FROM property_type_group WHERE id = ?', [Number(group.id)])
      }

      // ---- relations: replaced wholesale; nothing references these rows
      await tx.exec('DELETE FROM content_type_composition WHERE child_content_type_id = ?', [
        nodeId,
      ])
      for (const composition of aggregate.compositions) {
        const parent = await repo.nodes.byKey(composition.contentTypeKey)
        if (parent)
          await tx.exec(
            'INSERT INTO content_type_composition (parent_content_type_id, child_content_type_id) VALUES (?, ?)',
            [parent.id, nodeId],
          )
      }
      await tx.exec('DELETE FROM content_type_allowed_child WHERE content_type_id = ?', [nodeId])
      for (const allowed of aggregate.allowedContentTypes) {
        const child = await repo.nodes.byKey(allowed.contentTypeKey)
        if (child)
          await tx.exec(
            'INSERT INTO content_type_allowed_child (content_type_id, allowed_content_type_id, sort_order) VALUES (?, ?, ?)',
            [nodeId, child.id, allowed.sortOrder],
          )
      }
      await tx.exec('DELETE FROM content_type_template WHERE content_type_node_id = ?', [nodeId])
      for (const componentKey of aggregate.allowedComponentKeys) {
        const template = await repo.nodes.byKey(componentKey)
        if (template)
          await tx.exec(
            'INSERT INTO content_type_template (content_type_node_id, template_node_id, is_default) VALUES (?, ?, ?)',
            [nodeId, template.id, bool(componentKey === aggregate.defaultComponentKey)],
          )
      }

      const saved = await repo.byKey(aggregate.key)
      if (!saved) throw new Error('Content type could not be read back after saving.')
      return saved
    })
  }

  async retiredProperties(typeKey: string): Promise<RetiredProperty[]> {
    const node = await this.#nodes.byKey(typeKey)
    if (!node) return []
    const rows = await this.#db.query(
      'SELECT unique_id, alias, retired_at FROM property_type WHERE content_type_id = ? AND retired_at IS NOT NULL',
      [node.id],
    )
    return rows.map((row) => ({
      key: normaliseUuid(String(row.unique_id)),
      alias: String(row.alias),
      retiredAt: DbDate.fromDb(row.retired_at) ?? new Date(0),
    }))
  }

  /** Whether any document of this type exists, trashed or not — the deletion-safety check. */
  /**
   * Deletes property types retired before `olderThan`, with every value they
   * ever held. The contract step; nothing else in the system deletes values.
   */
  async purgeRetired(olderThan: Date): Promise<Array<{ type: string; alias: string }>> {
    const rows = await this.#db.query<{ id: number; alias: string; type_alias: string }>(
      `SELECT p.id, p.alias, ct.alias AS type_alias FROM property_type p
       JOIN content_type ct ON ct.node_id = p.content_type_id
       WHERE p.retired_at IS NOT NULL AND p.retired_at < ?`,
      [DbDate.toDb(olderThan)],
    )
    const purged: Array<{ type: string; alias: string }> = []
    await this.#db.transaction(async (tx) => {
      for (const row of rows) {
        await tx.exec('DELETE FROM property_value WHERE property_type_id = ?', [Number(row.id)])
        await tx.exec('DELETE FROM member_property_type WHERE property_type_id = ?', [
          Number(row.id),
        ])
        await tx.exec('DELETE FROM property_type WHERE id = ?', [Number(row.id)])
        purged.push({ type: String(row.type_alias), alias: String(row.alias) })
      }
    })
    return purged
  }

  /** Several aggregates at once, for the batch endpoint and pickers. */
  async byKeys(keys: readonly string[]): Promise<ContentTypeAggregate[]> {
    const out: ContentTypeAggregate[] = []
    for (const key of keys) {
      const found = await this.byKey(key)
      if (found) out.push(found)
    }
    return out
  }

  /** Every live type, cheap enough while types number in the dozens. */
  async all(): Promise<ContentTypeAggregate[]> {
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT n.unique_id FROM content_type ct JOIN node n ON n.id = ct.node_id
       WHERE ct.retired_at IS NULL AND n.node_object_type = ? ORDER BY n.text`,
      [this.#objectType],
    )
    return this.byKeys(rows.map((r) => String(r.unique_id)))
  }

  /** Every live type's alias by its key, without loading the types themselves. */
  async aliasesByKey(): Promise<Map<string, string>> {
    const rows = await this.#db.query<{ unique_id: string; alias: string }>(
      `SELECT n.unique_id, ct.alias FROM content_type ct JOIN node n ON n.id = ct.node_id
       WHERE ct.retired_at IS NULL AND n.node_object_type = ?`,
      [this.#objectType],
    )
    return new Map(rows.map((r) => [normaliseUuid(String(r.unique_id)), String(r.alias)]))
  }

  async move(key: string, parentKey: string | null): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.#objectType) return false
    const parentId = parentKey ? (await this.#nodes.byKey(parentKey))?.id : SystemNodes.Root
    if (parentId === undefined) return false
    await this.#nodes.move(node.id, parentId)
    return true
  }

  /** A copy with fresh keys everywhere, named "(copy)" with a unique alias. */
  async copy(key: string, parentKey: string | null): Promise<ContentTypeAggregate | undefined> {
    const source = await this.byKey(key)
    if (!source) return undefined
    let alias = `${source.alias}Copy`
    for (let i = 2; await this.aliasExists(alias); i++) alias = `${source.alias}Copy${i}`
    const containerKeys = new Map(source.containers.map((c) => [c.key, crypto.randomUUID()]))
    const copy: ContentTypeAggregate = {
      ...source,
      key: crypto.randomUUID(),
      alias,
      name: `${source.name} (copy)`,
      parentKey,
      containers: source.containers.map((c) => ({
        ...c,
        key: containerKeys.get(c.key) as string,
        parentKey: c.parentKey ? (containerKeys.get(c.parentKey) ?? null) : null,
      })),
      properties: source.properties.map((p) => ({
        ...p,
        key: crypto.randomUUID(),
        containerKey: p.containerKey ? (containerKeys.get(p.containerKey) ?? null) : null,
      })),
    }
    return this.save(copy)
  }

  async search(
    query: string,
    options: { isElement?: boolean; skip: number; take: number },
  ): Promise<{ total: number; items: ContentTypeAggregate[] }> {
    const page = await this.#nodes.search(this.#objectType, query, {
      skip: 0,
      take: 10_000,
    })
    const aggregates = (await this.byKeys(page.items.map((n) => n.key))).filter(
      (a) => options.isElement === undefined || a.isElement === options.isElement,
    )
    return {
      total: aggregates.length,
      items: aggregates.slice(options.skip, options.skip + options.take),
    }
  }

  /** Types that compose this one, directly. */
  async compositionReferences(key: string): Promise<ContentTypeAggregate[]> {
    const node = await this.#nodes.byKey(key)
    if (!node) return []
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT child.unique_id FROM content_type_composition c JOIN node child ON child.id = c.child_content_type_id
       WHERE c.parent_content_type_id = ?`,
      [node.id],
    )
    return this.byKeys(rows.map((r) => String(r.unique_id)))
  }

  /** Types that allow this one as a child. */
  async allowedParents(key: string): Promise<string[]> {
    const node = await this.#nodes.byKey(key)
    if (!node) return []
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT parent.unique_id FROM content_type_allowed_child ac JOIN node parent ON parent.id = ac.content_type_id
       WHERE ac.allowed_content_type_id = ?`,
      [node.id],
    )
    return rows.map((r) => normaliseUuid(String(r.unique_id)))
  }

  /**
   * What a type may compose, and whether each candidate clashes. The rules are
   * Umbraco's: never itself, never a type that already uses it (no cycles), never
   * a type that has compositions of its own, element types compose only element
   * types; a candidate is incompatible when it brings a property alias the type
   * already has.
   */
  async availableCompositions(request: {
    key: string | null
    isElement: boolean
    currentPropertyAliases: readonly string[]
    currentCompositeKeys: readonly string[]
  }): Promise<Array<{ type: ContentTypeAggregate; isCompatible: boolean }>> {
    const all = await this.all()
    const self = request.key ? all.find((t) => t.key === request.key) : undefined
    const usesSelf = new Set<string>()
    if (self) {
      const walk = (typeKey: string) => {
        for (const t of all) {
          if (t.compositions.some((c) => c.contentTypeKey === typeKey) && !usesSelf.has(t.key)) {
            usesSelf.add(t.key)
            walk(t.key)
          }
        }
      }
      walk(self.key)
    }
    const taken = new Set(request.currentPropertyAliases)
    const selected = new Set(request.currentCompositeKeys)
    const out: Array<{ type: ContentTypeAggregate; isCompatible: boolean }> = []
    for (const candidate of all) {
      if (self && candidate.key === self.key) continue
      if (usesSelf.has(candidate.key)) continue
      if (candidate.compositions.length > 0) continue
      if (request.isElement && !candidate.isElement) continue
      const clash =
        !selected.has(candidate.key) && candidate.properties.some((p) => taken.has(p.alias))
      out.push({ type: candidate, isCompatible: !clash })
    }
    return out
  }

  async contentCount(typeKey: string): Promise<number> {
    const node = await this.#nodes.byKey(typeKey)
    if (!node) return 0
    const rows = await this.#db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM content WHERE content_type_id = ?',
      [node.id],
    )
    return Number(rows[0]?.n ?? 0)
  }

  async delete(key: string): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.#objectType) return false
    return this.#db.transaction(async (tx) => {
      await tx.exec(
        'DELETE FROM property_value WHERE property_type_id IN (SELECT id FROM property_type WHERE content_type_id = ?)',
        [node.id],
      )
      await tx.exec(
        'DELETE FROM member_property_type WHERE property_type_id IN (SELECT id FROM property_type WHERE content_type_id = ?)',
        [node.id],
      )
      await tx.exec('DELETE FROM property_type WHERE content_type_id = ?', [node.id])
      await tx.exec('DELETE FROM property_type_group WHERE content_type_node_id = ?', [node.id])
      await tx.exec(
        'DELETE FROM content_type_composition WHERE child_content_type_id = ? OR parent_content_type_id = ?',
        [node.id, node.id],
      )
      await tx.exec(
        'DELETE FROM content_type_allowed_child WHERE content_type_id = ? OR allowed_content_type_id = ?',
        [node.id, node.id],
      )
      await tx.exec('DELETE FROM content_type_template WHERE content_type_node_id = ?', [node.id])
      await tx.exec('DELETE FROM content_type WHERE node_id = ?', [node.id])
      await tx.exec('DELETE FROM node WHERE id = ?', [node.id])
      return true
    })
  }

  /** The full property set, unioning the type's own with every composition ancestor's. */
  async resolveProperties(key: string): Promise<PropertyTypeModel[]> {
    const visited = new Set<string>()
    const collected: PropertyTypeModel[] = []
    const walk = async (currentKey: string): Promise<void> => {
      if (visited.has(currentKey)) return
      visited.add(currentKey)
      const aggregate = await this.byKey(currentKey)
      if (!aggregate) return
      for (const composition of aggregate.compositions) await walk(composition.contentTypeKey)
      for (const property of aggregate.properties)
        if (!collected.some((p) => p.alias === property.alias)) collected.push(property)
    }
    await walk(key)
    return collected
  }

  async #load(
    nodeId: number,
    key: string,
    name: string,
    parentId: number,
  ): Promise<ContentTypeAggregate | undefined> {
    const typeRows = await this.#db.query(
      `SELECT ct.alias, ct.icon, ct.description, ct.list_view, ct.is_element, ct.allow_in_library, ct.allow_at_root, ct.variations,
              ct.prevent_cleanup, ct.keep_all_versions_newer_than_days, ct.keep_latest_version_per_day_for_days,
              ct.since_version, ss.version AS since_v, ss.revision AS since_r
       FROM content_type ct LEFT JOIN schema_state ss ON ss.id = ct.since_state_id WHERE ct.node_id = ?`,
      [nodeId],
    )
    const type = typeRows[0]
    if (!type) return undefined

    const groupRows = await this.#db.query(
      `SELECT g.unique_id, g.text, g.alias, g.type, g.sort_order, parent.unique_id AS parent_key
       FROM property_type_group g LEFT JOIN property_type_group parent ON parent.id = g.parent_id
       WHERE g.content_type_node_id = ? ORDER BY g.sort_order, g.id`,
      [nodeId],
    )
    const containers: PropertyGroupModel[] = groupRows.map((row) => ({
      key: normaliseUuid(String(row.unique_id)),
      name: (row.text as string | null) ?? null,
      alias: (row.alias as string | null) ?? null,
      type: GROUP_TYPE_NAMES[Number(row.type)] ?? 'Group',
      sortOrder: Number(row.sort_order),
      parentKey: row.parent_key ? normaliseUuid(String(row.parent_key)) : null,
    }))

    // Retired properties are hidden here; `retiredProperties()` lists them.
    const propertyRows = await this.#db.query(
      `SELECT p.unique_id, p.alias, p.name, p.description, p.sort_order, p.mandatory, p.mandatory_message,
              p.validation_reg_exp, p.validation_reg_exp_message, p.label_on_top, p.variations,
              dtn.unique_id AS data_type_key, g.unique_id AS container_key,
              p.since_version, ss.version AS since_v, ss.revision AS since_r,
              m.member_can_edit, m.member_can_view, m.is_sensitive
       FROM property_type p
       JOIN node dtn ON dtn.id = p.data_type_id
       LEFT JOIN property_type_group g ON g.id = p.property_type_group_id
       LEFT JOIN schema_state ss ON ss.id = p.since_state_id
       LEFT JOIN member_property_type m ON m.property_type_id = p.id
       WHERE p.content_type_id = ? AND p.retired_at IS NULL
       ORDER BY p.sort_order, p.id`,
      [nodeId],
    )
    const properties: PropertyTypeModel[] = propertyRows.map((row) => ({
      key: normaliseUuid(String(row.unique_id)),
      alias: String(row.alias),
      name: String(row.name),
      description: (row.description as string | null) ?? null,
      dataTypeKey: normaliseUuid(String(row.data_type_key)),
      containerKey: row.container_key ? normaliseUuid(String(row.container_key)) : null,
      sortOrder: Number(row.sort_order),
      variesByCulture: variesByCulture(Number(row.variations)),
      variesBySegment: variesBySegment(Number(row.variations)),
      mandatory: fromDbBool(row.mandatory),
      mandatoryMessage: (row.mandatory_message as string | null) ?? null,
      regEx: (row.validation_reg_exp as string | null) ?? null,
      regExMessage: (row.validation_reg_exp_message as string | null) ?? null,
      labelOnTop: fromDbBool(row.label_on_top),
      sinceVersion: (row.since_version as string | null) ?? null,
      pending: this.#pending(row),
      ...(this.#kind === 'member'
        ? {
            memberCanEdit: fromDbBool(row.member_can_edit),
            memberCanView: fromDbBool(row.member_can_view),
            isSensitive: fromDbBool(row.is_sensitive),
          }
        : {}),
    }))

    const compositionRows = await this.#db.query<{ unique_id: string }>(
      'SELECT parent.unique_id FROM content_type_composition c JOIN node parent ON parent.id = c.parent_content_type_id WHERE c.child_content_type_id = ?',
      [nodeId],
    )
    const allowedRows = await this.#db.query(
      'SELECT child.unique_id, ac.sort_order FROM content_type_allowed_child ac JOIN node child ON child.id = ac.allowed_content_type_id WHERE ac.content_type_id = ? ORDER BY ac.sort_order',
      [nodeId],
    )
    const templateRows = await this.#db.query(
      'SELECT tn.unique_id, ctt.is_default FROM content_type_template ctt JOIN node tn ON tn.id = ctt.template_node_id WHERE ctt.content_type_node_id = ?',
      [nodeId],
    )
    const parentNode = parentId > 0 ? await this.#nodes.byId(parentId) : undefined
    const flags = Number(type.variations ?? ContentVariation.Nothing)
    const num = (value: unknown) => (value === null || value === undefined ? null : Number(value))

    return {
      key,
      name,
      alias: String(type.alias),
      description: (type.description as string | null) ?? null,
      icon: (type.icon as string | null) ?? 'icon-document',
      allowedAsRoot: fromDbBool(type.allow_at_root),
      variesByCulture: variesByCulture(flags),
      variesBySegment: variesBySegment(flags),
      isElement: fromDbBool(type.is_element),
      allowedInLibrary: fromDbBool(type.allow_in_library),
      collectionKey: type.list_view ? normaliseUuid(String(type.list_view)) : null,
      cleanup: {
        preventCleanup: fromDbBool(type.prevent_cleanup),
        keepAllVersionsNewerThanDays: num(type.keep_all_versions_newer_than_days),
        keepLatestVersionPerDayForDays: num(type.keep_latest_version_per_day_for_days),
      },
      properties,
      containers,
      sinceVersion: (type.since_version as string | null) ?? null,
      pending: this.#pending(type),
      compositions: compositionRows.map((row) => ({
        contentTypeKey: normaliseUuid(String(row.unique_id)),
        compositionType: 'Composition' as const,
      })),
      allowedContentTypes: allowedRows.map((row) => ({
        contentTypeKey: normaliseUuid(String(row.unique_id)),
        sortOrder: Number(row.sort_order),
      })),
      allowedComponentKeys: templateRows.map((row) => normaliseUuid(String(row.unique_id))),
      defaultComponentKey:
        templateRows
          .filter((row) => fromDbBool(row.is_default))
          .map((row) => normaliseUuid(String(row.unique_id)))[0] ?? null,
      parentKey: parentNode?.key ?? null,
    }
  }
}
