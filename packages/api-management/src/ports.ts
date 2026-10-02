/**
 * Ports the Management API needs from the rest of the application.
 *
 * Declared here as interfaces so this package depends only on @bunbraco/core and
 * @bunbraco/contracts; the composition root supplies the implementations. The
 * return types come from the generated contract, so an implementation that
 * drifts from the wire shape fails to compile.
 */

import type { ResponseOf } from '@bunbraco/contracts'
import type { UploadSettings } from '@bunbraco/core'
import type {
  BlueprintPort,
  ContentTypePort,
  DataTypePort,
  DocumentPort,
  ElementPort,
  MediaPort,
  RedirectPort,
  ReferencePort,
  TemplatePort,
} from './ports-content.ts'
import type { FileSystemPort, Snippet } from './ports-files.ts'
import type { LogViewerPort } from './ports-logs.ts'
import type { MemberGroupPort, MemberPort, PublicAccessPort } from './ports-members.ts'
import type { ModelsBuilderPort } from './ports-models-builder.ts'
import type { UserDataPort, UserGroupPort, UserPort } from './ports-users.ts'
import type { Principal } from './router.ts'

export interface ServerPort {
  status(): ResponseOf<'GetServerStatus'>
  configuration(): ResponseOf<'GetServerConfiguration'>
  information(): ResponseOf<'GetServerInformation'>
  /** What may be uploaded; Umbraco's defaults when omitted. */
  uploadSettings?(): UploadSettings
}

export type ManifestVisibility = 'all' | 'public' | 'private'

export interface ManifestPort {
  list(visibility: ManifestVisibility): ResponseOf<'GetManifestManifest'>
}

export interface LanguageInput {
  isoCode: string
  name: string
  isDefault: boolean
  isMandatory: boolean
  fallbackIsoCode: string | null
}

export interface LocalizationPort {
  /** Languages live in the database (and `schema/languages.toml`); cultures are the fixed list. */
  allLanguages(): Promise<LanguageInput[]>
  language(isoCode: string): Promise<LanguageInput | undefined>
  saveLanguage(language: LanguageInput): Promise<void>
  deleteLanguage(isoCode: string): Promise<'deleted' | 'default' | 'in-use' | 'not-found'>
  cultures(): ResponseOf<'GetCulture'>['items']
}

export interface CurrentUserPort {
  get(principal: Principal): ResponseOf<'GetUserCurrent'> | Promise<ResponseOf<'GetUserCurrent'>>
}

/** Backoffice users by key, for anything that names who did something. */
export interface UserItemPort {
  items(
    keys: readonly string[],
  ): Promise<Array<{ key: string; name: string; avatarUrls: string[]; kind?: 'Default' | 'Api' }>>
}

/** Uploads waiting to be saved into a value (Umbraco's temporary files). */
export interface TemporaryFilePort {
  save(
    id: string,
    file: File,
  ): Promise<
    | { ok: true; file: { id: string; fileName: string; availableUntil: Date } }
    | { ok: false; reason: string }
  >
  get(id: string): Promise<{ id: string; fileName: string; availableUntil: Date } | undefined>
  /** The upload's name and bytes, for files that are read rather than placed. */
  read(id: string): Promise<{ fileName: string; bytes: Uint8Array } | undefined>
  remove(id: string): Promise<boolean>
}

/** Tags in use, for the tags editor's suggestions. */
export interface TagPort {
  list(filter: {
    query?: string
    group?: string
    culture?: string | null
  }): Promise<Array<{ id: string; text: string; group: string; nodeCount: number }>>
}

/**
 * The published content cache behind the Published Status dashboard.
 *
 * Umbraco distinguishes reloading the in-memory cache from rebuilding the
 * database cache it reads (`cmsContentNu`). There is no such table here — the
 * content tables are the source — so the difference is when the cost is paid:
 * a reload drops the snapshot and lets the next request rebuild it, a rebuild
 * builds it before answering.
 */
export interface PublishedCachePort {
  reload(): void
  rebuild(): Promise<void>
  /** Ours completes within the request, so this is only ever false afterwards. */
  isRebuilding(): boolean
}

/** Embed markup for a URL, from its oEmbed provider. */
export interface OEmbedPort {
  markup(
    url: string,
    maxWidth?: number,
    maxHeight?: number,
  ): Promise<
    { ok: true; markup: string } | { ok: false; status: 'unsupported' | 'failed'; reason: string }
  >
}

/** Preview mode is a cookie; the server owns its name and attributes. */
export interface PreviewPort {
  /** `Set-Cookie` values that enter preview for the signed-in editor. */
  enter(): string[]
  /** `Set-Cookie` values that leave it. */
  exit(): string[]
}

export interface DictionaryItemModel {
  key: string
  name: string
  parentKey: string | null
  translations: Array<{ isoCode: string; translation: string }>
}

export type DictionaryWriteStatus =
  | 'Success'
  | 'DuplicateItemKey'
  | 'DuplicateKey'
  | 'ParentNotFound'
  | 'NotFound'
  | 'InvalidParent'
  | 'InvalidLanguage'

/** Dictionary items and their translations. */
export interface DictionaryPort {
  all(filter?: string): Promise<DictionaryItemModel[]>
  get(key: string): Promise<DictionaryItemModel | undefined>
  items(keys: readonly string[]): Promise<DictionaryItemModel[]>
  children(
    parentKey: string | null,
  ): Promise<Array<{ key: string; name: string; parentKey: string | null; hasChildren: boolean }>>
  /** The item and its ancestors, root first. */
  ancestry(key: string): Promise<DictionaryItemModel[]>
  create(item: DictionaryItemModel): Promise<DictionaryWriteStatus>
  update(
    key: string,
    change: { name: string; translations: DictionaryItemModel['translations'] },
  ): Promise<DictionaryWriteStatus>
  move(key: string, parentKey: string | null): Promise<DictionaryWriteStatus>
  delete(key: string): Promise<DictionaryWriteStatus>
  /** The item, with its descendants when asked, as a `.udt` file. */
  export(
    key: string,
    includeChildren: boolean,
  ): Promise<{ fileName: string; content: string } | undefined>
  /** Creates or updates the items in an uploaded `.udt` file, under `parentKey`. */
  import(
    temporaryFileId: string,
    parentKey: string | null,
  ): Promise<
    | { ok: true; key: string }
    | { ok: false; status: 'NotFound' | 'ParentNotFound' | 'Invalid'; reason: string }
  >
}

export interface AuthPort {
  /** Ends the caller's session. */
  signOut(principal: Principal): Promise<void>
}

export interface ManagementApiDeps {
  server: ServerPort
  manifests: ManifestPort
  localization: LocalizationPort
  currentUser: CurrentUserPort
  users?: UserItemPort
  preview?: PreviewPort
  temporaryFiles?: TemporaryFilePort
  media?: MediaPort
  tags?: TagPort
  oembed?: OEmbedPort
  blueprints?: BlueprintPort
  contentTypes?: ContentTypePort
  mediaTypes?: ContentTypePort
  memberTypes?: ContentTypePort
  dataTypes?: DataTypePort
  templates?: TemplatePort
  documents?: DocumentPort
  dictionary?: DictionaryPort
  userManagement?: UserPort
  userGroups?: UserGroupPort
  userData?: UserDataPort
  partialViews?: FileSystemPort
  partialViewSnippets?: readonly Snippet[]
  stylesheets?: FileSystemPort
  scripts?: FileSystemPort
  logViewer?: LogViewerPort
  modelsBuilder?: ModelsBuilderPort
  publishedCache?: PublishedCachePort
  memberGroups?: MemberGroupPort
  members?: MemberPort
  publicAccess?: PublicAccessPort
  elements?: ElementPort
  references?: ReferencePort
  redirects?: RedirectPort
}
