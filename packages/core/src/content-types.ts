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
  allowedComponentKeys: string[]
  defaultComponentKey: string | null
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

/**
 * Content types this CMS ships: always present, not deletable, alias fixed. A
 * site may add fields to one, but not remove or change the ones it ships with.
 */
export const SYSTEM_CONTENT_TYPE_KEYS: Readonly<Record<'SeoFields', string>> = {
  SeoFields: '5e0f1c2a-7b3d-4c8e-9a61-0d2b4f6e8a13',
}

export function isSystemContentType(kind: 'document' | 'media' | 'member', key: string): boolean {
  if (kind === 'media') return isSystemMediaType(key)
  if (kind === 'member') return isSystemMemberType(key)
  return Object.values(SYSTEM_CONTENT_TYPE_KEYS).includes(key.toLowerCase())
}

/** A field a system content type ships with, which a site may not remove or change. */
export interface SystemPropertyModel {
  key: string
  alias: string
  name: string
  description: string
  dataTypeKey: string
}

/**
 * The "Search & sharing" composition's own fields. Invariant as shipped: the data
 * layer does not mask a property's variance by the composing type's, so a site
 * that wants per-language values turns variance on in its own file.
 */
export const SEO_FIELDS_PROPERTIES: readonly SystemPropertyModel[] = [
  {
    key: '8d1f3a52-6c0e-4b7a-9e24-1a5c7d9f0b31',
    alias: 'seoTitle',
    name: 'Search title',
    description: 'Shown in search results and browser tabs. Leave empty to use the page name.',
    dataTypeKey: '0cc0eba1-9960-42c9-bf9b-60e150b429ae',
  },
  {
    key: '2b7e9c41-0d5f-4a63-8b18-6e4c2a0f7d52',
    alias: 'seoDescription',
    name: 'Search description',
    description: 'A sentence or two shown under the title in search results and when shared.',
    dataTypeKey: 'c6bac0dd-4ab9-45b1-8e30-e4b619ee5da3',
  },
  {
    key: 'f4a60d83-9e2b-4c15-a7d0-3b8e1f5c9a64',
    alias: 'seoImage',
    name: 'Sharing image',
    description: 'Shown when the page is shared. Leave empty to use the site image.',
    dataTypeKey: 'ad9f0cf2-bda2-45d5-9ea1-a63cfc873fd3',
  },
  {
    key: '6c3b8e14-2f7a-4d90-b5e1-9a0d4c7f2e75',
    alias: 'seoCanonical',
    name: 'Preferred address',
    description:
      'Only when the same content lives at another address search engines should use instead.',
    dataTypeKey: '0cc0eba1-9960-42c9-bf9b-60e150b429ae',
  },
  {
    key: '0e9d5a27-4b1c-4f86-8c32-7d6f0a3e1b86',
    alias: 'seoNoindex',
    name: 'Hide from search engines',
    description: 'Asks search engines to leave this page out of their results.',
    dataTypeKey: '92897bc6-a5f3-4ffe-ae27-f2e7e33dda49',
  },
  {
    key: 'a7f2c6e9-8d4b-4e31-b0a5-2c9e6f1d3a97',
    alias: 'seoSitemapHide',
    name: 'Hide from sitemap',
    description: 'Leaves this page out of the list of pages offered to search engines.',
    dataTypeKey: '92897bc6-a5f3-4ffe-ae27-f2e7e33dda49',
  },
]

/** The fields a system content type ships with, by the type's key. */
export function systemContentTypeProperties(key: string): readonly SystemPropertyModel[] {
  return key.toLowerCase() === SYSTEM_CONTENT_TYPE_KEYS.SeoFields ? SEO_FIELDS_PROPERTIES : []
}

/**
 * Why a change to a system content type's fields is refused, or undefined when
 * it keeps every shipped field's key, alias and data type. Fields may be added,
 * relabelled, moved, and switched to vary by culture.
 */
export function systemFieldViolation(
  key: string,
  properties: ReadonlyArray<{ key: string; alias: string; dataTypeKey: string }>,
): string | undefined {
  for (const shipped of systemContentTypeProperties(key)) {
    const found = properties.find((p) => p.key.toLowerCase() === shipped.key)
    if (
      !found ||
      found.alias !== shipped.alias ||
      found.dataTypeKey.toLowerCase() !== shipped.dataTypeKey
    )
      return `The '${shipped.name}' field is provided by Bunbraco and cannot be removed or changed. You can add your own fields beside it.`
  }
  return undefined
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

export interface ComponentModel {
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
  /** The content type of a blueprint in the blueprint tree. */
  contentTypeKey?: string | null
}

export interface Page<T> {
  total: number
  items: T[]
}
