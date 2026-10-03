/**
 * Umbraco's definitions → the schema-as-code model: document, media and member
 * types, data types and languages, as `@bunbraco/schema` writes them to TOML.
 *
 * Keys are carried over unchanged, which is what lets the content bundle name a
 * content type by key and find it after the schema has been synced.
 */
import { ObjectTypes } from '@bunbraco/core'
import { BUILT_IN_MEDIA_TYPES, DEFAULT_DATA_TYPES, SYSTEM_MEMBER_TYPE } from '@bunbraco/data'
import {
  aliasFromName,
  BUILTIN_DATA_TYPES,
  builtInMediaTypeSchema,
  type SchemaDataType,
  type SchemaDocumentType,
  type SchemaGroup,
  type SchemaLanguage,
  type SchemaProperty,
  type SchemaSet,
  type SchemaTypeKind,
  validateSchemaSet,
  writeMediaType,
} from '@bunbraco/schema'
import type { Findings } from './findings.ts'
import { key, type Source } from './source.ts'

/** The property editors bunbraco has an editor and a value converter for. */
export const SUPPORTED_EDITORS: ReadonlySet<string> = new Set([
  ...DEFAULT_DATA_TYPES.map((dataType) => dataType.editorAlias),
  'Umbraco.BlockList',
  'Umbraco.BlockGrid',
  'Umbraco.Decimal',
  'Umbraco.ElementPicker',
  'Umbraco.EmailAddress',
  'Umbraco.MultiNodeTreePicker',
  'Umbraco.MultipleTextstring',
  'Umbraco.Slider',
])

const TINY_MCE_UI = 'Umb.PropertyEditorUi.TinyMCE'
const TIPTAP_UI = 'Umb.PropertyEditorUi.Tiptap'

export interface SourceDataType {
  id: number
  key: string
  name: string
  alias: string
  editor: string
  dbType: string
  supported: boolean
}

export interface SourceContentType {
  id: number
  key: string
  alias: string
  name: string
  kind: SchemaTypeKind
  isElement: boolean
  variesByCulture: boolean
}

export interface SourcePropertyType {
  id: number
  alias: string
  contentTypeId: number
  dataType: SourceDataType
}

export interface SourceTemplate {
  id: number
  key: string
  alias: string
  name: string
  /** The layout it renders inside, by alias. */
  layout?: string
}

export interface SourceLanguage {
  id: number
  iso: string
}

export interface ConvertedSchema {
  set: SchemaSet
  dataTypes: Map<number, SourceDataType>
  contentTypes: Map<number, SourceContentType>
  propertyTypes: Map<number, SourcePropertyType>
  templates: Map<number, SourceTemplate>
  languages: Map<number, SourceLanguage>
}

const KIND_OF: Record<string, SchemaTypeKind> = {
  [ObjectTypes.DocumentType]: 'document',
  [ObjectTypes.MediaType]: 'media',
  [ObjectTypes.MemberType]: 'member',
}

const CONTAINERS: ReadonlySet<string> = new Set([
  ObjectTypes.DocumentTypeContainer,
  ObjectTypes.MediaTypeContainer,
  ObjectTypes.MemberTypeContainer,
  ObjectTypes.DataTypeContainer,
])

const truthy = (value: unknown): boolean => value === 1 || value === true || value === '1'
const text = (value: unknown): string | undefined =>
  value === null || value === undefined || value === '' ? undefined : String(value)

function parseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const sortedJson = (config: Record<string, unknown>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b))))

/** `A/B` for a node inside folders, from the container nodes above it. */
function folderResolver(source: Source): (parentId: number) => string | undefined {
  const containers = new Map(
    source
      .all<{ id: number; parentId: number; name: string | null; objectType: string | null }>(
        'SELECT id, parentId, "text" AS name, nodeObjectType AS objectType FROM umbracoNode',
      )
      .filter((row) => CONTAINERS.has(key(row.objectType)))
      .map((row) => [Number(row.id), row]),
  )
  return (parentId) => {
    const path: string[] = []
    for (let at = containers.get(parentId), depth = 0; at && depth < 32; depth++) {
      path.unshift(at.name ?? '')
      at = containers.get(Number(at.parentId))
    }
    return path.length > 0 ? path.join('/') : undefined
  }
}

function readDataTypes(
  source: Source,
  findings: Findings,
  folderOf: (parentId: number) => string | undefined,
): { byId: Map<number, SourceDataType>; files: SchemaDataType[] } {
  const builtinAliasByKey = new Map(DEFAULT_DATA_TYPES.map((d) => [d.key.toLowerCase(), d.alias]))
  const taken = new Set(BUILTIN_DATA_TYPES.map((d) => d.alias))
  const byId = new Map<number, SourceDataType>()
  const files: SchemaDataType[] = []
  const tinyMce: string[] = []

  const rows = source.all<{
    id: number
    editor: string
    editorUi: string | null
    dbType: string
    config: string | null
    key: string
    name: string | null
    parentId: number
  }>(
    `SELECT d.nodeId AS id, d.propertyEditorAlias AS editor, d.propertyEditorUiAlias AS editorUi,
            d.dbType AS dbType, d.config AS config, n.uniqueId AS key, n."text" AS name, n.parentId AS parentId
     FROM umbracoDataType d JOIN umbracoNode n ON n.id = d.nodeId ORDER BY d.nodeId`,
  )
  for (const row of rows) {
    const name = row.name ?? row.editor
    let alias = builtinAliasByKey.get(key(row.key))
    if (!alias) {
      alias = aliasFromName(name)
      for (let n = 2, base = alias; taken.has(alias); n++) alias = `${base}${n}`
      taken.add(alias)
    }

    let editorUi = text(row.editorUi)
    if (editorUi === TINY_MCE_UI) {
      // Umbraco 16 replaced TinyMCE with Tiptap; the stored markup is the same.
      editorUi = TIPTAP_UI
      tinyMce.push(name)
    }

    const dataType: SchemaDataType = {
      key: key(row.key),
      alias,
      name,
      editor: row.editor,
      config: parseConfig(row.config),
    }
    if (editorUi) dataType.editorUi = editorUi
    const folder = folderOf(Number(row.parentId))
    if (folder) dataType.folder = folder

    byId.set(Number(row.id), {
      id: Number(row.id),
      key: key(row.key),
      name,
      alias,
      editor: row.editor,
      dbType: row.dbType,
      supported: SUPPORTED_EDITORS.has(row.editor),
    })

    // A built-in needs no file unless the site changed its editor or configuration.
    const builtin = BUILTIN_DATA_TYPES.find((b) => b.alias === alias)
    const unchanged =
      builtin !== undefined &&
      builtin.editor === dataType.editor &&
      sortedJson(builtin.config) === sortedJson(dataType.config)
    if (!unchanged) files.push(dataType)
  }

  findings.some({
    class: 'needs-a-person',
    code: 'tinymce-data-types',
    title: 'Rich text editors configured for TinyMCE',
    detail:
      'These now use the Tiptap editor. Stored content is unchanged, but each toolbar is TinyMCE’s and needs setting up again.',
    count: tinyMce.length,
    items: tinyMce,
  })
  return { byId, files }
}

/** A media type as text, with the property keys taken out, to compare two definitions by meaning. */
function shapeOf(type: SchemaDocumentType): string {
  const strip = (properties: SchemaProperty[]) => properties.map(({ key: _, ...rest }) => rest)
  return writeMediaType({
    ...type,
    properties: strip(type.properties),
    groups: type.groups?.map((g) => ({ ...g, properties: strip(g.properties) })),
    tabs: type.tabs.map((tab) => ({
      ...tab,
      properties: strip(tab.properties),
      groups: tab.groups.map((g) => ({ ...g, properties: strip(g.properties) })),
    })),
  })
}

interface ContentTypeRow {
  id: number
  alias: string
  icon: string | null
  description: string | null
  isElement: unknown
  allowAtRoot: unknown
  variations: number
  listView: string | null
  key: string
  name: string | null
  parentId: number
  objectType: string
}

export function convertSchema(source: Source, findings: Findings): ConvertedSchema {
  const folderOf = folderResolver(source)
  const { byId: dataTypes, files: dataTypeFiles } = readDataTypes(source, findings, folderOf)
  const dataTypeAliasByKey = new Map([...dataTypes.values()].map((d) => [d.key, d.alias]))

  // Languages
  const languageRows = source.all<{
    id: number
    iso: string
    name: string | null
    isDefault: unknown
    mandatory: unknown
    fallbackId: number | null
  }>(
    `SELECT id, languageISOCode AS iso, languageCultureName AS name, isDefaultVariantLang AS isDefault,
            mandatory, fallbackLanguageId AS fallbackId FROM umbracoLanguage ORDER BY id`,
  )
  const languages = new Map(
    languageRows.map((l) => [Number(l.id), { id: Number(l.id), iso: l.iso }]),
  )
  const schemaLanguages: SchemaLanguage[] = languageRows.map((l) => {
    const language: SchemaLanguage = {
      iso: l.iso,
      name: l.name ?? l.iso,
      default: truthy(l.isDefault),
      mandatory: truthy(l.mandatory),
    }
    const fallback = l.fallbackId === null ? undefined : languages.get(Number(l.fallbackId))?.iso
    if (fallback) language.fallback = fallback
    return language
  })

  // Templates, with the layout each renders inside
  const templateRows = source.all<{
    id: number
    alias: string
    key: string
    name: string | null
    parentId: number
  }>(
    `SELECT t.nodeId AS id, t.alias AS alias, n.uniqueId AS key, n."text" AS name, n.parentId AS parentId
     FROM cmsTemplate t JOIN umbracoNode n ON n.id = t.nodeId ORDER BY t.nodeId`,
  )
  const templates = new Map<number, SourceTemplate>(
    templateRows.map((t) => [
      Number(t.id),
      { id: Number(t.id), key: key(t.key), alias: t.alias, name: t.name ?? t.alias },
    ]),
  )
  for (const row of templateRows) {
    const layout = templates.get(Number(row.parentId))
    const template = templates.get(Number(row.id))
    if (layout && template) template.layout = layout.alias
  }

  // Content types
  const typeRows = source
    .all<ContentTypeRow>(
      `SELECT c.nodeId AS id, c.alias AS alias, c.icon AS icon, c.description AS description,
              c.isElement AS isElement, c.allowAtRoot AS allowAtRoot, c.variations AS variations,
              c.listView AS listView, n.uniqueId AS key, n."text" AS name, n.parentId AS parentId,
              n.nodeObjectType AS objectType
       FROM cmsContentType c JOIN umbracoNode n ON n.id = c.nodeId ORDER BY c.nodeId`,
    )
    .filter((row) => KIND_OF[key(row.objectType)] !== undefined)

  const contentTypes = new Map<number, SourceContentType>(
    typeRows.map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        key: key(row.key),
        alias: row.alias,
        name: row.name ?? row.alias,
        kind: KIND_OF[key(row.objectType)] as SchemaTypeKind,
        isElement: truthy(row.isElement),
        variesByCulture: (Number(row.variations) & 1) === 1,
      },
    ]),
  )
  const aliasOf = (id: number, kind: SchemaTypeKind) => {
    const type = contentTypes.get(id)
    return type && type.kind === kind ? type.alias : undefined
  }

  const groups = source.all<{
    id: number
    typeId: number
    type: number
    name: string | null
    alias: string | null
    sortOrder: number
  }>(
    `SELECT id, contenttypeNodeId AS typeId, "type" AS type, "text" AS name, alias, sortorder AS sortOrder
     FROM cmsPropertyTypeGroup ORDER BY sortorder, id`,
  )
  const memberFlags = source.has('cmsMemberType')
    ? new Map(
        source
          .all<{ propertyTypeId: number; canEdit: unknown; canView: unknown; sensitive: unknown }>(
            'SELECT propertytypeId AS propertyTypeId, memberCanEdit AS canEdit, viewOnProfile AS canView, isSensitive AS sensitive FROM cmsMemberType',
          )
          .map((row) => [Number(row.propertyTypeId), row]),
      )
    : new Map()

  const propertyRows = source.all<{
    id: number
    dataTypeId: number
    typeId: number
    groupId: number | null
    alias: string
    name: string | null
    sortOrder: number
    mandatory: unknown
    mandatoryMessage: string | null
    regex: string | null
    regexMessage: string | null
    description: string | null
    labelOnTop: unknown
    variations: number
    key: string
  }>(
    `SELECT id, dataTypeId, contentTypeId AS typeId, propertyTypeGroupId AS groupId, Alias AS alias,
            Name AS name, sortOrder, mandatory, mandatoryMessage, validationRegExp AS regex,
            validationRegExpMessage AS regexMessage, Description AS description, labelOnTop,
            variations, UniqueID AS key
     FROM cmsPropertyType ORDER BY sortOrder, id`,
  )

  const propertyTypes = new Map<number, SourcePropertyType>()
  const propertiesByGroup = new Map<string, SchemaProperty[]>()
  const unsupported = new Map<string, string[]>()
  const orphaned: string[] = []
  for (const row of propertyRows) {
    const type = contentTypes.get(Number(row.typeId))
    if (!type) continue
    const dataType = dataTypes.get(Number(row.dataTypeId))
    if (!dataType) {
      orphaned.push(`${type.alias}.${row.alias}`)
      continue
    }
    propertyTypes.set(Number(row.id), {
      id: Number(row.id),
      alias: row.alias,
      contentTypeId: type.id,
      dataType,
    })
    if (!dataType.supported) {
      const users = unsupported.get(dataType.editor) ?? []
      users.push(`${type.alias}.${row.alias}`)
      unsupported.set(dataType.editor, users)
    }

    const property: SchemaProperty = {
      key: key(row.key),
      alias: row.alias,
      name: row.name ?? row.alias,
      type: dataType.alias,
      mandatory: truthy(row.mandatory),
      // The validator refuses a varying property on a type that does not vary.
      variesByCulture: type.variesByCulture && (Number(row.variations) & 1) === 1,
      variesBySegment: (Number(row.variations) & 2) === 2,
      labelOnTop: truthy(row.labelOnTop),
    }
    const description = text(row.description)
    if (description) property.description = description
    const mandatoryMessage = text(row.mandatoryMessage)
    if (mandatoryMessage) property.mandatoryMessage = mandatoryMessage
    const regex = text(row.regex)
    if (regex) property.regex = regex
    const regexMessage = text(row.regexMessage)
    if (regexMessage) property.regexMessage = regexMessage
    if (type.kind === 'member') {
      const flags = memberFlags.get(Number(row.id))
      if (truthy(flags?.canView)) property.memberCanView = true
      if (truthy(flags?.canEdit)) property.memberCanEdit = true
      if (truthy(flags?.sensitive)) property.sensitive = true
    }

    const slot = `${type.id}:${row.groupId ?? ''}`
    const list = propertiesByGroup.get(slot) ?? []
    list.push(property)
    propertiesByGroup.set(slot, list)
  }

  const compositions = source.all<{ parent: number; child: number }>(
    'SELECT parentContentTypeId AS parent, childContentTypeId AS child FROM cmsContentType2ContentType',
  )
  const allowed = source.all<{ id: number; allowed: number; sortOrder: number }>(
    'SELECT Id AS id, AllowedId AS allowed, SortOrder AS sortOrder FROM cmsContentTypeAllowedContentType ORDER BY SortOrder',
  )
  const typeTemplates = source.all<{ typeId: number; templateId: number; isDefault: unknown }>(
    'SELECT contentTypeNodeId AS typeId, templateNodeId AS templateId, IsDefault AS isDefault FROM cmsDocumentType',
  )
  const cleanup = source.has('umbracoContentVersionCleanupPolicy')
    ? new Map(
        source
          .all<{ typeId: number; prevent: unknown; newer: number | null; perDay: number | null }>(
            `SELECT contentTypeId AS typeId, preventCleanup AS prevent,
                    keepAllVersionsNewerThanDays AS newer, keepLatestVersionPerDayForDays AS perDay
             FROM umbracoContentVersionCleanupPolicy`,
          )
          .map((row) => [Number(row.typeId), row]),
      )
    : new Map()

  const documentTypes: SchemaDocumentType[] = []
  const mediaTypes: SchemaDocumentType[] = []
  const memberTypes: SchemaDocumentType[] = []
  const strippedElements: string[] = []

  for (const row of typeRows) {
    const meta = contentTypes.get(Number(row.id)) as SourceContentType
    const kind = meta.kind
    const type: SchemaDocumentType = {
      key: meta.key,
      alias: meta.alias,
      name: meta.name,
      icon: text(row.icon) ?? 'icon-document',
      allowAtRoot: truthy(row.allowAtRoot),
      isElement: meta.isElement,
      allowInLibrary: false,
      variesByCulture: meta.variesByCulture,
      variesBySegment: (Number(row.variations) & 2) === 2,
      compositions: compositions
        .filter((c) => Number(c.child) === meta.id)
        .flatMap((c) => aliasOf(Number(c.parent), kind) ?? []),
      allowChildren: allowed
        .filter((a) => Number(a.id) === meta.id)
        .flatMap((a) => aliasOf(Number(a.allowed), kind) ?? []),
      templates: [],
      cleanup: { prevent: false },
      properties: propertiesByGroup.get(`${meta.id}:`) ?? [],
      tabs: [],
    }
    const description = text(row.description)
    if (description) type.description = description
    const folder = folderOf(Number(row.parentId))
    if (folder) type.folder = folder
    const collection = row.listView ? dataTypeAliasByKey.get(key(row.listView)) : undefined
    if (collection) type.collection = collection

    if (kind === 'document') {
      for (const link of typeTemplates.filter((t) => Number(t.typeId) === meta.id)) {
        const template = templates.get(Number(link.templateId))
        if (!template) continue
        type.templates.push(template.alias)
        if (truthy(link.isDefault)) type.defaultTemplate = template.alias
      }
      const policy = cleanup.get(meta.id)
      if (policy) {
        type.cleanup.prevent = truthy(policy.prevent)
        if (policy.newer !== null) type.cleanup.keepAllNewerThanDays = Number(policy.newer)
        if (policy.perDay !== null) type.cleanup.keepLatestPerDayForDays = Number(policy.perDay)
      }
      // An element type is a property bag with no URL; Umbraco tolerates route
      // settings left on one, and the schema validator here does not.
      if (type.isElement) {
        if (type.allowAtRoot || type.templates.length > 0 || type.allowChildren.length > 0)
          strippedElements.push(type.alias)
        type.allowAtRoot = false
        type.templates = []
        type.defaultTemplate = undefined
        type.allowChildren = []
      }
    }

    // Tabs and groups. A group inside a tab carries the tab's alias as a prefix.
    const own = groups.filter((g) => Number(g.typeId) === meta.id)
    const tabs = own.filter((g) => Number(g.type) === 1)
    const tabAliases = new Set(tabs.map((tab) => tab.alias ?? ''))
    const toGroup = (g: (typeof own)[number]): SchemaGroup => {
      const group: SchemaGroup = {
        name: g.name ?? '',
        properties: propertiesByGroup.get(`${meta.id}:${g.id}`) ?? [],
      }
      const alias = g.alias?.split('/').at(-1)
      if (alias) group.alias = alias
      return group
    }
    const parentTab = (g: (typeof own)[number]) => {
      const prefix = g.alias?.includes('/') ? g.alias.slice(0, g.alias.lastIndexOf('/')) : undefined
      return prefix !== undefined && tabAliases.has(prefix) ? prefix : undefined
    }
    for (const tab of tabs) {
      const entry: SchemaDocumentType['tabs'][number] = {
        name: tab.name ?? '',
        properties: propertiesByGroup.get(`${meta.id}:${tab.id}`) ?? [],
        groups: own
          .filter((g) => Number(g.type) === 0 && parentTab(g) === (tab.alias ?? ''))
          .map(toGroup),
      }
      if (tab.alias) entry.alias = tab.alias
      type.tabs.push(entry)
    }
    const orphanGroups = own.filter((g) => Number(g.type) === 0 && parentTab(g) === undefined)
    if (orphanGroups.length > 0) type.groups = orphanGroups.map(toGroup)

    if (kind === 'document') documentTypes.push(type)
    else if (kind === 'media') {
      // A media type Umbraco ships is written only where the site changed it.
      // Property keys are left out of the comparison: bunbraco seeds its own.
      const shipped = BUILT_IN_MEDIA_TYPES.find((t) => t.key === meta.key)
      const present = new Set(
        typeRows.filter((r) => KIND_OF[key(r.objectType)] === 'media').map((r) => r.alias),
      )
      if (!shipped || shapeOf(type) !== shapeOf(builtInMediaTypeSchema(shipped, present)))
        mediaTypes.push(type)
    } else {
      type.templates = []
      type.allowChildren = []
      const hasProperties =
        type.properties.length > 0 || type.tabs.length > 0 || (type.groups ?? []).length > 0
      if (meta.key !== SYSTEM_MEMBER_TYPE.key || hasProperties) memberTypes.push(type)
    }
  }

  const set: SchemaSet = {
    version: '1.0.0',
    documentTypes,
    mediaTypes,
    memberTypes,
    dataTypes: dataTypeFiles,
    languages: schemaLanguages,
  }

  findings.add({
    class: 'migrates',
    code: 'content-types',
    title: 'Document, media and member types',
    count: typeRows.length,
    detail: `${documentTypes.length} document types, ${mediaTypes.length} media types and ${memberTypes.length} member types are written as files; built-in types the site left alone need none.`,
  })
  findings.add({
    class: 'migrates',
    code: 'data-types',
    title: 'Data types',
    count: dataTypes.size,
    detail: `${dataTypeFiles.length} are written as files; the rest are built in and unchanged.`,
  })
  findings.some({
    class: 'migrates',
    code: 'languages',
    title: 'Languages',
    count: schemaLanguages.length,
    items: schemaLanguages.map((l) => l.iso),
  })
  for (const [editor, users] of unsupported) {
    const names = [...dataTypes.values()].filter((d) => d.editor === editor).map((d) => d.name)
    findings.add({
      class: 'needs-a-person',
      code: 'unsupported-editor',
      title: `Property editor ${editor} has no equivalent here`,
      detail: `Data types: ${names.join(', ')}. The stored values are carried across untouched, but the backoffice has no editor for them and templates receive the raw value.`,
      count: users.length,
      items: users,
    })
  }
  findings.some({
    class: 'needs-a-person',
    code: 'element-route-settings',
    title: 'Element types with templates, children or allow-at-root',
    detail: 'An element type is never routed, so these settings were dropped from it.',
    count: strippedElements.length,
    items: strippedElements,
  })
  findings.some({
    class: 'dropped',
    code: 'orphaned-properties',
    title: 'Properties whose data type no longer exists',
    count: orphaned.length,
    items: orphaned,
  })

  const templateAliases = new Set([...templates.values()].map((t) => t.alias))
  for (const problem of validateSchemaSet(set, { templateAliases }))
    findings.add({
      class: 'blocking',
      code: 'schema-invalid',
      title: `The converted schema is not valid: ${problem.file}`,
      detail: `${problem.path ? `${problem.path}: ` : ''}${problem.message}`,
    })

  return { set, dataTypes, contentTypes, propertyTypes, templates, languages }
}
