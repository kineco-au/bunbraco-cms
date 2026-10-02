import { join } from 'node:path'
/** Implementations of the Management API ports. */
import type {
  CurrentUserPort,
  LocalizationPort,
  ManagementApiDeps,
  ManifestPort,
  NodeLookup,
  Principal,
  ServerPort,
  TemporaryFilePort,
  UserItemPort,
} from '@bunbraco/api-management'
import { AuthStore } from '@bunbraco/auth'
import {
  ASSISTANT_MANIFEST_ID,
  type BackOfficePaths,
  collectManifests,
  toResponseModels,
} from '@bunbraco/backoffice-host'
import {
  CORE_SECTION_ALIASES,
  DEFAULT_UPLOAD_SETTINGS,
  hasAccessToSensitiveData,
  isUploadAllowed,
  permissionsForPath,
} from '@bunbraco/core'
import {
  type Db,
  LanguageRepository,
  RedirectRepository,
  TagRepository,
  UserRepository,
} from '@bunbraco/data'
import type { PublishedCache } from '@bunbraco/render'
import { createNodeLookup } from './access.ts'
import { createBlueprintPort } from './adapters/blueprints.ts'
import {
  createContentTypePort,
  createDataTypePort,
  createTemplatePort,
} from './adapters/content.ts'
import { createDictionaryPort } from './adapters/dictionary.ts'
import { createDocumentPort } from './adapters/documents.ts'
import { createElementPort } from './adapters/elements.ts'
import { createFileSystemPort } from './adapters/file-system.ts'
import { createMediaPort } from './adapters/media.ts'
import { createMemberGroupPort } from './adapters/member-groups.ts'
import { createMemberPort } from './adapters/members.ts'
import { createPublicAccessPort } from './adapters/public-access.ts'
import { createRedirectPort } from './adapters/redirects.ts'
import { createReferencePort } from './adapters/references.ts'
import {
  createSchemaFileWriter,
  type SchemaFiles,
  type SchemaFileWriter,
} from './adapters/schema-files.ts'
import { createTemplateFileStore } from './adapters/template-files.ts'
import { avatarUrls, createUserPorts } from './adapters/users.ts'
import { type BunbracoConfig, type UserLinkSender, VERSION } from './config.ts'
import { createFileIntake } from './file-intake.ts'
import { createLogViewerPort } from './log-viewer.ts'
import { logger } from './logging.ts'
import { MediaFileStore } from './media-files.ts'
import { createModelsBuilderPort } from './models-builder.ts'
import { createOEmbedService } from './oembed.ts'
import { PARTIAL_VIEW_SNIPPETS } from './partial-view-snippets.ts'
import { createRedirectTracker } from './redirects.ts'
import { type SchemaBoot, templateAliasesIn } from './schema.ts'
import { publishSchema } from './schema-store.ts'

/** Re-exported for tests; the canonical list lives in @bunbraco/core. */
export const CORE_SECTIONS = CORE_SECTION_ALIASES

const CULTURES = [
  { name: 'en-US', englishName: 'English (United States)' },
  { name: 'en-GB', englishName: 'English (United Kingdom)' },
  { name: 'da-DK', englishName: 'Danish (Denmark)' },
  { name: 'de-DE', englishName: 'German (Germany)' },
  { name: 'fr-FR', englishName: 'French (France)' },
  { name: 'nl-NL', englishName: 'Dutch (Netherlands)' },
  { name: 'sv-SE', englishName: 'Swedish (Sweden)' },
]

function createServerPort(config: BunbracoConfig): ServerPort {
  return {
    // Phase 6 derives this from migration state; until then the site is always up.
    status: () => ({ serverStatus: 'Run' }),
    configuration: () => ({
      allowPasswordReset: config.allowPasswordReset,
      versionCheckPeriod: config.versionCheckPeriod,
      allowLocalLogin: config.allowLocalLogin,
      umbracoCssPath: config.umbracoCssPath,
      signalR: { skipNegotiation: config.signalRSkipNegotiation },
    }),
    information: () => ({
      version: VERSION,
      assemblyVersion: VERSION,
      baseUtcOffset: '00:00:00',
      runtimeMode: config.development ? 'BackofficeDevelopment' : 'Production',
    }),
  }
}

function createManifestPort(
  paths: BackOfficePaths,
  appPluginsDir: string,
  omit: readonly string[],
): ManifestPort {
  return {
    list: (visibility) =>
      toResponseModels(
        collectManifests(paths, appPluginsDir, { omit }).all,
        paths.cacheBustHash,
        visibility,
      ),
  }
}

function createLocalizationPort(db: Db | undefined, files?: SchemaFileWriter): LocalizationPort {
  const repo = db ? new LanguageRepository(db) : undefined
  const fallback = [
    {
      isoCode: 'en-US',
      name: 'English (United States)',
      isDefault: true,
      isMandatory: true,
      fallbackIsoCode: null,
    },
  ]
  return {
    cultures: () => CULTURES,
    allLanguages: async () =>
      repo
        ? (await repo.all()).map((l) => ({
            isoCode: l.isoCode,
            name: l.cultureName,
            isDefault: l.isDefault,
            isMandatory: l.isMandatory,
            fallbackIsoCode: l.fallbackIsoCode,
          }))
        : fallback,
    async language(isoCode) {
      const found = repo ? await repo.byIso(isoCode) : undefined
      if (!found) return repo ? undefined : fallback.find((l) => l.isoCode === isoCode)
      return {
        isoCode: found.isoCode,
        name: found.cultureName,
        isDefault: found.isDefault,
        isMandatory: found.isMandatory,
        fallbackIsoCode: found.fallbackIsoCode,
      }
    },
    async saveLanguage(language) {
      if (!repo) return
      await repo.save({
        isoCode: language.isoCode,
        cultureName: language.name,
        isDefault: language.isDefault,
        isMandatory: language.isMandatory,
        fallbackIsoCode: language.fallbackIsoCode,
      })
      await files?.writeLanguages()
    },
    async deleteLanguage(isoCode) {
      if (!repo) return 'not-found'
      const result = await repo.delete(isoCode)
      if (result === 'deleted') await files?.writeLanguages()
      return result
    },
  }
}

function createCurrentUserPort(
  config: BunbracoConfig,
  db: Db | undefined,
  nodes: NodeLookup | undefined,
): CurrentUserPort {
  const languages = db ? new LanguageRepository(db) : undefined
  return {
    async get(principal: Principal) {
      // The verbs on every node a group sets explicitly, calculated as a check would
      const explicit = [...new Set(principal.groups.flatMap((g) => [...g.granular.keys()]))]
      const found = nodes && explicit.length > 0 ? await nodes.documents(explicit) : new Map()
      const permissions = explicit.flatMap((key) => {
        const node = found.get(key)
        return node
          ? [
              {
                $type: 'DocumentPermissionPresentationModel' as const,
                document: { id: key },
                verbs: [...permissionsForPath(principal.groups, node.chain)],
              },
            ]
          : []
      })
      const { document, media, element } = principal.startNodes
      return {
        id: principal.id,
        userName: principal.userName,
        name: principal.name,
        email: principal.email,
        isAdmin: principal.isAdmin,
        languageIsoCode: principal.languageIsoCode ?? config.defaultUiLanguage,
        documentStartNodeIds: document.keys.map((id) => ({ id })),
        hasDocumentRootAccess: document.root,
        mediaStartNodeIds: media.keys.map((id) => ({ id })),
        hasMediaRootAccess: media.root,
        elementStartNodeIds: element.keys.map((id) => ({ id })),
        hasElementRootAccess: element.root,
        avatarUrls: principal.avatarUrls,
        languages:
          principal.hasAccessToAllLanguages && languages
            ? (await languages.all()).map((l) => l.isoCode)
            : principal.languages,
        hasAccessToAllLanguages: principal.hasAccessToAllLanguages,
        hasAccessToSensitiveData: hasAccessToSensitiveData(principal.groups),
        fallbackPermissions: principal.permissions,
        permissions,
        allowedSections: principal.allowedSections,
        userGroupIds: principal.groupKeys.map((id) => ({ id })),
      }
    },
  }
}

function createUserItemPort(db: Db): UserItemPort {
  const users = new UserRepository(db)
  return {
    async items(keys) {
      return (await users.byKeys(keys)).map((user) => ({
        key: user.key,
        name: user.name,
        avatarUrls: avatarUrls(user.avatar),
        kind: user.kind,
      }))
    },
  }
}

/** Development's stand-in for e-mail: the link a person would have been sent, on the console. */
const logUserLink: UserLinkSender = async ({ kind, to, link }) => {
  logger('users').info(
    `${kind === 'invite' ? 'Invitation' : 'Password reset'} for {email}: {link}`,
    {
      email: to.email,
      link,
    },
  )
}

/** Where the backoffice writes schema files, and whether it may. */
function schemaFiles(config: BunbracoConfig): SchemaFiles {
  const store = config.schemaStore
  return {
    schemaDir: config.schemaDir,
    writable: config.schemaWritable,
    templateAliases: () => templateAliasesIn(config.viewsDir),
    // Only when a store is configured: a schema directory in a repository is
    // already where the files durably live.
    onChanged: store
      ? async () => {
          const report = await publishSchema(store, config.schemaDir)
          if (report.written.length > 0 || report.removed.length > 0) {
            logger('schema').info(
              'Published schema to {store}: {written} written, {removed} removed',
              {
                store: store.description,
                written: report.written.length,
                removed: report.removed.length,
              },
            )
          }
        }
      : undefined,
  }
}

export interface DepsOptions {
  config: BunbracoConfig
  paths: BackOfficePaths
  appPluginsDir: string
  /** Omitted only by tests that exercise the contract without a database. */
  db?: Db
  /** Required alongside `db` to serve documents, which invalidate the cache. */
  cache?: PublishedCache
  schema?: SchemaBoot
  /** Uploaded files; one is made on `config.mediaDir` when omitted. */
  mediaFiles?: MediaFileStore
  /** How oEmbed providers are reached; the global fetch unless a test supplies one. */
  fetch?: typeof fetch
  /**
   * A template was written or removed here. The server takes a new snapshot and
   * tells the other nodes to look; without it they keep the view they imported.
   */
  onViewsChange?: (alias: string) => void | Promise<void>
}

function createTemporaryFilePort(files: MediaFileStore): TemporaryFilePort {
  return {
    async save(id, file) {
      if (!isUploadAllowed(file.name, DEFAULT_UPLOAD_SETTINGS))
        return { ok: false, reason: `Files of this type may not be uploaded: '${file.name}'.` }
      if (
        DEFAULT_UPLOAD_SETTINGS.maxFileSize !== null &&
        file.size > DEFAULT_UPLOAD_SETTINGS.maxFileSize
      )
        return { ok: false, reason: 'The file is larger than uploads may be.' }
      const saved = await files.saveTemporary(id, file)
      return { ok: true, file: saved }
    },
    get: (id) => files.temporary(id),
    read: (id) => files.readTemporary(id),
    remove: async (id) => files.deleteTemporary(id),
  }
}

export function createDeps(options: DepsOptions): ManagementApiDeps {
  const deps: ManagementApiDeps = {
    server: createServerPort(options.config),
    // An unconfigured assistant contributes no extension, so the backoffice has
    // no drawer, no button and nothing to load.
    manifests: createManifestPort(
      options.paths,
      options.appPluginsDir,
      options.config.assistant ? [] : [ASSISTANT_MANIFEST_ID],
    ),
    localization: createLocalizationPort(
      options.db,
      options.db ? createSchemaFileWriter(options.db, schemaFiles(options.config)) : undefined,
    ),
    currentUser: createCurrentUserPort(
      options.config,
      options.db,
      options.db ? createNodeLookup(options.db) : undefined,
    ),
  }
  const mediaFiles =
    options.mediaFiles ?? new MediaFileStore(options.config.mediaStore ?? options.config.mediaDir)
  deps.temporaryFiles = createTemporaryFilePort(mediaFiles)
  const valueIntake = createFileIntake(mediaFiles)
  deps.oembed = createOEmbedService(options.fetch)
  // Umbraco's places: ~/Views/Partials, ~/css and ~/scripts
  deps.partialViews = createFileSystemPort(join(options.config.viewsDir, 'Partials'), {
    extension: '.tsx',
    rewrites: ['.cshtml'],
  })
  deps.partialViewSnippets = PARTIAL_VIEW_SNIPPETS
  deps.stylesheets = createFileSystemPort(options.config.stylesheetsDir, { extension: '.css' })
  deps.scripts = createFileSystemPort(options.config.scriptsDir, { extension: '.js' })
  if (options.db) {
    const tags = new TagRepository(options.db)
    deps.tags = { list: (filter) => tags.all(filter) }
    deps.users = createUserItemPort(options.db)
    const store = new AuthStore(options.db)
    const userPorts = createUserPorts(options.db, {
      config: {
        ...options.config,
        sendUserLink:
          options.config.sendUserLink === undefined
            ? options.config.development
              ? logUserLink
              : undefined
            : (options.config.sendUserLink ?? undefined),
      },
      mediaFiles,
      nodes: createNodeLookup(options.db),
      endSessions: async (userId) => {
        await store.endAllSessionsForUser(userId)
      },
    })
    deps.userManagement = userPorts.users
    deps.userGroups = userPorts.groups
    deps.userData = userPorts.userData
    deps.media = createMediaPort(options.db, mediaFiles, {
      nodeState: options.schema?.nodeState,
      nodeId: options.schema?.nodeId,
      valueIntake,
      onChange: () => options.cache?.invalidate(),
    })
    deps.blueprints = createBlueprintPort(options.db, {
      nodeState: options.schema?.nodeState,
      valueIntake,
    })
    deps.contentTypes = createContentTypePort(options.db, schemaFiles(options.config), {
      nodeState: options.schema?.nodeState,
      templateFiles: createTemplateFileStore(options.config.viewsDir, options.onViewsChange),
    })
    deps.mediaTypes = createContentTypePort(options.db, schemaFiles(options.config), {
      nodeState: options.schema?.nodeState,
      kind: 'media',
    })
    deps.memberTypes = createContentTypePort(options.db, schemaFiles(options.config), {
      nodeState: options.schema?.nodeState,
      kind: 'member',
    })
    deps.dataTypes = createDataTypePort(options.db, schemaFiles(options.config))
    deps.templates = createTemplatePort(
      options.db,
      createTemplateFileStore(options.config.viewsDir, options.onViewsChange),
    )
    deps.logViewer = createLogViewerPort(options.db, options.config)
    deps.modelsBuilder = createModelsBuilderPort(options.config)
    deps.memberGroups = createMemberGroupPort(options.db)
    deps.members = createMemberPort(options.db, {
      nodeState: options.schema?.nodeState,
      nodeId: options.schema?.nodeId,
      valueIntake,
    })
    deps.publicAccess = createPublicAccessPort(options.db, {
      onChange: () => options.cache?.invalidate(),
    })
    deps.elements = createElementPort(options.db, {
      nodeState: options.schema?.nodeState,
      nodeId: options.schema?.nodeId,
      valueIntake,
      onChange: () => options.cache?.invalidate(),
    })
    deps.references = createReferencePort(options.db)
    deps.redirects = createRedirectPort(options.db, options.cache, {
      isTracking: options.config.trackRedirects,
      onChange: () => options.cache?.invalidate(),
    })
    if (options.cache) {
      const cache = options.cache
      deps.publishedCache = {
        reload: () => cache.invalidate(),
        rebuild: async () => {
          cache.invalidate()
          await cache.snapshot()
        },
        isRebuilding: () => false,
      }
    }
    deps.dictionary = createDictionaryPort(options.db, mediaFiles, {
      onChange: () => options.cache?.invalidate(),
    })
    if (options.cache)
      deps.documents = createDocumentPort(
        options.db,
        options.cache,
        {
          nodeState: options.schema?.nodeState,
          nodeId: options.schema?.nodeId,
          valueIntake,
        },
        createRedirectTracker({
          cache: options.cache,
          redirects: new RedirectRepository(options.db),
          enabled: options.config.trackRedirects,
        }),
        options.config.siteDir,
      )
  }
  return deps
}
