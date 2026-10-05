/**
 * The Bunbraco server.
 *
 * Route order matters and mirrors docs/01-architecture.md: static assets, the
 * non-contract security and branding endpoints, the contract-first Management
 * API, the SPA shells, then the front-end site.
 */

import { join } from 'node:path'
import { createManagementApiRouter, hasSection, type Principal } from '@bunbraco/api-management'
import {
  AuthService,
  AuthStore,
  cookieNames,
  createAuthRoutes,
  expireCookie,
  REDACTED,
  readCookie,
  serializeCookie,
} from '@bunbraco/auth'
import {
  collectManifests,
  createBackOfficePaths,
  createExtensionRegistry,
  isSpaRoute,
  renderBackOfficeShell,
  renderLoginShell,
  resolveGraphic,
  resolveLoginAsset,
  resolveStaticFile,
  serveStaticFile,
} from '@bunbraco/backoffice-host'
import {
  DEFAULT_UPLOAD_SETTINGS,
  FormPermissions,
  hasAccessToSensitiveData,
  localReturnUrl,
  MANAGEMENT_API_PREFIX,
  PREVIEW_HUB_PATH,
  SERVER_EVENT_HUB_PATH,
} from '@bunbraco/core'
import {
  appendCacheInstruction,
  type Db,
  FormEntryRepository,
  FormWorkflowRepository,
  RedirectRepository,
  readReport,
  type WritesPaused,
} from '@bunbraco/data'
import {
  contentForNode,
  DEVELOPMENT_LIMITS,
  FORM_SCRIPT,
  FORM_SCRIPT_PATH,
  FORM_SUBMIT_PATH,
  PublishedCache,
  Renderer,
  type SnapshotStatus,
  setFormTokenSigner,
  ViewSnapshots,
} from '@bunbraco/render'
import type { SyncReport } from '@bunbraco/schema'
import type { Server } from 'bun'
import { createNodeLookup, loadAccess } from './access.ts'
import { createPublishedContentSource, loadDraftNode } from './adapters/documents.ts'
import { createSchemaProposals } from './adapters/schema-proposals.ts'
import { createBundleRedirects, createServerBundles } from './bundles.ts'
import { type BunbracoConfig, loadConfig, type ServerRole, VERSION } from './config.ts'
import { attachDatabase, bootstrapDatabase } from './database.ts'
import { createDiagnostics } from './diagnostics.ts'
import { syncDomainsFile } from './domains.ts'
import { editorTypeLibs } from './editor-types.ts'
import { emailAvailability, resolveEmailPort } from './email.ts'
import { noticeAboutEmail } from './email-notice.ts'
import { warnAboutAppPlugins } from './extensions-notice.ts'
import { coerceForm, deleteForm, saveForm } from './form-files.ts'
import {
  createFormRegistry,
  FORM_FLASH_COOKIE,
  formSigningSecret,
  readFlash,
  signFormToken,
  submitForm,
  wantsJson,
  writeFlash,
} from './form-submit.ts'
import { createWorkflowRunner } from './form-workflows.ts'
import {
  entriesCsv,
  formDetail,
  formSummary,
  formsByKey,
  parseEntryState,
  redactSensitive,
} from './forms.ts'
import { ImageProcessor, parseImagingQuery } from './imaging.ts'
import { type BackgroundJobs, createBackgroundJobs } from './jobs.ts'
import { configureLogging, logger } from './logging.ts'
import { createMarketplace } from './marketplace.ts'
import { MediaFileStore } from './media-files.ts'
import { mediaStoreFromEnvironment } from './media-store.ts'
import { createMemberAuth, MEMBER_ROUTE_PREFIX } from './member-auth.ts'
import { noNodesPage } from './no-nodes.ts'
import { NotImplementedLog } from './not-implemented.ts'
import { createDeps, resolveUserLinkSender } from './ports.ts'
import { syncConfiguredRedirects } from './redirects.ts'
import {
  bootSchema,
  CacheInstructionPoller,
  importSchema,
  type SchemaBoot,
  watchSchema,
} from './schema.ts'
import { materialiseSchema, publishSchema, type SchemaStore } from './schema-store.ts'
import {
  combineHubs,
  createServerEventHub,
  type HubSocketData,
  type ServerEventHub,
} from './server-events.ts'
import { assertViewRuntime } from './view-runtime.ts'

const CONTRACT_PATH = Bun.resolveSync('@bunbraco/contracts/OpenApi.json', import.meta.dir)

export interface ServerHandle {
  config: BunbracoConfig
  fetch(request: Request): Promise<Response>
  /** Everything `Bun.serve` needs, the live-update WebSocket included. */
  serveOptions: {
    port: number
    maxRequestBodySize: number
    fetch(request: Request, server: Server<HubSocketData>): Promise<Response | undefined>
    websocket: ServerEventHub['websocket']
  }
  /** The live-update channel the backoffice holds open. */
  events: ServerEventHub
  paths: ReturnType<typeof createBackOfficePaths>
  db: Db
  auth: AuthService
  cache: PublishedCache
  renderer: Renderer
  /** The views generations this node has taken; `status()` is what /health reports. */
  snapshots: ViewSnapshots
  seededAdminPassword: string | undefined
  schema: SchemaBoot
  /** Applies cache instructions other nodes appended; the interval calls this too. */
  poll(): Promise<number>
  /** Development only: every operation the client asked for that answered 501, in first-seen order. */
  notImplemented: NotImplementedLog
  /**
   * What /health reports. Not ok once the database is ahead of a node that
   * serves the editor; a `web` node stays ok while behind until a contract has
   * run past it, because its reads stay correct until then.
   */
  health(): {
    ok: boolean
    readOnly: boolean
    /** Set while an operator has paused editing cluster-wide; drains nothing. */
    paused: WritesPaused | null
    version: string
    revision: string
    nodeId: string
    role: ServerRole
    /** The views generation in use, and whether newer ones are being refused. */
    views: SnapshotStatus
  }
  /** Scheduled publishing and version cleanup; each run can be called directly. */
  jobs: BackgroundJobs
  /** Stops the watcher and the poll, then closes the database. */
  close(): Promise<void>
}

/** Umbraco's preview cookie; with a signed-in editor it turns on draft rendering. */
export const PREVIEW_COOKIE = 'UMB_PREVIEW'

export async function createServer(config: BunbracoConfig = loadConfig()): Promise<ServerHandle> {
  configureLogging({
    logsDir: config.logsDir,
    level: config.logLevel,
    console: config.logToConsole,
  })
  const diagnostics = createDiagnostics(config.diagnostics)
  const log = logger('server')
  const schemaLog = logger('schema')
  const renderLog = logger('render')
  const redirectLog = logger('redirects')
  const bundleLog = (id: string) => {
    const named = logger('bundle', id)
    return {
      info: (message: string, properties?: Record<string, unknown>) =>
        named.info(message, properties),
      warn: (message: string, properties?: Record<string, unknown>) =>
        named.warn(message, properties),
      error: (message: string, properties?: Record<string, unknown>) =>
        named.error(message, properties),
    }
  }
  const domainLog = logger('domains')
  // Extensions are the site's own npm dependencies (`docs/17-bundles.md`).
  // Uncached in development so an author editing one sees a reload pick it up.
  const extensions = createExtensionRegistry(config.siteDir, { cache: !config.development })
  const marketplace = createMarketplace({
    registry: config.npmRegistry,
    keyword: config.packageKeyword,
    marketplaceUrl: config.marketplaceUrl,
    extensions,
    siteDir: config.siteDir,
  })
  const paths = createBackOfficePaths({ backOfficePath: config.backOfficePath })
  // Two questions, not one: what this process answers, and what it is
  // responsible for converging at boot. `all` and `api` are both owners; only
  // `all` and `web` serve the public site.
  const servesBackOffice = config.role !== 'web'
  const owns = config.role !== 'web'
  const { db, seededAdminPassword } = owns
    ? await bootstrapDatabase(config)
    : await attachDatabase(config)
  // A configured schema store is copied down before anything reads `schema/`, and
  // becomes the schema directory for this boot. Everything after here — loading,
  // validation, hashing, sync, the writer — works on files exactly as it always has.
  if (config.schemaStore) {
    const copied = await materialiseSchema(config.schemaStore, config.schemaCacheDir)
    config.schemaDir = config.schemaCacheDir
    schemaLog.info('Schema read from {store}: {count} files in {dir}', {
      store: config.schemaStore.description,
      count: copied.length,
      dir: config.schemaCacheDir,
    })
  }
  // A node that does not own the schema still loads it — the renderer needs the
  // property definitions — but writes none of it.
  const schema = await bootSchema(db, owns ? config : { ...config, syncSchemaAtBoot: false })

  const auth = new AuthService(new AuthStore(db))
  const cookies = { siteName: config.siteName, securePrefix: config.secureCookies }
  const names = cookieNames(cookies)
  const authRoutes = createAuthRoutes({
    backOfficePath: paths.backOfficePath,
    service: auth,
    cookies,
  })

  /**
   * Resolves the caller from the reference access token. The client sends
   * `Authorization: Bearer [redacted]`, so the cookie is the real source; a
   * non-browser client may still present a real bearer token.
   */
  async function authenticate(request: Request): Promise<Principal | undefined> {
    const header = request.headers.get('authorization')
    const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
    const token = bearer && bearer !== REDACTED ? bearer : readCookie(request, names.accessToken)
    if (!token) return undefined

    const identity = await auth.resolveAccessToken(token)
    if (!identity) return undefined
    return {
      id: identity.user.key,
      userName: identity.user.login,
      name: identity.user.userName,
      email: identity.user.email,
      isAdmin: identity.isAdmin,
      languageIsoCode: identity.user.language ?? undefined,
      avatarUrls: identity.user.avatar ? [identity.user.avatar] : [],
      allowedSections: identity.allowedSections,
      permissions: identity.permissions,
      groupKeys: identity.groupKeys,
      hasAccessToAllLanguages: identity.hasAccessToAllLanguages,
      ...(await loadAccess(db, identity.user.id)),
    }
  }

  // Form definitions are files, so they are re-read rather than cached with the
  // content: nothing about a publish tells this node that a form changed.
  const forms = createFormRegistry(config.schemaDir)
  // Every form this node renders carries a token signed with the site's key, so
  // the timing guard cannot be bypassed by posting a made-up render time.
  const formSecret = await formSigningSecret(db)
  setFormTokenSigner((formKey, renderedAt) => signFormToken(formSecret, formKey, renderedAt))
  const cache = new PublishedCache(
    createPublishedContentSource(db, { nodeState: schema.nodeState, nodeId: schema.nodeId }),
    { form: (key) => forms.byKey(key) },
  )
  // A snapshot of the views, so a template edited anywhere — the backoffice, a
  // deploy, a bucket synced underneath — is picked up without restarting this
  // node. `assertViewRuntime` first, because a cache directory the JSX runtime
  // cannot be resolved from fails every render rather than the boot.
  assertViewRuntime(config.viewsCacheDir)
  const snapshots = new ViewSnapshots({
    sourceDir: config.viewsDir,
    cacheDir: config.viewsCacheDir,
    limits: { ...(config.development ? DEVELOPMENT_LIMITS : {}), ...config.viewsSnapshot },
    onProblem: (message) => renderLog.error('{message}', { message }),
    // Only a change: every boot takes a generation, and saying so each time is
    // noise. The start banner names the one a node came up on.
    onSwap: (hash, previous) => {
      if (previous)
        renderLog.info('Views changed: generation {previous} to {hash}', {
          previous: previous.slice(0, 8),
          hash: hash.slice(0, 8),
        })
    },
  })
  await snapshots.prepare()
  // Before the poller, which tells it to look again on a `views` instruction
  // from another node: a closure over a `const` declared later would be a
  // temporal dead zone waiting for the first instruction to land.
  const renderer = new Renderer({ cache, viewsDir: config.viewsDir, snapshots })
  // The site's own redirects are code, so the database follows the file: rules it
  // no longer declares are removed, which is what makes deleting one from config
  // actually take effect.
  //
  // File-to-database convergence belongs to one node. Two of them racing would
  // each remove what the other had just written, so a `web` node reads these
  // rules through the cache and converges nothing.
  if (owns) {
    const configuredRedirects = await syncConfiguredRedirects(
      new RedirectRepository(db),
      config.redirects,
    )
    if (configuredRedirects.stored > 0 || configuredRedirects.removed > 0)
      redirectLog.info('Configured redirects: {stored} in force, {removed} removed', {
        stored: configuredRedirects.stored,
        removed: configuredRedirects.removed,
      })
    // The same bargain for hostnames, from `domains.toml`: the file is the truth,
    // so an entry deleted from it is unbound here. A site without the file is left
    // alone, which is every site that has never written one.
    const domains = await syncDomainsFile(db, config.siteDir)
    for (const problem of domains.problems) domainLog.warn('{problem}', { problem })
    if (domains.action === 'applied')
      domainLog.info('Domains from domains.toml: {applied} bound, {removed} removed', {
        applied: domains.applied.length,
        removed: domains.removed,
      })
  }
  /**
   * The server halves of the site's bundles, mounted only where the backoffice
   * is: these are backoffice endpoints, and a `web` node serves none of them.
   *
   * Capabilities are built here, from what this node already holds, so a bundle
   * is handed a narrow interface rather than the database. A bad bundle fails the
   * boot — see `createServerBundles`.
   */
  const bundles = servesBackOffice
    ? createServerBundles({
        bundles: config.bundles,
        pluginApiPath: `${paths.pluginPath}/api`,
        host: {
          redirects: createBundleRedirects({ db, cache }),
          documents: {
            url: async (key, culture) => {
              const content = await cache.byKey(key, culture ?? null)
              return content && content.url !== '#' ? content.url : undefined
            },
          },
          log: bundleLog('bundle'),
        },
        log: (id) => bundleLog(id),
      })
    : undefined
  for (const bundle of bundles?.mounted ?? [])
    log.info('Bundle {name} answering below {prefix} for the {section} section', {
      name: bundle.name,
      prefix: bundle.prefix,
      section: bundle.section,
    })

  const poller = new CacheInstructionPoller({
    db,
    nodeId: schema.nodeId,
    nodeState: schema.nodeState,
    role: config.role,
    // `schema` and `content` change what renders: schema alters property
    // definitions. `views` changes the code that renders it, which is a new
    // snapshot rather than anything in the published cache.
    onInstruction: (kind, payload) => {
      if (kind !== 'views') return cache.invalidate()
      // The hash only says when to stop looking eagerly; the snapshot is always
      // of the bytes this node reads, so a superseded one is harmless.
      snapshots.announce(typeof payload.hash === 'string' ? payload.hash : undefined)
    },
  })
  await poller.start(config.development ? 2_000 : 5_000)
  const watcher =
    config.development && owns
      ? watchSchema(
          db,
          config,
          { nodeId: schema.nodeId, revision: config.schemaRevision },
          (report: SyncReport) => {
            cache.invalidate()
            if (report.action === 'refused')
              schemaLog.error('Schema change refused: {reason}', {
                reason:
                  report.reason ?? report.problems.map((p) => `${p.file}: ${p.message}`).join('; '),
              })
            else if (report.action === 'applied') {
              // Move this node on with the database it has just synced. The
              // repositories hold `schema.nodeState`, and `assertNodeMayWrite`
              // refuses a write from a node behind the database — so without
              // this, a schema change made through this server's own API (the
              // backoffice creating a type, which bumps `schema.toml` and lands
              // here through the watcher) leaves every later write refused until
              // the process restarts. `importSchema` already does the same for
              // the path it owns.
              if (report.state?.version) schema.nodeState.version = report.state.version
              schemaLog.info('Schema {version} applied', { version: report.state?.version ?? '' })
            }
          },
        )
      : undefined
  const members = createMemberAuth(db, config, {
    nodeState: schema.nodeState,
    nodeId: schema.nodeId,
  })

  const notImplementedLog = logger('not-implemented')
  const notImplemented = new NotImplementedLog((line, entry) => {
    // The console line is the development aid; the file keeps it for the log viewer
    console.warn(line)
    notImplementedLog.warning('Operation {operationId} ({method} {path}) is not implemented', {
      ...entry,
    })
  })
  const previewPort = {
    enter: () => [
      serializeCookie({ name: PREVIEW_COOKIE, value: 'preview', secure: config.secureCookies }),
    ],
    exit: () => [expireCookie(PREVIEW_COOKIE, config.secureCookies)],
  }
  // The site's config may name a store; without one the environment decides,
  // and that falls back to the media directory on this disk.
  const mediaStore = config.mediaStore ?? (await mediaStoreFromEnvironment(config.mediaDir))
  // Resolved once: constructing it twice would warn twice about a provider that
  // is half-configured, and the adapters are cheap but not free of side effects.
  const email = resolveEmailPort(config)
  const emailStatus = emailAvailability(email)
  // Whether an invitation or a reset link can reach anyone at all, which is what
  // gates the options rather than `emailStatus.available`: development delivers
  // to the console, and that is a working flow for the person using it.
  const canSendUserLinks = Boolean(resolveUserLinkSender(config, email))
  const mediaFiles = new MediaFileStore(mediaStore)
  const images = new ImageProcessor(mediaStore)
  const api = createManagementApiRouter({
    deps: {
      ...createDeps({
        config,
        paths,
        extensions,
        db,
        cache,
        schema,
        mediaFiles,
        email,
        // This node looks again at once; the others are told to. The write has
        // already landed wherever `viewsDir` points, so there is nothing to
        // distribute — only the fact that it happened.
        onViewsChange: async (alias) => {
          // The snapshot first, and awaited: the hash announced is then the one
          // this write produced rather than the generation it replaced, and the
          // editor's next request renders what they just saved.
          const hash = await snapshots.refresh()
          void appendCacheInstruction(db, {
            kind: 'views',
            payload: hash ? { alias, hash } : { alias },
            by: schema.nodeId,
          }).catch((error: unknown) => {
            renderLog.error('Could not announce the template {alias}: {error}', { alias, error })
          })
        },
      }),
      preview: previewPort,
    },
    authenticate,
    nodes: createNodeLookup(db),
    allowLocalLogin: config.allowLocalLogin,
    onNotImplemented: config.development
      ? (operation, request) => notImplemented.record(operation, request)
      : undefined,
    onServerEvent: (event) => {
      events.broadcast('notify', [event])
      // An open preview of the document reloads when it changes.
      if (event.eventSource === 'Umbraco:CMS:Document' && event.eventType !== 'Deleted')
        previewHub.broadcast('refreshed', [event.key])
    },
  })

  // Fixed by the contract and the client's SDK, wherever the editor is mounted.
  const apiPrefix = MANAGEMENT_API_PREFIX

  const health = () => {
    const paused = poller.paused
    const readOnly = schema.compatibilityMode || poller.behind || paused !== undefined
    // A `web` node behind the database still answers its readers correctly,
    // as-of its own state, until a contract removes something it reads. Draining
    // it any earlier would drain every renderer the moment an upgrade cuts over —
    // before a single new node can boot — and readers would see the gap. A node
    // that serves the editor drains as soon as it is behind, so editors land on
    // a node that can save. A pause drains nothing: it is for editors to see.
    const serving =
      !schema.compatibilityMode && (config.role === 'web' ? !poller.readsUnsafe : !poller.behind)
    return {
      // A frozen views snapshot deliberately does not make this false. Draining
      // every node because they are all serving a slightly old template would
      // turn a stale view into an outage; the `views` block below is what says
      // so, and restarting the node clears it.
      ok: serving,
      readOnly,
      paused: paused ?? null,
      version: schema.nodeState.version,
      revision: schema.nodeState.revision,
      nodeId: schema.nodeId,
      role: config.role,
      views: snapshots.status(),
    }
  }

  const events = createServerEventHub()
  const previewHub = createServerEventHub({ name: 'PreviewHub' })
  const jobs = createBackgroundJobs({
    db,
    cache,
    nodeState: schema.nodeState,
    nodeId: schema.nodeId,
    versionCleanup: config.versionCleanup,
    mediaFiles,
    // The workflow queue drains here rather than in the request: a submission is
    // stored first, and an e-mail that cannot be sent yet must not cost it.
    formWorkflows: createWorkflowRunner({
      db,
      forms,
      email,
      mediaFiles,
      nodeState: schema.nodeState,
      nodeId: schema.nodeId,
      onContentChanged: () => cache.invalidate(),
    }),
    onDocumentChanged: (key) =>
      events.broadcast('notify', [
        { eventSource: 'Umbraco:CMS:Document', eventType: 'Updated', key },
      ]),
  })
  // Scheduled publishing and version cleanup are writes on a timer. Running them
  // on every node would have two processes publishing the same document in the
  // same second, so only an owner starts them.
  if (owns) jobs.start()
  log.info('Bunbraco {version} started on node {nodeId} as {role}', {
    version: VERSION,
    nodeId: schema.nodeId,
    role: config.role,
  })
  // App_Plugins is gone (`docs/17-bundles.md`). Saying so beats a site whose
  // extensions silently stopped loading after an upgrade; remove at 1.0.
  warnAboutAppPlugins(config.siteDir, log)
  noticeAboutEmail(emailStatus, logger('email'), { development: config.development })
  const hubPath = SERVER_EVENT_HUB_PATH
  const previewHubPath = PREVIEW_HUB_PATH

  // Imported only when the feature is configured, so an unconfigured site never
  // loads the assistant, its provider or its tool definitions.
  const assistantPath = `${paths.pluginPath}/api/assistant`
  const assistant =
    config.assistant && servesBackOffice
      ? await import('./assistant.ts').then((module) =>
          module.createAssistantHost({
            config: config.assistant as NonNullable<typeof config.assistant>,
            db,
            schema: createSchemaProposals({ db, config, boot: schema }),
            siteName: config.siteName,
            version: VERSION,
            dispatch: (inner) => api.dispatch(inner),
          }),
        )
      : undefined
  if (assistant) {
    log.info('Assistant enabled with {provider}{mcp}', {
      provider: config.assistant?.provider.name,
      mcp: config.assistant?.mcp === true ? ', MCP endpoint served' : '',
    })
    // Checked once at boot so an expired SSO session is reported here rather than
    // as a failed message later. Never awaited into the boot path: the assistant
    // is optional and the site must come up either way.
    void assistant.status(true).then((status) => {
      if (status.ok) {
        log.info('Assistant credentials resolved: {detail}{expires}', {
          detail: status.detail,
          expires: status.expires ? `, expiring ${status.expires}` : '',
        })
      } else {
        log.warning('Assistant cannot reach its model: {detail} {remedy}', {
          detail: status.detail,
          remedy: status.remedy ?? '',
        })
      }
    })
  }

  // Imported only when configured, like the assistant: an unconfigured site has no
  // git route and no credentials anywhere near it.
  const gitPath = `${paths.pluginPath}/api/git`
  const git =
    config.git && servesBackOffice
      ? await import('./git-routes.ts').then((module) =>
          module.createGitHost({
            config: config.git as NonNullable<typeof config.git>,
            schemaDir: config.schemaDir,
            siteName: config.siteName,
          }),
        )
      : undefined
  if (git) {
    log.info('Source control enabled: {provider} on {branch}', {
      provider: config.git?.provider.description,
      branch: config.git?.provider.branch,
    })
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url

    // Non-contract, unauthenticated: a load balancer drains a node that has fallen behind.
    if (pathname === '/health') {
      const status = health()
      return Response.json(status, { status: status.ok ? 200 : 503 })
    }

    // Everything the editor talks to, answered only by a node that serves it. A
    // `web` node falls straight through to the public site, so the backoffice,
    // the Management API and the sign-in routes are not merely unauthorised
    // there — they are not routes at all, and 404 like any other unknown path.
    if (servesBackOffice) {
      const response = await serveBackOffice(request, url)
      if (response) return response
    }

    if (pathname.startsWith(`${MEMBER_ROUTE_PREFIX}/`)) {
      const response = await members.handle(request, pathname)
      if (response) return response
    }

    // The progressive-enhancement script. A site adds it to a layout; a form
    // works without it, so nothing emits it automatically.
    if (pathname === FORM_SCRIPT_PATH)
      return new Response(FORM_SCRIPT, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': config.development ? 'no-cache' : 'public, max-age=3600',
        },
      })

    // A visitor posting a form. Before the renderer, which would otherwise try
    // to resolve `/bunbraco/forms/...` as a page.
    if (pathname.startsWith(`${FORM_SUBMIT_PATH}/`))
      return request.method === 'POST'
        ? submitFormRoute(request, pathname)
        : new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } })

    if (pathname.startsWith('/media/')) return serveMedia(pathname, url.searchParams)
    if (pathname.startsWith('/css/')) return serveSiteFile(config.stylesheetsDir, pathname, '.css')
    if (pathname.startsWith('/scripts/')) return serveSiteFile(config.scriptsDir, pathname, '.js')
    return renderSite(request, pathname, url.host)
  }

  /**
   * The backoffice, the Management API and everything that serves an editor.
   *
   * Ordering within this function is load-bearing — `authRoutes` intercepts the
   * security paths before the generic API dispatch — but its position relative
   * to the member routes is not: `/umbraco/members` collides with neither the
   * management prefix, the SPA route list, nor the auth prefix.
   */
  async function serveBackOffice(request: Request, url: URL): Promise<Response | undefined> {
    const { pathname } = url

    // Non-contract, signed-in: the assistant's chat, review and MCP endpoints.
    // Absent configuration there is no `assistant`, so these paths 404 like any
    // other unknown route.
    if (assistant && pathname.startsWith(`${assistantPath}/`)) {
      const principal = await authenticate(request)
      if (!principal) return new Response('Unauthorized', { status: 401 })
      const response = await assistant.handle(
        request,
        pathname.slice(assistantPath.length),
        principal,
      )
      if (response) return response
    }

    // Non-contract, Settings: what the repository has against what this site has.
    // Settings and not merely signed in, because the diff is the schema's full
    // text and a commit pushes it under this site's credentials — the same
    // authority `authorization.ts` demands for changing a type in the first place.
    if (git && pathname.startsWith(`${gitPath}/`)) {
      const principal = await authenticate(request)
      if (!principal) return new Response('Unauthorized', { status: 401 })
      if (!hasSection(principal, 'settings')) return new Response('Forbidden', { status: 403 })
      const response = await git.handle(request, pathname.slice(gitPath.length), principal)
      if (response) return response
    }

    // Non-contract, signed-in: import the schema files into this database. A GET
    // asks what would happen and changes nothing; a POST applies it. Never
    // automatic — see `importSchema`.
    if (pathname === `${paths.pluginPath}/api/schema-import`) {
      const principal = await authenticate(request)
      if (!principal) return new Response('Unauthorized', { status: 401 })
      // Settings: this applies type changes to the database, which is what every
      // `document-type` write requires, and what the assistant asks of a schema
      // proposal before it writes one.
      if (!hasSection(principal, 'settings')) return new Response('Forbidden', { status: 403 })
      if (request.method !== 'GET' && request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 })
      }
      const dryRun = request.method === 'GET'
      const result = await importSchema(db, config, schema, { dryRun })
      if (!dryRun) {
        log.info('{user} imported the schema: {action}, {classification}', {
          user: principal.userName,
          action: result.report?.action ?? 'nothing to do',
          classification: result.classification,
        })
      }
      return Response.json({
        dryRun,
        classification: result.classification,
        materialised: result.materialised,
        action: result.report?.action,
        reason: result.report?.reason,
        findings: result.findings,
        state: { version: schema.nodeState.version, revision: schema.nodeState.revision },
      })
    }

    // Non-contract, signed-in: the declarations the view editor type-checks a
    // template against — `@bunbraco/render`'s own sources and the schema's
    // generated content types.
    //
    // Signed in and not Settings, although only Settings can open a template:
    // this is the same vocabulary of type and property aliases that the content
    // editor in front of every backoffice user already shows them, and the
    // assistant's review pane loads a template for anyone who may use it.
    if (pathname === `${paths.pluginPath}/api/editor-types`) {
      const principal = await authenticate(request)
      if (!principal) return new Response('Unauthorized', { status: 401 })
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
      return Response.json(
        { libs: await editorTypeLibs({ schemaDir: config.schemaDir }) },
        // The generated types follow the schema, which a colleague may have
        // changed since this tab was opened.
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    /**
     * A bundle's own endpoints, below `api/bundle/<id>/`.
     *
     * Authentication happens here and authorisation happens in the registry
     * against the section the bundle declared, so a bundle never sees an
     * anonymous request and cannot widen its own access. `undefined` means no
     * bundle claims the path, which falls through to the 404 below.
     */
    if (bundles && pathname.startsWith(bundles.basePath)) {
      const principal = await authenticate(request)
      if (!principal) return new Response('Unauthorized', { status: 401 })
      const answered = await bundles.handle(request, url, principal)
      if (answered) return answered
    }

    /**
     * Non-contract: the Packages section's marketplace, installed list and
     * install. There is no operation in the contract for any of it — Umbraco's
     * marketplace is an iframe — so this is ours, and it answers to the
     * Packages section exactly as the operations beside it would.
     */
    if (pathname.startsWith(`${paths.pluginPath}/api/bundles/`)) {
      const principal = await authenticate(request)
      if (!principal) return new Response('Unauthorized', { status: 401 })
      if (!hasSection(principal, 'packages')) return new Response('Forbidden', { status: 403 })
      const action = pathname.slice(`${paths.pluginPath}/api/bundles/`.length)

      if (action === 'marketplace' && request.method === 'GET') {
        return Response.json({
          url: marketplace.url(),
          keyword: config.packageKeyword,
          items: await marketplace.search(url.searchParams.get('q') ?? undefined),
        })
      }

      if (action === 'installed' && request.method === 'GET') {
        return Response.json({ items: marketplace.installed() })
      }

      if ((action === 'install' || action === 'uninstall') && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
          name?: unknown
          version?: unknown
        }
        const name = typeof body.name === 'string' ? body.name : ''
        const version = typeof body.version === 'string' ? body.version : undefined
        const outcome =
          action === 'install'
            ? await marketplace.install(name, version)
            : await marketplace.uninstall(name)
        log.info('{user} {action} the package {name}: {outcome}', {
          user: principal.email,
          action: action === 'install' ? 'installed' : 'removed',
          name,
          outcome: outcome.ok ? 'ok' : outcome.message,
        })
        return Response.json(outcome, { status: outcome.ok ? 200 : 400 })
      }

      return new Response('Not Found', { status: 404 })
    }

    /**
     * Non-contract: whether this site can send e-mail, and what is unavailable
     * because it cannot.
     *
     * Any signed-in user may ask, because the features it gates are spread
     * across sections — invitations live in Users, the explanation belongs
     * wherever someone finds the option missing. The provider's `description`
     * is deliberately left out: for a custom adapter it is an internal URL.
     */
    if (pathname === `${paths.pluginPath}/api/email` && request.method === 'GET') {
      if (!(await authenticate(request))) return new Response('Unauthorized', { status: 401 })
      return Response.json({
        available: emailStatus.available,
        provider: emailStatus.provider,
        reason: emailStatus.reason,
        affects: emailStatus.affects,
        canSendUserLinks,
      })
    }

    /**
     * Non-contract: forms and their entries. There is no form operation in the
     * vendored contract — Umbraco Forms ships its own API and its own client,
     * and neither is here — so this is ours (`docs/18-forms.md`).
     *
     * Definitions are read from `schema/` per request rather than cached: the
     * files are the truth, the backoffice may have just rewritten one, and a
     * picker that disagreed with what a render uses would be worse than slow.
     */
    if (pathname.startsWith(`${paths.pluginPath}/api/forms`)) {
      const principal = await authenticate(request)
      if (!principal) return new Response('Unauthorized', { status: 401 })
      const action = pathname.slice(`${paths.pluginPath}/api/forms`.length).replace(/^\//, '')
      // Through the registry the renderer uses, so the designer and a render
      // cannot disagree; a save invalidates it rather than waiting out the memo.
      const definitions = forms.all()

      // A definition is structure, like a document type: anyone who may open the
      // section may read it, and the picker needs it in the Content section too.
      if (action === '' && request.method === 'GET')
        return Response.json({ items: definitions.map(formSummary) })

      const entries = new FormEntryRepository(db)
      const byKey = formsByKey(definitions)
      // Submissions are personal data, so reading them asks for more than a
      // session. Four verbs, because designing a form and reading what people
      // sent it are different jobs (`docs/18-forms.md`).
      const may = (verb: string) => principal.isAdmin || principal.permissions.includes(verb)
      const formFiles = {
        schemaDir: config.schemaDir,
        writable: config.schemaWritable,
        onChanged: config.schemaStore
          ? async () => {
              await publishSchema(config.schemaStore as SchemaStore, config.schemaDir)
            }
          : undefined,
      }
      const maySeeEntries = may(FormPermissions.EntriesView)
      const mayManageEntries = may(FormPermissions.EntriesManage)
      // The group alias still counts: `sensitiveData` is how Umbraco carries
      // this and how members already work, so both routes to it are honoured.
      const maySeeSensitive =
        may(FormPermissions.EntriesSensitive) || hasAccessToSensitiveData(principal.groups)

      const entryMatch = /^entries\/([^/]+)(?:\/(state))?$/.exec(action)
      if (entryMatch) {
        if (!maySeeEntries) return new Response('Forbidden', { status: 403 })
        const id = decodeURIComponent(entryMatch[1] as string)
        if (entryMatch[2] === 'state' && request.method === 'POST') {
          if (!mayManageEntries) return new Response('Forbidden', { status: 403 })
          const body = (await request.json().catch(() => ({}))) as { state?: unknown }
          const next = parseEntryState(typeof body.state === 'string' ? body.state : null)
          if (!next) return new Response('Bad Request', { status: 400 })
          const updated = await entries.setState(id, next)
          if (!updated) return new Response('Not Found', { status: 404 })
          // Approval is the other trigger: a workflow declared `on = "approve"`
          // runs now, from the values the entry holds.
          if (next === 'approved') {
            const form = byKey.get(updated.formKey)
            const onApprove = form?.workflows.filter((workflow) => workflow.on === 'approve') ?? []
            if (onApprove.length > 0)
              await new FormWorkflowRepository(db).enqueue(
                onApprove.map((workflow) => ({
                  formKey: updated.formKey,
                  formAlias: updated.formAlias,
                  workflowName: workflow.name,
                  workflowType: workflow.type,
                  runOn: workflow.on,
                  entryId: updated.id,
                  payload: updated.values.map((value) => ({
                    fieldAlias: value.fieldAlias,
                    values: value.values,
                  })),
                })),
              )
          }
          log.info('{user} set form entry {id} to {state}', {
            user: principal.email,
            id,
            state: next,
          })
          return Response.json({ id: updated.id, state: updated.state })
        }
        if (request.method === 'DELETE') {
          if (!mayManageEntries) return new Response('Forbidden', { status: 403 })
          if (!(await entries.remove(id))) return new Response('Not Found', { status: 404 })
          log.info('{user} deleted form entry {id}', { user: principal.email, id })
          return new Response(null, { status: 200 })
        }
        if (request.method === 'GET') {
          const entry = await entries.byId(id)
          if (!entry) return new Response('Not Found', { status: 404 })
          return Response.json({
            ...entry,
            values: redactSensitive(entry, byKey.get(entry.formKey), maySeeSensitive),
          })
        }
        return new Response('Method Not Allowed', { status: 405 })
      }

      const csvMatch = /^([^/]+)\/entries\.csv$/.exec(action)
      if (csvMatch && request.method === 'GET') {
        if (!maySeeEntries) return new Response('Forbidden', { status: 403 })
        const key = decodeURIComponent(csvMatch[1] as string)
        const form = byKey.get(key)
        if (!form) return new Response('Not Found', { status: 404 })
        const page = await entries.list({ formKey: key, take: 10_000 })
        const result = entriesCsv(form, page.items, { includeSensitive: maySeeSensitive })
        if (!result.ok)
          return new Response(result.reason, {
            status: 403,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
        return new Response(result.csv, {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${result.fileName}"`,
          },
        })
      }

      const listMatch = /^([^/]+)\/entries$/.exec(action)
      if (listMatch && request.method === 'GET') {
        if (!maySeeEntries) return new Response('Forbidden', { status: 403 })
        const key = decodeURIComponent(listMatch[1] as string)
        const since = url.searchParams.get('from')
        const until = url.searchParams.get('to')
        const page = await entries.list({
          formKey: key,
          state: parseEntryState(url.searchParams.get('state')),
          from: since ? new Date(since) : undefined,
          to: until ? new Date(until) : undefined,
          search: url.searchParams.get('search') ?? undefined,
          includeSpam: url.searchParams.get('includeSpam') === 'true',
          skip: Number(url.searchParams.get('skip') ?? 0) || 0,
          take: Number(url.searchParams.get('take') ?? 100) || 100,
        })
        const form = byKey.get(key)
        return Response.json({
          total: page.total,
          items: page.items.map((entry) => ({
            ...entry,
            values: redactSensitive(entry, form, maySeeSensitive),
          })),
        })
      }

      if (action && request.method === 'GET') {
        const form = byKey.get(decodeURIComponent(action))
        if (!form) return new Response('Not Found', { status: 404 })
        // The whole definition, which is what the designer edits.
        return Response.json({ ...formDetail(form), definition: form })
      }

      // Designing a form is a developer's job, so it is its own verb rather
      // than something an entry reader can do.
      if (request.method === 'POST' || request.method === 'PUT') {
        if (!may(FormPermissions.Manage)) return new Response('Forbidden', { status: 403 })
        const body = await request.json().catch(() => ({}))
        const written = await saveForm(coerceForm(body), formFiles)
        if (!written.ok) {
          log.warning('{user} could not save a form: {detail}', {
            user: principal.email,
            detail: written.problems.map((problem) => problem.message).join('; '),
          })
          return Response.json(
            { status: written.status, problems: written.problems },
            { status: written.status === 'readOnly' ? 409 : 400 },
          )
        }
        // The memo would otherwise hold the old definition for a second, which
        // is exactly long enough for the designer to reload and see it.
        forms.invalidate()
        log.info('{user} saved the form {form}', {
          user: principal.email,
          form: coerceForm(body).alias,
        })
        return Response.json({ ok: true })
      }

      if (action && request.method === 'DELETE') {
        if (!may(FormPermissions.Manage)) return new Response('Forbidden', { status: 403 })
        const form = byKey.get(decodeURIComponent(action))
        if (!form) return new Response('Not Found', { status: 404 })
        const removed = await deleteForm(form.alias, formFiles)
        if (!removed.ok)
          return Response.json(
            { status: removed.status, problems: removed.problems },
            { status: removed.status === 'readOnly' ? 409 : 404 },
          )
        forms.invalidate()
        log.info('{user} deleted the form {form}; its entries are kept', {
          user: principal.email,
          form: form.alias,
        })
        return Response.json({ ok: true })
      }
      return new Response('Not Found', { status: 404 })
    }

    // Non-contract: what the Changes dashboard and the read-only banner read.
    //
    // Two audiences, so two answers. `health` says this node has fallen behind
    // and writes will be refused, which is the banner in the header — every
    // editor needs to see that, and gating it would leave them with failing saves
    // and no explanation. The findings name documents and the properties that are
    // unfilled: that is the Settings dashboard's material, and the dashboard's own
    // manifest is already `Umb.Condition.SectionAlias` on Settings.
    if (pathname === `${paths.pluginPath}/api/change-report`) {
      const principal = await authenticate(request)
      if (!principal) return new Response('Unauthorized', { status: 401 })
      if (!hasSection(principal, 'settings')) return Response.json({ health: health() })
      const findings = await readReport(db, { includeResolved: true })
      const counts: Record<string, number> = {}
      // Per source as well as overall, so the dashboard can separate a pending
      // upgrade from a content bundle waiting on a decision.
      const bySource: Record<string, Record<string, number>> = {}
      for (const f of findings) {
        if (f.status !== 'open') continue
        counts[f.kind] = (counts[f.kind] ?? 0) + 1
        const source = bySource[f.source] ?? {}
        source[f.kind] = (source[f.kind] ?? 0) + 1
        bySource[f.source] = source
      }
      return Response.json({ health: health(), counts, bySource, findings })
    }

    const staticMatch = resolveStaticFile(paths, pathname, {
      extensions: extensions.list(),
      immutable: config.immutableAssets ?? !config.development,
    })
    if (staticMatch) {
      return (
        (await serveStaticFile(staticMatch, request)) ?? new Response('Not Found', { status: 404 })
      )
    }

    const loginAsset = resolveLoginAsset(paths.backOfficePath, pathname)
    if (loginAsset) {
      const response = await serveStaticFile(
        { file: loginAsset, cacheControl: 'no-cache' },
        request,
      )
      if (response) return response
    }

    const graphic = resolveGraphic(paths, pathname)
    if (graphic) {
      const response = await serveStaticFile({ file: graphic, cacheControl: 'no-cache' }, request)
      if (response) return response
    }

    const authResponse = await authRoutes.handle(request, pathname)
    if (authResponse) return authResponse

    if (pathname.startsWith(apiPrefix)) {
      if (pathname === `${apiPrefix}openapi.json`) {
        return new Response(Bun.file(CONTRACT_PATH), {
          headers: { 'content-type': 'application/json' },
        })
      }
      return api.dispatch(request)
    }

    if (pathname === `${paths.backOfficePath}/login`) {
      const { importmap } = collectManifests(paths, extensions.list())
      return html(
        renderLoginShell(paths, importmap, {
          defaultUiLanguage: config.defaultUiLanguage,
          keepUserLoggedIn: config.keepUserLoggedIn,
          title: config.siteName,
          usernameIsEmail: true,
          allowUserInvite: false,
          // Offering "forgot password" with no way to send the link is a dead
          // end that looks like a bug; without a sender the option is not there.
          allowPasswordReset: config.allowPasswordReset && canSendUserLinks,
          disableLocalLogin: !config.allowLocalLogin,
          // Set by the authorize endpoint so sign-in resumes the OAuth flow. Only
          // a path on this site: the login page hands this to the browser once
          // the session exists, so anything else is an open redirect at the worst
          // possible moment, and `javascript:` there would run signed in.
          returnUrl: localReturnUrl(url.searchParams.get('returnUrl')) ?? paths.backOfficePath,
        }),
      )
    }

    if (isSpaRoute(paths.backOfficePath, pathname)) {
      const { importmap } = collectManifests(paths, extensions.list())
      return html(
        renderBackOfficeShell(paths, importmap, {
          defaultUiLanguage: config.defaultUiLanguage,
          keepUserLoggedIn: config.keepUserLoggedIn,
          title: config.siteName,
        }),
      )
    }

    return undefined
  }

  /** A stylesheet or script the Settings section edits, from its folder; nothing else from there. */
  async function serveSiteFile(root: string, pathname: string, extension: string) {
    const segments = decodeURIComponent(pathname).split('/').slice(2)
    const safe =
      segments.length > 0 &&
      segments.every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes('\\')) &&
      segments.at(-1)?.toLowerCase().endsWith(extension)
    const file = safe ? Bun.file(join(root, ...segments)) : undefined
    if (!file || !(await file.exists())) return new Response('Not Found', { status: 404 })
    const headers = { 'cache-control': 'no-cache', 'content-type': file.type }
    // Bun.serve answers an empty file body 204, and an empty stylesheet is still one
    return new Response(file.size === 0 ? '' : file, { status: 200, headers })
  }

  /**
   * An uploaded file from the media store; an image with a resize or crop query
   * is served as that variant, computed once and cached in the store.
   *
   * A store that serves its own bytes (a CDN, a presigned bucket URL) gets the
   * browser sent straight there. Otherwise this streams them — from the local
   * file when there is one, so a disk-backed site still gets sendfile.
   */
  async function serveMedia(pathname: string, search: URLSearchParams): Promise<Response> {
    // Media is what someone else uploaded, served from this origin, so a browser
    // must not guess a type the store did not give.
    const cacheable = {
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    }
    /**
     * `sandbox` for the types that carry script, which Umbraco's upload rules
     * allow into the library as ours do. Only those: opening a PDF inline is
     * something a media library is expected to do, and sandboxing every response
     * would take that away to no purpose. An `<img src>` is unaffected either way
     * — what this stops is opening an SVG or an HTML file as a page.
     */
    const protective = (contentType: string) =>
      /^(?:image\/svg\+xml|text\/html|application\/xhtml\+xml|(?:text|application)\/xml)\b/.test(
        contentType,
      )
        ? { ...cacheable, 'content-security-policy': 'sandbox' }
        : cacheable
    // A prefix may be a path on this host as well as an absolute URL, and
    // Response.redirect insists on the latter.
    const sendTo = (location: string) =>
      new Response(null, { status: 302, headers: { location, ...cacheable } })
    const key = mediaFiles.key(pathname)
    if (!key) return new Response('Not Found', { status: 404 })
    const request = parseImagingQuery(search)
    const extension = key.split('.').pop()?.toLowerCase() ?? ''

    if (request && DEFAULT_UPLOAD_SETTINGS.imageFileTypes.includes(extension)) {
      const source = await mediaStore.get(key)
      if (source) {
        try {
          const variant = await images.variant(source, request)
          const elsewhere = mediaStore.publicUrl?.(variant.key)
          if (elsewhere) return sendTo(elsewhere)
          return new Response(variant.bytes as Uint8Array<ArrayBuffer>, {
            headers: { ...cacheable, 'content-type': variant.contentType },
          })
        } catch (error) {
          log.error('Could not process image {path}', { path: pathname, error })
        }
      }
    }

    const elsewhere = mediaStore.publicUrl?.(key)
    if (elsewhere) return sendTo(elsewhere)
    const stored = await mediaStore.get(key)
    if (!stored) return new Response('Not Found', { status: 404 })
    const headers = { ...protective(stored.contentType), 'content-type': stored.contentType }
    if (stored.localPath) return new Response(Bun.file(stored.localPath), { headers })
    return new Response((await stored.bytes()) as Uint8Array<ArrayBuffer>, { headers })
  }

  /**
   * Preview: a signed-in editor with the preview cookie sees drafts. The
   * backoffice's preview app frames `/<document key>`; a routed URL renders the
   * draft of the page it resolves to.
   */
  async function renderPreview(request: Request, pathname: string, host: string) {
    if (!readCookie(request, PREVIEW_COOKIE) || !(await authenticate(request))) return undefined
    const byKey = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
      pathname,
    )
    const key = byKey?.[1] ?? (await cache.resolve(host, pathname))?.content.key
    if (!key) return undefined
    const draft = await loadDraftNode(db, key, {
      nodeState: schema.nodeState,
      nodeId: schema.nodeId,
    })
    if (!draft) return undefined
    const url = new URL(request.url)
    const snapshot = await cache.snapshot()
    const culture =
      url.searchParams.get('culture') ||
      (draft.cultures.length > 0 ? (snapshot.defaultCulture ?? draft.cultures[0]) : null) ||
      null
    const published = await cache.byKey(key, culture)
    return renderer.renderModel(
      contentForNode(
        draft,
        published?.url ?? `/${draft.key}`,
        culture,
        snapshot.languages,
      ).withValueContext(await cache.valueContext(culture)),
      culture,
    )
  }

  /**
   * The front end: resolve the route against the published cache and render.
   *
   * Public access is enforced here, not in the renderer: a protected page is
   * *rewritten* to its login or error page, as Umbraco does, so the visitor
   * keeps the URL they asked for. Preview is exempt — only a signed-in editor
   * reaches it.
   */
  /**
   * A form submission from a visitor. Not the Management API: the caller is the
   * public, and there is no operation in the vendored contract for it.
   *
   * Answers JSON to a `fetch` caller and a 303 to a browser, so a form works
   * with no JavaScript — `form-submit.ts` says why the state goes in a cookie
   * rather than a body.
   */
  async function submitFormRoute(request: Request, pathname: string): Promise<Response> {
    const key = decodeURIComponent(pathname.slice(`${FORM_SUBMIT_PATH}/`.length))
    // Where to send a browser back to. The form was rendered on a page, and the
    // referer is the only thing that names it without the view passing it down.
    const back = (() => {
      const referer = request.headers.get('referer')
      if (!referer) return '/'
      try {
        const url = new URL(referer)
        return `${url.pathname}${url.search}`
      } catch {
        return '/'
      }
    })()

    const outcome = await submitForm(
      {
        db,
        forms,
        mediaFiles,
        uploads: DEFAULT_UPLOAD_SETTINGS,
        urlOf: async (contentKey) => (await cache.byKey(contentKey))?.url,
      },
      request,
      key,
      { ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() },
    )

    const json = wantsJson(request)
    const flash = (state: Parameters<typeof writeFlash>[1]) =>
      serializeCookie({
        name: FORM_FLASH_COOKIE,
        value: writeFlash(formSecret, state),
        secure: config.secureCookies,
        maxAgeSeconds: 60,
      })
    const plain = (body: string, status: number) =>
      new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

    switch (outcome.status) {
      case 'notFound':
        return json
          ? Response.json({ ok: false, error: 'No such form.' }, { status: 404 })
          : plain('Not Found', 404)
      case 'badToken': {
        // Stale or forged. Somebody who left the page open overnight lands here,
        // so it says what to do rather than only refusing.
        const message = 'This form has expired. Reload the page and try again.'
        return json
          ? Response.json({ ok: false, error: message }, { status: 400 })
          : plain(message, 400)
      }
      case 'full': {
        const message = 'This form is no longer accepting entries.'
        return json
          ? Response.json({ ok: false, error: message }, { status: 409 })
          : plain(message, 409)
      }
      case 'invalid':
        return json
          ? Response.json({ ok: false, errors: outcome.state.errors }, { status: 422 })
          : new Response(null, {
              status: 303,
              headers: { location: back, 'set-cookie': flash(outcome.state) },
            })
      case 'ok':
        return json
          ? Response.json({ ok: true, message: outcome.state.message, entryId: outcome.entryId })
          : new Response(null, {
              status: 303,
              headers: {
                location: outcome.redirectTo ?? back,
                'set-cookie': flash(outcome.state),
              },
            })
    }
  }

  async function renderSite(request: Request, pathname: string, host: string): Promise<Response> {
    const preview = await renderPreview(request, pathname, host)
    // An `api` node renders for preview and nothing else. The backoffice opens a
    // site URL to preview a draft, so the renderer has to be here; serving the
    // published site as well would mean a second public copy of it on whatever
    // address the editing box answers.
    if (!preview && config.role === 'api')
      return new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    const member = preview ? undefined : await members.resolve(request)
    // What a submission redirected back with, if anything. Read once and
    // cleared, so a reload shows the page rather than the thank-you again.
    const cookie = readCookie(request, FORM_FLASH_COOKIE)
    const submission = cookie ? readFlash(formSecret, cookie) : undefined
    const result =
      preview ??
      (await renderer.render(pathname, host, {
        member,
        submission,
        access: (content) => members.decide(content, member),
      }))
    const cleared: Record<string, string> = cookie
      ? { 'set-cookie': expireCookie(FORM_FLASH_COOKIE, config.secureCookies) }
      : {}
    switch (result.status) {
      case 'ok':
        return new Response(result.html, {
          headers: { 'content-type': 'text/html; charset=utf-8', ...cleared },
        })
      case 'noTemplate':
        // Content exists but renders nothing, which Umbraco also treats as a 404.
        return new Response(`No template is assigned to '${result.content.name}'.`, {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      case 'error': {
        // Through `inSource`, so the file named is the one somebody can open
        // rather than the snapshot generation it was imported from.
        const detail = renderer.inSource(result.error.stack ?? result.error.message)
        renderLog.error('Template error while rendering {name} ({key}): {detail}', {
          name: result.content.name,
          key: result.content.key,
          detail,
        })
        return new Response(
          config.development
            ? `Template error while rendering '${result.content.name}':\n\n${detail}`
            : 'Server Error',
          { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
        )
      }
      default: {
        // Only once no page answered, so a redirect can never hide live content.
        const redirect = await cache.redirect(host, pathname)
        if (redirect)
          return new Response(null, {
            status: redirect.statusCode,
            headers: {
              location: withQuery(redirect.location, request.url),
              // Umbraco sends a 301 uncacheable on purpose: browsers cache them
              // hard, so a page renamed and then renamed back would keep
              // redirecting for visitors who saw the first answer.
              'cache-control': 'no-store, must-revalidate',
              pragma: 'no-cache',
              expires: '0',
            },
          })
        // A site with nothing published is not a 404 anybody can act on, so it
        // explains itself instead. Still a 404: see `no-nodes.ts`.
        const snapshot = await cache.snapshot()
        if ([...snapshot.views.values()].every((view) => view.roots.length === 0))
          return new Response(
            noNodesPage({ siteName: config.siteName, backOfficePath: config.backOfficePath }),
            { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
          )
        return new Response('Not Found', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
    }
  }

  return {
    config,
    fetch,
    paths,
    db,
    auth,
    cache,
    renderer,
    snapshots,
    seededAdminPassword,
    schema,
    poll: () => poller.poll(),
    notImplemented,
    health,
    events,
    jobs,
    serveOptions: {
      port: config.port,
      maxRequestBodySize: config.maxRequestBodyBytes,
      fetch: diagnostics.wrap(async (request, bunServer: Server<HubSocketData>) => {
        const pathname = new URL(request.url).pathname
        if (pathname === hubPath || pathname === previewHubPath) {
          const principal = await authenticate(request)
          const hub = pathname === hubPath ? events : previewHub
          return hub.upgrade(request, bunServer, principal?.id)
        }
        return fetch(request)
      }),
      websocket: combineHubs([events, previewHub]),
    },
    async close() {
      diagnostics.stop()
      jobs.stop()
      events.stop()
      previewHub.stop()
      watcher?.close()
      poller.stop()
      await db.close()
    },
  }
}

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/**
 * Carries the request's query string onto a redirect target, as Umbraco does, so
 * campaign and tracking parameters survive a rename. A target that names its own
 * query wins.
 */
function withQuery(location: string, requestUrl: string): string {
  const query = new URL(requestUrl).search
  return query && !location.includes('?') ? `${location}${query}` : location
}
