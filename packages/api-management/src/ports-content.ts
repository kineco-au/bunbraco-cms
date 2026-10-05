/**
 * Ports for content types, data types, templates and documents.
 *
 * Return types come from the generated contract so an implementation that drifts
 * from the wire shape fails to compile.
 */
import type {
  ComponentModel,
  ContentTypeAggregate,
  DataTypeModel,
  DocumentAggregate,
  DocumentTreeItem,
  DocumentValidationError,
  DocumentValue,
  DocumentVersionSummary,
  ElementTreeItem,
  Page,
  TreeItem,
} from '@bunbraco/core'
import type { Principal } from './router.ts'

/** A failed port call; `status` overrides the handler's default 400 (409 for a write gate). */
export type PortFailure = {
  ok: false
  reason: string
  status?: number
  /** Validation failures, when the reason is the request's values. */
  errors?: DocumentValidationError[]
}

export interface SkipTake {
  skip: number
  take: number
}

/** A settings tree page: folders and items, or folders only. */
export interface TreePage extends SkipTake {
  foldersOnly?: boolean
}

export interface FolderInput {
  key?: string
  name: string
  parentKey: string | null
}

/** Document types and media types share one port shape. */
export type ContentTypeKind = 'document' | 'media' | 'member'

/** Umbraco's TreeItemKind: which of folders and items a search returns. */
export type TreeItemKind = 'All' | 'Item' | 'Folder'

/** The Library section: a tree of folders, with no items in it yet. */
/**
 * The Library section: Umbraco 18's Elements.
 *
 * Publishable, versioned content with no URL and no template — so this is the
 * document port without URLs, templates, schedules or domains, plus the folders
 * elements are gathered in. `folders` and the four tree reads stay as they were,
 * because a folder is a plain node and the generic folder port already carries it.
 */
export interface ElementPort {
  folders: FolderPort
  treeRoot(paging: TreePage): Promise<Page<ElementTreeItem>>
  treeChildren(parentKey: string, paging: TreePage): Promise<Page<ElementTreeItem>>
  ancestors(descendantKey: string): Promise<ElementTreeItem[]>
  items(keys: readonly string[]): Promise<ElementTreeItem[]>
  treeSiblings(
    target: string,
    before: number,
    after: number,
  ): Promise<{ items: ElementTreeItem[]; totalBefore: number; totalAfter: number } | undefined>

  byKey(key: string): Promise<DocumentAggregate | undefined>
  /** The published version's values; undefined when nothing is published. */
  byKeyPublished(key: string): Promise<DocumentAggregate | undefined>
  validate(input: SaveDocument, cultures: string[] | null): Promise<DocumentValidationError[]>
  create(
    input: SaveDocument,
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  update(
    key: string,
    input: SaveDocument,
    principal: Principal,
  ): Promise<{ ok: true } | PortFailure>
  createAndPublish(
    input: SaveDocument,
    cultures: string[] | null,
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  updateAndPublish(
    key: string,
    input: SaveDocument,
    cultures: string[] | null,
    principal: Principal,
  ): Promise<{ ok: true } | PortFailure>
  publish(key: string, cultures: string[] | null): Promise<{ ok: true } | PortFailure>
  unpublish(key: string, cultures: string[] | null): Promise<{ ok: true } | PortFailure>
  copy(
    key: string,
    targetKey: string | null,
    options: { includeDescendants: boolean },
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  move(key: string, targetKey: string | null): Promise<{ ok: true } | PortFailure>
  moveToRecycleBin(key: string): Promise<boolean>
  remove(key: string): Promise<boolean>
  /** `targetKey` undefined restores to where it was trashed from. */
  restore(key: string, targetKey: string | null | undefined): Promise<{ ok: true } | PortFailure>
  emptyRecycleBin(): Promise<void>
  /** null at the root; undefined when the element does not exist. */
  originalParent(key: string): Promise<string | null | undefined>
  recycleBin(parentKey: string | null, paging: SkipTake): Promise<Page<ElementTreeItem>>
  recycleBinSiblings(
    target: string,
    before: number,
    after: number,
  ): Promise<{ items: ElementTreeItem[]; totalBefore: number; totalAfter: number } | undefined>
  search(
    query: string,
    options: { trashed?: boolean; parentKey?: string | null } & SkipTake,
  ): Promise<Page<ElementTreeItem>>
  versions(key: string): Promise<DocumentVersionSummary[]>
  /** The element as it stood at a version. */
  atVersion(
    versionId: string,
  ): Promise<{ versionId: string; document: DocumentAggregate } | undefined>
  rollback(versionId: string): Promise<boolean>
  setPreventCleanup(versionId: string, prevent: boolean): Promise<boolean>
  /** The author the audit log falls back to, as documents and media do. */
  systemUserKey(): Promise<string | null>
  /**
   * Folders move and trash too, which no other area's folders do — so these are
   * here rather than on the shared `FolderPort`.
   */
  moveFolder(key: string, targetKey: string | null): Promise<{ ok: true } | PortFailure>
  folderToRecycleBin(key: string): Promise<boolean>
  /** The folders alone, for the picker that chooses where a folder goes. */
  folderItems(keys: readonly string[]): Promise<ElementTreeItem[]>
}

export interface FolderPort {
  /** Name search over the tree's folders and items. */
  search(query: string, kind: TreeItemKind, paging: SkipTake): Promise<Page<TreeItem>>
  folder(key: string): Promise<{ key: string; name: string; parentKey: string | null } | undefined>
  createFolder(input: FolderInput): Promise<{ key: string }>
  renameFolder(key: string, name: string): Promise<boolean>
  deleteFolder(key: string): Promise<'deleted' | 'not-empty' | 'not-found'>
  siblings(
    target: string,
    before: number,
    after: number,
    foldersOnly?: boolean,
  ): Promise<{ items: TreeItem[]; totalBefore: number; totalAfter: number } | undefined>
}

export interface TreePort {
  root(paging: SkipTake): Promise<Page<TreeItem>>
  children(parentKey: string, paging: SkipTake): Promise<Page<TreeItem>>
  ancestors(descendantKey: string): Promise<TreeItem[]>
  items(keys: readonly string[]): Promise<TreeItem[]>
}

export interface ContentTypePort extends TreePort {
  byKey(key: string): Promise<ContentTypeAggregate | undefined>
  create(aggregate: ContentTypeAggregate, principal: Principal): Promise<{ ok: true } | PortFailure>
  update(
    key: string,
    aggregate: ContentTypeAggregate,
    principal: Principal,
  ): Promise<{ ok: true } | PortFailure>
  remove(key: string): Promise<boolean>
  /** The type as Umbraco's `.udt` XML, or undefined when it is not there. */
  exportUdt(key: string): Promise<string | undefined>
  /**
   * Creates from a `.udt` document, or updates `targetKey` from one. `mismatch`
   * means the file describes a different kind or a different type.
   */
  importUdt(
    xml: string,
    targetKey?: string,
  ): Promise<
    | { status: 'ok'; key: string }
    | { status: 'not-found' | 'invalid' | 'mismatch'; reason?: string }
  >
  /** The type's values as a JSON Schema, or undefined when it is not there. */
  jsonSchema(key: string): Promise<Record<string, unknown> | undefined>
  allowedAtRoot(paging: SkipTake): Promise<Page<ContentTypeAggregate>>
  allowedInLibrary(paging: SkipTake): Promise<Page<ContentTypeAggregate>>
  allowedChildren(key: string, paging: SkipTake): Promise<Page<ContentTypeAggregate>>
  byKeys(keys: readonly string[]): Promise<ContentTypeAggregate[]>
  search(
    query: string,
    options: { isElement?: boolean } & SkipTake,
  ): Promise<Page<ContentTypeAggregate>>
  compositionReferences(key: string): Promise<ContentTypeAggregate[]>
  allowedParents(key: string): Promise<string[]>
  availableCompositions(request: {
    key: string | null
    isElement: boolean
    currentPropertyAliases: string[]
    currentCompositeKeys: string[]
  }): Promise<Array<{ type: ContentTypeAggregate; folderPath: string[]; isCompatible: boolean }>>
  move(key: string, parentKey: string | null): Promise<boolean>
  copy(key: string, parentKey: string | null): Promise<ContentTypeAggregate | undefined>
  /** Creates a view for the type and attaches it, as the "Create template" toggle does. Document types only. */
  createTemplate(
    key: string,
    template: { alias: string; name: string; isDefault: boolean },
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  folders: FolderPort
  /** Tree pages that may include folders. */
  treeRoot(paging: TreePage): Promise<Page<TreeItem>>
  treeChildren(parentKey: string, paging: TreePage): Promise<Page<TreeItem>>
}

export interface DataTypePort extends TreePort {
  /** The value a data type stores, as a JSON Schema; undefined when missing. */
  valueSchema(
    key: string,
  ): Promise<{ valueTypeName: string; jsonSchema: Record<string, unknown> } | undefined>
  byKey(key: string): Promise<DataTypeModel | undefined>
  byKeys(keys: readonly string[]): Promise<DataTypeModel[]>
  save(model: DataTypeModel, principal: Principal): Promise<void>
  /** 'in-use' when a property type still uses it. */
  remove(key: string): Promise<boolean | 'in-use'>
  filter(
    criteria: { name?: string; editorAlias?: string; editorUiAlias?: string },
    paging: SkipTake,
  ): Promise<Page<DataTypeModel>>
  search(query: string, paging: SkipTake): Promise<Page<DataTypeModel>>
  referencedBy(key: string): Promise<
    Array<{
      propertyKey: string
      alias: string
      name: string
      contentType: { key: string; alias: string; name: string; icon: string }
    }>
  >
  move(key: string, parentKey: string | null): Promise<boolean>
  copy(key: string, parentKey: string | null): Promise<DataTypeModel | undefined>
  folders: FolderPort
  treeRoot(paging: TreePage): Promise<Page<TreeItem>>
  treeChildren(parentKey: string, paging: TreePage): Promise<Page<TreeItem>>
}

export interface TemplatePort extends TreePort {
  byKey(key: string): Promise<ComponentModel | undefined>
  save(model: ComponentModel, principal: Principal): Promise<void>
  remove(key: string): Promise<boolean>
  /** A starter view for a new template, as Umbraco scaffolds one. */
  scaffold(name: string, alias: string): string
  search(query: string, paging: SkipTake): Promise<Page<ComponentModel>>
  siblings(
    target: string,
    before: number,
    after: number,
  ): Promise<{ items: TreeItem[]; totalBefore: number; totalAfter: number } | undefined>
}

export interface DocumentPort extends TreePort {
  byKey(key: string): Promise<DocumentAggregate | undefined>
  /** The published version's values; undefined when nothing is published. */
  byKeyPublished(key: string): Promise<DocumentAggregate | undefined>
  /** What the editor asks before a save: the rules the server would enforce. */
  validate(input: SaveDocument, cultures: string[] | null): Promise<DocumentValidationError[]>
  createAndPublish(
    input: SaveDocument,
    cultures: string[] | null,
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  updateAndPublish(
    key: string,
    input: SaveDocument,
    cultures: string[] | null,
    principal: Principal,
  ): Promise<{ ok: true } | PortFailure>
  /** The content tree's own items, richer than the generic tree item. */
  treeRoot(paging: SkipTake): Promise<Page<DocumentTreeItem>>
  treeChildren(parentKey: string, paging: SkipTake): Promise<Page<DocumentTreeItem>>
  treeAncestors(descendantKey: string): Promise<DocumentTreeItem[]>
  /** Documents by key, in the order asked, skipping unknown keys. */
  documentItems(keys: readonly string[]): Promise<DocumentTreeItem[]>
  treeSiblings(
    target: string,
    before: number,
    after: number,
  ): Promise<{ items: DocumentTreeItem[]; totalBefore: number; totalAfter: number } | undefined>
  search(
    query: string,
    options: { trashed?: boolean; parentKey?: string | null } & SkipTake,
  ): Promise<Page<DocumentTreeItem>>
  recycleBin(parentKey: string | null, paging: SkipTake): Promise<Page<DocumentTreeItem>>
  recycleBinSiblings(
    target: string,
    before: number,
    after: number,
  ): Promise<{ items: DocumentTreeItem[]; totalBefore: number; totalAfter: number } | undefined>
  /** null at the root; undefined when the document does not exist. */
  originalParent(key: string): Promise<string | null | undefined>
  create(
    input: SaveDocument,
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  update(
    key: string,
    input: SaveDocument,
    principal: Principal,
  ): Promise<{ ok: true } | PortFailure>
  publish(key: string, cultures: string[] | null): Promise<{ ok: true } | PortFailure>
  unpublish(key: string, cultures: string[] | null): Promise<{ ok: true } | PortFailure>
  moveToRecycleBin(key: string): Promise<boolean>
  remove(key: string): Promise<boolean>
  move(key: string, targetKey: string | null): Promise<{ ok: true } | PortFailure>
  copy(
    key: string,
    targetKey: string | null,
    options: { includeDescendants: boolean },
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  sort(
    parentKey: string | null,
    sorting: ReadonlyArray<{ key: string; sortOrder: number }>,
  ): Promise<{ ok: true } | PortFailure>
  sortChildrenBy(
    parentKey: string | null,
    field: 'Name' | 'CreateDate' | 'UpdateDate',
    direction: 'Ascending' | 'Descending',
  ): Promise<{ ok: true } | PortFailure>
  /** `targetKey` undefined restores to where it was trashed from. */
  restore(key: string, targetKey: string | null | undefined): Promise<{ ok: true } | PortFailure>
  emptyRecycleBin(): Promise<void>
  publishBranch(
    key: string,
    cultures: string[] | null,
    includeUnpublished: boolean,
  ): Promise<
    { ok: true; published: string[]; failed: Array<{ key: string; reason: string }> } | PortFailure
  >
  /** Replaces the scheduled publish/unpublish of each culture given. */
  schedule(
    key: string,
    entries: ReadonlyArray<{
      culture: string | null
      publishTime: Date | null
      unpublishTime: Date | null
    }>,
  ): Promise<boolean>
  domains(key: string): Promise<DocumentDomains | undefined>
  setDomains(
    key: string,
    domains: DocumentDomains,
  ): Promise<
    /** `file` names the declaration the site keeps hostnames in, when it has one. */
    | { status: 'ok'; file?: string }
    | { status: 'notFound' }
    | { status: 'invalidLanguage'; isoCode: string }
    | { status: 'invalidName' | 'conflict'; domainName: string }
  >
  /** Every action the user may subscribe to on the document, and whether they have. */
  notifications(
    key: string,
    principal: Principal,
  ): Promise<Array<{ actionId: string; alias: string; subscribed: boolean }> | undefined>
  setNotifications(key: string, principal: Principal, actionIds: string[]): Promise<boolean>
  /** The document as it stood at a version. */
  atVersion(
    versionId: string,
  ): Promise<{ versionId: string; document: DocumentAggregate } | undefined>
  versions(key: string): Promise<DocumentVersionSummary[]>
  /** Who a version with no recorded author is attributed to: the first administrator. */
  systemUserKey(): Promise<string | null>
  rollback(versionId: string): Promise<boolean>
  setPreventCleanup(versionId: string, prevent: boolean): Promise<boolean>
  /** Published URLs per culture, for the editor's info panel. */
  urls(key: string): Promise<Array<{ culture: string | null; url: string }>>
  collection(parentKey: string | null, paging: SkipTake): Promise<Page<DocumentAggregate>>
}

export interface SaveDocument {
  key: string
  contentTypeKey: string
  componentKey: string | null
  parentKey: string | null
  values: DocumentValue[]
  variants: Array<{ culture: string | null; segment: string | null; name: string }>
}

export interface DocumentDomains {
  defaultIsoCode: string | null
  domains: Array<{ domainName: string; isoCode: string }>
}

/** Document blueprints: documents that are never published, used to prefill new ones. */
export interface BlueprintPort {
  byKey(key: string): Promise<DocumentAggregate | undefined>
  create(input: SaveDocument, principal: Principal): Promise<{ ok: true } | PortFailure>
  update(
    key: string,
    input: SaveDocument,
    principal: Principal,
  ): Promise<{ ok: true } | PortFailure>
  /** A blueprint from a document's current draft, under `name`. */
  fromDocument(
    documentKey: string,
    init: { key: string; name: string; parentKey: string | null },
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  remove(key: string): Promise<boolean>
  move(key: string, targetKey: string | null): Promise<{ ok: true } | PortFailure>
  versions(key: string): Promise<DocumentVersionSummary[]>
  systemUserKey(): Promise<string | null>
  /** Blueprints of one document type, by name. */
  forDocumentType(
    contentTypeKey: string,
    paging: SkipTake,
  ): Promise<Page<{ key: string; name: string }>>
  treeRoot(paging: TreePage): Promise<Page<TreeItem>>
  treeChildren(parentKey: string, paging: TreePage): Promise<Page<TreeItem>>
  treeAncestors(descendantKey: string): Promise<TreeItem[]>
  treeSiblings(
    target: string,
    before: number,
    after: number,
    foldersOnly?: boolean,
  ): Promise<{ items: TreeItem[]; totalBefore: number; totalAfter: number } | undefined>
  items(
    keys: readonly string[],
  ): Promise<Array<{ key: string; name: string; contentTypeKey: string; icon: string }>>
  folders: FolderPort
}

/** Media: documents that never publish, whose file is served at its `umbracoFile` path. */
export interface MediaPort {
  byKey(key: string): Promise<DocumentAggregate | undefined>
  validate(input: SaveDocument): Promise<DocumentValidationError[]>
  create(
    input: SaveDocument,
    principal: Principal,
  ): Promise<{ ok: true; key: string } | PortFailure>
  update(
    key: string,
    input: SaveDocument,
    principal: Principal,
  ): Promise<{ ok: true } | PortFailure>
  /** Deletes a branch for good, and its files. */
  remove(key: string): Promise<boolean>
  moveToRecycleBin(key: string): Promise<boolean>
  move(key: string, targetKey: string | null): Promise<{ ok: true } | PortFailure>
  sort(
    parentKey: string | null,
    sorting: ReadonlyArray<{ key: string; sortOrder: number }>,
  ): Promise<{ ok: true } | PortFailure>
  sortChildrenBy(
    parentKey: string | null,
    field: 'Name' | 'CreateDate' | 'UpdateDate',
    direction: 'Ascending' | 'Descending',
  ): Promise<{ ok: true } | PortFailure>
  restore(key: string, targetKey: string | null | undefined): Promise<{ ok: true } | PortFailure>
  emptyRecycleBin(): Promise<void>
  originalParent(key: string): Promise<string | null | undefined>
  versions(key: string): Promise<DocumentVersionSummary[]>
  systemUserKey(): Promise<string | null>
  treeRoot(paging: SkipTake): Promise<Page<DocumentTreeItem>>
  treeChildren(parentKey: string, paging: SkipTake): Promise<Page<DocumentTreeItem>>
  treeAncestors(descendantKey: string): Promise<DocumentTreeItem[]>
  treeSiblings(
    target: string,
    before: number,
    after: number,
  ): Promise<{ items: DocumentTreeItem[]; totalBefore: number; totalAfter: number } | undefined>
  recycleBin(parentKey: string | null, paging: SkipTake): Promise<Page<DocumentTreeItem>>
  items(keys: readonly string[]): Promise<DocumentTreeItem[]>
  search(
    query: string,
    options: { trashed?: boolean; parentKey?: string | null } & SkipTake,
  ): Promise<Page<DocumentTreeItem>>
  /** A folder's children for the media collection view, with their values. */
  collection(
    parentKey: string | null,
    options: {
      filter?: string
      orderBy: string
      orderDirection: 'Ascending' | 'Descending'
    } & SkipTake,
  ): Promise<Page<DocumentAggregate & { sortOrder: number; creator: string | null }>>
  /** The URL of each item's file, if it has one. */
  urls(keys: readonly string[]): Promise<Array<{ key: string; url: string | null }>>
  /** Media types an upload of this extension can become, as Umbraco matches them. */
  typesForExtension(
    extension: string,
  ): Promise<Array<{ key: string; name: string; icon: string; matched: boolean }>>
  /** Media types that act as folders: no file, and something allowed inside. */
  folderTypes(): Promise<Array<{ key: string; name: string; icon: string }>>
}

/** What refers to a document, media item or member — the Info tab's list. */
export interface ReferencePort {
  referencedBy(key: string, paging: SkipTake): Promise<Page<unknown>>
  referencedDescendants(key: string, paging: SkipTake): Promise<Page<{ id: string }>>
  areReferenced(keys: readonly string[], paging: SkipTake): Promise<Page<{ id: string }>>
}

/** One redirect as the dashboard and the Info tab read it. */
export interface RedirectListing {
  key: string
  originalUrl: string
  destinationUrl: string
  culture: string | null
  /** The document it points at, when it points at one. */
  documentKey: string | null
  created: Date
  /** A rule the site's configuration owns cannot be deleted through the API. */
  isConfigured: boolean
}

/** The Redirect URL Management dashboard, and the redirects on a page's Info tab. */
export interface RedirectPort {
  list(filter: string | undefined, paging: SkipTake): Promise<Page<RedirectListing>>
  byDocument(key: string, paging: SkipTake): Promise<Page<RedirectListing>>
  /** `'configured'` refuses a rule the site's config owns. */
  remove(key: string): Promise<'deleted' | 'notFound' | 'configured'>
  /** Whether renaming a page records a redirect; from the site's config. */
  isTracking(): boolean
}
