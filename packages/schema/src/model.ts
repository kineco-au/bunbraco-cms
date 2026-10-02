/**
 * The schema-as-code model: what a site's `schema/*.toml` files describe.
 * The shapes mirror the TOML vocabulary in docs/09-schema-as-code.md, with
 * defaults applied, so the rest of the system never sees a missing key.
 */
export interface SchemaProperty {
  key?: string
  alias: string
  name: string
  description?: string
  notes?: string
  /** A data type alias, built in or defined in `schema/data-types/`. */
  type: string
  mandatory: boolean
  mandatoryMessage?: string
  regex?: string
  regexMessage?: string
  variesByCulture: boolean
  variesBySegment: boolean
  labelOnTop: boolean
  /** Member types only: shown to the member on their profile. */
  memberCanView?: boolean
  /** Member types only: editable by the member on their profile. */
  memberCanEdit?: boolean
  /** Member types only: hidden from users without sensitive-data access. */
  sensitive?: boolean
  /** Fills existing content when a required property is added to a type with pages. */
  default?: unknown
  since?: string
}

export interface SchemaGroup {
  name: string
  alias?: string
  properties: SchemaProperty[]
}

export interface SchemaTab {
  name: string
  alias?: string
  properties: SchemaProperty[]
  groups: SchemaGroup[]
}

export interface SchemaCleanup {
  prevent: boolean
  keepAllNewerThanDays?: number
  keepLatestPerDayForDays?: number
}

export interface SchemaDocumentType {
  key?: string
  alias: string
  name: string
  description?: string
  notes?: string
  icon: string
  allowAtRoot: boolean
  isElement: boolean
  allowInLibrary: boolean
  variesByCulture: boolean
  variesBySegment: boolean
  compositions: string[]
  allowChildren: string[]
  templates: string[]
  defaultTemplate?: string
  collection?: string
  /** Tree placement in the backoffice, `A/B`; not part of the type's meaning. */
  folder?: string
  cleanup: SchemaCleanup
  since?: string
  /** Properties outside any tab. */
  properties: SchemaProperty[]
  /** Groups outside any tab — `[[group]]`; Umbraco's built-in media types use one. */
  groups?: SchemaGroup[]
  tabs: SchemaTab[]
}

export interface SchemaDataType {
  key?: string
  alias: string
  name: string
  notes?: string
  editor: string
  editorUi?: string
  folder?: string
  config: Record<string, unknown>
  since?: string
}

export interface SchemaLanguage {
  iso: string
  name: string
  default: boolean
  mandatory: boolean
  fallback?: string
}

export interface SchemaSet {
  /** From schema/schema.toml; "0" when the file is absent. */
  version: string
  documentTypes: SchemaDocumentType[]
  /** `schema/media-types/*.toml`: the same vocabulary under `[media-type]`, without templates or cleanup. */
  mediaTypes?: SchemaDocumentType[]
  /** `schema/member-types/*.toml`: under `[member-type]`, no templates, cleanup or allowed children. */
  memberTypes?: SchemaDocumentType[]
  dataTypes: SchemaDataType[]
  languages: SchemaLanguage[]
}

/** A problem found while parsing or validating, always locatable. */
export interface SchemaProblem {
  file: string
  /** A dotted path into the file, e.g. `tab[1].property[0].type`. */
  path: string
  message: string
}

/** Which kind of content type a file defines. */
export type SchemaTypeKind = 'document' | 'media' | 'member'

/** The table header and directory for each kind. */
export const TYPE_KIND_FILES: Record<SchemaTypeKind, { header: string; dir: string }> = {
  document: { header: 'document-type', dir: 'document-types' },
  media: { header: 'media-type', dir: 'media-types' },
  member: { header: 'member-type', dir: 'member-types' },
}

/** The files-map key for a type: document types by bare alias, others prefixed. */
export function typeFileKey(kind: SchemaTypeKind, alias: string): string {
  return kind === 'document' ? alias : `${TYPE_KIND_FILES[kind].header}:${alias}`
}

export class SchemaError extends Error {
  constructor(readonly problems: SchemaProblem[]) {
    super(
      `${problems.length} schema problem${problems.length === 1 ? '' : 's'}:\n` +
        problems.map((p) => `  ${p.file}: ${p.path ? `${p.path}: ` : ''}${p.message}`).join('\n'),
    )
  }
}

/** Every property of a type, including tabbed and grouped ones, in editor order. */
export function allProperties(type: SchemaDocumentType): SchemaProperty[] {
  const out = [...type.properties]
  for (const group of type.groups ?? []) out.push(...group.properties)
  for (const tab of type.tabs) {
    out.push(...tab.properties)
    for (const group of tab.groups) out.push(...group.properties)
  }
  return out
}
