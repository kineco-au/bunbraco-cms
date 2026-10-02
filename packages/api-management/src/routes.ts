/**
 * Composition root for the Management API. Handlers are registered here as they
 * are implemented; every other operation in the contract answers 501.
 */
import { registerContentTypeHandlers } from './handlers/content-type.ts'
import { registerDataTypeHandlers } from './handlers/data-type.ts'
import { registerDictionaryHandlers } from './handlers/dictionary.ts'
import { registerDocumentHandlers } from './handlers/document.ts'
import { registerDocumentBlueprintHandlers } from './handlers/document-blueprint.ts'
import { registerEditorServiceHandlers } from './handlers/editor-services.ts'
import { registerElementHandlers } from './handlers/element.ts'
import { registerFileSystemHandlers } from './handlers/file-systems.ts'
import { registerImportHandlers } from './handlers/import.ts'
import { registerLocalizationHandlers } from './handlers/localization.ts'
import { registerLogViewerHandlers } from './handlers/log-viewer.ts'
import { registerManifestHandlers } from './handlers/manifest.ts'
import { registerMediaHandlers } from './handlers/media.ts'
import { registerMemberHandlers } from './handlers/member.ts'
import { registerMemberGroupHandlers } from './handlers/member-group.ts'
import { registerModelsBuilderHandlers } from './handlers/models-builder.ts'
import { registerPublicAccessHandlers } from './handlers/public-access.ts'
import { registerPublishedCacheHandlers } from './handlers/published-cache.ts'
import { registerRedirectHandlers } from './handlers/redirects.ts'
import { registerReferenceHandlers } from './handlers/references.ts'
import { registerServerHandlers } from './handlers/server.ts'
import { registerSettingsStubHandlers } from './handlers/settings-stubs.ts'
import { registerTemplateHandlers } from './handlers/template.ts'
import { registerTemporaryFileHandlers } from './handlers/temporary-file.ts'
import { registerUserHandlers } from './handlers/user.ts'
import type { ManagementApiDeps } from './ports.ts'
import { type Authenticator, ManagementApiRouter, type RouterOptions } from './router.ts'

export interface ManagementApiOptions {
  deps?: ManagementApiDeps
  authenticate?: Authenticator
  onNotImplemented?: RouterOptions['onNotImplemented']
  onServerEvent?: RouterOptions['onServerEvent']
  nodes?: RouterOptions['nodes']
  allowLocalLogin?: boolean
}

export function createManagementApiRouter(options: ManagementApiOptions = {}): ManagementApiRouter {
  const router = new ManagementApiRouter({
    authenticate: options.authenticate,
    onNotImplemented: options.onNotImplemented,
    onServerEvent: options.onServerEvent,
    nodes: options.nodes,
    allowLocalLogin: options.allowLocalLogin,
  })
  const { deps } = options
  if (!deps) return router

  registerServerHandlers(router, deps.server)
  registerManifestHandlers(router, deps.manifests)
  registerLocalizationHandlers(router, deps.localization)
  registerUserHandlers(router, deps.currentUser, deps.users, {
    users: deps.userManagement,
    groups: deps.userGroups,
    userData: deps.userData,
  })
  registerSettingsStubHandlers(router)
  if (deps.contentTypes)
    registerContentTypeHandlers(router, deps.contentTypes, 'document', deps.temporaryFiles)
  if (deps.mediaTypes)
    registerContentTypeHandlers(router, deps.mediaTypes, 'media', deps.temporaryFiles)
  if (deps.memberTypes)
    registerContentTypeHandlers(router, deps.memberTypes, 'member', deps.temporaryFiles)
  if (deps.dataTypes) registerDataTypeHandlers(router, deps.dataTypes)
  if (deps.templates) registerTemplateHandlers(router, deps.templates)
  if (deps.documents) registerDocumentHandlers(router, deps.documents, deps.preview)
  if (deps.blueprints) registerDocumentBlueprintHandlers(router, deps.blueprints)
  if (deps.temporaryFiles) registerTemporaryFileHandlers(router, deps.temporaryFiles)
  if (deps.media) registerMediaHandlers(router, deps.media)
  if (deps.dictionary) registerDictionaryHandlers(router, deps.dictionary)
  if (deps.partialViews)
    registerFileSystemHandlers(router, 'PartialView', deps.partialViews, deps.partialViewSnippets)
  if (deps.stylesheets) registerFileSystemHandlers(router, 'Stylesheet', deps.stylesheets)
  if (deps.scripts) registerFileSystemHandlers(router, 'Script', deps.scripts)
  if (deps.logViewer) registerLogViewerHandlers(router, deps.logViewer)
  if (deps.modelsBuilder) registerModelsBuilderHandlers(router, deps.modelsBuilder)
  if (deps.publishedCache) registerPublishedCacheHandlers(router, deps.publishedCache)
  if (deps.temporaryFiles) registerImportHandlers(router, deps.temporaryFiles)
  if (deps.memberGroups) registerMemberGroupHandlers(router, deps.memberGroups)
  if (deps.members) registerMemberHandlers(router, deps.members)
  if (deps.publicAccess) registerPublicAccessHandlers(router, deps.publicAccess)
  if (deps.elements) registerElementHandlers(router, deps.elements, deps.references)
  if (deps.redirects) registerRedirectHandlers(router, deps.redirects)
  if (deps.references)
    for (const area of ['Document', 'Media', 'Member', 'Element'] as const)
      registerReferenceHandlers(router, area, deps.references)
  registerEditorServiceHandlers(router, { tags: deps.tags, oembed: deps.oembed })
  return router
}
