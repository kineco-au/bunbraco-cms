/** Adapters binding the document repository to the API port and the renderer. */
import type {
  DocumentPort,
  PortFailure,
  Principal,
  SaveDocument,
  SkipTake,
} from '@bunbraco/api-management'
import {
  type DocumentAggregate,
  normaliseUuid,
  ObjectTypes,
  type Page,
  type TreeItem,
  toPublishedValue,
} from '@bunbraco/core'
import {
  appendCacheInstruction,
  ContentTypeRepository,
  type Db,
  DictionaryRepository,
  DocumentRepository,
  type DocumentRepositoryOptions,
  DomainRepository,
  LanguageRepository,
  NOTIFIABLE_ACTIONS,
  type NodeRow,
  NotificationRepository,
  PublishBlockedError,
  RedirectRepository,
  WriteRejectedError,
} from '@bunbraco/data'
import type { PublishedCache, PublishedContentSource, PublishedNode } from '@bunbraco/render'
import {
  DOMAINS_FILE,
  nodeReferenceFor,
  readDomainsFile,
  replaceNodeDeclarations,
  writeDomains,
} from '../domains.ts'
import { TemporaryFileMissingError } from '../file-intake.ts'
import { NO_REDIRECT_TRACKING, type RedirectTracker } from '../redirects.ts'

async function toTreeItems(
  repo: DocumentRepository,
  rows: readonly NodeRow[],
): Promise<TreeItem[]> {
  const counts = await repo.nodes.childCounts(
    rows.map((row) => row.id),
    ObjectTypes.Document,
  )
  const items: TreeItem[] = []
  for (const row of rows) {
    const parent = row.parentId > 0 ? await repo.nodes.byId(row.parentId) : undefined
    const aggregate = await repo.load(row)
    items.push({
      key: row.key,
      name: row.text ?? '',
      hasChildren: (counts.get(row.id) ?? 0) > 0,
      parentKey: parent && parent.objectType === ObjectTypes.Document ? parent.key : null,
      icon: aggregate?.contentTypeIcon ?? 'icon-document',
      isFolder: false,
    })
  }
  return items
}

export function createDocumentPort(
  db: Db,
  cache: PublishedCache,
  options: DocumentRepositoryOptions = {},
  /** Without one, a rename or a move records no redirect. */
  tracker: RedirectTracker = NO_REDIRECT_TRACKING,
  /** The site's own directory: where `domains.toml` is, when the site keeps one. */
  siteDir?: string,
): DocumentPort {
  const repo = new DocumentRepository(db, options)
  const domains = new DomainRepository(db)
  const notifications = new NotificationRepository(db)

  /** The signed-in user's row id, which versions record as their author. */
  const userIdOf = async (principal: Principal | undefined): Promise<number | undefined> => {
    if (!principal) return undefined
    const rows = await db.query<{ id: number }>('SELECT id FROM user_account WHERE key = ?', [
      principal.id,
    ])
    return rows[0] ? Number(rows[0].id) : undefined
  }

  /** A node behind the database's schema state may read but not write: 409. */
  const failure = (error: unknown) => {
    if (error instanceof WriteRejectedError)
      return { ok: false as const, reason: error.message, status: 409 }
    if (error instanceof PublishBlockedError) return { ok: false as const, reason: error.message }
    if (error instanceof TemporaryFileMissingError)
      return { ok: false as const, reason: error.message, status: 400 }
    throw error
  }

  /** Publishing changes what is reachable, so the cache must be dropped. */
  const invalidate = () => cache.invalidate()

  const validationFailure = (errors: NonNullable<PortFailure['errors']>): PortFailure => ({
    ok: false,
    reason: 'One or more properties did not pass validation',
    status: 400,
    errors,
  })

  return {
    byKey: (key) => repo.byKey(key),
    byKeyPublished: (key) => repo.byKeyPublished(key),
    validate: (input, cultures) => repo.validate(input, cultures),

    async createAndPublish(input: SaveDocument, cultures: string[] | null, principal: Principal) {
      try {
        const userId = await userIdOf(principal)
        const result = await repo.createAndPublish({ ...input, userId }, cultures)
        if (!result.ok) return validationFailure(result.errors)
        invalidate()
        return { ok: true as const, key: result.document.key }
      } catch (error) {
        return failure(error)
      }
    },

    async updateAndPublish(
      key: string,
      input: SaveDocument,
      cultures: string[] | null,
      principal: Principal,
    ) {
      try {
        const userId = await userIdOf(principal)
        const before = await tracker.capture(key)
        const result = await repo.updateAndPublish({ ...input, key, userId }, cultures)
        if (!result) return { ok: false as const, reason: 'The document could not be found.' }
        if (!result.ok) return validationFailure(result.errors)
        invalidate()
        await tracker.commit(before)
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async treeRoot(paging: SkipTake) {
      const page = await repo.children(null, paging.skip, paging.take)
      return { total: page.total, items: await repo.treeItems(page.items) }
    },
    async treeChildren(parentKey: string, paging: SkipTake) {
      const page = await repo.children(parentKey, paging.skip, paging.take)
      return { total: page.total, items: await repo.treeItems(page.items) }
    },
    treeAncestors: async (descendantKey: string) =>
      repo.treeItems(
        (await repo.nodes.ancestors(descendantKey)).filter(
          (row) => row.objectType === ObjectTypes.Document,
        ),
      ),
    async documentItems(keys: readonly string[]) {
      const rows = await Promise.all(keys.map((key) => repo.nodes.byKey(key)))
      return repo.treeItems(
        rows.filter((row): row is NodeRow => row?.objectType === ObjectTypes.Document),
      )
    },
    async treeSiblings(target: string, before: number, after: number) {
      const window = await repo.siblings(target, before, after)
      if (!window) return undefined
      return { ...window, items: await repo.treeItems(window.items) }
    },
    async search(query, options) {
      const page = await repo.search(query, options)
      return { total: page.total, items: await repo.treeItems(page.items) }
    },
    async recycleBin(parentKey: string | null, paging: SkipTake) {
      const page = await repo.trashed(parentKey, paging.skip, paging.take)
      return { total: page.total, items: await repo.treeItems(page.items) }
    },
    originalParent: (key) => repo.originalParent(key),
    async recycleBinSiblings(target: string, before: number, after: number) {
      const window = await repo.siblings(target, before, after)
      if (!window) return undefined
      return { ...window, items: await repo.treeItems(window.items) }
    },

    async create(input: SaveDocument, principal: Principal) {
      try {
        const created = await repo.create({ ...input, userId: await userIdOf(principal) })
        return { ok: true as const, key: created.key }
      } catch (error) {
        return failure(error)
      }
    },

    async update(key: string, input: SaveDocument, principal: Principal) {
      try {
        const updated = await repo.update({ ...input, key, userId: await userIdOf(principal) })
        if (!updated) return { ok: false as const, reason: 'The document could not be found.' }
        invalidate()
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async publish(key: string, cultures: string[] | null) {
      try {
        const before = await tracker.capture(key)
        const published = await repo.publish(key, cultures)
        if (!published) return { ok: false as const, reason: 'The document could not be found.' }
        invalidate()
        await tracker.commit(before)
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async unpublish(key: string, cultures: string[] | null) {
      try {
        const result = await repo.unpublish(key, cultures)
        if (!result) return { ok: false as const, reason: 'The document could not be found.' }
        invalidate()
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async moveToRecycleBin(key: string) {
      const moved = await repo.moveToRecycleBin(key)
      if (moved) invalidate()
      return moved
    },

    async remove(key: string) {
      const removed = await repo.delete(key)
      if (removed) invalidate()
      return removed
    },

    async move(key, targetKey) {
      try {
        const before = await tracker.capture(key)
        const result = await repo.move(key, targetKey)
        if (result === 'notFound')
          return {
            ok: false as const,
            reason: 'The document or target could not be found.',
            status: 404,
          }
        if (result === 'invalid')
          return {
            ok: false as const,
            reason: 'A document cannot be moved below itself or into the recycle bin.',
            status: 400,
          }
        invalidate()
        await tracker.commit(before)
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async copy(key, targetKey, options, principal) {
      try {
        const copied = await repo.copy(key, targetKey, {
          includeDescendants: options.includeDescendants,
          userId: await userIdOf(principal),
        })
        if (!copied)
          return {
            ok: false as const,
            reason: 'The document or target could not be found.',
            status: 404,
          }
        return { ok: true as const, key: copied }
      } catch (error) {
        return failure(error)
      }
    },

    async sort(parentKey, sorting) {
      try {
        const before = await tracker.captureChildren(parentKey)
        const result = await repo.sort(parentKey, sorting)
        if (result === 'notFound')
          return {
            ok: false as const,
            reason: 'The parent, or one of the items, could not be found under it.',
            status: 404,
          }
        invalidate()
        await tracker.commit(before)
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async sortChildrenBy(parentKey, field, direction) {
      try {
        const before = await tracker.captureChildren(parentKey)
        const result = await repo.sortChildrenBy(parentKey, field, direction)
        if (result === 'notFound')
          return { ok: false as const, reason: 'The document could not be found.', status: 404 }
        invalidate()
        await tracker.commit(before)
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async restore(key, targetKey) {
      try {
        const result = await repo.restore(key, targetKey)
        if (result === 'notFound')
          return {
            ok: false as const,
            reason: 'The document is not in the recycle bin.',
            status: 404,
          }
        if (result === 'invalid')
          return {
            ok: false as const,
            reason: 'The restore target does not exist or is in the recycle bin.',
            status: 400,
          }
        invalidate()
        return { ok: true as const }
      } catch (error) {
        return failure(error)
      }
    },

    async emptyRecycleBin() {
      for (const node of await repo.trashedRoots()) await repo.delete(node.key)
      invalidate()
    },

    async publishBranch(key, cultures, includeUnpublished) {
      try {
        const before = await tracker.capture(key)
        const result = await repo.publishBranch(key, cultures, includeUnpublished)
        if (!result)
          return { ok: false as const, reason: 'The document could not be found.', status: 404 }
        invalidate()
        await tracker.commit(before)
        return { ok: true as const, ...result }
      } catch (error) {
        return failure(error)
      }
    },

    atVersion: (versionId) => repo.atVersion(versionId),
    schedule: (key, entries) => repo.setSchedule(key, entries),

    async domains(key) {
      const node = await repo.nodes.byKey(key)
      if (!node || node.objectType !== repo.objectType) return undefined
      return domains.forNode(node.id)
    },
    async setDomains(key, assignment) {
      const node = await repo.nodes.byKey(key)
      if (!node || node.objectType !== repo.objectType) return { status: 'notFound' as const }
      const result = await domains.setForNode(node.id, assignment)
      if (result.status !== 'ok') return result
      await appendCacheInstruction(db, {
        kind: 'content',
        payload: { key: node.key },
        by: options.nodeId,
      })
      invalidate()

      // A site that keeps `domains.toml` keeps it in the file: the next boot
      // converges onto it, so a change saved only here would be undone. Only
      // this page's entries are rewritten, so `${VAR}` in the others survives.
      const declarations = siteDir ? readDomainsFile(siteDir) : undefined
      if (!declarations) return result
      await writeDomains(
        siteDir as string,
        replaceNodeDeclarations(
          declarations.declarations,
          await nodeReferenceFor(db, declarations.declarations, node),
          assignment.domains.map((domain) => ({
            host: domain.domainName,
            culture: domain.isoCode || undefined,
          })),
          assignment.defaultIsoCode ?? undefined,
        ),
      )
      return { status: 'ok' as const, file: DOMAINS_FILE }
    },

    async notifications(key, principal) {
      const node = await repo.nodes.byKey(key)
      const userId = await userIdOf(principal)
      if (!node || node.objectType !== repo.objectType || userId === undefined) return undefined
      const subscribed = new Set(await notifications.subscribed(userId, node.id))
      return NOTIFIABLE_ACTIONS.map((action) => ({
        ...action,
        subscribed: subscribed.has(action.actionId),
      }))
    },
    async setNotifications(key, principal, actionIds) {
      const node = await repo.nodes.byKey(key)
      const userId = await userIdOf(principal)
      if (!node || node.objectType !== repo.objectType || userId === undefined) return false
      await notifications.set(userId, node.id, actionIds)
      return true
    },

    versions: (key) => repo.versions(key),
    async systemUserKey() {
      const rows = await db.query<{ key: string }>(
        'SELECT key FROM user_account ORDER BY id LIMIT 1',
      )
      return rows[0] ? normaliseUuid(String(rows[0].key)) : null
    },

    async rollback(versionId: string) {
      const result = await repo.rollback(versionId)
      if (result) invalidate()
      return result !== undefined
    },

    setPreventCleanup: (versionId, prevent) => repo.setPreventCleanup(versionId, prevent),

    // An unpublished document, or culture, has no URL, which the editor renders as such.
    urls: (key: string) => cache.urls(key),

    async root(paging: SkipTake): Promise<Page<TreeItem>> {
      const page = await repo.children(null, paging.skip, paging.take)
      return { total: page.total, items: await toTreeItems(repo, page.items) }
    },

    async children(parentKey: string, paging: SkipTake): Promise<Page<TreeItem>> {
      const page = await repo.children(parentKey, paging.skip, paging.take)
      return { total: page.total, items: await toTreeItems(repo, page.items) }
    },

    async ancestors(descendantKey: string): Promise<TreeItem[]> {
      return toTreeItems(repo, await repo.nodes.ancestors(descendantKey))
    },

    async items(keys: readonly string[]): Promise<TreeItem[]> {
      return toTreeItems(repo, await repo.nodes.byKeys(keys))
    },

    async collection(parentKey: string | null, paging: SkipTake): Promise<Page<DocumentAggregate>> {
      const page = await repo.children(parentKey, paging.skip, paging.take)
      const items: DocumentAggregate[] = []
      for (const row of page.items) {
        const aggregate = await repo.load(row)
        if (aggregate) items.push(aggregate)
      }
      return { total: page.total, items }
    },
  }
}

export function createPublishedContentSource(
  db: Db,
  options: DocumentRepositoryOptions = {},
): PublishedContentSource {
  const repo = new DocumentRepository(db, options)
  return {
    async loadPublished(): Promise<PublishedNode[]> {
      const rows = await repo.loadPublished()
      return rows.map((row) => ({
        key: row.key,
        id: row.id,
        parentId: row.parentId,
        level: row.level,
        path: row.path,
        sortOrder: row.sortOrder,
        name: row.name,
        contentTypeAlias: row.contentTypeAlias,
        componentAlias: row.componentAlias,
        createDate: row.createDate,
        updateDate: row.updateDate,
        cultures: row.cultures,
        names: row.names,
        properties: row.values.map((value) => ({
          alias: value.alias,
          editorAlias: value.editorAlias ?? '',
          culture: value.culture,
          segment: value.segment,
          value: toPublishedValue(value.editorAlias, value.value),
          config: value.config,
        })),
      }))
    },
    async loadMedia() {
      const media = new DocumentRepository(db, { ...options, kind: 'media' })
      const rows = await db.query<{ unique_id: string }>(
        'SELECT unique_id FROM node WHERE node_object_type = ? AND trashed = ?',
        [ObjectTypes.Media, db.dialect.boolValue(false)],
      )
      const nodes = []
      for (const row of rows) {
        const item = await media.byKey(normaliseUuid(String(row.unique_id)))
        if (!item) continue
        nodes.push({
          key: item.key,
          id: (await media.nodes.byKey(item.key))?.id ?? 0,
          name: item.variants[0]?.name ?? '',
          mediaTypeAlias: item.contentTypeAlias,
          properties: item.values.map((value) => ({
            alias: value.alias,
            editorAlias: value.editorAlias ?? '',
            culture: value.culture,
            segment: value.segment,
            value: toPublishedValue(value.editorAlias, value.value),
            config: value.config,
          })),
        })
      }
      return nodes
    },
    async loadLanguages() {
      return (await new LanguageRepository(db).all()).map((l) => ({
        isoCode: l.isoCode,
        isDefault: l.isDefault,
        fallbackIsoCode: l.fallbackIsoCode,
      }))
    },
    loadDictionary: () => new DictionaryRepository(db).translations(),
    async loadDomains() {
      return (await new DomainRepository(db).all()).map((row) => ({
        nodeId: row.nodeId,
        domainName: row.domainName,
        isoCode: row.isoCode,
        isWildcard: row.isWildcard,
      }))
    },
    /**
     * Published library elements. `loadPublished` is keyed on the repository's own
     * object type, so the same query that builds the content cache builds this one
     * with `kind: 'element'`.
     */
    async loadElements() {
      const elements = new DocumentRepository(db, { ...options, kind: 'element' })
      const types = new ContentTypeRepository(db)
      const keyOfType = new Map<string, string>()
      const rows = await elements.loadPublished()
      const out = []
      for (const row of rows) {
        if (!keyOfType.has(row.contentTypeAlias))
          keyOfType.set(
            row.contentTypeAlias,
            (await types.byAlias(row.contentTypeAlias))?.key ?? '',
          )
        out.push({
          key: row.key,
          contentTypeKey: keyOfType.get(row.contentTypeAlias) as string,
          contentTypeAlias: row.contentTypeAlias,
          cultures: row.cultures,
          properties: row.values.map((value) => ({
            alias: value.alias,
            editorAlias: value.editorAlias ?? '',
            culture: value.culture,
            segment: value.segment,
            value: toPublishedValue(value.editorAlias, value.value),
            config: value.config,
          })),
        })
      }
      return out
    },
    loadContentTypeAliases: () => new ContentTypeRepository(db).aliasesByKey(),

    async loadRedirects() {
      return (await new RedirectRepository(db).all()).map((row) => ({
        key: row.key,
        matchKind: row.matchKind,
        pattern: row.pattern,
        rootKey: row.rootKey,
        culture: row.culture,
        targetKind: row.targetKind,
        target: row.target,
        statusCode: row.statusCode,
        sortOrder: row.sortOrder,
        source: row.source,
      }))
    },
  }
}

/** A document's current draft in the shape the renderer takes, for preview. */
export async function loadDraftNode(
  db: Db,
  key: string,
  options: DocumentRepositoryOptions = {},
): Promise<PublishedNode | undefined> {
  const repo = new DocumentRepository(db, options)
  const node = await repo.nodes.byKey(key)
  if (!node || node.objectType !== repo.objectType) return undefined
  const draft = await repo.load(node)
  if (!draft) return undefined
  const template = draft.componentKey ? await repo.nodes.byKey(draft.componentKey) : undefined
  const componentAlias = template
    ? ((
        await db.query<{ alias: string }>('SELECT alias FROM template WHERE node_id = ?', [
          template.id,
        ])
      )[0]?.alias ?? null)
    : null
  const invariant = draft.variants.find((v) => v.culture === null) ?? draft.variants[0]
  return {
    key: node.key,
    id: node.id,
    parentId: node.parentId,
    level: node.level,
    path: node.path,
    sortOrder: node.sortOrder,
    name: invariant?.name ?? node.text ?? '',
    contentTypeAlias: draft.contentTypeAlias,
    componentAlias: componentAlias ? String(componentAlias) : null,
    createDate: node.createDate ?? new Date(),
    updateDate: invariant?.updateDate ?? new Date(),
    cultures: draft.variants.flatMap((v) => (v.culture ? [v.culture] : [])),
    names: Object.fromEntries(
      draft.variants.flatMap((v) => (v.culture ? [[v.culture, v.name]] : [])),
    ),
    properties: draft.values.map((value) => ({
      alias: value.alias,
      editorAlias: value.editorAlias ?? '',
      culture: value.culture,
      segment: value.segment,
      value: toPublishedValue(value.editorAlias, value.value),
    })),
  }
}
