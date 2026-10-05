/**
 * Database → files. `exportSchemaSet` reads the current definitions as the
 * schema model; `writeSchemaFiles` lays them out canonically; `writeKeysBack`
 * records the keys a sync minted so the next deploy carries them.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ContentTypeAggregate,
  type DataTypeModel,
  ObjectTypes,
  type PropertyTypeModel,
} from '@bunbraco/core'
import {
  ComponentRepository,
  ContentTypeRepository,
  DataTypeRepository,
  type Db,
  FolderRepository,
  LanguageRepository,
  SYSTEM_MEDIA_TYPES,
} from '@bunbraco/data'
import { BUILTIN_DATA_TYPES, builtInMediaTypeSchema } from './builtin.ts'
import type { LoadedSchema } from './load.ts'
import type {
  SchemaDataType,
  SchemaDocumentType,
  SchemaLanguage,
  SchemaProperty,
  SchemaSet,
} from './model.ts'
import { typeFileKey } from './model.ts'
import type { AssignedKey } from './sync.ts'
import {
  fileNameFor,
  writeDataType,
  writeDocumentType,
  writeLanguages,
  writeMediaType,
  writeMemberType,
  writeSchemaVersion,
} from './write.ts'

/** Key → alias lookups for everything a document type refers to. */
export interface ExportContext {
  dataTypeAlias(key: string): string | undefined
  contentTypeAlias(key: string): string | undefined
  componentAlias(key: string): string | undefined
}

function toSchemaProperty(p: PropertyTypeModel, ctx: ExportContext): SchemaProperty {
  const property: SchemaProperty = {
    key: p.key,
    alias: p.alias,
    name: p.name,
    type: ctx.dataTypeAlias(p.dataTypeKey) ?? p.dataTypeKey,
    mandatory: p.mandatory,
    variesByCulture: p.variesByCulture,
    variesBySegment: p.variesBySegment,
    labelOnTop: p.labelOnTop,
  }
  if (p.description) property.description = p.description
  if (p.mandatoryMessage) property.mandatoryMessage = p.mandatoryMessage
  if (p.regEx) property.regex = p.regEx
  if (p.regExMessage) property.regexMessage = p.regExMessage
  if (p.memberCanView) property.memberCanView = true
  if (p.memberCanEdit) property.memberCanEdit = true
  if (p.isSensitive) property.sensitive = true
  return property
}

export function toSchemaDocumentType(
  aggregate: ContentTypeAggregate,
  ctx: ExportContext,
): SchemaDocumentType {
  const byOrder = (a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder
  const properties = [...aggregate.properties].sort(byOrder)
  const containers = [...aggregate.containers].sort(byOrder)
  const under = (containerKey: string | null) =>
    properties
      .filter((p) => (p.containerKey ?? null) === containerKey)
      .map((p) => toSchemaProperty(p, ctx))

  const type: SchemaDocumentType = {
    key: aggregate.key,
    alias: aggregate.alias,
    name: aggregate.name,
    icon: aggregate.icon,
    allowAtRoot: aggregate.allowedAsRoot,
    isElement: aggregate.isElement,
    allowInLibrary: aggregate.allowedInLibrary,
    variesByCulture: aggregate.variesByCulture,
    variesBySegment: aggregate.variesBySegment,
    compositions: aggregate.compositions
      .map((c) => ctx.contentTypeAlias(c.contentTypeKey))
      .filter((alias): alias is string => alias !== undefined),
    allowChildren: [...aggregate.allowedContentTypes]
      .sort(byOrder)
      .map((c) => ctx.contentTypeAlias(c.contentTypeKey))
      .filter((alias): alias is string => alias !== undefined),
    components: aggregate.allowedComponentKeys
      .map((key) => ctx.componentAlias(key))
      .filter((alias): alias is string => alias !== undefined),
    cleanup: { prevent: aggregate.cleanup.preventCleanup },
    properties: under(null),
    tabs: [],
  }
  if (aggregate.description) type.description = aggregate.description
  if (aggregate.defaultComponentKey) {
    const alias = ctx.componentAlias(aggregate.defaultComponentKey)
    if (alias) type.defaultComponent = alias
  }
  if (aggregate.collectionKey) {
    const alias = ctx.dataTypeAlias(aggregate.collectionKey)
    if (alias) type.collection = alias
  }
  if (aggregate.cleanup.keepAllVersionsNewerThanDays !== null)
    type.cleanup.keepAllNewerThanDays = aggregate.cleanup.keepAllVersionsNewerThanDays
  if (aggregate.cleanup.keepLatestVersionPerDayForDays !== null)
    type.cleanup.keepLatestPerDayForDays = aggregate.cleanup.keepLatestVersionPerDayForDays

  // Umbraco allows a group without a tab: that is a top-level `[[group]]`.
  const tabs = containers.filter((c) => c.type === 'Tab')
  const orphanGroups = containers.filter((c) => c.type === 'Group' && !c.parentKey)
  for (const tab of tabs) {
    const groups = containers.filter((c) => c.type === 'Group' && c.parentKey === tab.key)
    const entry: SchemaDocumentType['tabs'][number] = {
      name: tab.name ?? '',
      properties: under(tab.key),
      groups: groups.map((g) => {
        const group: SchemaDocumentType['tabs'][number]['groups'][number] = {
          name: g.name ?? '',
          properties: under(g.key),
        }
        if (g.alias) group.alias = g.alias
        return group
      }),
    }
    if (tab.alias) entry.alias = tab.alias
    type.tabs.push(entry)
  }
  if (orphanGroups.length > 0) {
    type.groups = orphanGroups.map((g) => {
      const group: NonNullable<SchemaDocumentType['groups']>[number] = {
        name: g.name ?? '',
        properties: under(g.key),
      }
      if (g.alias) group.alias = g.alias
      return group
    })
  }
  return type
}

export function toSchemaDataType(model: DataTypeModel, alias: string): SchemaDataType {
  const dataType: SchemaDataType = {
    key: model.key,
    alias,
    name: model.name,
    editor: model.editorAlias,
    config: Object.fromEntries(model.values.map((v) => [v.alias, v.value])),
  }
  if (model.editorUiAlias) dataType.editorUi = model.editorUiAlias
  return dataType
}

/** A data type created in the backoffice has no alias; derive one from its name. */
export function aliasFromName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const camel = words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join('')
  return /^[A-Za-z]/.test(camel) ? camel : `dataType${camel}`
}

/** A built-in needs no file unless the site changed its editor or configuration. */
function isUnchangedBuiltin(dataType: SchemaDataType): boolean {
  const builtin = BUILTIN_DATA_TYPES.find((b) => b.alias === dataType.alias)
  if (!builtin) return false
  const config = (c: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b))))
  return builtin.editor === dataType.editor && config(builtin.config) === config(dataType.config)
}

/** Every live definition in the database as a schema set; keys are always present. */
export async function exportSchemaSet(db: Db, version: string): Promise<SchemaSet> {
  const types = new ContentTypeRepository(db)
  const dataTypes = new DataTypeRepository(db)
  const templates = new ComponentRepository(db)

  const mediaTypeRepo = new ContentTypeRepository(db, { kind: 'media' })
  const liveTypes = async (repo: ContentTypeRepository) => {
    const rows = await db.query<{ unique_id: string }>(
      `SELECT n.unique_id FROM content_type ct JOIN node n ON n.id = ct.node_id
       WHERE ct.retired_at IS NULL AND n.node_object_type = ? ORDER BY ct.alias`,
      [repo.objectType],
    )
    const out: ContentTypeAggregate[] = []
    for (const row of rows) {
      const aggregate = await repo.byKey(String(row.unique_id))
      if (aggregate) out.push(aggregate)
    }
    return out
  }
  const aggregates = await liveTypes(types)
  const mediaAggregates = await liveTypes(mediaTypeRepo)
  const memberAggregates = await liveTypes(new ContentTypeRepository(db, { kind: 'member' }))

  const dataTypeRows = await db.query<{ unique_id: string }>(
    'SELECT n.unique_id FROM data_type d JOIN node n ON n.id = d.node_id ORDER BY n.text',
  )
  const dataTypeAliasByKey = new Map<string, string>()
  const exportedDataTypes: SchemaDataType[] = []
  const taken = new Set<string>()
  for (const row of dataTypeRows) {
    const model = await dataTypes.byKey(String(row.unique_id))
    if (!model) continue
    let alias = model.alias
    if (!alias) {
      alias = aliasFromName(model.name)
      while (taken.has(alias)) alias = `${alias}2`
      // Recorded so the next export and the sync agree on the name.
      await dataTypes.save({ ...model, alias })
    }
    taken.add(alias)
    dataTypeAliasByKey.set(model.key, alias)
    const dataType = toSchemaDataType(model, alias)
    if (!isUnchangedBuiltin(dataType)) exportedDataTypes.push(dataType)
  }

  const templateAliasByKey = new Map<string, string>()
  const templatePage = await templates.list(0, 10_000)
  for (const template of templatePage.items) templateAliasByKey.set(template.key, template.alias)
  const contentTypeAliasByKey = new Map(
    [...aggregates, ...mediaAggregates, ...memberAggregates].map((a) => [a.key, a.alias]),
  )

  const typeFolders = new FolderRepository(
    db,
    ObjectTypes.DocumentTypeContainer,
    ObjectTypes.DocumentType,
  )
  const dataTypeFolders = new FolderRepository(
    db,
    ObjectTypes.DataTypeContainer,
    ObjectTypes.DataType,
  )
  const folderOf = async (repo: FolderRepository, key: string) => {
    const path = await repo.pathOf(key)
    return path.length > 0 ? path.join('/') : undefined
  }
  for (const d of exportedDataTypes) {
    const folder = await folderOf(dataTypeFolders, d.key as string)
    if (folder) d.folder = folder
  }
  const ctx: ExportContext = {
    dataTypeAlias: (key) => dataTypeAliasByKey.get(key.toLowerCase()),
    contentTypeAlias: (key) => contentTypeAliasByKey.get(key.toLowerCase()),
    componentAlias: (key) => templateAliasByKey.get(key.toLowerCase()),
  }
  const languages: SchemaLanguage[] = (await new LanguageRepository(db).all()).map((l) => {
    const language: SchemaLanguage = {
      iso: l.isoCode,
      name: l.cultureName,
      default: l.isDefault,
      mandatory: l.isMandatory,
    }
    if (l.fallbackIsoCode) language.fallback = l.fallbackIsoCode
    return language
  })
  const documentTypes: SchemaDocumentType[] = []
  for (const a of aggregates) {
    const type = toSchemaDocumentType(a, ctx)
    const folder = await folderOf(typeFolders, a.key)
    if (folder) type.folder = folder
    documentTypes.push(type)
  }
  const mediaTypeFolders = new FolderRepository(
    db,
    ObjectTypes.MediaTypeContainer,
    ObjectTypes.MediaType,
  )
  const mediaTypes: SchemaDocumentType[] = []
  for (const a of mediaAggregates) {
    // Media types carry neither templates nor a cleanup policy.
    const type = toSchemaDocumentType(
      { ...a, allowedComponentKeys: [], defaultComponentKey: null },
      ctx,
    )
    type.cleanup = { prevent: false }
    const folder = await folderOf(mediaTypeFolders, a.key)
    if (folder) type.folder = folder
    const shipped = SYSTEM_MEDIA_TYPES.find((t) => t.key === a.key)
    if (shipped) {
      const present = new Set(mediaAggregates.map((m) => m.alias))
      if (writeMediaType(type) === writeMediaType(builtInMediaTypeSchema(shipped, present)))
        continue
    }
    mediaTypes.push(type)
  }
  const memberTypeFolders = new FolderRepository(
    db,
    ObjectTypes.MemberTypeContainer,
    ObjectTypes.MemberType,
  )
  const memberTypes: SchemaDocumentType[] = []
  for (const a of memberAggregates) {
    // Member types carry neither templates, a cleanup policy, nor children.
    const type = toSchemaDocumentType(
      { ...a, allowedComponentKeys: [], defaultComponentKey: null, allowedContentTypes: [] },
      ctx,
    )
    type.cleanup = { prevent: false }
    const folder = await folderOf(memberTypeFolders, a.key)
    if (folder) type.folder = folder
    memberTypes.push(type)
  }
  return {
    version,
    documentTypes,
    mediaTypes,
    memberTypes,
    dataTypes: exportedDataTypes,
    languages,
  }
}

/** Writes a set as canonical files; returns the paths written. Never deletes. */
export function writeSchemaFiles(schemaDir: string, set: SchemaSet): string[] {
  const written: string[] = []
  const put = (relative: string, content: string) => {
    const file = join(schemaDir, relative)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
    written.push(file)
  }
  put('schema.toml', writeSchemaVersion(set.version))
  for (const t of set.documentTypes)
    put(join('document-types', fileNameFor(t.alias)), writeDocumentType(t))
  for (const t of set.mediaTypes ?? [])
    put(join('media-types', fileNameFor(t.alias)), writeMediaType(t))
  for (const t of set.memberTypes ?? [])
    put(join('member-types', fileNameFor(t.alias)), writeMemberType(t))
  for (const d of set.dataTypes) put(join('data-types', fileNameFor(d.alias)), writeDataType(d))
  if (set.languages.length > 0) put('languages.toml', writeLanguages(set.languages))
  return written
}

/** Rewrites, canonically, every file a sync assigned keys in. */
export function writeKeysBack(loaded: LoadedSchema, assigned: readonly AssignedKey[]): string[] {
  const touched = new Set<string>()
  for (const a of assigned) {
    const allTypes = [
      ...loaded.set.documentTypes,
      ...(loaded.set.mediaTypes ?? []),
      ...(loaded.set.memberTypes ?? []),
    ]
    if (a.propertyAlias === undefined) {
      const type = allTypes.find((t) => t.alias === a.typeAlias)
      if (type) type.key = a.key
      const dataType = loaded.set.dataTypes.find((d) => d.alias === a.typeAlias)
      if (dataType) dataType.key = a.key
    } else {
      const type = allTypes.find((t) => t.alias === a.typeAlias)
      const property = type && allPropertiesOf(type).find((p) => p.alias === a.propertyAlias)
      if (property) property.key = a.key
    }
    if (a.file) touched.add(a.file)
  }
  const written: string[] = []
  for (const file of touched) {
    const type = loaded.set.documentTypes.find((t) => loaded.files.get(t.alias) === file)
    if (type) {
      writeFileSync(file, writeDocumentType(type))
      written.push(file)
      continue
    }
    const mediaType = (loaded.set.mediaTypes ?? []).find(
      (t) => loaded.files.get(typeFileKey('media', t.alias)) === file,
    )
    if (mediaType) {
      writeFileSync(file, writeMediaType(mediaType))
      written.push(file)
      continue
    }
    const memberType = (loaded.set.memberTypes ?? []).find(
      (t) => loaded.files.get(typeFileKey('member', t.alias)) === file,
    )
    if (memberType) {
      writeFileSync(file, writeMemberType(memberType))
      written.push(file)
      continue
    }
    const dataType = loaded.set.dataTypes.find(
      (d) => loaded.files.get(`data-type:${d.alias}`) === file,
    )
    if (dataType) {
      writeFileSync(file, writeDataType(dataType))
      written.push(file)
    }
  }
  return written
}

function allPropertiesOf(type: SchemaDocumentType): SchemaProperty[] {
  const out = [...type.properties]
  for (const tab of type.tabs) {
    out.push(...tab.properties)
    for (const group of tab.groups) out.push(...group.properties)
  }
  return out
}
