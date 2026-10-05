/**
 * The document aggregate.
 *
 * Values are a flat list keyed by (alias, culture, segment), matching the wire
 * format, because that is also how they are stored: one `property_data` row per
 * combination.
 */
export interface DocumentValue {
  alias: string
  culture: string | null
  segment: string | null
  value: unknown
  /** Present on responses so the editor knows which editor rendered the value. */
  editorAlias?: string
  /** The data type's configuration, on reads; converters that depend on it use it. */
  config?: Record<string, unknown>
}

/**
 * Per-culture state. `NotCreated` means the culture has no name yet;
 * `PublishedPendingChanges` means the draft differs from what is published.
 */
export type VariantState =
  | 'NotCreated'
  | 'Draft'
  | 'Published'
  | 'PublishedPendingChanges'
  | 'Trashed'

export interface DocumentVariant {
  culture: string | null
  segment: string | null
  name: string
  state: VariantState
  createDate: Date
  updateDate: Date
  publishDate: Date | null
  /** When a scheduled publish of this variant will run. */
  scheduledPublishDate?: Date | null
  scheduledUnpublishDate?: Date | null
}

export interface DocumentAggregate {
  key: string
  contentTypeKey: string
  contentTypeAlias: string
  contentTypeIcon: string
  /** The list view the type shows its children in, if any. */
  contentTypeCollectionKey?: string | null
  componentKey: string | null
  parentKey: string | null
  sortOrder: number
  isTrashed: boolean
  /** True when any culture is published. */
  published: boolean
  /** True when the draft differs from the published version. */
  edited: boolean
  values: DocumentValue[]
  variants: DocumentVariant[]
}

/** One property that failed validation, in the terms the editor highlights. */
export interface DocumentValidationError {
  alias: string
  culture: string | null
  segment: string | null
  messages: string[]
}

/** What the content tree shows for a document, beyond the generic tree item. */
export interface DocumentTreeItem {
  key: string
  name: string
  hasChildren: boolean
  parentKey: string | null
  contentTypeKey: string
  contentTypeCollectionKey?: string | null
  icon: string
  isTrashed: boolean
  createDate: Date
  ancestorKeys: string[]
  variants: Array<{ culture: string | null; name: string; state: VariantState }>
}

/**
 * A row in the Library tree, which mixes folders and elements: a folder carries
 * the name and nothing else, so `documentType` is reported as null and its single
 * variant as `NotCreated` — the contract's own way of saying there is no content
 * here.
 */
export interface ElementTreeItem extends DocumentTreeItem {
  isFolder: boolean
}

export interface DocumentVersionSummary {
  id: string
  documentKey: string
  versionDate: Date
  /** The draft that is currently being edited. */
  isCurrentDraft: boolean
  isCurrentPublished: boolean
  preventCleanup: boolean
  userKey: string | null
  culture: string | null
  /** What made this version: a save, publish, rollback or schema migration. */
  kind?: 'save' | 'publish' | 'rollback' | 'migrate'
}

/** A value keyed for lookup, so variance handling stays explicit. */
export function valueKey(alias: string, culture: string | null, segment: string | null): string {
  return `${alias}|${culture ?? ''}|${segment ?? ''}`
}

/**
 * The culture a value belongs to, honouring the effective variance: a value sent
 * with a culture for an invariant property is stored invariant, which is what
 * keeps a type change from orphaning data.
 */
export function normaliseValueCulture(
  culture: string | null,
  propertyVariesByCulture: boolean,
): string | null {
  return propertyVariesByCulture ? culture : null
}
