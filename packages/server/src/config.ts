import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_BACKOFFICE_PATH } from '@bunbraco/core'
import type { RedirectRule, SnapshotLimits } from '@bunbraco/render'
import type { AssistantConfig } from './assistant.ts'
import type { GitConfig } from './git-routes.ts'
import type { MediaStore } from './media-store.ts'
import type { SchemaStore } from './schema-store.ts'

/**
 * Runtime settings for a site. Umbraco's equivalents live in appsettings.json;
 * a site declares these in `bunbraco.config.ts` via `defineConfig`, and
 * `loadConfig` fills anything unset from the environment.
 */
/** What a process serves; see `BunbracoConfig.role`. */
export const SERVER_ROLES = ['all', 'api', 'web'] as const

export type ServerRole = (typeof SERVER_ROLES)[number]

/** Delivers an invitation or password-reset link to a backoffice user, typically by e-mail. */
export type UserLinkSender = (message: {
  kind: 'invite' | 'reset'
  to: { name: string; email: string }
  link: string
  /** The inviting user's personal message, for an invitation. */
  message: string | null
}) => Promise<void>

export interface BunbracoConfig {
  port: number
  /** The largest request body the server will read, media uploads included. */
  maxRequestBodyBytes: number
  backOfficePath: string
  defaultUiLanguage: string
  keepUserLoggedIn: boolean
  allowLocalLogin: boolean
  allowPasswordReset: boolean
  versionCheckPeriod: number
  umbracoCssPath: string
  /**
   * Reporting true lets the client open a plain WebSocket and skip SignalR's
   * /negotiate handshake, which is the shortcut Umbraco intends for servers that
   * do not implement the full protocol.
   */
  signalRSkipNegotiation: boolean
  development: boolean
  /**
   * Whether the cache-busted asset path may be cached immutably. Defaults to
   * `!development`.
   *
   * The hash in that path comes from the vendored client's `VERSION` alone, so
   * re-vendoring the *same* upstream version with different output — editing
   * `vendor-backoffice.ts`, or changing what `upstream-static/` seeds — leaves the
   * path unchanged while the bytes behind it move. Development therefore sends
   * `no-cache`, or a developer would debug a stale module graph.
   *
   * A long-lived process that vendors once wants the opposite, and wants it
   * badly: the client is ~6,500 separate modules, and re-fetching all of them on
   * every page load is enough to exhaust a browser. The browser suite sets this
   * true for exactly that reason — see `tests/browser/serve.ts`.
   */
  immutableAssets?: boolean
  /** SQLite file, or ':memory:'. Ignored when BUNBRACO_DB=postgres. */
  sqliteFile: string
  adminLogin: string
  /** When unset, a password is generated on first run and printed once. */
  adminPassword: string | undefined
  /**
   * The `__Host-` cookie prefix requires Secure. Browsers treat http://localhost
   * as secure, so this stays on in local development.
   */
  secureCookies: boolean
  siteName: string
  /** The site's own directory: where `bunbraco.config.ts` and `domains.toml` are. */
  siteDir: string
  /** Where template views live on disk. */
  viewsDir: string
  /**
   * Where backoffice plugin packages live, served at `/App_Plugins/`.
   *
   * Its own setting rather than a sibling of `viewsDir`, which is what it used
   * to be: pointing the views somewhere else — a mounted bucket, a cache
   * directory — would otherwise move this with it and the backoffice would
   * quietly find no plugins.
   */
  appPluginsDir: string
  /**
   * Where content-addressed copies of `viewsDir` are written, so an edited view
   * is picked up without restarting the node.
   *
   * Inside the site by necessity, not by preference: JSX compiles to an import
   * of `bunbraco/jsx-runtime`, which resolves by walking up from the file, so a
   * snapshot outside the site tree cannot load at all. Ephemeral — cleared at
   * boot — and never shared between nodes.
   */
  viewsCacheDir: string
  /**
   * Tuning for the views snapshot: how often a node looks for a change, how
   * long it looks eagerly after one is announced, how many generations it will
   * load before it freezes, and the caps on a tree it will copy.
   *
   * Anything unset takes `SNAPSHOT_LIMITS`, or its development override.
   */
  viewsSnapshot: Partial<SnapshotLimits>
  /** Where `schema/*.toml` lives; sync is skipped when the directory is absent. */
  schemaDir: string
  /** Supplied at deploy time (BUNBRACO_SCHEMA_REVISION); orders deploys within one schema version. */
  schemaRevision: string
  /** This node's identity in `server` and on cache instructions. */
  nodeId: string
  /**
   * What this process serves, and whether it owns the boot's write duties.
   *
   * `all` is one process doing everything, which is every single-box site and
   * all local development. The other two split a deployment in half:
   *
   * - `api` serves the backoffice and the Management API, and owns the schema
   *   sync, the `domains.toml` and redirect convergence and the background jobs.
   *   It renders only for preview, so public traffic routed here by mistake is a
   *   404 rather than a second copy of the site.
   * - `web` serves the public site and nothing else: no backoffice, no
   *   Management API, no sign-in routes, and none of the write duties above. It
   *   neither migrates nor seeds, and refuses to boot against a database that
   *   has not been migrated yet — that is `api`'s job.
   *
   * Both halves still hold a database connection and stay coherent through
   * `cache_instruction`, exactly as a load-balanced set already does. Splitting
   * needs Postgres: `locks.ts`'s SQLite manager is an in-process queue, so it
   * coordinates nothing between processes.
   */
  role: ServerRole
  /**
   * Where the schema files live, when not in `schemaDir` on this disk. Unset means
   * the directory, which is what a repository checkout wants. Set — with
   * `s3SchemaStore` or `azureSchemaStore` — the store is the truth: it is copied
   * into `schemaCacheDir` at boot, every node reads the same copy, and a change
   * made in the backoffice is published back rather than lost with the container.
   */
  schemaStore: SchemaStore | undefined
  /** Where a `schemaStore` is materialised. Ephemeral by design: the store is the truth. */
  schemaCacheDir: string
  /**
   * Whether the backoffice may write schema files. Development only by default,
   * because a production container's disk does not survive a redeploy — unless a
   * `schemaStore` makes the writes durable, which turns this on, or
   * BUNBRACO_SCHEMA_WRITABLE says otherwise outright.
   */
  schemaWritable: boolean
  /** Sync `schema/` at boot; a pipeline that runs `bunbraco schema sync` turns this off. */
  syncSchemaAtBoot: boolean
  /** Which database engine; from BUNBRACO_DB. */
  dialect: 'sqlite' | 'postgres'
  /** A shell command that backs up Postgres; `--fix` and `upgrade` run it first. */
  pgDump: string | undefined
  /** Whether findings that need a person gate an upgrade: strict in production. */
  upgradePolicy: 'strict' | 'pending-allowed'
  /**
   * The hourly version cleanup, as Umbraco's `ContentVersionCleanupPolicy`: off
   * unless enabled, and a content type's own policy wins over these windows.
   */
  versionCleanup: {
    enabled: boolean
    keepAllVersionsNewerThanDays: number
    keepLatestVersionPerDayForDays: number
  }
  /** Where uploaded media files live; served at `/media/`. */
  mediaDir: string
  /**
   * Where the bytes of uploaded media actually go. Unset means the environment
   * decides (`BUNBRACO_MEDIA_STORE`), which defaults to `mediaDir` on this disk.
   * A site swaps in blob storage with `s3MediaStore` or `azureMediaStore`.
   */
  mediaStore: MediaStore | undefined
  /** Where log files are written, and read by the backoffice's log viewer. */
  logsDir: string
  /** The least severe level logged: trace, debug, info, warning, error or fatal. */
  logLevel: 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'
  /** Whether log events are also printed to the console. */
  logToConsole: boolean
  /**
   * A per-request trace on the console, and a regular report of the heap and of
   * in-flight requests. For diagnosing a live node; both off by default.
   */
  diagnostics: { traceRequests: boolean; heapIntervalSeconds: number }
  /** Stylesheets the Settings section edits, served at `/css/`. */
  stylesheetsDir: string
  /** Scripts the Settings section edits, served at `/scripts/`. */
  scriptsDir: string
  /** Umbraco's `UsernameIsEmail`: a user's login is their e-mail address. */
  usernameIsEmail: boolean
  /** The site's public URL, which invitation and reset links point at. */
  applicationUrl: string
  /**
   * How invitation and reset links reach people. Without one users cannot be
   * invited and passwords cannot be reset by e-mail; in development the links
   * are printed to the console instead, unless this is `null`.
   */
  sendUserLink: UserLinkSender | null | undefined
  /**
   * Whether `POST /umbraco/members/register` accepts a registration. Off by
   * default: an always-open endpoint that creates members is a decision a site
   * makes deliberately, not one a framework makes for it.
   */
  allowMemberRegistration: boolean
  /** The member type a registration creates, by alias. */
  memberRegistrationType: string
  /** Member group names a registration joins the new member to. */
  memberRegistrationGroups: string[]
  /** How long a member's session cookie is good for. */
  memberSessionMinutes: number
  /** Failed sign-ins that lock a member out; Umbraco's default is 5. 0 never locks out. */
  maxFailedPasswordAttempts: number
  /**
   * Redirects the site declares itself, built with `redirect()`. They are synced
   * into the database at boot, so the backoffice lists them beside the tracked
   * ones, and they are matched only once route resolution has found no page —
   * a rule can never make a live URL unreachable.
   */
  redirects: RedirectRule[]
  /**
   * Whether renaming or moving a published page records a redirect from the URL
   * it used to answer on. Umbraco's `DisableRedirectUrlTracking`, inverted.
   */
  trackRedirects: boolean
  /**
   * Source control for the schema, so a change made on a running site reaches the
   * repository without an editor meeting git. Unset means the feature does not
   * exist: no route, no credentials. Set with `gitHub({ repository, token })`.
   */
  git: GitConfig | undefined
  /**
   * The AI helper in the backoffice. Absent means the feature does not exist: no
   * route, no tools, no model client, and nothing in the backoffice. When it is
   * configured the assistant can read the CMS and propose changes, and a person
   * approves each one — it cannot write, and it cannot publish.
   */
  assistant: AssistantConfig | undefined
}

export type SiteConfig = BunbracoConfig

export const DEFAULTS = {
  // The same port the container stack publishes, so the backoffice is at one
  // address whichever way the site was started. Only one of the two can hold it;
  // `assertPortAvailable` says so rather than letting the bind fail obscurely.
  port: 8080,
  // Bun's own default is 128 MB, which every unauthenticated endpoint that reads
  // a body would otherwise accept. 32 MiB leaves room for the media library —
  // Kestrel's default, which Umbraco runs behind, is about 30 MB.
  maxRequestBodyBytes: 32 * 1024 * 1024,
  backOfficePath: DEFAULT_BACKOFFICE_PATH,
  defaultUiLanguage: 'en-US',
  keepUserLoggedIn: false,
  allowLocalLogin: true,
  allowPasswordReset: false,
  versionCheckPeriod: 7,
  umbracoCssPath: '/css',
  signalRSkipNegotiation: true,
  sqliteFile: 'bunbraco.sqlite',
  adminLogin: 'admin@bunbraco.local',
  secureCookies: true,
  siteName: 'Bunbraco',
  viewsDir: 'Views',
  appPluginsDir: 'App_Plugins',
  viewsCacheDir: join('.bunbraco', 'views'),
  schemaDir: 'schema',
  schemaRevision: '0',
  mediaDir: 'media',
  stylesheetsDir: 'css',
  logsDir: 'logs',
  scriptsDir: 'scripts',
  keepAllVersionsNewerThanDays: 7,
  keepLatestVersionPerDayForDays: 90,
  memberRegistrationType: 'Member',
  memberSessionMinutes: 60 * 24 * 14,
  maxFailedPasswordAttempts: 5,
} as const

/**
 * A misspelt role is refused rather than defaulted: silently falling back to
 * `all` would put a second set of background jobs and a second schema sync on a
 * node meant to be read-only, which is the failure this flag exists to prevent.
 */
function assertRole(value: string): asserts value is ServerRole {
  if (!(SERVER_ROLES as readonly string[]).includes(value))
    throw new Error(`role must be one of ${SERVER_ROLES.join(', ')}, not '${value}'.`)
}

function roleFromEnvironment(value: string | undefined): ServerRole {
  if (value === undefined || value === '') return 'all'
  assertRole(value)
  return value
}

/** A site's config file exports `defineConfig({...})`; unset keys come from the environment. */
export function defineConfig(overrides: Partial<BunbracoConfig> = {}): Partial<BunbracoConfig> {
  return overrides
}

/** Builds the effective config: explicit values, then environment, then defaults. */
export function loadConfig(
  overrides: Partial<BunbracoConfig> = {},
  cwd = process.cwd(),
): BunbracoConfig {
  const fromEnv: BunbracoConfig = {
    port: Number(Bun.env.PORT ?? DEFAULTS.port),
    maxRequestBodyBytes: Bun.env.BUNBRACO_MAX_REQUEST_BODY_MB
      ? Number(Bun.env.BUNBRACO_MAX_REQUEST_BODY_MB) * 1024 * 1024
      : DEFAULTS.maxRequestBodyBytes,
    backOfficePath: Bun.env.BUNBRACO_BACKOFFICE_PATH ?? DEFAULTS.backOfficePath,
    defaultUiLanguage: DEFAULTS.defaultUiLanguage,
    keepUserLoggedIn: DEFAULTS.keepUserLoggedIn,
    allowLocalLogin: DEFAULTS.allowLocalLogin,
    allowPasswordReset: DEFAULTS.allowPasswordReset,
    versionCheckPeriod: DEFAULTS.versionCheckPeriod,
    umbracoCssPath: DEFAULTS.umbracoCssPath,
    signalRSkipNegotiation: DEFAULTS.signalRSkipNegotiation,
    development: Bun.env.NODE_ENV !== 'production',
    sqliteFile: Bun.env.BUNBRACO_SQLITE_FILE ?? DEFAULTS.sqliteFile,
    adminLogin: Bun.env.BUNBRACO_ADMIN_LOGIN ?? DEFAULTS.adminLogin,
    adminPassword: Bun.env.BUNBRACO_ADMIN_PASSWORD,
    secureCookies: Bun.env.BUNBRACO_INSECURE_COOKIES !== 'true',
    siteName: Bun.env.BUNBRACO_SITE_NAME ?? DEFAULTS.siteName,
    siteDir: cwd,
    viewsDir: Bun.env.BUNBRACO_VIEWS_DIR ?? DEFAULTS.viewsDir,
    appPluginsDir: Bun.env.BUNBRACO_APP_PLUGINS_DIR ?? DEFAULTS.appPluginsDir,
    viewsCacheDir: Bun.env.BUNBRACO_VIEWS_CACHE_DIR ?? DEFAULTS.viewsCacheDir,
    viewsSnapshot: {
      ...(Bun.env.BUNBRACO_VIEWS_GATE_MS
        ? { gateTtlMs: Number(Bun.env.BUNBRACO_VIEWS_GATE_MS) }
        : {}),
      ...(Bun.env.BUNBRACO_VIEWS_GENERATION_LIMIT
        ? { maxGenerations: Number(Bun.env.BUNBRACO_VIEWS_GENERATION_LIMIT) }
        : {}),
      ...(Bun.env.BUNBRACO_VIEWS_KEEP ? { keep: Number(Bun.env.BUNBRACO_VIEWS_KEEP) } : {}),
      ...(Bun.env.BUNBRACO_VIEWS_SWAP_MS
        ? { minSwapIntervalMs: Number(Bun.env.BUNBRACO_VIEWS_SWAP_MS) }
        : {}),
    },
    schemaDir: Bun.env.BUNBRACO_SCHEMA_DIR ?? DEFAULTS.schemaDir,
    schemaRevision: Bun.env.BUNBRACO_SCHEMA_REVISION ?? DEFAULTS.schemaRevision,
    nodeId: Bun.env.BUNBRACO_NODE_ID ?? `${hostname()}:${process.pid}`,
    role: roleFromEnvironment(Bun.env.BUNBRACO_ROLE),
    git: undefined,
    schemaStore: undefined,
    schemaCacheDir: Bun.env.BUNBRACO_SCHEMA_CACHE_DIR ?? join(tmpdir(), 'bunbraco-schema'),
    // Resolved again below, once it is known whether a store was configured.
    schemaWritable:
      Bun.env.BUNBRACO_SCHEMA_WRITABLE !== undefined
        ? Bun.env.BUNBRACO_SCHEMA_WRITABLE === 'true'
        : Bun.env.NODE_ENV !== 'production',
    syncSchemaAtBoot: Bun.env.BUNBRACO_SYNC_SCHEMA_AT_BOOT !== 'false',
    dialect: Bun.env.BUNBRACO_DB === 'postgres' ? 'postgres' : 'sqlite',
    pgDump: Bun.env.BUNBRACO_PG_DUMP,
    upgradePolicy:
      Bun.env.BUNBRACO_UPGRADE_POLICY === 'pending-allowed' ||
      (Bun.env.BUNBRACO_UPGRADE_POLICY === undefined && Bun.env.NODE_ENV !== 'production')
        ? 'pending-allowed'
        : 'strict',
    versionCleanup: {
      enabled: Bun.env.BUNBRACO_VERSION_CLEANUP === 'true',
      keepAllVersionsNewerThanDays: Number(
        Bun.env.BUNBRACO_VERSION_CLEANUP_KEEP_ALL_DAYS ?? DEFAULTS.keepAllVersionsNewerThanDays,
      ),
      keepLatestVersionPerDayForDays: Number(
        Bun.env.BUNBRACO_VERSION_CLEANUP_KEEP_LATEST_DAYS ??
          DEFAULTS.keepLatestVersionPerDayForDays,
      ),
    },
    mediaDir: Bun.env.BUNBRACO_MEDIA_DIR ?? DEFAULTS.mediaDir,
    mediaStore: undefined,
    logsDir: Bun.env.BUNBRACO_LOGS_DIR ?? DEFAULTS.logsDir,
    logLevel: parseLogLevel(Bun.env.BUNBRACO_LOG_LEVEL),
    logToConsole: Bun.env.BUNBRACO_LOG_TO_CONSOLE !== 'false',
    diagnostics: {
      traceRequests: Bun.env.BUNBRACO_TRACE_REQUESTS === 'true',
      heapIntervalSeconds: Math.max(0, Number(Bun.env.BUNBRACO_HEAP_INTERVAL_SECONDS ?? 0) || 0),
    },
    stylesheetsDir: Bun.env.BUNBRACO_CSS_DIR ?? DEFAULTS.stylesheetsDir,
    scriptsDir: Bun.env.BUNBRACO_SCRIPTS_DIR ?? DEFAULTS.scriptsDir,
    usernameIsEmail: Bun.env.BUNBRACO_USERNAME_IS_EMAIL !== 'false',
    applicationUrl: Bun.env.BUNBRACO_APPLICATION_URL ?? '',
    sendUserLink: undefined,
    allowMemberRegistration: Bun.env.BUNBRACO_ALLOW_MEMBER_REGISTRATION === 'true',
    memberRegistrationType:
      Bun.env.BUNBRACO_MEMBER_REGISTRATION_TYPE ?? DEFAULTS.memberRegistrationType,
    memberRegistrationGroups: (Bun.env.BUNBRACO_MEMBER_REGISTRATION_GROUPS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    memberSessionMinutes: Number(
      Bun.env.BUNBRACO_MEMBER_SESSION_MINUTES ?? DEFAULTS.memberSessionMinutes,
    ),
    maxFailedPasswordAttempts: Number(
      Bun.env.BUNBRACO_MAX_FAILED_PASSWORD_ATTEMPTS ?? DEFAULTS.maxFailedPasswordAttempts,
    ),
    redirects: [],
    trackRedirects: Bun.env.BUNBRACO_TRACK_REDIRECTS !== 'false',
    // No environment variable: enabling it takes a provider, which is code.
    assistant: undefined,
  }
  const merged: BunbracoConfig = { ...fromEnv, ...stripUndefined(overrides) }
  // A schema store makes backoffice writes durable, so it carries writability with
  // it — that is the point of configuring one. An explicit setting still wins.
  if (
    merged.schemaStore &&
    Bun.env.BUNBRACO_SCHEMA_WRITABLE === undefined &&
    overrides.schemaWritable === undefined
  ) {
    merged.schemaWritable = true
  }
  // Relative paths are relative to the site, not to wherever the process started.
  merged.siteDir = resolve(cwd, merged.siteDir)
  // Against the site rather than the working directory: it has to sit where the
  // JSX runtime resolves from, which is the site's own tree.
  merged.viewsCacheDir = resolve(merged.siteDir, merged.viewsCacheDir)
  merged.viewsDir = resolve(cwd, merged.viewsDir)
  merged.appPluginsDir = resolve(cwd, merged.appPluginsDir)
  merged.schemaDir = resolve(cwd, merged.schemaDir)
  merged.mediaDir = resolve(cwd, merged.mediaDir)
  merged.logsDir = resolve(cwd, merged.logsDir)
  merged.stylesheetsDir = resolve(cwd, merged.stylesheetsDir)
  merged.scriptsDir = resolve(cwd, merged.scriptsDir)
  merged.applicationUrl = (merged.applicationUrl || `http://localhost:${merged.port}`).replace(
    /\/$/,
    '',
  )
  if (merged.sqliteFile !== ':memory:') merged.sqliteFile = resolve(cwd, merged.sqliteFile)
  // Checked on the merged value, so a typo in `bunbraco.config.ts` is refused on
  // the same terms as one in the environment.
  assertRole(merged.role)
  return merged
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const

function parseLogLevel(value: string | undefined): BunbracoConfig['logLevel'] {
  const level = value?.toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(level ?? '')
    ? (level as BunbracoConfig['logLevel'])
    : 'info'
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * The database a banner or log line should name. The Postgres URL carries the
 * password, so only its host and database are shown.
 */
export function describeDatabase(
  config: Pick<BunbracoConfig, 'dialect' | 'sqliteFile'>,
  url: string | undefined = Bun.env.BUNBRACO_POSTGRES_URL ?? Bun.env.DATABASE_URL,
): string {
  if (config.dialect !== 'postgres') return config.sqliteFile
  if (!url) return 'postgres'
  try {
    const parsed = new URL(url)
    return `postgres ${parsed.host}${parsed.pathname}`
  } catch {
    return 'postgres'
  }
}

export const VERSION = '0.4.0'
