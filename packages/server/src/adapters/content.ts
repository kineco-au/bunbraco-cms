/**
 * Adapters binding the data repositories to the Management API ports.
 *
 * Tree shaping lives here because "is this a folder", "does it have children" and
 * "which icon" are presentation concerns rather than storage ones.
 */
import type {
  ContentTypePort,
  DataTypePort,
  FolderPort,
  PortFailure,
  Principal,
  SkipTake,
  TemplatePort,
  TreePage,
} from '@bunbraco/api-management'
import {
  type ContentTypeAggregate,
  type DataTypeModel,
  ObjectTypes,
  type Page,
  SystemNodes,
  type TemplateModel,
  type TreeItem,
} from '@bunbraco/core'
import {
  CONTENT_TYPE_OBJECT_TYPES,
  type ContentTypeKind,
  ContentTypeRepository,
  type ContentTypeRepositoryOptions,
  DataTypeRepository,
  type Db,
  FolderRepository,
  type NodeRepository,
  type NodeRow,
  type TemplateFileStore,
  TemplateRepository,
} from '@bunbraco/data'
import { aliasFromName } from '@bunbraco/schema'
import { readContentTypeUdt, writeContentTypeUdt } from '../content-type-udt.ts'
import { classifyTypeChange } from '../schema-classify.ts'
import { contentTypeJsonSchema, schemaForStorage, valueTypeName } from '../value-schemas.ts'
import { createSchemaFileWriter, type SchemaFiles } from './schema-files.ts'

async function toTreeItems(
  nodes: NodeRepository,
  rows: readonly NodeRow[],
  objectType: string,
  icon: (row: NodeRow) => string | null,
): Promise<TreeItem[]> {
  // One grouped query rather than one per row.
  const counts = await nodes.childCounts(
    rows.map((row) => row.id),
    objectType,
  )
  const items: TreeItem[] = []
  for (const row of rows) {
    const parent = row.parentId > 0 ? await nodes.byId(row.parentId) : undefined
    items.push({
      key: row.key,
      name: row.text ?? '',
      hasChildren: (counts.get(row.id) ?? 0) > 0,
      parentKey: parent?.key ?? null,
      icon: icon(row),
      isFolder: false,
    })
  }
  return items
}

/**
 * A settings tree mixes folders and items. Folders come first; an item's
 * decoration (icon, element flag, editor) is filled in by the caller.
 */
export function createSettingsTree(
  nodes: NodeRepository,
  containerType: string,
  itemType: string,
  decorate: (item: TreeItem) => Promise<void>,
) {
  const types = (foldersOnly: boolean | undefined) =>
    foldersOnly ? [containerType] : [containerType, itemType]

  const shape = async (rows: readonly NodeRow[]): Promise<TreeItem[]> => {
    const items: TreeItem[] = []
    for (const row of rows) {
      const parent = row.parentId > 0 ? await nodes.byId(row.parentId) : undefined
      const inside = await nodes.childrenOf(row.id, [containerType, itemType], 0, 1)
      const item: TreeItem = {
        key: row.key,
        name: row.text ?? '',
        hasChildren: inside.total > 0,
        parentKey: parent && parent.objectType === containerType ? parent.key : null,
        icon: row.objectType === containerType ? 'icon-folder' : null,
        isFolder: row.objectType === containerType,
      }
      if (!item.isFolder) await decorate(item)
      items.push(item)
    }
    return items
  }

  const page = async (parentKey: string | null, paging: TreePage): Promise<Page<TreeItem>> => {
    const parentId = parentKey ? (await nodes.byKey(parentKey))?.id : SystemNodes.Root
    if (parentId === undefined) return { total: 0, items: [] }
    const result = await nodes.childrenOf(
      parentId,
      types(paging.foldersOnly),
      paging.skip,
      paging.take,
    )
    return { total: result.total, items: await shape(result.items) }
  }

  return {
    shape,
    nodes,
    containerType,
    itemType,
    treeRoot: (paging: TreePage) => page(null, paging),
    treeChildren: (parentKey: string, paging: TreePage) => page(parentKey, paging),
    ancestors: async (descendantKey: string) => shape(await nodes.ancestors(descendantKey)),
    items: async (keys: readonly string[]) => shape(await nodes.byKeys(keys)),
    async siblings(target: string, before: number, after: number, foldersOnly?: boolean) {
      const window = await nodes.siblings(target, types(foldersOnly), before, after)
      if (!window) return undefined
      return { ...window, items: await shape(window.items) }
    },
  }
}

export function createFolderPort(
  folders: FolderRepository,
  tree: ReturnType<typeof createSettingsTree>,
  afterChange: () => Promise<void>,
): FolderPort {
  return {
    folder: (key) => folders.byKey(key),
    async createFolder(input) {
      const created = await folders.create(input)
      return { key: created.key }
    },
    async renameFolder(key, name) {
      const ok = await folders.rename(key, name)
      if (ok) await afterChange()
      return ok
    },
    async deleteFolder(key) {
      const result = await folders.delete(key)
      if (result === 'deleted') await afterChange()
      return result
    },
    siblings: tree.siblings,
    async search(query, kind, paging) {
      const types = [
        ...(kind !== 'Item' ? [tree.containerType] : []),
        ...(kind !== 'Folder' ? [tree.itemType] : []),
      ]
      const hits: NodeRow[] = []
      for (const type of types)
        hits.push(...(await tree.nodes.search(type, query, { skip: 0, take: 10_000 })).items)
      hits.sort(
        (a, b) =>
          Number(b.objectType === tree.containerType) -
            Number(a.objectType === tree.containerType) ||
          (a.text ?? '').localeCompare(b.text ?? ''),
      )
      return {
        total: hits.length,
        items: await tree.shape(hits.slice(paging.skip, paging.skip + paging.take)),
      }
    },
  }
}

export interface ContentTypePortOptions extends ContentTypeRepositoryOptions {
  /** Document types by default; media types share the port. */
  kind?: ContentTypeKind
  /** Lets "Create template" write the view file. */
  templateFiles?: TemplateFileStore
}

export function createContentTypePort(
  db: Db,
  schemaFiles?: SchemaFiles,
  options: ContentTypePortOptions = {},
): ContentTypePort {
  const kind = options.kind ?? 'document'
  const repo = new ContentTypeRepository(db, { nodeState: options.nodeState, kind })
  const nodes = repo.nodes
  const objectType = repo.objectType
  const containerType = CONTENT_TYPE_OBJECT_TYPES[kind].container
  const folders = new FolderRepository(db, containerType, objectType)
  const files = schemaFiles ? createSchemaFileWriter(db, schemaFiles, kind) : undefined
  const templates = new TemplateRepository(db, options.templateFiles)
  const rewrite = () => files?.rewriteAll() ?? Promise.resolve()

  const decorate = async (item: TreeItem) => {
    const aggregate = await repo.byKey(item.key)
    item.icon = aggregate?.icon ?? (kind === 'document' ? 'icon-document' : 'icon-picture')
    item.isElement = aggregate?.isElement ?? false
  }
  const tree = createSettingsTree(nodes, containerType, objectType, decorate)
  const shape = async (rows: readonly NodeRow[]): Promise<TreeItem[]> => {
    const items = await toTreeItems(nodes, rows, objectType, () => null)
    for (const item of items) await decorate(item)
    return items
  }

  return {
    byKey: (key) => repo.byKey(key),
    byKeys: (keys) => repo.byKeys(keys),

    async create(aggregate, principal: Principal) {
      if (await repo.aliasExists(aggregate.alias)) {
        return { ok: false as const, reason: `The alias '${aggregate.alias}' is already in use.` }
      }
      const refused = files?.refuse(aggregate)
      if (refused) return refused
      // A new type can only be additive, and the version moves before the write so
      // the file that lands carries the version it belongs to.
      await files?.bumpVersion('additive')
      await repo.save(aggregate)
      await files?.write(aggregate)
      void principal
      return { ok: true as const }
    },

    async update(key, aggregate, principal: Principal) {
      if (await repo.aliasExists(aggregate.alias, key)) {
        return { ok: false as const, reason: `The alias '${aggregate.alias}' is already in use.` }
      }
      const refused = files?.refuse(aggregate)
      if (refused) return refused
      const before = await repo.byKey(key)
      // Classified here, while the database still holds the old type: once it is
      // saved there is nothing left to compare it with.
      if (files)
        await files.bumpVersion(await classifyTypeChange(db, before, { ...aggregate, key }))
      // The editor does not send tree placement; keep what the type has.
      await repo.save({ ...aggregate, key, parentKey: before?.parentKey ?? aggregate.parentKey })
      await files?.write({ ...aggregate, key }, before?.alias)
      void principal
      return { ok: true as const }
    },

    async remove(key) {
      const before = await repo.byKey(key)
      const removed = await repo.delete(key)
      if (removed && before) await files?.remove(before.alias)
      return removed
    },

    allowedAtRoot: (paging) => repo.allowedAtRoot(paging.skip, paging.take),
    allowedInLibrary: (paging) => repo.allowedInLibrary(paging.skip, paging.take),
    allowedChildren: (key, paging) => repo.allowedChildren(key, paging.skip, paging.take),
    search: (query, options) => repo.search(query, options),
    compositionReferences: (key) => repo.compositionReferences(key),
    allowedParents: (key) => repo.allowedParents(key),

    async availableCompositions(request) {
      const available = await repo.availableCompositions(request)
      const out: Array<{
        type: ContentTypeAggregate
        folderPath: string[]
        isCompatible: boolean
      }> = []
      for (const a of available) out.push({ ...a, folderPath: await folders.pathOf(a.type.key) })
      return out
    },

    async move(key, parentKey) {
      const moved = await repo.move(key, parentKey)
      if (moved) await rewrite()
      return moved
    },

    async copy(key, parentKey) {
      const copy = await repo.copy(key, parentKey)
      if (copy) await files?.write(copy)
      return copy
    },

    async createTemplate(key, template, principal: Principal) {
      const aggregate = await repo.byKey(key)
      if (!aggregate) {
        const failure: PortFailure = {
          ok: false,
          reason: 'The document type could not be found.',
          status: 404,
        }
        return failure
      }
      const refused = files?.refuse(aggregate)
      if (refused) return refused
      const alias = template.alias || aggregate.alias
      const name = template.name || aggregate.name
      const saved =
        (await templates.byAlias(alias)) ??
        (await templates.save({
          key: crypto.randomUUID(),
          name,
          alias,
          content: scaffoldTemplate(name, alias),
        }))
      const allowed = aggregate.allowedTemplateKeys.includes(saved.key)
        ? aggregate.allowedTemplateKeys
        : [...aggregate.allowedTemplateKeys, saved.key]
      const updated: ContentTypeAggregate = {
        ...aggregate,
        allowedTemplateKeys: allowed,
        defaultTemplateKey:
          template.isDefault || !aggregate.defaultTemplateKey
            ? saved.key
            : aggregate.defaultTemplateKey,
      }
      await repo.save(updated)
      await files?.write(updated)
      void principal
      return { ok: true as const, key: saved.key }
    },

    async exportUdt(key) {
      const aggregate = await repo.byKey(key)
      if (!aggregate) return undefined
      const aliases = new Map<string, string>()
      for (const reference of [
        ...aggregate.compositions.map((c) => c.contentTypeKey),
        ...aggregate.allowedContentTypes.map((a) => a.contentTypeKey),
      ]) {
        const other = await repo.byKey(reference)
        if (other) aliases.set(reference, other.alias)
      }
      const templateAliases = new Map<string, string>()
      for (const templateKey of [
        ...aggregate.allowedTemplateKeys,
        ...(aggregate.defaultTemplateKey ? [aggregate.defaultTemplateKey] : []),
      ]) {
        const template = await templates.byKey(templateKey)
        if (template) templateAliases.set(templateKey, template.alias)
      }
      return writeContentTypeUdt(aggregate, kind, {
        aliasOf: (k: string) => aliases.get(k),
        templateAliasOf: (k: string) => templateAliases.get(k),
      })
    },

    async importUdt(xml, targetKey) {
      const parsed = readContentTypeUdt(xml)
      if (!parsed) return { status: 'invalid', reason: 'The file is not a content type export.' }
      if (parsed.kind !== kind)
        return { status: 'mismatch', reason: `The file describes a ${parsed.kind} type.` }

      const existing = targetKey ? await repo.byKey(targetKey) : undefined
      if (targetKey && !existing) return { status: 'not-found' }
      if (existing && parsed.alias !== existing.alias)
        return {
          status: 'mismatch',
          reason: `The file describes '${parsed.alias}', not '${existing.alias}'.`,
        }

      const dataTypes = new DataTypeRepository(db)
      // Creating from a file exported elsewhere: its container and property keys
      // still belong to that type, so a new type mints its own. An update keeps
      // them, because the alias guard above proved the file describes this type.
      const reuseKeys = existing !== undefined
      const containers = parsed.containers.map((container: (typeof parsed.containers)[number]) => ({
        key: (reuseKeys && container.key) || crypto.randomUUID(),
        name: container.name,
        alias: container.alias,
        type: container.type,
        sortOrder: container.sortOrder,
        parentKey: null,
      }))
      const byAlias = new Map(
        containers.map((container: { alias: string; key: string }) => [
          container.alias,
          container.key,
        ]),
      )

      const properties = []
      for (const property of parsed.properties) {
        if (!property.dataTypeKey)
          return { status: 'invalid', reason: `'${property.alias}' names no data type.` }
        if (!(await dataTypes.byKey(property.dataTypeKey)))
          return {
            status: 'invalid',
            reason: `The data type for '${property.alias}' is not on this site.`,
          }
        properties.push({
          key: (reuseKeys && property.key) || crypto.randomUUID(),
          alias: property.alias,
          name: property.name,
          description: property.description,
          dataTypeKey: property.dataTypeKey,
          containerKey: property.tabAlias ? (byAlias.get(property.tabAlias) ?? null) : null,
          sortOrder: property.sortOrder,
          variesByCulture: property.variesByCulture,
          variesBySegment: property.variesBySegment,
          mandatory: property.mandatory,
          mandatoryMessage: property.mandatoryMessage,
          regEx: property.regEx,
          regExMessage: property.regExMessage,
          labelOnTop: property.labelOnTop,
        })
      }

      const keyFor = async (alias: string) => (await repo.byAlias(alias))?.key
      const compositions = []
      for (const alias of parsed.compositionAliases) {
        const found = await keyFor(alias)
        if (found)
          compositions.push({ contentTypeKey: found, compositionType: 'Composition' as const })
      }
      const allowed = []
      for (const [index, alias] of parsed.allowedAliases.entries()) {
        const found = await keyFor(alias)
        if (found) allowed.push({ contentTypeKey: found, sortOrder: index })
      }
      const templateKeys = []
      for (const alias of parsed.templateAliases) {
        const template = await templates.byAlias(alias)
        if (template) templateKeys.push(template.key)
      }
      const defaultTemplate = parsed.defaultTemplateAlias
        ? ((await templates.byAlias(parsed.defaultTemplateAlias))?.key ?? null)
        : null

      const aggregate: ContentTypeAggregate = {
        ...(existing ?? {
          collectionKey: null,
          cleanup: {
            preventCleanup: false,
            keepAllVersionsNewerThanDays: null,
            keepLatestVersionPerDayForDays: null,
          },
          parentKey: null,
        }),
        key: existing?.key ?? crypto.randomUUID(),
        alias: parsed.alias,
        name: parsed.name,
        description: parsed.description,
        icon: parsed.icon ?? 'icon-document',
        allowedAsRoot: parsed.allowedAsRoot,
        isElement: parsed.isElement,
        allowedInLibrary: parsed.allowedInLibrary,
        variesByCulture: parsed.variesByCulture,
        variesBySegment: parsed.variesBySegment,
        properties,
        containers,
        compositions,
        allowedContentTypes: allowed,
        allowedTemplateKeys: templateKeys,
        defaultTemplateKey: defaultTemplate,
      } as ContentTypeAggregate

      if (!existing && (await repo.aliasExists(aggregate.alias)))
        return { status: 'invalid', reason: `The alias '${aggregate.alias}' is already in use.` }
      await repo.save(aggregate)
      await files?.write(aggregate)
      return { status: 'ok', key: aggregate.key }
    },

    async jsonSchema(key) {
      const aggregate = await repo.byKey(key)
      if (!aggregate) return undefined
      const dataTypes = new DataTypeRepository(db)
      const properties = []
      for (const property of aggregate.properties) {
        const dataType = await dataTypes.byKey(property.dataTypeKey)
        properties.push({
          alias: property.alias,
          name: property.name,
          description: property.description,
          mandatory: property.mandatory,
          storage: dataType?.dbType ?? 'Ntext',
        })
      }
      return contentTypeJsonSchema(aggregate, properties)
    },

    folders: createFolderPort(folders, tree, rewrite),
    treeRoot: tree.treeRoot,
    treeChildren: tree.treeChildren,

    async root(paging: SkipTake): Promise<Page<TreeItem>> {
      const page = await nodes.roots(objectType, paging.skip, paging.take)
      return { total: page.total, items: await shape(page.items) }
    },

    async children(parentKey: string, paging: SkipTake): Promise<Page<TreeItem>> {
      const parent = await nodes.byKey(parentKey)
      if (!parent) return { total: 0, items: [] }
      const page = await nodes.children(parent.id, objectType, paging.skip, paging.take)
      return { total: page.total, items: await shape(page.items) }
    },

    ancestors: tree.ancestors,
    items: tree.items,
  }
}

export function createDataTypePort(db: Db, schemaFiles?: SchemaFiles): DataTypePort {
  const repo = new DataTypeRepository(db)
  const nodes = repo.nodes
  const objectType = ObjectTypes.DataType
  const folders = new FolderRepository(db, ObjectTypes.DataTypeContainer, objectType)
  const files = schemaFiles ? createSchemaFileWriter(db, schemaFiles) : undefined
  const rewrite = () => files?.rewriteAll() ?? Promise.resolve()
  const tree = createSettingsTree(
    nodes,
    ObjectTypes.DataTypeContainer,
    objectType,
    async (item) => {
      const model = await repo.byKey(item.key)
      item.icon = 'icon-autofill'
      item.editorUiAlias = model?.editorUiAlias ?? null
    },
  )
  const shape = (rows: readonly NodeRow[]) =>
    toTreeItems(nodes, rows, objectType, () => 'icon-autofill')

  /** A data type saved in the backoffice gets a file alias from its name, once. */
  const withAlias = async (model: DataTypeModel): Promise<DataTypeModel> => {
    const existing = await repo.byKey(model.key)
    if (existing?.alias) return { ...model, alias: existing.alias }
    if (model.alias) return model
    const base = aliasFromName(model.name)
    let alias = base
    for (let i = 2; await repo.byAlias(alias); i++) alias = `${base}${i}`
    return { ...model, alias }
  }

  return {
    byKey: (key) => repo.byKey(key),
    byKeys: (keys) => repo.byKeys(keys),
    async valueSchema(key) {
      const model = await repo.byKey(key)
      if (!model) return undefined
      return {
        valueTypeName: valueTypeName(model.dbType),
        jsonSchema: schemaForStorage(model.dbType),
      }
    },
    async save(model: DataTypeModel) {
      const saved = await repo.save(await withAlias(model))
      await files?.writeDataType(saved)
    },
    async remove(key) {
      const before = await repo.byKey(key)
      if (!before) return false
      if ((await repo.referencedBy(key)).length > 0) return 'in-use'
      const removed = await repo.delete(key)
      if (removed && before.alias) await files?.removeDataType(before.alias)
      return removed
    },
    filter: (criteria, paging) => repo.filter(criteria, paging),
    search: (query, paging) => repo.filter({ name: query }, paging),
    referencedBy: (key) => repo.referencedBy(key),
    async move(key, parentKey) {
      const moved = await repo.move(key, parentKey)
      if (moved) await rewrite()
      return moved
    },
    async copy(key, parentKey) {
      const copy = await repo.copy(key, parentKey)
      if (!copy) return undefined
      const aliased = await repo.save(await withAlias(copy))
      await files?.writeDataType(aliased)
      return aliased
    },
    folders: createFolderPort(folders, tree, rewrite),
    treeRoot: tree.treeRoot,
    treeChildren: tree.treeChildren,

    async root(paging) {
      const page = await nodes.roots(objectType, paging.skip, paging.take)
      return { total: page.total, items: await shape(page.items) }
    },
    async children(parentKey, paging) {
      const parent = await nodes.byKey(parentKey)
      if (!parent) return { total: 0, items: [] }
      const page = await nodes.children(parent.id, objectType, paging.skip, paging.take)
      return { total: page.total, items: await shape(page.items) }
    },
    ancestors: tree.ancestors,
    items: tree.items,
  }
}

function toIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
    next ? next.toUpperCase() : '',
  )
  const identifier = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return /^[A-Za-z]/.test(identifier) ? identifier : `Template${identifier}`
}

/** The starter view a new template gets, mirroring Umbraco's scaffold. */
export function scaffoldTemplate(
  name: string,
  alias: string,
  layout: string | null = null,
): string {
  const layoutLine = layout ? `export const layout = '${layout}'\n\n` : ''
  return `import type { PageProps } from 'bunbraco'

${layoutLine}export default function ${toIdentifier(name || alias)}({ model }: PageProps) {
  return (
    <div>
      <h1>{model.name}</h1>
    </div>
  )
}
`
}

const RAZOR_LAYOUT_BLOCK = /^\s*@\{\s*Layout\s*=\s*(null|"([^"]*)")\s*;\s*\}\s*/
const RAZOR_PREAMBLE = /^\s*(?:@(?:using|inherits)\b[^\n]*\n\s*)*/
const LAYOUT_EXPORT = /^export\s+const\s+layout\s*=\s*['"][^'"]*['"]\s*;?[ \t]*\n*/m

/**
 * The template editor is Umbraco's, and speaks Razor: a new template starts as
 * its Razor scaffold, and picking a master template prepends a
 * `@{ Layout = "x.cshtml"; }` block (`"undefined.cshtml"` when the master is
 * removed from a view that has no such block). Views here are TSX, so the
 * untouched scaffold becomes the TSX one, and a layout block becomes the view's
 * `export const layout`. Anything else is saved as written.
 */
export function fromBackofficeTemplate(content: string, name: string, alias: string): string {
  const afterPreamble = content.replace(RAZOR_PREAMBLE, '')
  const block = RAZOR_LAYOUT_BLOCK.exec(afterPreamble)
  if (!block) return content
  const target = block[2]?.replace(/\.cshtml$/i, '')
  const layout = target && target !== 'undefined' ? target : null
  const rest = afterPreamble.slice(block[0].length)
  if (rest.trim() === '') return scaffoldTemplate(name, alias, layout)
  const withoutLayout = rest.replace(LAYOUT_EXPORT, '')
  return layout ? `export const layout = '${layout}'\n\n${withoutLayout}` : withoutLayout
}

/** The layout a view names, which the template tree shows as its master. */
export function layoutAliasOf(content: string | null): string | null {
  const match = /export\s+const\s+layout\s*=\s*['"]([^'"]+)['"]/.exec(content ?? '')
  return match?.[1] ?? null
}

export function createTemplatePort(db: Db, files: TemplateFileStore): TemplatePort {
  const repo = new TemplateRepository(db, files)

  /** Every template with its master resolved from the view, one pass. */
  const withMasters = async (): Promise<TemplateModel[]> => {
    const all = await repo.all()
    const byAlias = new Map(all.map((t) => [t.alias, t]))
    return all.map((t) => {
      const layout = layoutAliasOf(t.content)
      return { ...t, masterKey: layout ? (byAlias.get(layout)?.key ?? null) : null }
    })
  }
  const toItem = (t: TemplateModel, all: readonly TemplateModel[]): TreeItem => ({
    key: t.key,
    name: t.name,
    hasChildren: all.some((o) => o.masterKey === t.key),
    parentKey: t.masterKey ?? null,
    icon: 'icon-layout',
    isFolder: false,
  })
  const pageOf = (items: TreeItem[], paging: SkipTake): Page<TreeItem> => ({
    total: items.length,
    items: items.slice(paging.skip, paging.skip + paging.take),
  })

  return {
    async byKey(key) {
      const model = await repo.byKey(key)
      if (!model) return undefined
      const layout = layoutAliasOf(model.content)
      const master = layout ? await repo.byAlias(layout) : undefined
      return { ...model, masterKey: master?.key ?? null }
    },
    async save(model: TemplateModel) {
      await repo.save({
        ...model,
        content:
          model.content === null
            ? model.content
            : fromBackofficeTemplate(model.content, model.name, model.alias),
      })
    },
    remove: (key) => repo.delete(key),
    scaffold: scaffoldTemplate,

    async root(paging) {
      const all = await withMasters()
      return pageOf(
        all.filter((t) => !t.masterKey).map((t) => toItem(t, all)),
        paging,
      )
    },
    async children(parentKey, paging) {
      const all = await withMasters()
      return pageOf(
        all.filter((t) => t.masterKey === parentKey).map((t) => toItem(t, all)),
        paging,
      )
    },
    async ancestors(descendantKey) {
      const all = await withMasters()
      const chain: TreeItem[] = []
      let current = all.find((t) => t.key === descendantKey)
      while (current?.masterKey) {
        const master = all.find((t) => t.key === current?.masterKey)
        if (!master) break
        chain.unshift(toItem(master, all))
        current = master
      }
      return chain
    },
    async siblings(target, before, after) {
      const all = await withMasters()
      const self = all.find((t) => t.key === target)
      if (!self) return undefined
      const group = all.filter((t) => (t.masterKey ?? null) === (self.masterKey ?? null))
      const index = group.findIndex((t) => t.key === target)
      const start = Math.max(0, index - before)
      const end = Math.min(group.length, index + after + 1)
      return {
        items: group.slice(start, end).map((t) => toItem(t, all)),
        totalBefore: start,
        totalAfter: group.length - end,
      }
    },
    async search(query, paging) {
      const q = query.toLowerCase()
      const all = (await withMasters()).filter(
        (t) => t.name.toLowerCase().includes(q) || t.alias.toLowerCase().includes(q),
      )
      return { total: all.length, items: all.slice(paging.skip, paging.skip + paging.take) }
    },
    async items(keys) {
      const all = await withMasters()
      return all.filter((t) => keys.includes(t.key)).map((t) => toItem(t, all))
    },
  }
}
