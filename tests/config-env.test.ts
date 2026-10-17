import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describeDatabase, loadConfig } from '@crombolo/server'

const OWNED = /^(CROMBOLO_|PORT$|NODE_ENV$|DATABASE_URL$)/
let saved: Record<string, string | undefined> = {}

function setEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) Bun.env[key] = value
}

beforeEach(() => {
  saved = { ...Bun.env }
  for (const key of Object.keys(Bun.env)) if (OWNED.test(key)) delete Bun.env[key]
})

afterEach(() => {
  for (const key of Object.keys(Bun.env)) if (OWNED.test(key)) delete Bun.env[key]
  for (const [key, value] of Object.entries(saved))
    if (OWNED.test(key) && value !== undefined) Bun.env[key] = value
})

const site = '/srv/site'

describe('loadConfig reads the environment', () => {
  test('with nothing set, every value is its default', () => {
    const config = loadConfig({}, site)
    expect(config).toMatchObject({
      port: 8080,
      maxRequestBodyBytes: 32 * 1024 * 1024,
      backOfficePath: '/crombolo',
      development: true,
      sqliteFile: resolve(site, 'crombolo.sqlite'),
      adminLogin: 'admin@crombolo.local',
      localAdmin: false,
      secureCookies: true,
      siteName: 'Crombolo',
      siteDir: site,
      componentsDir: resolve(site, 'components'),
      componentsCacheDir: resolve(site, '.crombolo/components'),
      componentsSnapshot: {},
      renderTimeoutMs: 10_000,
      schemaDir: resolve(site, 'schema'),
      schemaRevision: '0',
      role: 'all',
      schemaCacheDir: join(tmpdir(), 'crombolo-schema'),
      schemaWritable: true,
      syncSchemaAtBoot: true,
      dialect: 'sqlite',
      upgradePolicy: 'pending-allowed',
      versionCleanup: {
        enabled: false,
        keepAllVersionsNewerThanDays: 7,
        keepLatestVersionPerDayForDays: 90,
      },
      auditRetentionDays: 365,
      mediaDir: resolve(site, 'media'),
      logsDir: resolve(site, 'logs'),
      logLevel: 'info',
      logToConsole: true,
      diagnostics: { traceRequests: false, heapIntervalSeconds: 0 },
      stylesheetsDir: resolve(site, 'css'),
      scriptsDir: resolve(site, 'scripts'),
      usernameIsEmail: true,
      applicationUrl: 'http://localhost:8080',
      allowMemberRegistration: false,
      memberRegistrationType: 'Member',
      memberRegistrationGroups: [],
      memberSessionMinutes: 20_160,
      maxFailedPasswordAttempts: 5,
      remote: {
        enabled: false,
        environment: 'production',
        protected: true,
        approvals: false,
        maxUploadBytes: 50 * 1024 ** 3,
      },
      trackRedirects: true,
      applyBundleContentOnInstall: true,
      runtimeInstalls: true,
      seo: {},
      deliveryApi: { media: {} },
      marketplaceUrl: 'https://www.npmjs.com/search?q=keywords%3Acrombolo-bundle',
      packageKeyword: 'crombolo-bundle',
      npmRegistry: 'https://registry.npmjs.org',
    })
    expect(config.adminPassword).toBeUndefined()
    expect(config.apiClient).toBeUndefined()
    expect(config.setupCode).toBeUndefined()
    expect(config.secretKey).toBeUndefined()
    expect(config.pgDump).toBeUndefined()
    expect(config.nodeId).toBe(`${hostname()}:${process.pid}`)
  })

  test('production changes the defaults that follow it', () => {
    setEnv({ NODE_ENV: 'production' })
    const config = loadConfig({}, site)
    expect(config.development).toBe(false)
    expect(config.schemaWritable).toBe(false)
    expect(config.upgradePolicy).toBe('strict')
  })

  test('every variable lands in its field', () => {
    setEnv({
      PORT: '3000',
      CROMBOLO_MAX_REQUEST_BODY_MB: '2',
      CROMBOLO_BACKOFFICE_PATH: '/edit',
      CROMBOLO_SQLITE_FILE: 'data/site.db',
      CROMBOLO_ADMIN_LOGIN: 'owner@example.com',
      CROMBOLO_ADMIN_PASSWORD: 'a-long-password',
      CROMBOLO_API_CLIENT_ID: 'crombolo-back-office-ci',
      CROMBOLO_API_CLIENT_SECRET: 'a-long-enough-secret',
      CROMBOLO_LOCAL_ADMIN: 'true',
      CROMBOLO_SETUP_CODE: 'sixteen-characters',
      CROMBOLO_SECRET_KEY: 'k'.repeat(32),
      CROMBOLO_INSECURE_COOKIES: 'true',
      CROMBOLO_SITE_NAME: 'Acme',
      CROMBOLO_COMPONENTS_DIR: 'views',
      CROMBOLO_COMPONENTS_CACHE_DIR: 'cache/views',
      CROMBOLO_COMPONENTS_GATE_MS: '100',
      CROMBOLO_COMPONENTS_GENERATION_LIMIT: '9',
      CROMBOLO_COMPONENTS_KEEP: '2',
      CROMBOLO_COMPONENTS_SWAP_MS: '50',
      CROMBOLO_RENDER_TIMEOUT_MS: '0',
      CROMBOLO_SCHEMA_DIR: 'types',
      CROMBOLO_SCHEMA_REVISION: '42',
      CROMBOLO_NODE_ID: 'node-a',
      CROMBOLO_ROLE: 'web',
      CROMBOLO_SCHEMA_CACHE_DIR: '/tmp/schema-cache',
      CROMBOLO_SCHEMA_WRITABLE: 'false',
      CROMBOLO_SYNC_SCHEMA_AT_BOOT: 'false',
      CROMBOLO_DB: 'postgres',
      CROMBOLO_PG_DUMP: 'pg_dump x',
      CROMBOLO_UPGRADE_POLICY: 'strict',
      CROMBOLO_VERSION_CLEANUP: 'true',
      CROMBOLO_VERSION_CLEANUP_KEEP_ALL_DAYS: '3',
      CROMBOLO_VERSION_CLEANUP_KEEP_LATEST_DAYS: '30',
      CROMBOLO_AUDIT_RETENTION_DAYS: '0',
      CROMBOLO_MEDIA_DIR: 'uploads',
      CROMBOLO_LOGS_DIR: 'var/logs',
      CROMBOLO_LOG_LEVEL: 'WARNING',
      CROMBOLO_LOG_TO_CONSOLE: 'false',
      CROMBOLO_TRACE_REQUESTS: 'true',
      CROMBOLO_HEAP_INTERVAL_SECONDS: '30',
      CROMBOLO_CSS_DIR: 'styles',
      CROMBOLO_SCRIPTS_DIR: 'js',
      CROMBOLO_USERNAME_IS_EMAIL: 'false',
      CROMBOLO_APPLICATION_URL: 'https://example.com/',
      CROMBOLO_ALLOW_MEMBER_REGISTRATION: 'true',
      CROMBOLO_MEMBER_REGISTRATION_TYPE: 'Customer',
      CROMBOLO_MEMBER_REGISTRATION_GROUPS: ' Buyers , ,Friends',
      CROMBOLO_MEMBER_SESSION_MINUTES: '60',
      CROMBOLO_MAX_FAILED_PASSWORD_ATTEMPTS: '0',
      CROMBOLO_REMOTE_ENABLED: 'true',
      CROMBOLO_REMOTE_ENVIRONMENT: 'staging',
      CROMBOLO_REMOTE_PROTECTED: 'false',
      CROMBOLO_REMOTE_APPROVALS: 'true',
      CROMBOLO_REMOTE_MAX_UPLOAD_GB: '1',
      CROMBOLO_TRACK_REDIRECTS: 'false',
      CROMBOLO_APPLY_BUNDLE_CONTENT: 'false',
      CROMBOLO_RUNTIME_INSTALLS: 'false',
      CROMBOLO_SITEMAP: 'false',
      CROMBOLO_INDEXABLE: 'false',
      CROMBOLO_DELIVERY_API: 'true',
      CROMBOLO_DELIVERY_API_KEY: 'key',
      CROMBOLO_DELIVERY_API_PUBLIC: 'false',
      CROMBOLO_DELIVERY_API_MEDIA: 'true',
      CROMBOLO_MARKETPLACE_URL: 'https://market.example.com',
      CROMBOLO_PACKAGE_KEYWORD: 'acme-bundle',
      CROMBOLO_NPM_REGISTRY: 'https://npm.example.com',
    })
    const config = loadConfig({}, site)
    expect(config).toMatchObject({
      port: 3000,
      maxRequestBodyBytes: 2 * 1024 * 1024,
      backOfficePath: '/edit',
      sqliteFile: resolve(site, 'data/site.db'),
      adminLogin: 'owner@example.com',
      adminPassword: 'a-long-password',
      apiClient: { id: 'crombolo-back-office-ci', secret: 'a-long-enough-secret' },
      localAdmin: true,
      setupCode: 'sixteen-characters',
      secretKey: 'k'.repeat(32),
      secureCookies: false,
      siteName: 'Acme',
      componentsDir: resolve(site, 'views'),
      componentsCacheDir: resolve(site, 'cache/views'),
      componentsSnapshot: { gateTtlMs: 100, maxGenerations: 9, keep: 2, minSwapIntervalMs: 50 },
      renderTimeoutMs: 0,
      schemaDir: resolve(site, 'types'),
      schemaRevision: '42',
      nodeId: 'node-a',
      role: 'web',
      schemaCacheDir: '/tmp/schema-cache',
      schemaWritable: false,
      syncSchemaAtBoot: false,
      dialect: 'postgres',
      pgDump: 'pg_dump x',
      upgradePolicy: 'strict',
      versionCleanup: {
        enabled: true,
        keepAllVersionsNewerThanDays: 3,
        keepLatestVersionPerDayForDays: 30,
      },
      auditRetentionDays: 0,
      mediaDir: resolve(site, 'uploads'),
      logsDir: resolve(site, 'var/logs'),
      logLevel: 'warning',
      logToConsole: false,
      diagnostics: { traceRequests: true, heapIntervalSeconds: 30 },
      stylesheetsDir: resolve(site, 'styles'),
      scriptsDir: resolve(site, 'js'),
      usernameIsEmail: false,
      applicationUrl: 'https://example.com',
      allowMemberRegistration: true,
      memberRegistrationType: 'Customer',
      memberRegistrationGroups: ['Buyers', 'Friends'],
      memberSessionMinutes: 60,
      maxFailedPasswordAttempts: 0,
      remote: {
        enabled: true,
        environment: 'staging',
        protected: false,
        approvals: true,
        maxUploadBytes: 1024 ** 3,
      },
      trackRedirects: false,
      applyBundleContentOnInstall: false,
      runtimeInstalls: false,
      seo: { sitemap: false, indexable: false },
      deliveryApi: { enabled: true, apiKey: 'key', publicAccess: false, media: { enabled: true } },
      marketplaceUrl: 'https://market.example.com',
      packageKeyword: 'acme-bundle',
      npmRegistry: 'https://npm.example.com',
    })
  })

  test('odd values fall back the way they always have', () => {
    setEnv({
      CROMBOLO_MAX_REQUEST_BODY_MB: '',
      CROMBOLO_REMOTE_ENVIRONMENT: '',
      CROMBOLO_DELIVERY_API_KEY: '',
      CROMBOLO_DELIVERY_API: 'yes',
      CROMBOLO_AUDIT_RETENTION_DAYS: '-1',
      CROMBOLO_LOG_LEVEL: 'loud',
      CROMBOLO_HEAP_INTERVAL_SECONDS: 'soon',
      CROMBOLO_ROLE: '',
      CROMBOLO_DB: 'mysql',
      CROMBOLO_UPGRADE_POLICY: 'whatever',
      CROMBOLO_LOCAL_ADMIN: 'yes',
      CROMBOLO_COMPONENTS_GATE_MS: '',
    })
    const config = loadConfig({}, site)
    expect(config.maxRequestBodyBytes).toBe(32 * 1024 * 1024)
    expect(config.remote.environment).toBe('production')
    expect(config.deliveryApi.apiKey).toBeUndefined()
    expect(config.deliveryApi.enabled).toBe(true)
    expect(config.auditRetentionDays).toBe(365)
    expect(config.logLevel).toBe('info')
    expect(config.diagnostics.heapIntervalSeconds).toBe(0)
    expect(config.role).toBe('all')
    expect(config.dialect).toBe('sqlite')
    expect(config.upgradePolicy).toBe('strict')
    expect(config.localAdmin).toBe(false)
    expect(config.componentsSnapshot).toEqual({})
  })

  test('an empty PORT is read as it always was', () => {
    setEnv({ PORT: '' })
    expect(loadConfig({}, site).port).toBe(0)
  })

  test('half an API client is refused', () => {
    setEnv({ CROMBOLO_API_CLIENT_ID: 'crombolo-back-office-ci' })
    expect(() => loadConfig({}, site)).toThrow(/go together/)
  })

  test('explicit values win over the environment, field by field', () => {
    setEnv({
      CROMBOLO_SITE_NAME: 'From env',
      CROMBOLO_SITEMAP: 'false',
      CROMBOLO_REMOTE_ENABLED: 'true',
      CROMBOLO_DELIVERY_API_MEDIA: 'true',
    })
    const config = loadConfig(
      {
        siteName: 'Explicit',
        seo: { titleSuffix: ' | Acme' },
        remote: { environment: 'staging' } as never,
        deliveryApi: { enabled: true },
      },
      site,
    )
    expect(config.siteName).toBe('Explicit')
    expect(config.seo).toEqual({ sitemap: false, titleSuffix: ' | Acme' })
    expect(config.remote.enabled).toBe(true)
    expect(config.remote.environment).toBe('staging')
    expect(config.deliveryApi).toMatchObject({ enabled: true, media: { enabled: true } })
  })

  test('a schema store makes the schema writable and runtime installs off, unless set', () => {
    const store = {} as never
    setEnv({ NODE_ENV: 'production' })
    let config = loadConfig({ schemaStore: store }, site)
    expect(config.schemaWritable).toBe(true)
    expect(config.runtimeInstalls).toBe(false)
    setEnv({ CROMBOLO_SCHEMA_WRITABLE: 'false', CROMBOLO_RUNTIME_INSTALLS: 'true' })
    config = loadConfig({ schemaStore: store }, site)
    expect(config.schemaWritable).toBe(false)
    expect(config.runtimeInstalls).toBe(true)
  })

  test('the database description prefers the crombolo URL, then DATABASE_URL', () => {
    const postgres = { dialect: 'postgres' as const, sqliteFile: 'x' }
    expect(describeDatabase(postgres)).toBe('postgres')
    setEnv({ DATABASE_URL: 'postgres://u:p@other:5432/b' })
    expect(describeDatabase(postgres)).toBe('postgres other:5432/b')
    setEnv({ CROMBOLO_POSTGRES_URL: 'postgres://u:p@db:5432/site' })
    expect(describeDatabase(postgres)).toBe('postgres db:5432/site')
  })
})
