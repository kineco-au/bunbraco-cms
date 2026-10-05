/**
 * The data types that ship built in and need no file. A site file with the same
 * alias overrides the built-in. Mirrors the seeded set in @bunbraco/data.
 */
import {
  ALL_SEEDED_DATA_TYPES,
  BUILT_IN_MEDIA_TYPES,
  type BuiltInMediaType,
  SYSTEM_MEDIA_TYPES,
} from '@bunbraco/data'
import type { SchemaDataType, SchemaDocumentType } from './model.ts'
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
): SchemaDocumentType {
  const type: SchemaDocumentType = {
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
