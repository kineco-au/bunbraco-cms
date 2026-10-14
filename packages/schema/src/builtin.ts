/**
 * The data types that ship built in and need no file. A site file with the same
 * alias overrides the built-in. Mirrors the seeded set in @bunbraco/data.
 */
import {
  ALL_SEEDED_DATA_TYPES,
  BUILT_IN_MEDIA_TYPES,
  type BuiltInContentType,
  type BuiltInMediaType,
  SYSTEM_CONTENT_TYPES,
  SYSTEM_MEDIA_TYPES,
} from '@bunbraco/data'
import type { SchemaContentType, SchemaDataType, SchemaProperty } from './model.ts'
import { fileNameFor, writeMediaType } from './write.ts'

/** Every seeded data type, in the file vocabulary; the seed is the one definition. */
export const BUILTIN_DATA_TYPES: readonly SchemaDataType[] = ALL_SEEDED_DATA_TYPES.map(
  (seeded) => ({
    alias: seeded.alias,
    name: seeded.name,
    editor: seeded.editorAlias,
    editorUi: seeded.editorUiAlias,
    config: { ...(seeded.config ?? {}) },
  }),
)

/** The `property_value` column family an editor stores into; Umbraco's ValueStorageType. */
/** Folder, Image and File: always present, never deleted, alias fixed. */
export const SYSTEM_MEDIA_TYPE_ALIASES: ReadonlySet<string> = new Set(
  SYSTEM_MEDIA_TYPES.map((t) => t.alias),
)

/**
 * A built-in media type in the file vocabulary: what `bunbraco init` writes
 * for the site-owned four, and what export compares a system type against.
 * Folder allows only the built-ins in `present`.
 */
export function builtInMediaTypeSchema(
  def: BuiltInMediaType,
  present: ReadonlySet<string> = new Set(BUILT_IN_MEDIA_TYPES.map((t) => t.alias)),
): SchemaContentType {
  const type: SchemaContentType = {
    key: def.key,
    alias: def.alias,
    name: def.name,
    icon: def.icon,
    allowAtRoot: true,
    isElement: false,
    allowInLibrary: false,
    variesByCulture: false,
    variesBySegment: false,
    compositions: [],
    allowChildren: def.allowChildren.filter((a) => present.has(a)),
    components: [],
    cleanup: { prevent: false },
    properties: [],
    tabs: [],
  }
  if (def.collection) type.collection = def.collection
  if (def.group)
    type.groups = [
      {
        name: def.group.name,
        alias: def.group.alias,
        properties: def.properties.map((p) => ({
          key: p.key,
          alias: p.alias,
          name: p.name,
          type: p.dataType,
          mandatory: p.mandatory,
          variesByCulture: false,
          variesBySegment: false,
          labelOnTop: false,
        })),
      },
    ]
  return type
}

/** Content types the framework ships: always present, never deleted, alias fixed. */
export const SYSTEM_CONTENT_TYPE_ALIASES: ReadonlySet<string> = new Set(
  SYSTEM_CONTENT_TYPES.map((t) => t.alias),
)

const dataTypeAliasOf = (key: string): string => {
  const found = ALL_SEEDED_DATA_TYPES.find((d) => d.key === key)
  if (!found) throw new Error(`system content types reference unknown data type "${key}"`)
  return found.alias
}

/** A system content type in the file vocabulary: what export compares a site's copy against. */
export function builtInContentTypeSchema(def: BuiltInContentType): SchemaContentType {
  return {
    key: def.key,
    alias: def.alias,
    name: def.name,
    description: def.description,
    icon: def.icon,
    allowAtRoot: false,
    isElement: false,
    allowInLibrary: false,
    variesByCulture: false,
    variesBySegment: false,
    compositions: [],
    allowChildren: [],
    components: [],
    cleanup: { prevent: false },
    properties: [],
    tabs: [
      {
        name: def.tab.name,
        alias: def.tab.alias,
        groups: [],
        properties: def.properties.map((p) => ({
          key: p.key,
          alias: p.alias,
          name: p.name,
          description: p.description,
          type: dataTypeAliasOf(p.dataTypeKey),
          mandatory: false,
          variesByCulture: false,
          variesBySegment: false,
          labelOnTop: false,
        })),
      },
    ],
  }
}

/** Every property a type file declares, wherever it sits. */
export function declaredProperties(t: SchemaContentType): SchemaProperty[] {
  return [
    ...t.properties,
    ...(t.groups ?? []).flatMap((g) => g.properties),
    ...t.tabs.flatMap((tab) => [...tab.properties, ...tab.groups.flatMap((g) => g.properties)]),
  ]
}

/**
 * What is wrong with a site's file for a system content type: it may add
 * fields, relabel and move them, and vary them by culture, but every shipped
 * field keeps its key, alias and data type.
 */
export function checkSystemContentTypeFile(t: SchemaContentType): string[] {
  const def = SYSTEM_CONTENT_TYPES.find((d) => d.alias === t.alias)
  if (!def) return []
  const findings: string[] = []
  if (t.key && t.key.toLowerCase() !== def.key)
    findings.push(`"${t.alias}" is provided by Bunbraco; its key must be ${def.key}`)
  if (t.isElement)
    findings.push(`"${t.alias}" is provided by Bunbraco and cannot be an element type`)
  const declared = declaredProperties(t)
  for (const shipped of def.properties) {
    const found = declared.find((p) => p.alias === shipped.alias)
    const type = dataTypeAliasOf(shipped.dataTypeKey)
    if (!found)
      findings.push(`the "${shipped.alias}" field is provided by Bunbraco and cannot be removed`)
    else if (found.type !== type)
      findings.push(
        `the "${shipped.alias}" field is provided by Bunbraco; its type must stay "${type}"`,
      )
    else if (found.key && found.key.toLowerCase() !== shipped.key)
      findings.push(
        `the "${shipped.alias}" field is provided by Bunbraco; its key must be ${shipped.key}`,
      )
  }
  return findings
}

/** A system content type's shipped property keys by alias, for a file that omits them. */
export function systemPropertyKeys(alias: string): ReadonlyMap<string, string> {
  const def = SYSTEM_CONTENT_TYPES.find((d) => d.alias === alias)
  return new Map((def?.properties ?? []).map((p) => [p.alias, p.key]))
}

export function storageTypeFor(
  editorAlias: string,
): 'Ntext' | 'Nvarchar' | 'Integer' | 'Date' | 'Decimal' {
  switch (editorAlias) {
    case 'Umbraco.TextBox':
    case 'Umbraco.ContentPicker':
    case 'Umbraco.UploadField':
    case 'Umbraco.EmailAddress':
    // One form key, which is a UUID and never long.
    case 'Bunbraco.FormPicker':
      return 'Nvarchar'
    case 'Umbraco.Integer':
    case 'Umbraco.TrueFalse':
      return 'Integer'
    case 'Umbraco.Decimal':
      return 'Decimal'
    case 'Umbraco.DateTime':
      return 'Date'
    default:
      return 'Ntext'
  }
}

export const BUILTIN_DATA_TYPE_ALIASES: ReadonlySet<string> = new Set(
  BUILTIN_DATA_TYPES.map((d) => d.alias),
)

/**
 * The media types a new site owns as files: Umbraco's Video, Audio, Article
 * and Vector Graphics, keyed as Umbraco keys them. `bunbraco init` writes these
 * to `schema/media-types/`; relative path → canonical TOML.
 */
export function siteMediaTypeFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const def of BUILT_IN_MEDIA_TYPES.filter((t) => !t.system))
    files[`schema/media-types/${fileNameFor(def.alias)}`] = writeMediaType(
      builtInMediaTypeSchema(def),
    )
  return files
}
