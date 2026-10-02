/**
 * The content-type aggregate: a content type plus its property groups, property
 * types, compositions, allowed children and templates.
 *
 * Kept as one aggregate because the editor saves it as one document, and because
 * the property set is only meaningful together with the compositions it inherits.
 */
export interface PropertyTypeModel {
  key: string
  alias: string
  name: string
  description: string | null
  dataTypeKey: string
  /** The group this property renders in, or null for the generic tab. */
  containerKey: string | null
  sortOrder: number
  variesByCulture: boolean
  variesBySegment: boolean
  mandatory: boolean
  mandatoryMessage: string | null
  regEx: string | null
  regExMessage: string | null
  labelOnTop: boolean
  /** The file's `since`, when written. */
  sinceVersion?: string | null
  /** Set when the element is not yet live on the reading node: the state it goes live in. */
  pending?: { version: string; revision: string } | null
  /** Member types only: shown to the member on their profile. */
  memberCanView?: boolean
  /** Member types only: editable by the member on their profile. */
  memberCanEdit?: boolean
  /** Member types only: hidden from users without sensitive-data access. */
  isSensitive?: boolean
}

export interface PropertyGroupModel {
  key: string
  name: string | null
  alias: string | null
  /** 'Tab' or 'Group'; the wire format is a string. */
  type: string
  sortOrder: number
  parentKey: string | null
}

export type CompositionType = 'Composition' | 'Inheritance'

export interface CompositionModel {
  contentTypeKey: string
  compositionType: CompositionType
}

export interface AllowedChildModel {
  contentTypeKey: string
  sortOrder: number
}

export interface CleanupModel {
  preventCleanup: boolean
  keepAllVersionsNewerThanDays: number | null
  keepLatestVersionPerDayForDays: number | null
}

export interface ContentTypeAggregate {
  key: string
  alias: string
  name: string
  description: string | null
  icon: string
  allowedAsRoot: boolean
  variesByCulture: boolean
  variesBySegment: boolean
  isElement: boolean
  allowedInLibrary: boolean
  collectionKey: string | null
  cleanup: CleanupModel
  properties: PropertyTypeModel[]
  containers: PropertyGroupModel[]
  compositions: CompositionModel[]
  allowedContentTypes: AllowedChildModel[]
  allowedTemplateKeys: string[]
  defaultTemplateKey: string | null
  /** Folder placement in the tree, which is not the composition graph. */
  parentKey: string | null
  sinceVersion?: string | null
  pending?: { version: string; revision: string } | null
}

/**
 * Umbraco's system media types (`IsSystemMediaType`): always present, not
 * deletable, alias fixed. Keys from its installer.
 */
export const SYSTEM_MEDIA_TYPE_KEYS: Readonly<Record<'Folder' | 'Image' | 'File', string>> = {
  Folder: 'f38bd2d7-65d0-48e6-95dc-87ce06ec2d3d',
  Image: 'cc07b313-0843-4aa8-bbda-871c8da728c8',
  File: '4c52d8ab-54e6-40cd-999c-7a5f24903e4d',
}

export function isSystemMediaType(key: string): boolean {
  return Object.values(SYSTEM_MEDIA_TYPE_KEYS).includes(key.toLowerCase())
}

/**
 * Umbraco's one built-in member type, "Member", by the key its installer uses:
 * always present, so a fresh install can create a member without a schema file.
 */
export const SYSTEM_MEMBER_TYPE_KEY = 'd59be02f-1df9-4228-aa1e-01917d806cda'

export function isSystemMemberType(key: string): boolean {
  return key.toLowerCase() === SYSTEM_MEMBER_TYPE_KEY
}

/** How the editor labels a pending element. */
export function pendingLabel(until: { version: string }): string {
  return `goes live in ${until.version}`
}

export interface DataTypeModel {
  key: string
  /** Schema files reference a data type by this; Umbraco itself has only key and name. */
  alias: string | null
  name: string
  editorAlias: string
  editorUiAlias: string | null
  /** One of ValueStorageType. */
  dbType: string
  values: Array<{ alias: string; value: unknown }>
  parentKey: string | null
}

export interface TemplateModel {
  key: string
  name: string
  alias: string
  content: string | null
  /** Derived from `export const layout = '…'` in the view; the tree hangs children under it. */
  masterKey?: string | null
}

/** One entry in a backoffice tree. */
export interface TreeItem {
  key: string
  name: string
  hasChildren: boolean
  parentKey: string | null
  icon: string | null
  isFolder: boolean
  isElement?: boolean
  editorUiAlias?: string | null
  /** The document type of a blueprint in the blueprint tree. */
  contentTypeKey?: string | null
}

export interface Page<T> {
  total: number
  items: T[]
}
