/**
 * Documents, versions and publishing on the append-only value model.
 *
 * A value never changes in place: every change appends a `property_value` row
 * tagged with the event that wrote it and the schema state the writer was at.
 * `content_version` rows are events (save | publish | rollback | migrate).
 * Publish is an event and a pointer, not a copy; rollback appends the old
 * values under a new event. See docs/02-data-model.md.
 */
import {
  type DocumentAggregate,
  type DocumentTreeItem,
  type DocumentValidationError,
  type DocumentValue,
  type DocumentVariant,
  type DocumentVersionSummary,
  variesByCulture as flagVariesByCulture,
  normaliseUuid,
  ObjectTypes,
  type Page,
  STORAGE_COLUMN,
  SystemNodes,
  toEditorValue,
  type ValueStorageTypeName,
  type VariantState,
} from '@bunbraco/core'
import { appendCacheInstruction } from '../cluster.ts'
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'
import { Locks } from '../locks.ts'
import { isPending } from '../pending.ts'
import {
  assertNodeMayWrite,
  BASELINE_NODE_STATE,
  type NodeSchemaState,
  type SchemaStateRow,
  visibleStateIdFor,
} from '../schema-state.ts'
import { NodeRepository, type NodeRow } from './nodes.ts'

export type EventKind = 'save' | 'publish' | 'rollback' | 'migrate'

interface PropertyTypeRow {
  id: number
  alias: string
  name: string
  variesByCulture: boolean
  storage: ValueStorageTypeName
  editorAlias: string
  /** The data type's configuration, for converters that depend on it. */
  config: Record<string, unknown>
  mandatory: boolean
  mandatoryMessage: string | null
  regEx: string | null
  regExMessage: string | null
  /** Not yet live on this node: editable, never validated, never rendered. */
  pending: boolean
}

interface LanguageRow {
  id: number
  isoCode: string
  isDefault: boolean
  isMandatory: boolean
}

export interface CurrentValue {
  rowId: number
  eventId: number
  schemaStateId: number
  alias: string
  culture: string | null
  segment: string | null
  value: unknown
}

export interface MigratedValue {
  alias: string
  culture: string | null
  segment: string | null
  value: unknown
  /** The event to file the value under; defaults to the row it supersedes. */
  eventId?: number
  /** The storage column to write, when the value is in a new editor's format ahead of the cut-over. */
  storage?: ValueStorageTypeName
}

interface ValueRow {
  eventId: number
  id: number
  propertyTypeId: number
  languageId: number | null
  segment: string | null
  raw: unknown
}

export interface SaveDocumentInput {
  key: string
  contentTypeKey: string
  templateKey: string | null
  parentKey: string | null
  values: DocumentValue[]
  variants: Array<{ culture: string | null; segment: string | null; name: string }>
  userId?: number
}

/** A published document plus the values of its published version. */
export interface PublishedNodeRow {
  id: number
  key: string
  parentId: number
  level: number
  path: string
  sortOrder: number
  name: string
  contentTypeAlias: string
  templateAlias: string | null
  createDate: Date
  updateDate: Date
  cultures: string[]
  /** Each published culture's name, as it was published. */
  names: Record<string, string>
  values: DocumentValue[]
}

/**
 * What a repository holds. Media, members and blueprints are stored exactly as
 * documents are (node, content, versions, values); they differ in object type,
 * recycle bin, and in never being published.
 */
export type ContentKind = 'document' | 'media' | 'member' | 'blueprint' | 'element'

const KINDS: Record<
  ContentKind,
  { objectType: string; recycleBin: number | undefined; container: string | undefined }
> = {
  document: {
    objectType: ObjectTypes.Document,
    recycleBin: SystemNodes.ContentRecycleBin,
    container: undefined,
  },
  media: {
    objectType: ObjectTypes.Media,
    recycleBin: SystemNodes.MediaRecycleBin,
    container: undefined,
  },
  // Members are a flat list at the tree root: no bin to trash them into, and
  // no folders to gather them in.
  member: {
    objectType: ObjectTypes.Member,
    recycleBin: undefined,
    container: undefined,
  },
  blueprint: {
    objectType: ObjectTypes.DocumentBlueprint,
    recycleBin: undefined,
    container: ObjectTypes.DocumentBlueprintContainer,
  },
  // Umbraco 18's Elements: publishable content with no URL, gathered in folders
  // and trashed into a bin of its own at -22, as its Constants.System says.
  element: {
    objectType: ObjectTypes.Element,
    recycleBin: SystemNodes.ElementRecycleBin,
    container: ObjectTypes.ElementContainer,
  },
}

/**
 * A step every save runs on its values before they are stored, knowing each
 * property's editor: where uploaded files are placed and file facts filled in.
 */
export type ValueIntake = (
  values: readonly DocumentValue[],
  propertyTypes: ReadonlyArray<{ alias: string; editorAlias: string }>,
) => Promise<DocumentValue[]>

export interface DocumentRepositoryOptions {
  /** The schema state this process runs at; writes are refused if the database is ahead. */
  nodeState?: NodeSchemaState
  /** Stamped on the cache instructions this repository appends. */
  nodeId?: string
  kind?: ContentKind
  valueIntake?: ValueIntake
  /**
   * Set when the caller already holds the content-tree lock, so the writes
   * below must not take it again.
   *
   * Neither lock manager survives re-entry: the SQLite one is a promise queue
   * that would wait on itself for ever, and the Postgres one acquires inside
   * its own `transaction`. Transactions *do* nest — both implementations join
   * an enclosing one — so this flag is only ever about the lock.
   *
   * It exists for an operation that spans many documents and has to be atomic
   * across all of them, like importing a content bundle: one lock and one
   * transaction for the run, rather than one of each per node.
   */
  inTreeLock?: boolean
}

/** Thrown when a publish is refused by a business rule rather than failing. */
export class PublishBlockedError extends Error {}

const isEmpty = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '')

/**
 * Mandatory and pattern rules over a set of values. Invariant properties are
 * checked once; culture-varying ones once per culture given. Pending
 * properties are never checked.
 */
function validateValues(
  propertyTypes: readonly PropertyTypeRow[],
  values: readonly DocumentValue[],
  cultures: readonly string[],
): DocumentValidationError[] {
  const errors: DocumentValidationError[] = []
  for (const type of propertyTypes) {
    if (type.pending) continue
    const targets: Array<string | null> = type.variesByCulture ? [...cultures] : [null]
    if (type.variesByCulture && targets.length === 0) continue
    for (const culture of targets) {
      const value = values.find(
        (v) =>
          v.alias === type.alias &&
          (type.variesByCulture ? v.culture === culture : true) &&
          (v.segment ?? null) === null,
      )
      const messages: string[] = []
      if (type.mandatory && (!value || isEmpty(value.value)))
        messages.push(type.mandatoryMessage || 'Value cannot be empty')
      if (type.regEx && value && !isEmpty(value.value) && typeof value.value === 'string') {
        let matches = true
        try {
          matches = new RegExp(type.regEx).test(value.value)
        } catch {
          matches = true
        }
        if (!matches)
          messages.push(
            type.regExMessage || 'Value is invalid, it does not match the correct pattern',
          )
      }
      if (messages.length > 0) errors.push({ alias: type.alias, culture, segment: null, messages })
    }
  }
  return errors
}

const keyOf = (propertyTypeId: number, languageId: number | null, segment: string | null) =>
  `${propertyTypeId}|${languageId ?? ''}|${segment ?? ''}`

export class DocumentRepository {
  #db: Db
  #nodes: NodeRepository
  #nodeState: NodeSchemaState
  #nodeId: string | undefined
  readonly kind: ContentKind
  readonly objectType: string
  #recycleBin: number | undefined
  #intake: ValueIntake | undefined
  #inTreeLock: boolean

  constructor(db: Db, options: DocumentRepositoryOptions = {}) {
    this.#db = db
    this.#nodes = new NodeRepository(db)
    this.#nodeState = options.nodeState ?? BASELINE_NODE_STATE
    this.#nodeId = options.nodeId
    this.kind = options.kind ?? 'document'
    this.objectType = KINDS[this.kind].objectType
    this.#recycleBin = KINDS[this.kind].recycleBin
    this.#intake = options.valueIntake
    this.#inTreeLock = options.inTreeLock ?? false
  }

  get nodes(): NodeRepository {
    return this.#nodes
  }

  /**
   * The content-tree lock, unless the caller already holds it. Every write that
   * depends on sibling order or on a branch not moving under it goes through
   * here rather than taking the lock directly, so `inTreeLock` is honoured in
   * one place instead of six.
   */
  #withTree<T>(fn: () => Promise<T>): Promise<T> {
    return this.#inTreeLock ? fn() : this.#db.locks.withLock(Locks.ContentTree, fn)
  }

  #child(tx: Db): DocumentRepository {
    return new DocumentRepository(tx, {
      nodeState: this.#nodeState,
      nodeId: this.#nodeId,
      kind: this.kind,
      valueIntake: this.#intake,
      // A child runs inside whatever its parent took.
      inTreeLock: true,
    })
  }

  // ---------------------------------------------------------------- reads

  async byKey(key: string): Promise<DocumentAggregate | undefined> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.objectType) return undefined
    return this.#load(node)
  }

  async load(node: NodeRow): Promise<DocumentAggregate | undefined> {
    return this.#load(node)
  }

  async children(parentKey: string | null, skip: number, take: number): Promise<Page<NodeRow>> {
    const parentId = parentKey ? (await this.#nodes.byKey(parentKey))?.id : SystemNodes.Root
    if (parentId === undefined) return { total: 0, items: [] }
    return this.#nodes.children(parentId, this.objectType, skip, take)
  }

  /** The recycle bin's tree: trashed documents, top level being what was trashed directly. */
  async trashed(parentKey: string | null, skip: number, take: number): Promise<Page<NodeRow>> {
    const parentId = parentKey ? (await this.#nodes.byKey(parentKey))?.id : this.#recycleBin
    if (parentId === undefined) return { total: 0, items: [] }
    return this.#nodes.children(parentId, this.objectType, skip, take, true)
  }

  siblings(key: string, before: number, after: number) {
    return this.#nodes.siblings(key, this.objectType, before, after)
  }

  async search(
    query: string,
    options: { trashed?: boolean; parentKey?: string | null; skip: number; take: number },
  ): Promise<Page<NodeRow>> {
    const parentId = options.parentKey
      ? (await this.#nodes.byKey(options.parentKey))?.id
      : undefined
    if (options.parentKey && parentId === undefined) return { total: 0, items: [] }
    return this.#nodes.search(this.objectType, query, { ...options, parentId })
  }

  async versions(key: string): Promise<DocumentVersionSummary[]> {
    const node = await this.#nodes.byKey(key)
    if (!node) return []
    const rows = await this.#db.query(
      `SELECT cv.id, cv.kind, cv.version_date, cv.current, cv.prevent_cleanup, dv.published, u.key AS user_key
       FROM content_version cv
       JOIN document_version dv ON dv.id = cv.id
       LEFT JOIN user_account u ON u.id = cv.user_id
       WHERE cv.node_id = ?
       ORDER BY cv.id DESC`,
      [node.id],
    )
    return rows.map((row) => ({
      id: String(row.id),
      documentKey: node.key,
      versionDate: DbDate.fromDb(row.version_date) ?? new Date(0),
      isCurrentDraft: fromDbBool(row.current),
      isCurrentPublished: fromDbBool(row.published),
      preventCleanup: fromDbBool(row.prevent_cleanup),
      userKey: row.user_key ? normaliseUuid(String(row.user_key)) : null,
      culture: null,
      kind: String(row.kind) as EventKind,
    }))
  }

  /**
   * Every published document with the values of its published version, for the
   * published cache. A node reads as-of its own schema state, so a conversion
   * appended by a newer deployment is invisible to it.
   */
  /** Every published node of this kind, for the published cache. Elements too. */
  async loadPublished(asOfSchemaStateId?: number): Promise<PublishedNodeRow[]> {
    const t = this.#db.dialect.boolValue(true)
    const f = this.#db.dialect.boolValue(false)
    const rows = await this.#db.query(
      `SELECT n.id, n.unique_id, n.parent_id, n.level, n.path, n.sort_order, n.create_date,
              cv.id AS event_id, cv.text AS name, cv.version_date,
              ct.alias AS content_type_alias, c.content_type_id, tpl.alias AS template_alias
       FROM node n
       JOIN content c ON c.node_id = n.id
       JOIN content_type ct ON ct.node_id = c.content_type_id
       JOIN document d ON d.node_id = n.id
       JOIN content_version cv ON cv.node_id = n.id
       JOIN document_version dv ON dv.id = cv.id AND dv.published = ?
       LEFT JOIN template tpl ON tpl.node_id = dv.template_id
       WHERE d.published = ? AND n.trashed = ? AND n.node_object_type = ?
       ORDER BY n.level, n.sort_order, n.id`,
      [t, t, f, this.objectType],
    )
    const languages = await this.#languages()
    const published: PublishedNodeRow[] = []
    for (const row of rows) {
      // A pending property is never rendered, even if a template asks for it.
      const propertyTypes = (await this.#propertyTypes(Number(row.content_type_id))).filter(
        (p) => !p.pending,
      )
      const cultures = await this.#publishedCultureEvents(Number(row.id))
      const values = await this.#readPublishedValues(
        Number(row.id),
        propertyTypes,
        languages,
        Number(row.event_id),
        cultures,
        asOfSchemaStateId,
      )
      published.push({
        id: Number(row.id),
        key: normaliseUuid(String(row.unique_id)),
        parentId: Number(row.parent_id),
        level: Number(row.level),
        path: String(row.path),
        sortOrder: Number(row.sort_order),
        name: String(row.name ?? ''),
        contentTypeAlias: String(row.content_type_alias),
        templateAlias: (row.template_alias as string | null) ?? null,
        createDate: DbDate.fromDb(row.create_date) ?? new Date(),
        updateDate: DbDate.fromDb(row.version_date) ?? new Date(),
        cultures: cultures.map((c) => c.isoCode),
        names: Object.fromEntries(cultures.map((c) => [c.isoCode, c.name])),
        values,
      })
    }
    return published
  }

  // --------------------------------------------------------------- writes

  /** Creates a document with its first save event. Under the content-tree lock so sibling sort orders cannot race. */
  async create(input: SaveDocumentInput): Promise<DocumentAggregate> {
    return this.#withTree(async () =>
      this.#db.transaction(async (tx) => {
        const repo = this.#child(tx)
        const state = await assertNodeMayWrite(tx, this.#nodeState)
        const contentTypeNode = await repo.nodes.byKey(input.contentTypeKey)
        if (!contentTypeNode) throw new Error(`Unknown document type '${input.contentTypeKey}'.`)

        const parentId = input.parentKey
          ? ((await repo.nodes.byKey(input.parentKey))?.id ?? SystemNodes.Root)
          : SystemNodes.Root
        const name = input.variants[0]?.name ?? ''
        const node = await repo.nodes.create({
          key: input.key,
          parentId,
          objectType: this.objectType,
          text: name,
          userId: input.userId,
        })

        await tx.exec('INSERT INTO content (node_id, content_type_id) VALUES (?, ?)', [
          node.id,
          contentTypeNode.id,
        ])
        await tx.exec('INSERT INTO document (node_id, published, edited) VALUES (?, ?, ?)', [
          node.id,
          tx.dialect.boolValue(false),
          tx.dialect.boolValue(true),
        ])

        const templateId = input.templateKey
          ? ((await repo.nodes.byKey(input.templateKey))?.id ?? null)
          : null
        const eventId = await repo.#insertEvent(
          node.id,
          'save',
          name,
          input.userId,
          templateId,
          false,
        )
        await repo.#appendValues(node.id, eventId, state, contentTypeNode.id, input.values)
        await repo.#writeCultureVariations(node.id, eventId, input.variants)

        const created = await repo.#load({ ...node, text: name })
        if (!created) throw new Error('Document could not be read back after creation.')
        return created
      }),
    )
  }

  /** Documents of these types (by content type node id), trashed ones excluded. */
  async documentsOfTypes(contentTypeNodeIds: readonly number[]): Promise<
    Array<{
      key: string
      nodeId: number
      name: string
      contentTypeNodeId: number
      published: boolean
    }>
  > {
    if (contentTypeNodeIds.length === 0) return []
    const rows = await this.#db.query(
      `SELECT n.id, n.unique_id, n.text, c.content_type_id, d.published FROM content c
       JOIN node n ON n.id = c.node_id JOIN document d ON d.node_id = n.id
       WHERE c.content_type_id IN (${contentTypeNodeIds.map(() => '?').join(', ')}) AND n.trashed = ?
       ORDER BY n.path`,
      [...contentTypeNodeIds, this.#db.dialect.boolValue(false)],
    )
    return rows.map((row) => ({
      key: normaliseUuid(String(row.unique_id)),
      nodeId: Number(row.id),
      name: String(row.text ?? ''),
      contentTypeNodeId: Number(row.content_type_id),
      published: fromDbBool(row.published),
    }))
  }

  /**
   * Current values of the named properties, retired ones included: the check
   * and the fix read what the editor no longer shows. Each carries the state
   * that wrote it and the event it belongs to.
   */
  async currentValuesByAlias(nodeId: number, aliases: readonly string[]): Promise<CurrentValue[]> {
    if (aliases.length === 0) return []
    const languages = await this.#languages()
    const isoById = new Map(languages.map((l) => [l.id, l.isoCode]))
    const rows = await this.#db.query(
      `SELECT pv.id, pv.event_id, pv.schema_state_id, pv.language_id, pv.segment, pv.int_value, pv.decimal_value,
              pv.date_value, pv.varchar_value, pv.text_value, p.alias, d.db_type
       FROM property_value pv
       JOIN property_type p ON p.id = pv.property_type_id
       JOIN data_type d ON d.node_id = p.data_type_id
       WHERE pv.node_id = ? AND pv.is_current = ? AND p.alias IN (${aliases.map(() => '?').join(', ')})`,
      [nodeId, this.#db.dialect.boolValue(true), ...aliases],
    )
    const out: CurrentValue[] = []
    for (const row of rows) {
      const storage = String(row.db_type) as ValueStorageTypeName
      const value = this.#fromStorage(
        (row as Record<string, unknown>)[STORAGE_COLUMN[storage]],
        storage,
      )
      out.push({
        rowId: Number(row.id),
        eventId: Number(row.event_id),
        schemaStateId: Number(row.schema_state_id),
        alias: String(row.alias),
        culture: row.language_id === null ? null : (isoById.get(Number(row.language_id)) ?? null),
        segment: (row.segment as string | null) ?? null,
        value,
      })
    }
    return out
  }

  /**
   * Appends values under an explicit schema state — the upgrade tool's write.
   * Each value joins the event of the row it converts (so a published version
   * keeps reading as one), or the document's published event, or its head.
   * Not gated: the tool runs from the newer artifact by definition.
   */
  async appendUnderState(
    key: string,
    values: readonly MigratedValue[],
    options: { schemaStateId: number; userId?: number },
  ): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const repo = this.#child(tx)
      const node = await repo.nodes.byKey(key)
      if (!node) return false
      const contentTypeNodeId = await repo.#contentTypeNodeId(node.id)
      if (!contentTypeNodeId) return false
      const propertyTypes = await repo.#propertyTypes(contentTypeNodeId)
      const byAlias = new Map(propertyTypes.map((p) => [p.alias, p]))
      const languages = await repo.#languages()
      const idByIso = new Map(languages.map((l) => [l.isoCode.toLowerCase(), l.id]))
      const current = new Map(
        (await repo.#currentValueRows(node.id)).map((row) => [
          keyOf(row.propertyTypeId, row.languageId, row.segment),
          row,
        ]),
      )
      const head = await repo.#headEvent(node.id)
      const published = await tx.query<{ id: number }>(
        'SELECT cv.id FROM content_version cv JOIN document_version dv ON dv.id = cv.id AND dv.published = ? WHERE cv.node_id = ? ORDER BY cv.id DESC LIMIT 1',
        [tx.dialect.boolValue(true), node.id],
      )
      const fallbackEvent = Number(published[0]?.id ?? head?.id ?? 0)
      let written = false
      for (const value of values) {
        const propertyType = byAlias.get(value.alias)
        if (!propertyType) continue
        const culture = propertyType.variesByCulture ? value.culture : null
        const languageId = culture ? (idByIso.get(culture.toLowerCase()) ?? null) : null
        const existing = current.get(keyOf(propertyType.id, languageId, value.segment ?? null))
        const eventId = value.eventId ?? existing?.eventId ?? fallbackEvent
        await repo.#insertValue(
          node.id,
          eventId,
          options.schemaStateId,
          value.storage ? { ...propertyType, storage: value.storage } : propertyType,
          languageId,
          value.segment ?? null,
          value.value,
          existing?.id,
        )
        written = true
      }
      if (written) await repo.#recomputeEdited(node.id)
      return written
    })
  }

  /** Saves the draft: one save event, and a new value version for each value that changed. */
  async update(input: SaveDocumentInput): Promise<DocumentAggregate | undefined> {
    return this.#db.transaction(async (tx) => {
      const repo = this.#child(tx)
      const state = await assertNodeMayWrite(tx, this.#nodeState)
      const node = await repo.nodes.byKey(input.key)
      if (!node) return undefined
      const contentTypeNodeId = await repo.#contentTypeNodeId(node.id)
      if (!contentTypeNodeId) return undefined

      const name = input.variants[0]?.name ?? node.text ?? ''
      await repo.nodes.rename(node.id, name)
      const templateId = input.templateKey
        ? ((await repo.nodes.byKey(input.templateKey))?.id ?? null)
        : null
      const eventId = await repo.#insertEvent(
        node.id,
        'save',
        name,
        input.userId,
        templateId,
        false,
      )

      await repo.#appendValues(node.id, eventId, state, contentTypeNodeId, input.values)
      await repo.#writeCultureVariations(node.id, eventId, input.variants)
      await repo.#recomputeEdited(node.id)
      return repo.#load({ ...node, text: name })
    })
  }

  /**
   * Publish is an event and a pointer; nothing is copied. For a document that
   * varies by culture, each culture published points at this event, and the
   * others keep pointing at the event they were last published with, so their
   * newer drafts stay unpublished. Every mandatory language must end up
   * published, as Umbraco requires.
   */
  async publish(
    key: string,
    cultures: readonly string[] | null,
  ): Promise<DocumentAggregate | undefined> {
    return this.#withTree(async () =>
      this.#db.transaction(async (tx) => {
        const repo = this.#child(tx)
        await assertNodeMayWrite(tx, this.#nodeState)
        const node = await repo.nodes.byKey(key)
        if (!node) return undefined
        // An unpublished ancestor makes a published descendant unreachable, so
        // Umbraco refuses the publish rather than creating a dead route.
        if (!(await repo.#ancestorsPublished(node)))
          throw new PublishBlockedError('An ancestor is not published.')

        const variant = await repo.#variesByCulture(node.id)
        const available = variant ? await repo.#availableCultures(node.id) : []
        const targets = variant
          ? cultures && cultures.length > 0
            ? [...cultures]
            : available
          : null
        if (targets) {
          const missing = targets.filter(
            (c) => !available.some((a) => a.toLowerCase() === c.toLowerCase()),
          )
          if (missing.length > 0)
            throw new PublishBlockedError(
              `The document has no ${missing.join(', ')} variant to publish.`,
            )
          const published = await repo.#publishedCultures(node.id)
          const settled = new Set([...targets, ...published].map((c) => c.toLowerCase()))
          const mandatory = (await repo.#languages()).filter(
            (l) => l.isMandatory && !settled.has(l.isoCode.toLowerCase()),
          )
          if (mandatory.length > 0)
            throw new PublishBlockedError(
              `The mandatory ${mandatory.map((l) => l.isoCode).join(', ')} must be published too.`,
            )
        }
        await repo.#assertMandatoryFilled(node, targets)

        const head = await repo.#headEvent(node.id)
        const t = tx.dialect.boolValue(true)
        const f = tx.dialect.boolValue(false)
        await tx.exec(
          'UPDATE document_version SET published = ? WHERE id IN (SELECT id FROM content_version WHERE node_id = ?)',
          [f, node.id],
        )
        const eventId = await repo.#insertEvent(
          node.id,
          'publish',
          head?.name ?? node.text ?? '',
          head?.userId,
          head?.templateId ?? null,
          true,
        )
        await tx.exec('UPDATE document SET published = ? WHERE node_id = ?', [t, node.id])
        for (const iso of targets ?? []) await repo.#setCulturePublished(node.id, iso, eventId)
        await repo.#recomputeEdited(node.id)
        await repo.#instructContent(node.key)
        return repo.#load(node)
      }),
    )
  }

  /**
   * Why publishing this document would be refused, without publishing it.
   *
   * `publish` throws on the first of these, which is right for one node and
   * wrong for a branch: a caller publishing a selection asks this first, so the
   * whole thing is refused rather than half of it landing. The checks and their
   * order are `publish`'s own.
   */
  async publishBlockers(
    key: string,
    cultures: readonly string[] | null,
    /**
     * Node ids this caller is publishing in the same run, parents first.
     * Without it, publishing a branch reports every child as blocked by the
     * root that the same command is about to publish.
     */
    alsoPublishing: ReadonlySet<number> = new Set(),
  ): Promise<string[]> {
    const node = await this.#nodes.byKey(key)
    if (!node) return ['there is no such document here']
    const reasons: string[] = []
    if (!(await this.#ancestorsPublished(node, alsoPublishing)))
      reasons.push('an ancestor is not published')

    const variant = await this.#variesByCulture(node.id)
    const available = variant ? await this.#availableCultures(node.id) : []
    const targets = variant ? (cultures && cultures.length > 0 ? [...cultures] : available) : null
    if (targets) {
      const missing = targets.filter(
        (c) => !available.some((a) => a.toLowerCase() === c.toLowerCase()),
      )
      if (missing.length > 0) reasons.push(`there is no ${missing.join(', ')} variant to publish`)
      const published = await this.#publishedCultures(node.id)
      const settled = new Set([...targets, ...published].map((c) => c.toLowerCase()))
      const mandatory = (await this.#languages()).filter(
        (l) => l.isMandatory && !settled.has(l.isoCode.toLowerCase()),
      )
      if (mandatory.length > 0)
        reasons.push(
          `the mandatory ${mandatory.map((l) => l.isoCode).join(', ')} must be published too`,
        )
    }
    try {
      await this.#assertMandatoryFilled(node, targets)
    } catch (error) {
      reasons.push((error as Error).message)
    }
    return reasons
  }

  /**
   * Unpublishes the document, or only the cultures named. Taking a mandatory
   * culture offline takes the whole document offline, as in Umbraco.
   */
  async unpublish(
    key: string,
    cultures: readonly string[] | null,
  ): Promise<DocumentAggregate | undefined> {
    return this.#db.transaction(async (tx) => {
      const repo = this.#child(tx)
      await assertNodeMayWrite(tx, this.#nodeState)
      const node = await repo.nodes.byKey(key)
      if (!node) return undefined

      const mandatory = new Set(
        (await repo.#languages()).filter((l) => l.isMandatory).map((l) => l.isoCode.toLowerCase()),
      )
      const everything =
        !cultures || cultures.length === 0 || cultures.some((c) => mandatory.has(c.toLowerCase()))
      const isoCodes = everything ? await repo.#availableCultures(node.id) : cultures
      for (const iso of isoCodes) await repo.#setCulturePublished(node.id, iso, null)
      if (everything || !(await repo.#anyCulturePublished(node.id))) {
        // Events survive an unpublish; only the flags change.
        await tx.exec(
          'UPDATE document_version SET published = ? WHERE id IN (SELECT id FROM content_version WHERE node_id = ?)',
          [tx.dialect.boolValue(false), node.id],
        )
        await tx.exec('UPDATE document SET published = ?, edited = ? WHERE node_id = ?', [
          tx.dialect.boolValue(false),
          tx.dialect.boolValue(true),
          node.id,
        ])
      }
      await repo.#instructContent(node.key)
      return repo.#load(node)
    })
  }

  /**
   * Where a node stands in its own history: its latest event, and the event it
   * is serving. Together these are "the state this node was in", which is what
   * a content import records before touching it so a revert can put it back.
   */
  async eventMarkers(
    key: string,
  ): Promise<{ head: number | undefined; published: number | undefined } | undefined> {
    const node = await this.#nodes.byKey(key)
    if (!node) return undefined
    return {
      head: (await this.#headEvent(node.id))?.id,
      published: await this.#publishedEventId(node.id),
    }
  }

  /** Rollback appends the target version's values under a new event. History is never rewritten. */
  async rollback(versionId: string): Promise<DocumentAggregate | undefined> {
    return this.#db.transaction(async (tx) => {
      const repo = this.#child(tx)
      const state = await assertNodeMayWrite(tx, this.#nodeState)
      const targetId = Number(versionId)
      const rows = await tx.query<{ node_id: number; text: string | null; user_id: number | null }>(
        'SELECT node_id, text, user_id FROM content_version WHERE id = ?',
        [targetId],
      )
      const target = rows[0]
      if (!target) return undefined
      const node = await repo.nodes.byId(Number(target.node_id))
      if (!node) return undefined
      const contentTypeNodeId = await repo.#contentTypeNodeId(node.id)
      if (!contentTypeNodeId) return undefined

      const templateRows = await tx.query<{ template_id: number | null }>(
        'SELECT template_id FROM document_version WHERE id = ?',
        [targetId],
      )
      const name = String(target.text ?? node.text ?? '')
      const eventId = await repo.#insertEvent(
        node.id,
        'rollback',
        name,
        undefined,
        templateRows[0]?.template_id ?? null,
        false,
      )

      const snapshot = await repo.#valueRowsAsOf(node.id, { eventId: targetId })
      const current = await repo.#currentValueRows(node.id)
      await repo.#appendRows(node.id, eventId, state, snapshot, current)
      await repo.#copyCultureVariations(targetId, eventId)
      await repo.nodes.rename(node.id, name)
      await repo.#recomputeEdited(node.id)
      return repo.#load({ ...node, text: name })
    })
  }

  async setPreventCleanup(versionId: string, prevent: boolean): Promise<boolean> {
    const rows = await this.#db.query<{ id: number }>(
      'SELECT id FROM content_version WHERE id = ?',
      [Number(versionId)],
    )
    if (!rows[0]) return false
    await this.#db.exec('UPDATE content_version SET prevent_cleanup = ? WHERE id = ?', [
      this.#db.dialect.boolValue(prevent),
      Number(versionId),
    ])
    return true
  }

  async moveToRecycleBin(key: string): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node || this.#recycleBin === undefined) return false
    return this.#withTree(async () => {
      const t = this.#db.dialect.boolValue(true)
      const f = this.#db.dialect.boolValue(false)
      // The branch root remembers where it came from; the rest keeps its parent.
      await this.#db.exec('UPDATE document SET original_parent_id = ? WHERE node_id = ?', [
        node.parentId === SystemNodes.Root ? null : node.parentId,
        node.id,
      ])
      // The whole branch goes with it, and stays unpublished while trashed.
      await this.#db.exec(
        `UPDATE node SET trashed = ?, parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END
         WHERE id = ? OR path LIKE ?`,
        [t, node.id, this.#recycleBin, node.id, `${node.path},%`],
      )
      await this.#db.exec(
        `UPDATE document SET published = ?, edited = ? WHERE node_id IN (SELECT id FROM node WHERE id = ? OR path LIKE ?)`,
        [f, t, node.id, `${node.path},%`],
      )
      return true
    })
  }

  async delete(key: string): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node) return false
    return this.#db.transaction(async (tx) => {
      const ids = await tx.query<{ id: number }>(
        'SELECT id FROM node WHERE id = ? OR path LIKE ?',
        [node.id, `${node.path},%`],
      )
      for (const row of ids.map((r) => Number(r.id)).reverse()) {
        await tx.exec('DELETE FROM property_value WHERE node_id = ?', [row])
        await tx.exec('DELETE FROM content_schedule WHERE node_id = ?', [row])
        await tx.exec('DELETE FROM user_notification WHERE node_id = ?', [row])
        await tx.exec('DELETE FROM domain WHERE node_id = ?', [row])
        await tx.exec(
          'DELETE FROM content_version_culture_variation WHERE version_id IN (SELECT id FROM content_version WHERE node_id = ?)',
          [row],
        )
        await tx.exec('DELETE FROM document_culture_variation WHERE node_id = ?', [row])
        await tx.exec(
          'DELETE FROM document_version WHERE id IN (SELECT id FROM content_version WHERE node_id = ?)',
          [row],
        )
        await tx.exec('DELETE FROM content_version WHERE node_id = ?', [row])
        await tx.exec('DELETE FROM document WHERE node_id = ?', [row])
        await tx.exec('DELETE FROM content WHERE node_id = ?', [row])
        await tx.exec('DELETE FROM node WHERE id = ?', [row])
      }
      return true
    })
  }

  /**
   * Re-parents a node and its branch under `targetKey` (null: the root), last
   * among its new siblings. Refused when the target is the node or below it.
   */
  async move(key: string, targetKey: string | null): Promise<'moved' | 'notFound' | 'invalid'> {
    return this.#withTree(async () =>
      this.#db.transaction(async (tx) => {
        const repo = this.#child(tx)
        await assertNodeMayWrite(tx, this.#nodeState)
        const node = await repo.nodes.byKey(key)
        if (!node || node.objectType !== this.objectType) return 'notFound'
        const target = targetKey ? await repo.nodes.byKey(targetKey) : undefined
        const container = KINDS[this.kind].container
        if (
          targetKey &&
          (!target || (target.objectType !== this.objectType && target.objectType !== container))
        )
          return 'notFound'
        if (target && (target.id === node.id || `${target.path},`.startsWith(`${node.path},`)))
          return 'invalid'
        if (target?.trashed) return 'invalid'
        const parentId = target?.id ?? SystemNodes.Root
        await repo.nodes.move(node.id, parentId)
        await tx.exec('UPDATE node SET sort_order = ? WHERE id = ?', [
          await repo.#nextSortOrder(parentId, node.id),
          node.id,
        ])
        await repo.#instructContent(node.key)
        return 'moved'
      }),
    )
  }

  /**
   * Copies a node's current draft (and, optionally, its branch) under
   * `targetKey`. Copies are unpublished and take a free name among their new
   * siblings (`Home (1)`), as Umbraco names them.
   */
  async copy(
    key: string,
    targetKey: string | null,
    options: { includeDescendants: boolean; userId?: number },
  ): Promise<string | undefined> {
    const source = await this.byKey(key)
    if (!source) return undefined
    if (targetKey) {
      const target = await this.#nodes.byKey(targetKey)
      if (!target || target.objectType !== this.objectType) return undefined
    }
    const copyOne = async (from: DocumentAggregate, parentKey: string | null): Promise<string> => {
      const siblings = await this.#siblingNames(parentKey)
      const variants = from.variants.map((variant) => ({
        culture: variant.culture,
        segment: variant.segment,
        name: variant.culture === null ? uniqueName(variant.name, siblings) : variant.name,
      }))
      const created = await this.create({
        key: crypto.randomUUID(),
        contentTypeKey: from.contentTypeKey,
        templateKey: from.templateKey,
        parentKey,
        values: from.values,
        variants,
        userId: options.userId,
      })
      return created.key
    }
    const copyBranch = async (from: DocumentAggregate, parentKey: string | null) => {
      const newKey = await copyOne(from, parentKey)
      if (!options.includeDescendants) return newKey
      const children = await this.children(from.key, 0, Number.MAX_SAFE_INTEGER)
      for (const child of children.items) {
        const loaded = await this.#load(child)
        if (loaded) await copyBranch(loaded, newKey)
      }
      return newKey
    }
    return copyBranch(source, targetKey)
  }

  /** Sets the sort order of the given children of `parentKey` (null: the root). */
  async sort(
    parentKey: string | null,
    sorting: ReadonlyArray<{ key: string; sortOrder: number }>,
  ): Promise<'sorted' | 'notFound'> {
    const parentId = parentKey ? (await this.#nodes.byKey(parentKey))?.id : SystemNodes.Root
    if (parentId === undefined) return 'notFound'
    return this.#withTree(async () =>
      this.#db.transaction(async (tx) => {
        await assertNodeMayWrite(tx, this.#nodeState)
        const nodes = await new NodeRepository(tx).byKeys(sorting.map((s) => s.key))
        const byKey = new Map(nodes.map((n) => [n.key, n]))
        for (const item of sorting) {
          const node = byKey.get(normaliseUuid(item.key))
          if (!node || node.parentId !== parentId || node.objectType !== this.objectType)
            return 'notFound'
        }
        for (const item of sorting) {
          const node = byKey.get(normaliseUuid(item.key)) as NodeRow
          await tx.exec('UPDATE node SET sort_order = ? WHERE id = ?', [item.sortOrder, node.id])
          await this.#child(tx).#instructContent(node.key)
        }
        return 'sorted'
      }),
    )
  }

  /** Re-sorts every child of `parentKey` by name or date, as the "Sort children" dialog asks. */
  async sortChildrenBy(
    parentKey: string | null,
    field: 'Name' | 'CreateDate' | 'UpdateDate',
    direction: 'Ascending' | 'Descending',
  ): Promise<'sorted' | 'notFound'> {
    const children = await this.children(parentKey, 0, Number.MAX_SAFE_INTEGER)
    if (parentKey && !(await this.#nodes.byKey(parentKey))) return 'notFound'
    const loaded = await Promise.all(
      children.items.map(async (node) => ({ node, aggregate: await this.#load(node) })),
    )
    const sortKey = (entry: (typeof loaded)[number]): string | number => {
      const variant = entry.aggregate?.variants[0]
      if (field === 'Name') return (variant?.name ?? entry.node.text ?? '').toLowerCase()
      if (field === 'CreateDate') return (entry.node.createDate ?? new Date(0)).getTime()
      return (variant?.updateDate ?? entry.node.createDate ?? new Date(0)).getTime()
    }
    loaded.sort((a, b) => {
      const x = sortKey(a)
      const y = sortKey(b)
      const order = x < y ? -1 : x > y ? 1 : a.node.id - b.node.id
      return direction === 'Ascending' ? order : -order
    })
    return this.sort(
      parentKey,
      loaded.map((entry, index) => ({ key: entry.node.key, sortOrder: index })),
    )
  }

  /**
   * Takes a branch out of the recycle bin to `targetKey`, or back where it was
   * when no target is given. Restored content is unpublished.
   */
  async restore(
    key: string,
    targetKey: string | null | undefined,
  ): Promise<'restored' | 'notFound' | 'invalid'> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.objectType || !node.trashed) return 'notFound'
    let parentKey: string | null
    if (targetKey !== undefined && targetKey !== null) parentKey = targetKey
    else if (targetKey === null) parentKey = null
    else parentKey = (await this.originalParent(key)) ?? null
    const parent = parentKey ? await this.#nodes.byKey(parentKey) : undefined
    if (parentKey && (!parent || parent.trashed)) return 'invalid'
    return this.#withTree(async () =>
      this.#db.transaction(async (tx) => {
        const repo = this.#child(tx)
        await assertNodeMayWrite(tx, this.#nodeState)
        const parentId = parent?.id ?? SystemNodes.Root
        await tx.exec('UPDATE node SET trashed = ? WHERE id = ? OR path LIKE ?', [
          tx.dialect.boolValue(false),
          node.id,
          `${node.path},%`,
        ])
        await repo.nodes.move(node.id, parentId)
        await tx.exec('UPDATE node SET sort_order = ? WHERE id = ?', [
          await repo.#nextSortOrder(parentId, node.id),
          node.id,
        ])
        await tx.exec('UPDATE document SET original_parent_id = NULL WHERE node_id = ?', [node.id])
        return 'restored' as const
      }),
    )
  }

  /**
   * Publishes a node, then its descendants shallowest first: those already
   * published, or every one when `includeUnpublished`. A descendant that cannot
   * publish (a missing mandatory value, an unpublished parent) is reported and
   * skipped, and so is its branch below.
   */
  async publishBranch(
    key: string,
    cultures: readonly string[] | null,
    includeUnpublished: boolean,
  ): Promise<{ published: string[]; failed: Array<{ key: string; reason: string }> } | undefined> {
    const root = await this.#nodes.byKey(key)
    if (!root || root.objectType !== this.objectType || root.trashed) return undefined
    const published: string[] = []
    const failed: Array<{ key: string; reason: string }> = []
    try {
      await this.publish(root.key, cultures)
      published.push(root.key)
    } catch (error) {
      if (!(error instanceof PublishBlockedError)) throw error
      return { published, failed: [{ key: root.key, reason: error.message }] }
    }
    const rows = await this.#db.query(
      `SELECT n.id, n.unique_id, n.path, d.published FROM node n JOIN document d ON d.node_id = n.id
       WHERE n.path LIKE ? AND n.node_object_type = ? AND n.trashed = ?
       ORDER BY n.level, n.sort_order, n.id`,
      [`${root.path},%`, this.objectType, this.#db.dialect.boolValue(false)],
    )
    const skipped: string[] = []
    for (const row of rows) {
      const path = String(row.path)
      if (skipped.some((prefix) => path.startsWith(`${prefix},`))) continue
      const nodeKey = normaliseUuid(String(row.unique_id))
      if (!includeUnpublished && !fromDbBool(row.published)) {
        skipped.push(path)
        continue
      }
      try {
        await this.publish(nodeKey, cultures)
        published.push(nodeKey)
      } catch (error) {
        if (!(error instanceof PublishBlockedError)) throw error
        failed.push({ key: nodeKey, reason: error.message })
        skipped.push(path)
      }
    }
    return { published, failed }
  }

  /** A document as it stood at one of its versions: that version's name and values. */
  async atVersion(
    versionId: string,
  ): Promise<{ versionId: string; document: DocumentAggregate } | undefined> {
    const id = Number(versionId)
    if (!Number.isInteger(id)) return undefined
    const rows = await this.#db.query<{ node_id: number; text: string | null }>(
      'SELECT node_id, text FROM content_version WHERE id = ?',
      [id],
    )
    const row = rows[0]
    if (!row) return undefined
    const node = await this.#nodes.byId(Number(row.node_id))
    if (!node || node.objectType !== this.objectType) return undefined
    const current = await this.#load(node)
    const contentTypeNodeId = await this.#contentTypeNodeId(node.id)
    if (!current || !contentTypeNodeId) return undefined
    const propertyTypes = await this.#propertyTypes(contentTypeNodeId)
    const values = await this.#readValues(node.id, propertyTypes, await this.#languages(), {
      eventId: id,
    })
    const name = String(row.text ?? node.text ?? '')
    return {
      versionId: String(id),
      document: {
        ...current,
        values,
        variants: current.variants.map((v) => (v.culture === null ? { ...v, name } : v)),
      },
    }
  }

  /**
   * Replaces the scheduled publish and unpublish of each culture given (null:
   * the invariant variant). A time of null clears that half of the schedule.
   */
  async setSchedule(
    key: string,
    entries: ReadonlyArray<{
      culture: string | null
      publishTime: Date | null
      unpublishTime: Date | null
    }>,
  ): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== this.objectType) return false
    const languages = await this.#languages()
    await this.#db.transaction(async (tx) => {
      for (const entry of entries) {
        const languageId = entry.culture
          ? (languages.find((l) => l.isoCode.toLowerCase() === entry.culture?.toLowerCase())?.id ??
            null)
          : null
        await tx.exec(
          `DELETE FROM content_schedule WHERE node_id = ? AND ${languageId === null ? 'language_id IS NULL' : 'language_id = ?'}`,
          languageId === null ? [node.id] : [node.id, languageId],
        )
        const add = async (action: 'Release' | 'Expire', date: Date | null) => {
          if (!date) return
          await tx.exec(
            'INSERT INTO content_schedule (node_id, language_id, action, date) VALUES (?, ?, ?, ?)',
            [node.id, languageId, action, DbDate.toDb(date)],
          )
        }
        await add('Release', entry.publishTime)
        await add('Expire', entry.unpublishTime)
      }
    })
    return true
  }

  async schedules(
    key: string,
  ): Promise<
    Array<{ id: number; culture: string | null; action: 'Release' | 'Expire'; date: Date }>
  > {
    const node = await this.#nodes.byKey(key)
    if (!node) return []
    const rows = await this.#db.query(
      `SELECT s.id, s.action, s.date, l.iso_code FROM content_schedule s
       LEFT JOIN language l ON l.id = s.language_id WHERE s.node_id = ? ORDER BY s.date`,
      [node.id],
    )
    return rows.map((row) => ({
      id: Number(row.id),
      culture: (row.iso_code as string | null) ?? null,
      action: String(row.action) as 'Release' | 'Expire',
      date: DbDate.fromDb(row.date) ?? new Date(0),
    }))
  }

  /** Schedules whose time has come, oldest first. */
  async dueSchedules(
    now: Date,
  ): Promise<
    Array<{ id: number; key: string; culture: string | null; action: 'Release' | 'Expire' }>
  > {
    const rows = await this.#db.query(
      `SELECT s.id, s.action, n.unique_id, l.iso_code FROM content_schedule s
       JOIN node n ON n.id = s.node_id LEFT JOIN language l ON l.id = s.language_id
       WHERE s.date <= ? AND n.node_object_type = ? ORDER BY s.date, s.id`,
      [DbDate.toDb(now), this.objectType],
    )
    return rows.map((row) => ({
      id: Number(row.id),
      key: normaliseUuid(String(row.unique_id)),
      culture: (row.iso_code as string | null) ?? null,
      action: String(row.action) as 'Release' | 'Expire',
    }))
  }

  /** Takes a due schedule for this process; false when another node already did. */
  async claimSchedule(id: number): Promise<boolean> {
    const rows = await this.#db.query('DELETE FROM content_schedule WHERE id = ? RETURNING id', [
      id,
    ])
    return rows.length > 0
  }

  /**
   * Prunes old versions under the cleanup policy: the content type's own, else
   * `global`. Kept always: the current draft, the published version, and any
   * version pinned with prevent-cleanup. Kept by age: everything newer than
   * keep-all days, then the latest version of each day for keep-latest days.
   *
   * Values are append-only, so a pruned version's value row may still be what a
   * kept version reads ("latest per key at or before it"). Such a row is
   * re-pointed at the earliest kept version after it rather than deleted, so
   * every kept version still reads exactly what it did.
   */
  async cleanupVersions(
    now: Date,
    global: { keepAllVersionsNewerThanDays: number; keepLatestVersionPerDayForDays: number },
  ): Promise<{ nodes: number; versionsDeleted: number }> {
    const types = await this.#db.query(
      `SELECT c.node_id, ct.prevent_cleanup, ct.keep_all_versions_newer_than_days AS keep_all,
              ct.keep_latest_version_per_day_for_days AS keep_latest
       FROM content c JOIN content_type ct ON ct.node_id = c.content_type_id
       JOIN node n ON n.id = c.node_id WHERE n.node_object_type = ?`,
      [this.objectType],
    )
    const day = 24 * 60 * 60 * 1000
    let nodes = 0
    let versionsDeleted = 0
    for (const type of types) {
      if (fromDbBool(type.prevent_cleanup)) continue
      const keepAll =
        type.keep_all === null ? global.keepAllVersionsNewerThanDays : Number(type.keep_all)
      const keepLatest =
        type.keep_latest === null ? global.keepLatestVersionPerDayForDays : Number(type.keep_latest)
      const deleted = await this.#db.transaction((tx) =>
        this.#child(tx).#cleanupNode(
          Number(type.node_id),
          now.getTime() - keepAll * day,
          now.getTime() - keepLatest * day,
        ),
      )
      if (deleted > 0) {
        nodes += 1
        versionsDeleted += deleted
      }
    }
    return { nodes, versionsDeleted }
  }

  async #cleanupNode(
    nodeId: number,
    keepAllAfter: number,
    keepLatestAfter: number,
  ): Promise<number> {
    const events = (
      await this.#db.query(
        `SELECT cv.id, cv.version_date, cv.current, cv.prevent_cleanup, dv.published
         FROM content_version cv JOIN document_version dv ON dv.id = cv.id
         WHERE cv.node_id = ? ORDER BY cv.id`,
        [nodeId],
      )
    ).map((row) => ({
      id: Number(row.id),
      date: (DbDate.fromDb(row.version_date) ?? new Date(0)).getTime(),
      pinned:
        fromDbBool(row.current) || fromDbBool(row.published) || fromDbBool(row.prevent_cleanup),
    }))
    const kept = new Set<number>()
    const latestPerDay = new Map<string, number>()
    for (const event of events) {
      if (event.pinned || event.date >= keepAllAfter) kept.add(event.id)
      else if (event.date >= keepLatestAfter) {
        // Ascending ids: the last one seen for a day is that day's latest.
        latestPerDay.set(new Date(event.date).toISOString().slice(0, 10), event.id)
      }
    }
    for (const id of latestPerDay.values()) kept.add(id)
    const pruned = events.filter((e) => !kept.has(e.id)).map((e) => e.id)
    if (pruned.length === 0) return 0
    const keptAscending = [...kept].sort((a, b) => a - b)
    const prunedSet = new Set(pruned)

    const rows = await this.#db.query<{
      id: number
      property_type_id: number
      language_id: number | null
      segment: string | null
      event_id: number
    }>(
      `SELECT id, property_type_id, language_id, segment, event_id FROM property_value
       WHERE node_id = ? ORDER BY event_id, id`,
      [nodeId],
    )
    // Per key, the distinct events that wrote it, ascending.
    const eventsByKey = new Map<string, number[]>()
    for (const row of rows) {
      const key = keyOf(
        Number(row.property_type_id),
        row.language_id === null ? null : Number(row.language_id),
        row.segment,
      )
      const list = eventsByKey.get(key) ?? []
      if (list.at(-1) !== Number(row.event_id)) list.push(Number(row.event_id))
      eventsByKey.set(key, list)
    }
    for (const row of rows) {
      const eventId = Number(row.event_id)
      if (!prunedSet.has(eventId)) continue
      const key = keyOf(
        Number(row.property_type_id),
        row.language_id === null ? null : Number(row.language_id),
        row.segment,
      )
      const written = eventsByKey.get(key) as number[]
      const next = written[written.indexOf(eventId) + 1] ?? Number.POSITIVE_INFINITY
      const reader = keptAscending.find((k) => k >= eventId)
      if (reader !== undefined && reader < next)
        await this.#db.exec('UPDATE property_value SET event_id = ? WHERE id = ?', [
          reader,
          Number(row.id),
        ])
      else await this.#db.exec('DELETE FROM property_value WHERE id = ?', [Number(row.id)])
    }
    const marks = pruned.map(() => '?').join(', ')
    await this.#db.exec(
      `DELETE FROM content_version_culture_variation WHERE version_id IN (${marks})`,
      pruned,
    )
    await this.#db.exec(`DELETE FROM document_version WHERE id IN (${marks})`, pruned)
    await this.#db.exec(`DELETE FROM content_version WHERE id IN (${marks})`, pruned)
    return pruned.length
  }

  /** Every top-level item in this kind's recycle bin, for emptying it. */
  async trashedRoots(): Promise<NodeRow[]> {
    return (await this.trashed(null, 0, Number.MAX_SAFE_INTEGER)).items
  }

  async #nextSortOrder(parentId: number, excludingId: number): Promise<number> {
    const rows = await this.#db.query<{ next: number | null }>(
      'SELECT MAX(sort_order) AS next FROM node WHERE parent_id = ? AND node_object_type = ? AND id <> ?',
      [parentId, this.objectType, excludingId],
    )
    const current = rows[0]?.next
    return current === null || current === undefined ? 0 : Number(current) + 1
  }

  async #siblingNames(parentKey: string | null): Promise<Set<string>> {
    const siblings = await this.children(parentKey, 0, Number.MAX_SAFE_INTEGER)
    return new Set(siblings.items.map((node) => (node.text ?? '').toLowerCase()))
  }

  // ------------------------------------------------------------ internals

  async #load(node: NodeRow): Promise<DocumentAggregate | undefined> {
    const t = this.#db.dialect.boolValue(true)
    const rows = await this.#db.query(
      `SELECT c.content_type_id, ct.alias AS content_type_alias, ct.icon AS content_type_icon,
              ct.list_view AS content_type_collection,
              ctn.unique_id AS content_type_key, d.published, d.edited,
              head.text AS draft_name, head.version_date AS draft_date,
              hv.template_id, tn.unique_id AS template_key,
              pub.version_date AS published_date
       FROM node n
       JOIN content c ON c.node_id = n.id
       JOIN content_type ct ON ct.node_id = c.content_type_id
       JOIN node ctn ON ctn.id = ct.node_id
       JOIN document d ON d.node_id = n.id
       JOIN content_version head ON head.node_id = n.id AND head.current = ?
       JOIN document_version hv ON hv.id = head.id
       LEFT JOIN node tn ON tn.id = hv.template_id
       LEFT JOIN (
         SELECT pc.node_id, pc.version_date FROM content_version pc
         JOIN document_version pd ON pd.id = pc.id AND pd.published = ?
       ) pub ON pub.node_id = n.id
       WHERE n.id = ?`,
      [t, t, node.id],
    )
    const row = rows[0]
    if (!row) return undefined

    const propertyTypes = await this.#propertyTypes(Number(row.content_type_id))
    const languages = await this.#languages()
    const values = await this.#readValues(node.id, propertyTypes, languages, {})
    const variants = await this.#readVariants(node, row)
    const parent = node.parentId > 0 ? await this.#nodes.byId(node.parentId) : undefined

    return {
      key: node.key,
      contentTypeKey: normaliseUuid(String(row.content_type_key)),
      contentTypeAlias: String(row.content_type_alias),
      contentTypeIcon: String(row.content_type_icon ?? 'icon-document'),
      contentTypeCollectionKey: row.content_type_collection
        ? normaliseUuid(String(row.content_type_collection))
        : null,
      templateKey: row.template_key ? normaliseUuid(String(row.template_key)) : null,
      parentKey: parent && parent.id !== SystemNodes.Root ? parent.key : null,
      sortOrder: node.sortOrder,
      isTrashed: node.trashed,
      published: fromDbBool(row.published),
      edited: fromDbBool(row.edited),
      values,
      variants,
    }
  }

  async #contentTypeNodeId(nodeId: number): Promise<number | undefined> {
    const rows = await this.#db.query<{ content_type_id: number }>(
      'SELECT content_type_id FROM content WHERE node_id = ?',
      [nodeId],
    )
    return rows[0] ? Number(rows[0].content_type_id) : undefined
  }

  async #languages(): Promise<LanguageRow[]> {
    const rows = await this.#db.query('SELECT id, iso_code, is_default, is_mandatory FROM language')
    return rows.map((row) => ({
      id: Number(row.id),
      isoCode: String(row.iso_code),
      isDefault: fromDbBool(row.is_default),
      isMandatory: fromDbBool(row.is_mandatory),
    }))
  }

  /** Property types of a content type, including everything it composes; retired ones excluded. */
  async #propertyTypes(contentTypeNodeId: number): Promise<PropertyTypeRow[]> {
    const rows = await this.#db.query(
      `WITH RECURSIVE ancestry(id) AS (
         SELECT ?
         UNION
         SELECT c.parent_content_type_id FROM content_type_composition c JOIN ancestry a ON a.id = c.child_content_type_id
       )
       SELECT p.id, p.alias, p.name, p.variations, p.mandatory, p.mandatory_message,
              p.validation_reg_exp, p.validation_reg_exp_message, d.db_type, d.editor_alias, d.config,
              p.since_version, ss.version AS since_v, ss.revision AS since_r
       FROM property_type p JOIN data_type d ON d.node_id = p.data_type_id
       LEFT JOIN schema_state ss ON ss.id = p.since_state_id
       WHERE p.content_type_id IN (SELECT id FROM ancestry) AND p.retired_at IS NULL
       ORDER BY p.sort_order, p.id`,
      [contentTypeNodeId],
    )
    return rows.map((row) => ({
      id: Number(row.id),
      alias: String(row.alias),
      name: String(row.name),
      variesByCulture: flagVariesByCulture(Number(row.variations)),
      storage: String(row.db_type) as ValueStorageTypeName,
      editorAlias: String(row.editor_alias),
      config: parseConfig(row.config),
      mandatory: fromDbBool(row.mandatory),
      mandatoryMessage: (row.mandatory_message as string | null) ?? null,
      regEx: (row.validation_reg_exp as string | null) ?? null,
      regExMessage: (row.validation_reg_exp_message as string | null) ?? null,
      pending: isPending(
        {
          since: row.since_v
            ? { version: String(row.since_v), revision: String(row.since_r ?? '0') }
            : null,
          sinceVersion: (row.since_version as string | null) ?? null,
        },
        this.#nodeState,
      ),
    }))
  }

  /**
   * What a read on this node sees: the current rows, unless the database has
   * states newer than the node — then the latest row per key at the node's own
   * state, so an early conversion appended under a prepared state is invisible
   * to the editor on an old node as well as to its renderer.
   */
  async #visibleValueRows(nodeId: number): Promise<ValueRow[]> {
    const stateId = await visibleStateIdFor(this.#db, this.#nodeState)
    return stateId === undefined
      ? this.#currentValueRows(nodeId)
      : this.#valueRowsAsOf(nodeId, { schemaStateId: stateId })
  }

  async #currentValueRows(nodeId: number): Promise<ValueRow[]> {
    const rows = await this.#db.query(
      `SELECT id, event_id, property_type_id, language_id, segment, int_value, decimal_value, date_value, varchar_value, text_value
       FROM property_value WHERE node_id = ? AND is_current = ?`,
      [nodeId, this.#db.dialect.boolValue(true)],
    )
    return rows.map((row) => this.#toValueRow(row))
  }

  /** Latest value per key at or before an event and/or a schema state. */
  async #valueRowsAsOf(
    nodeId: number,
    asOf: { eventId?: number; schemaStateId?: number },
  ): Promise<ValueRow[]> {
    const conditions = ['node_id = ?']
    const params: unknown[] = [nodeId]
    if (asOf.eventId !== undefined) {
      conditions.push('event_id <= ?')
      params.push(asOf.eventId)
    }
    if (asOf.schemaStateId !== undefined) {
      conditions.push('schema_state_id <= ?')
      params.push(asOf.schemaStateId)
    }
    const rows = await this.#db.query(
      `SELECT pv.id, pv.event_id, pv.property_type_id, pv.language_id, pv.segment,
              pv.int_value, pv.decimal_value, pv.date_value, pv.varchar_value, pv.text_value
       FROM property_value pv
       JOIN (
         SELECT property_type_id, language_id, segment, MAX(id) AS id
         FROM property_value WHERE ${conditions.join(' AND ')}
         GROUP BY property_type_id, language_id, segment
       ) latest ON latest.id = pv.id`,
      params,
    )
    return rows.map((row) => this.#toValueRow(row))
  }

  #toValueRow(row: Record<string, unknown>): ValueRow {
    return {
      id: Number(row.id),
      propertyTypeId: Number(row.property_type_id),
      languageId:
        row.language_id === null || row.language_id === undefined ? null : Number(row.language_id),
      segment: (row.segment as string | null) ?? null,
      eventId: Number(row.event_id),
      raw: row,
    }
  }

  async #readValues(
    nodeId: number,
    propertyTypes: readonly PropertyTypeRow[],
    languages: readonly LanguageRow[],
    asOf: { eventId?: number; schemaStateId?: number },
  ): Promise<DocumentValue[]> {
    if (propertyTypes.length === 0) return []
    const rows =
      asOf.eventId === undefined && asOf.schemaStateId === undefined
        ? await this.#visibleValueRows(nodeId)
        : await this.#valueRowsAsOf(nodeId, asOf)
    return this.#valuesFromRows(rows, propertyTypes, languages)
  }

  #valuesFromRows(
    rows: readonly ValueRow[],
    propertyTypes: readonly PropertyTypeRow[],
    languages: readonly LanguageRow[],
  ): DocumentValue[] {
    const byId = new Map(propertyTypes.map((p) => [p.id, p]))
    const isoById = new Map(languages.map((l) => [l.id, l.isoCode]))
    const values: DocumentValue[] = []
    for (const row of rows) {
      const propertyType = byId.get(row.propertyTypeId)
      if (!propertyType) continue
      const raw = (row.raw as Record<string, unknown>)[STORAGE_COLUMN[propertyType.storage]]
      const value = this.#fromStorage(raw, propertyType.storage)
      if (value === null) continue
      values.push({
        alias: propertyType.alias,
        culture: row.languageId === null ? null : (isoById.get(row.languageId) ?? null),
        segment: row.segment,
        value: toEditorValue(propertyType.editorAlias, value),
        editorAlias: propertyType.editorAlias,
        config: propertyType.config,
      })
    }
    return values
  }

  #fromStorage(raw: unknown, storage: ValueStorageTypeName): unknown {
    if (raw === null || raw === undefined) return null
    switch (storage) {
      case 'Integer':
      case 'Decimal':
        return Number(raw)
      case 'Date':
        return DbDate.fromDb(raw)?.toISOString() ?? null
      default:
        return raw
    }
  }

  #toStorage(value: unknown, storage: ValueStorageTypeName): unknown {
    if (value === null || value === undefined) return null
    switch (storage) {
      case 'Integer':
        return typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
      case 'Decimal':
        return String(Number(value))
      case 'Date': {
        if (value instanceof Date) return DbDate.toDb(value)
        // The date pickers send wall-clock time with no zone ("2026-01-02 03:04:05");
        // it is kept as that wall-clock time, not shifted by the server's zone.
        const text = String(value).trim()
        const naive = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(text)
        const date = new Date(
          naive ? `${text.replace(' ', 'T')}${text.length === 10 ? 'T00:00:00' : ''}Z` : text,
        )
        return Number.isNaN(date.getTime()) ? null : DbDate.toDb(date)
      }
      default:
        return typeof value === 'string' ? value : JSON.stringify(value)
    }
  }

  /** Whether a stored cell already holds an incoming value, so an unchanged value appends nothing. */
  #storedEquals(raw: unknown, incoming: unknown, storage: ValueStorageTypeName): boolean {
    const a = this.#fromStorage(raw, storage)
    const b = this.#fromStorage(this.#toStorage(incoming, storage), storage)
    if (a === null || b === null) return a === b
    return String(a) === String(b)
  }

  /**
   * Appends a value version for every incoming value that differs from the
   * current one, and a cleared version for every current value that is absent.
   */
  async #appendValues(
    nodeId: number,
    eventId: number,
    state: SchemaStateRow,
    contentTypeNodeId: number,
    incoming: readonly DocumentValue[],
  ): Promise<void> {
    const propertyTypes = await this.#propertyTypes(contentTypeNodeId)
    const values = this.#intake ? await this.#intake(incoming, propertyTypes) : incoming
    const byAlias = new Map(propertyTypes.map((p) => [p.alias, p]))
    const byId = new Map(propertyTypes.map((p) => [p.id, p]))
    const languages = await this.#languages()
    const idByIso = new Map(languages.map((l) => [l.isoCode.toLowerCase(), l.id]))
    // Equality is judged against what this node sees, so re-saving an unchanged
    // value never overwrites a conversion appended under a newer state; the
    // row superseded is the true current one.
    const current = new Map(
      (await this.#visibleValueRows(nodeId)).map((row) => [
        keyOf(row.propertyTypeId, row.languageId, row.segment),
        row,
      ]),
    )
    const trueCurrent = new Map(
      (await this.#currentValueRows(nodeId)).map((row) => [
        keyOf(row.propertyTypeId, row.languageId, row.segment),
        row,
      ]),
    )

    const seen = new Set<string>()
    for (const value of values) {
      const propertyType = byAlias.get(value.alias)
      if (!propertyType) continue
      const culture = propertyType.variesByCulture ? value.culture : null
      const languageId = culture ? (idByIso.get(culture.toLowerCase()) ?? null) : null
      const key = keyOf(propertyType.id, languageId, value.segment ?? null)
      if (seen.has(key)) continue
      seen.add(key)
      const existing = current.get(key)
      const raw = existing
        ? (existing.raw as Record<string, unknown>)[STORAGE_COLUMN[propertyType.storage]]
        : null
      if (existing && this.#storedEquals(raw, value.value, propertyType.storage)) continue
      if (!existing && (value.value === null || value.value === undefined)) continue
      await this.#insertValue(
        nodeId,
        eventId,
        state.id,
        propertyType,
        languageId,
        value.segment ?? null,
        value.value,
        trueCurrent.get(key)?.id ?? existing?.id,
      )
    }
    // A value that was current but is no longer sent is cleared, as a version.
    for (const [key, row] of current) {
      if (seen.has(key)) continue
      const propertyType = byId.get(row.propertyTypeId)
      if (!propertyType) continue
      const raw = (row.raw as Record<string, unknown>)[STORAGE_COLUMN[propertyType.storage]]
      if (raw === null || raw === undefined) continue
      await this.#insertValue(
        nodeId,
        eventId,
        state.id,
        propertyType,
        row.languageId,
        row.segment,
        null,
        trueCurrent.get(key)?.id ?? row.id,
      )
    }
  }

  /** Makes `target` the current set: used by rollback. */
  async #appendRows(
    nodeId: number,
    eventId: number,
    state: SchemaStateRow,
    target: readonly ValueRow[],
    current: readonly ValueRow[],
  ): Promise<void> {
    const types = new Map<number, PropertyTypeRow>()
    for (const row of [...target, ...current]) {
      if (types.has(row.propertyTypeId)) continue
      const found = await this.#db.query(
        'SELECT p.id, p.alias, p.variations, d.db_type, d.editor_alias FROM property_type p JOIN data_type d ON d.node_id = p.data_type_id WHERE p.id = ?',
        [row.propertyTypeId],
      )
      const r = found[0]
      if (r)
        types.set(row.propertyTypeId, {
          id: Number(r.id),
          alias: String(r.alias),
          name: String(r.alias),
          variesByCulture: flagVariesByCulture(Number(r.variations)),
          storage: String(r.db_type) as ValueStorageTypeName,
          editorAlias: String(r.editor_alias),
          config: {},
          // Only storage matters here: writes never validate or render.
          mandatory: false,
          mandatoryMessage: null,
          regEx: null,
          regExMessage: null,
          pending: false,
        })
    }
    const currentByKey = new Map(
      current.map((row) => [keyOf(row.propertyTypeId, row.languageId, row.segment), row]),
    )
    const seen = new Set<string>()
    for (const row of target) {
      const propertyType = types.get(row.propertyTypeId)
      if (!propertyType) continue
      const key = keyOf(row.propertyTypeId, row.languageId, row.segment)
      seen.add(key)
      const column = STORAGE_COLUMN[propertyType.storage]
      const wanted = this.#fromStorage(
        (row.raw as Record<string, unknown>)[column],
        propertyType.storage,
      )
      const existing = currentByKey.get(key)
      if (
        existing &&
        this.#storedEquals(
          (existing.raw as Record<string, unknown>)[column],
          wanted,
          propertyType.storage,
        )
      )
        continue
      await this.#insertValue(
        nodeId,
        eventId,
        state.id,
        propertyType,
        row.languageId,
        row.segment,
        wanted,
        existing?.id,
      )
    }
    for (const [key, row] of currentByKey) {
      if (seen.has(key)) continue
      const propertyType = types.get(row.propertyTypeId)
      if (!propertyType) continue
      await this.#insertValue(
        nodeId,
        eventId,
        state.id,
        propertyType,
        row.languageId,
        row.segment,
        null,
        row.id,
      )
    }
  }

  async #insertValue(
    nodeId: number,
    eventId: number,
    schemaStateId: number,
    propertyType: PropertyTypeRow,
    languageId: number | null,
    segment: string | null,
    value: unknown,
    supersedes: number | undefined,
  ): Promise<void> {
    const column = STORAGE_COLUMN[propertyType.storage]
    if (supersedes !== undefined) {
      await this.#db.exec('UPDATE property_value SET is_current = ? WHERE id = ?', [
        this.#db.dialect.boolValue(false),
        supersedes,
      ])
    }
    await this.#db.exec(
      `INSERT INTO property_value (node_id, property_type_id, language_id, segment, event_id, schema_state_id, is_current, ${column}, sortable_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nodeId,
        propertyType.id,
        languageId,
        segment,
        eventId,
        schemaStateId,
        this.#db.dialect.boolValue(true),
        this.#toStorage(value, propertyType.storage),
        typeof value === 'string' ? value.slice(0, 512) : null,
      ],
    )
  }

  /**
   * A mandatory property must have a current value before publishing. Pending
   * properties are exempt: a field created early for the next deploy never
   * blocks a publish on the live site.
   */
  async #assertMandatoryFilled(node: NodeRow, cultures: readonly string[] | null): Promise<void> {
    const contentTypeNodeId = await this.#contentTypeNodeId(node.id)
    if (!contentTypeNodeId) return
    const propertyTypes = await this.#propertyTypes(contentTypeNodeId)
    const languages = await this.#languages()
    const values = await this.#readValues(node.id, propertyTypes, languages, {})
    const errors = validateValues(
      propertyTypes,
      values,
      cultures ?? languages.map((l) => l.isoCode),
    )
    if (errors.length > 0) {
      const names = errors.map(
        (e) => `'${propertyTypes.find((p) => p.alias === e.alias)?.name ?? e.alias}'`,
      )
      throw new PublishBlockedError(
        `Required: ${[...new Set(names)].join(', ')} must have a value before publishing.`,
      )
    }
  }

  /**
   * What the editor is told before a save: mandatory and pattern rules over the
   * values as sent, per culture the document has (or the cultures asked for).
   * Pending properties are exempt, as at publish.
   */
  async validate(
    input: {
      contentTypeKey?: string
      key?: string
      values: readonly DocumentValue[]
      variants: SaveDocumentInput['variants']
    },
    cultures: readonly string[] | null = null,
  ): Promise<DocumentValidationError[]> {
    let contentTypeNodeId: number | undefined
    if (input.contentTypeKey)
      contentTypeNodeId = (await this.#nodes.byKey(input.contentTypeKey))?.id
    else if (input.key) {
      const node = await this.#nodes.byKey(input.key)
      if (node) contentTypeNodeId = await this.#contentTypeNodeId(node.id)
    }
    if (!contentTypeNodeId) return []
    const propertyTypes = await this.#propertyTypes(contentTypeNodeId)
    const variantCultures = input.variants
      .map((v) => v.culture)
      .filter((c): c is string => typeof c === 'string')
    return validateValues(propertyTypes, input.values, cultures ?? variantCultures)
  }

  /** Creates and publishes in one go, or refuses before creating anything. */
  async createAndPublish(
    input: SaveDocumentInput,
    cultures: readonly string[] | null,
  ): Promise<
    { ok: true; document: DocumentAggregate } | { ok: false; errors: DocumentValidationError[] }
  > {
    const errors = await this.validate(input, cultures)
    if (errors.length > 0) return { ok: false, errors }
    if (input.parentKey) {
      const parent = await this.#nodes.byKey(input.parentKey)
      if (parent && !(await this.#ancestorsPublished({ ...parent, path: `${parent.path},0` })))
        throw new PublishBlockedError('An ancestor is not published.')
    }
    const created = await this.create(input)
    const published = await this.publish(created.key, cultures)
    return { ok: true, document: published ?? created }
  }

  async updateAndPublish(
    input: SaveDocumentInput,
    cultures: readonly string[] | null,
  ): Promise<
    | { ok: true; document: DocumentAggregate }
    | { ok: false; errors: DocumentValidationError[] }
    | undefined
  > {
    const errors = await this.validate(input, cultures)
    if (errors.length > 0) return { ok: false, errors }
    const updated = await this.update(input)
    if (!updated) return undefined
    const published = await this.publish(input.key, cultures)
    return { ok: true, document: published ?? updated }
  }

  /** The published version's values, or undefined when nothing is published. */
  async byKeyPublished(key: string): Promise<DocumentAggregate | undefined> {
    const node = await this.#nodes.byKey(key)
    if (!node) return undefined
    const draft = await this.#load(node)
    if (!draft?.published) return undefined
    const published = await this.#db.query<{ id: number }>(
      'SELECT cv.id FROM content_version cv JOIN document_version dv ON dv.id = cv.id AND dv.published = ? WHERE cv.node_id = ? ORDER BY cv.id DESC LIMIT 1',
      [this.#db.dialect.boolValue(true), node.id],
    )
    const eventId = Number(published[0]?.id)
    const contentTypeNodeId = await this.#contentTypeNodeId(node.id)
    if (!contentTypeNodeId || !eventId) return undefined
    const propertyTypes = await this.#propertyTypes(contentTypeNodeId)
    const values = await this.#readPublishedValues(
      node.id,
      propertyTypes,
      await this.#languages(),
      eventId,
      await this.#publishedCultureEvents(node.id),
    )
    return { ...draft, values }
  }

  /** The content tree's view of documents, one query per page for the aggregates it decorates with. */
  async treeItems(rows: readonly NodeRow[]): Promise<DocumentTreeItem[]> {
    const counts = await this.#nodes.childCounts(
      rows.map((row) => row.id),
      this.objectType,
    )
    const items: DocumentTreeItem[] = []
    for (const row of rows) {
      const aggregate = await this.#load(row)
      if (!aggregate) continue
      const ancestors = await this.#nodes.ancestors(row.key)
      items.push({
        key: row.key,
        name: row.text ?? '',
        hasChildren: (counts.get(row.id) ?? 0) > 0,
        parentKey: aggregate.parentKey,
        contentTypeKey: aggregate.contentTypeKey,
        contentTypeCollectionKey: aggregate.contentTypeCollectionKey ?? null,
        icon: aggregate.contentTypeIcon,
        isTrashed: row.trashed,
        createDate: row.createDate ?? new Date(),
        ancestorKeys: ancestors.filter((a) => a.objectType === this.objectType).map((a) => a.key),
        variants: aggregate.variants.map((v) => ({
          culture: v.culture,
          name: v.name,
          state: v.state,
        })),
      })
    }
    return items
  }

  /** Where a trashed document was before the bin, when it was not at the root. */
  async originalParent(key: string): Promise<string | null | undefined> {
    const node = await this.#nodes.byKey(key)
    if (!node) return undefined
    const rows = await this.#db.query<{ original_parent_id: number | null }>(
      'SELECT original_parent_id FROM document WHERE node_id = ?',
      [node.id],
    )
    const parentId = rows[0]?.original_parent_id
    if (parentId === null || parentId === undefined) return null
    return (await this.#nodes.byId(Number(parentId)))?.key ?? null
  }

  /** Other nodes drop their published cache when they see this. */
  async #instructContent(key: string): Promise<void> {
    await appendCacheInstruction(this.#db, { kind: 'content', payload: { key }, by: this.#nodeId })
  }

  async #insertEvent(
    nodeId: number,
    kind: EventKind,
    name: string,
    userId: number | undefined,
    templateId: number | null,
    published: boolean,
  ): Promise<number> {
    const t = this.#db.dialect.boolValue(true)
    const f = this.#db.dialect.boolValue(false)
    await this.#db.exec('UPDATE content_version SET current = ? WHERE node_id = ?', [f, nodeId])
    await this.#db.exec(
      `INSERT INTO content_version (node_id, kind, version_date, user_id, current, text, prevent_cleanup) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nodeId, kind, DbDate.toDb(new Date()), userId ?? null, t, name, f],
    )
    const rows = await this.#db.query<{ id: number }>(
      'SELECT MAX(id) AS id FROM content_version WHERE node_id = ?',
      [nodeId],
    )
    const eventId = Number(rows[0]?.id)
    await this.#db.exec(
      'INSERT INTO document_version (id, template_id, published) VALUES (?, ?, ?)',
      [eventId, templateId, this.#db.dialect.boolValue(published)],
    )
    return eventId
  }

  async #headEvent(
    nodeId: number,
  ): Promise<
    { id: number; name: string; userId: number | undefined; templateId: number | null } | undefined
  > {
    const rows = await this.#db.query(
      `SELECT cv.id, cv.text, cv.user_id, dv.template_id FROM content_version cv JOIN document_version dv ON dv.id = cv.id
       WHERE cv.node_id = ? ORDER BY cv.id DESC LIMIT 1`,
      [nodeId],
    )
    const row = rows[0]
    if (!row) return undefined
    return {
      id: Number(row.id),
      name: String(row.text ?? ''),
      userId: row.user_id === null || row.user_id === undefined ? undefined : Number(row.user_id),
      templateId:
        row.template_id === null || row.template_id === undefined ? null : Number(row.template_id),
    }
  }

  async #publishedEventId(nodeId: number): Promise<number | undefined> {
    const rows = await this.#db.query<{ id: number }>(
      'SELECT cv.id FROM content_version cv JOIN document_version dv ON dv.id = cv.id WHERE cv.node_id = ? AND dv.published = ?',
      [nodeId, this.#db.dialect.boolValue(true)],
    )
    return rows[0] ? Number(rows[0].id) : undefined
  }

  /** `edited`: any value newer than the published event, or a changed name. */
  async #recomputeEdited(nodeId: number): Promise<void> {
    const publishedId = await this.#publishedEventId(nodeId)
    let edited = true
    if (publishedId !== undefined) {
      const newer = await this.#db.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM property_value WHERE node_id = ? AND event_id > ?',
        [nodeId, publishedId],
      )
      const names = await this.#db.query<{ head: string | null; pub: string | null }>(
        `SELECT (SELECT text FROM content_version WHERE node_id = ? ORDER BY id DESC LIMIT 1) AS head,
                (SELECT text FROM content_version WHERE id = ?) AS pub`,
        [nodeId, publishedId],
      )
      edited = Number(newer[0]?.n ?? 0) > 0 || (names[0]?.head ?? '') !== (names[0]?.pub ?? '')
    }
    await this.#db.exec('UPDATE document SET edited = ? WHERE node_id = ?', [
      this.#db.dialect.boolValue(edited),
      nodeId,
    ])
    // A published culture is edited when its values, the invariant ones, or its name moved on
    for (const culture of await this.#publishedCultureEvents(nodeId)) {
      const newer = await this.#db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM property_value
         WHERE node_id = ? AND event_id > ? AND (language_id = ? OR language_id IS NULL)`,
        [nodeId, culture.eventId, culture.languageId],
      )
      const names = await this.#db.query<{ name: string | null; published_name: string | null }>(
        'SELECT name, published_name FROM document_culture_variation WHERE node_id = ? AND language_id = ?',
        [nodeId, culture.languageId],
      )
      const cultureEdited =
        Number(newer[0]?.n ?? 0) > 0 || (names[0]?.name ?? '') !== (names[0]?.published_name ?? '')
      await this.#db.exec(
        'UPDATE document_culture_variation SET edited = ? WHERE node_id = ? AND language_id = ?',
        [this.#db.dialect.boolValue(cultureEdited), nodeId, culture.languageId],
      )
    }
  }

  async #readVariants(node: NodeRow, row: Record<string, unknown>): Promise<DocumentVariant[]> {
    const variants = await this.#readVariantsUnscheduled(node, row)
    const schedules = await this.schedules(node.key)
    if (schedules.length === 0) return variants
    return variants.map((variant) => {
      const mine = schedules.filter(
        (s) => (s.culture ?? '').toLowerCase() === (variant.culture ?? '').toLowerCase(),
      )
      return {
        ...variant,
        scheduledPublishDate: mine.find((s) => s.action === 'Release')?.date ?? null,
        scheduledUnpublishDate: mine.find((s) => s.action === 'Expire')?.date ?? null,
      }
    })
  }

  async #readVariantsUnscheduled(
    node: NodeRow,
    row: Record<string, unknown>,
  ): Promise<DocumentVariant[]> {
    const published = fromDbBool(row.published)
    const edited = fromDbBool(row.edited)
    const createDate = node.createDate ?? new Date()
    const updateDate = DbDate.fromDb(row.draft_date) ?? createDate
    const publishDate = DbDate.fromDb(row.published_date) ?? null
    const cultureRows = await this.#db.query(
      `SELECT dcv.name, dcv.published, dcv.edited, dcv.available, l.iso_code
       FROM document_culture_variation dcv JOIN language l ON l.id = dcv.language_id WHERE dcv.node_id = ?`,
      [node.id],
    )
    if (cultureRows.length === 0) {
      return [
        {
          culture: null,
          segment: null,
          name: String(row.draft_name ?? node.text ?? ''),
          state: stateFor(published, edited, node.trashed),
          createDate,
          updateDate,
          publishDate,
        },
      ]
    }
    return cultureRows.map((cultureRow) => ({
      culture: String(cultureRow.iso_code),
      segment: null,
      name: String(cultureRow.name ?? ''),
      state: stateFor(
        fromDbBool(cultureRow.published),
        fromDbBool(cultureRow.edited),
        node.trashed,
        fromDbBool(cultureRow.available),
      ),
      createDate,
      updateDate,
      publishDate,
    }))
  }

  async #writeCultureVariations(
    nodeId: number,
    eventId: number,
    variants: ReadonlyArray<{ culture: string | null; name: string }>,
  ): Promise<void> {
    const cultured = variants.filter((variant) => variant.culture !== null)
    if (cultured.length === 0) return
    const languages = await this.#languages()
    const idByIso = new Map(languages.map((l) => [l.isoCode.toLowerCase(), l.id]))
    const now = DbDate.toDb(new Date())
    const t = this.#db.dialect.boolValue(true)
    const f = this.#db.dialect.boolValue(false)
    for (const variant of cultured) {
      const languageId = idByIso.get(String(variant.culture).toLowerCase())
      if (!languageId) continue
      await this.#db.exec(
        'INSERT INTO content_version_culture_variation (version_id, language_id, name, date) VALUES (?, ?, ?, ?)',
        [eventId, languageId, variant.name, now],
      )
      const existing = await this.#db.query<{ id: number }>(
        'SELECT id FROM document_culture_variation WHERE node_id = ? AND language_id = ?',
        [nodeId, languageId],
      )
      if (existing[0]) {
        await this.#db.exec(
          'UPDATE document_culture_variation SET name = ?, available = ?, edited = ? WHERE id = ?',
          [variant.name, t, t, Number(existing[0].id)],
        )
      } else {
        await this.#db.exec(
          'INSERT INTO document_culture_variation (node_id, language_id, edited, available, published, name) VALUES (?, ?, ?, ?, ?, ?)',
          [nodeId, languageId, t, t, f, variant.name],
        )
      }
    }
  }

  async #copyCultureVariations(fromEventId: number, toEventId: number): Promise<void> {
    await this.#db.exec(
      `INSERT INTO content_version_culture_variation (version_id, language_id, name, date, available_user_id)
       SELECT ?, language_id, name, date, available_user_id FROM content_version_culture_variation WHERE version_id = ?`,
      [toEventId, fromEventId],
    )
  }

  async #availableCultures(nodeId: number): Promise<string[]> {
    const rows = await this.#db.query<{ iso_code: string }>(
      'SELECT l.iso_code FROM document_culture_variation dcv JOIN language l ON l.id = dcv.language_id WHERE dcv.node_id = ? AND dcv.available = ?',
      [nodeId, this.#db.dialect.boolValue(true)],
    )
    return rows.map((row) => String(row.iso_code))
  }

  async #publishedCultures(nodeId: number): Promise<string[]> {
    const rows = await this.#db.query<{ iso_code: string }>(
      'SELECT l.iso_code FROM document_culture_variation dcv JOIN language l ON l.id = dcv.language_id WHERE dcv.node_id = ? AND dcv.published = ?',
      [nodeId, this.#db.dialect.boolValue(true)],
    )
    return rows.map((row) => String(row.iso_code))
  }

  /** Publishes a culture at `eventId` with its current name, or unpublishes it (`null`). */
  async #setCulturePublished(nodeId: number, iso: string, eventId: number | null): Promise<void> {
    const languages = await this.#languages()
    const languageId = languages.find((l) => l.isoCode.toLowerCase() === iso.toLowerCase())?.id
    if (!languageId) return
    if (eventId === null)
      await this.#db.exec(
        'UPDATE document_culture_variation SET published = ?, edited = ? WHERE node_id = ? AND language_id = ?',
        [this.#db.dialect.boolValue(false), this.#db.dialect.boolValue(true), nodeId, languageId],
      )
    else
      await this.#db.exec(
        `UPDATE document_culture_variation SET published = ?, edited = ?, published_event_id = ?,
           published_name = name WHERE node_id = ? AND language_id = ?`,
        [
          this.#db.dialect.boolValue(true),
          this.#db.dialect.boolValue(false),
          eventId,
          nodeId,
          languageId,
        ],
      )
  }

  /** Each published culture: its language, the event it was published at, and its published name. */
  async #publishedCultureEvents(
    nodeId: number,
  ): Promise<Array<{ languageId: number; isoCode: string; eventId: number; name: string }>> {
    const rows = await this.#db.query(
      `SELECT dcv.language_id, l.iso_code, dcv.published_event_id, dcv.published_name, dcv.name
       FROM document_culture_variation dcv JOIN language l ON l.id = dcv.language_id
       WHERE dcv.node_id = ? AND dcv.published = ?`,
      [nodeId, this.#db.dialect.boolValue(true)],
    )
    return rows.map((row) => ({
      languageId: Number(row.language_id),
      isoCode: String(row.iso_code),
      eventId: Number(row.published_event_id ?? 0),
      name: String(row.published_name ?? row.name ?? ''),
    }))
  }

  async #variesByCulture(nodeId: number): Promise<boolean> {
    const rows = await this.#db.query<{ variations: number }>(
      'SELECT ct.variations FROM content c JOIN content_type ct ON ct.node_id = c.content_type_id WHERE c.node_id = ?',
      [nodeId],
    )
    return flagVariesByCulture(Number(rows[0]?.variations ?? 0))
  }

  /**
   * Published values: invariant ones as of the latest publish, each culture's
   * as of its own. A culture that is not published contributes nothing.
   */
  async #readPublishedValues(
    nodeId: number,
    propertyTypes: readonly PropertyTypeRow[],
    languages: readonly LanguageRow[],
    invariantEventId: number,
    cultures: ReadonlyArray<{ languageId: number; eventId: number }>,
    schemaStateId?: number,
  ): Promise<DocumentValue[]> {
    const cutoff = new Map(cultures.map((c) => [c.languageId, c.eventId]))
    const latest = Math.max(invariantEventId, ...cultures.map((c) => c.eventId))
    const conditions = ['node_id = ?', 'event_id <= ?']
    const params: unknown[] = [nodeId, latest]
    if (schemaStateId !== undefined) {
      conditions.push('schema_state_id <= ?')
      params.push(schemaStateId)
    }
    const all = (
      await this.#db.query(
        `SELECT id, event_id, property_type_id, language_id, segment,
                int_value, decimal_value, date_value, varchar_value, text_value
         FROM property_value WHERE ${conditions.join(' AND ')} ORDER BY id`,
        params,
      )
    ).map((row) => this.#toValueRow(row))
    const chosen = new Map<string, ValueRow>()
    for (const row of all) {
      const limit = row.languageId === null ? invariantEventId : cutoff.get(row.languageId)
      if (limit === undefined || row.eventId > limit) continue
      chosen.set(keyOf(row.propertyTypeId, row.languageId, row.segment), row)
    }
    return this.#valuesFromRows([...chosen.values()], propertyTypes, languages)
  }

  async #anyCulturePublished(nodeId: number): Promise<boolean> {
    const rows = await this.#db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM document_culture_variation WHERE node_id = ? AND published = ?',
      [nodeId, this.#db.dialect.boolValue(true)],
    )
    return Number(rows[0]?.n ?? 0) > 0
  }

  async #ancestorsPublished(
    node: NodeRow,
    alsoPublishing: ReadonlySet<number> = new Set(),
  ): Promise<boolean> {
    const ids = node.path
      .split(',')
      .map(Number)
      .filter((id) => id > 0 && id !== node.id && !alsoPublishing.has(id))
    if (ids.length === 0) return true
    const rows = await this.#db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM document WHERE node_id IN (${ids.map(() => '?').join(', ')}) AND published = ?`,
      [...ids, this.#db.dialect.boolValue(false)],
    )
    return Number(rows[0]?.n ?? 0) === 0
  }
}

function stateFor(
  published: boolean,
  edited: boolean,
  trashed: boolean,
  available = true,
): VariantState {
  if (trashed) return 'Trashed'
  if (!available) return 'NotCreated'
  if (published) return edited ? 'PublishedPendingChanges' : 'Published'
  return 'Draft'
}

/** `name`, or the first of `name (1)`, `name (2)`… no sibling already has. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 1; ; n++) {
    const candidate = `${name} (${n})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
