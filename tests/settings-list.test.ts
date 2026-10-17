import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  type CromboloConfig,
  loadConfig,
  SETTING_SECTIONS,
  SETTINGS,
  setting,
  settingsMarkdown,
} from '@crombolo/server'

const ROOT = join(import.meta.dir, '..')

/** Names the code mentions that are not settings anyone sets. */
const NOT_SETTINGS: Record<string, string> = {
  CROMBOLO_DATA_TYPES: 'a constant: the data types crombolo seeds',
  CROMBOLO_BACKUP_STAMP: 'given to the backup command, not read',
  CROMBOLO_BACKUP_REASON: 'given to the backup command, not read',
  CROMBOLO_PORT: "the container stack's published port, read by compose.yaml",
  CROMBOLO_EMAIL_SES_: 'the family of SES variables, named in a comment',
  KEY: 'an example inside a comment',
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name)) found.push(path)
  }
  return found
}

function scan(): { named: Map<string, string>; read: Map<string, string> } {
  const named = new Map<string, string>()
  const read = new Map<string, string>()
  const packages = join(ROOT, 'packages')
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, 'src')
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8')
      const where = relative(ROOT, file)
      for (const [name] of text.matchAll(/CROMBOLO_[A-Z0-9_]+/g)) named.set(name, where)
      for (const match of text.matchAll(
        /\benv(?:\.([A-Z][A-Z0-9_]+)\b|\[['"]([A-Z][A-Z0-9_]+)['"]\])/g,
      )) {
        const name = (match[1] ?? match[2]) as string
        if (!name.startsWith('CROMBOLO_')) read.set(name, where)
      }
      for (const [, name] of text.matchAll(/\bsetting\('([A-Z][A-Z0-9_]+)'\)/g))
        if (!name?.startsWith('CROMBOLO_')) read.set(name as string, where)
    }
  }
  return { named, read }
}

describe('the settings list and the code agree', () => {
  const { named, read } = scan()
  const declared = new Set(SETTINGS.map((entry) => entry.env))

  test('every variable the code names is declared', () => {
    const undeclared = [...named.keys(), ...read.keys()]
      .filter((name) => !declared.has(name) && !(name in NOT_SETTINGS))
      .map((name) => `${name} (${named.get(name) ?? read.get(name)})`)
    expect(undeclared).toEqual([])
  })

  test('every declared variable is read somewhere', () => {
    const unread = [...declared].filter((name) =>
      name.startsWith('CROMBOLO_') ? !named.has(name) : !read.has(name),
    )
    expect(unread).toEqual([])
  })

  test('nothing ignored is also declared, and everything ignored still appears', () => {
    for (const name of Object.keys(NOT_SETTINGS)) {
      expect(declared.has(name)).toBe(false)
      expect(named.has(name) || read.has(name)).toBe(true)
    }
  })
})

describe('the settings list', () => {
  test('names are unique, sections known and enums complete', () => {
    expect(new Set(SETTINGS.map((entry) => entry.env)).size).toBe(SETTINGS.length)
    for (const entry of SETTINGS) {
      expect(SETTING_SECTIONS).toContain(entry.section)
      expect(entry.description.length).toBeGreaterThan(0)
      if (entry.kind === 'enum') {
        expect(entry.values?.length ?? 0).toBeGreaterThan(1)
        if (entry.default && !/\s/.test(entry.default))
          expect(entry.values).toContain(entry.default)
      } else expect(entry.values).toBeUndefined()
      expect(entry.description).not.toMatch(/\bstory \d|docs\/|packages\//)
    }
    for (const section of SETTING_SECTIONS)
      expect(SETTINGS.some((entry) => entry.section === section)).toBe(true)
  })

  describe('defaults match what loadConfig does with nothing set', () => {
    const OWNED = /^(CROMBOLO_|PORT$|NODE_ENV$|DATABASE_URL$)/
    let saved: Record<string, string | undefined> = {}
    beforeEach(() => {
      saved = { ...Bun.env }
      for (const key of Object.keys(Bun.env)) if (OWNED.test(key)) delete Bun.env[key]
    })
    afterEach(() => {
      for (const [key, value] of Object.entries(saved))
        if (OWNED.test(key) && value !== undefined) Bun.env[key] = value
    })

    const site = '/srv/site'
    const fields: Record<string, (config: CromboloConfig) => unknown> = {
      PORT: (c) => c.port,
      CROMBOLO_SITE_NAME: (c) => c.siteName,
      CROMBOLO_ROLE: (c) => c.role,
      CROMBOLO_MAX_REQUEST_BODY_MB: (c) => c.maxRequestBodyBytes / 1024 ** 2,
      CROMBOLO_INSECURE_COOKIES: (c) => !c.secureCookies,
      CROMBOLO_DB: (c) => c.dialect,
      CROMBOLO_SQLITE_FILE: (c) => relative(site, c.sqliteFile),
      CROMBOLO_VERSION_CLEANUP: (c) => c.versionCleanup.enabled,
      CROMBOLO_VERSION_CLEANUP_KEEP_ALL_DAYS: (c) => c.versionCleanup.keepAllVersionsNewerThanDays,
      CROMBOLO_VERSION_CLEANUP_KEEP_LATEST_DAYS: (c) =>
        c.versionCleanup.keepLatestVersionPerDayForDays,
      CROMBOLO_AUDIT_RETENTION_DAYS: (c) => c.auditRetentionDays,
      CROMBOLO_ADMIN_LOGIN: (c) => c.adminLogin,
      CROMBOLO_LOCAL_ADMIN: (c) => c.localAdmin,
      CROMBOLO_USERNAME_IS_EMAIL: (c) => c.usernameIsEmail,
      CROMBOLO_BACKOFFICE_PATH: (c) => c.backOfficePath,
      CROMBOLO_CSS_DIR: (c) => relative(site, c.stylesheetsDir),
      CROMBOLO_SCRIPTS_DIR: (c) => relative(site, c.scriptsDir),
      CROMBOLO_APPLY_BUNDLE_CONTENT: (c) => c.applyBundleContentOnInstall,
      CROMBOLO_MARKETPLACE_URL: (c) => c.marketplaceUrl,
      CROMBOLO_PACKAGE_KEYWORD: (c) => c.packageKeyword,
      CROMBOLO_NPM_REGISTRY: (c) => c.npmRegistry,
      CROMBOLO_SCHEMA_DIR: (c) => relative(site, c.schemaDir),
      CROMBOLO_SCHEMA_REVISION: (c) => c.schemaRevision,
      CROMBOLO_SYNC_SCHEMA_AT_BOOT: (c) => c.syncSchemaAtBoot,
      CROMBOLO_COMPONENTS_DIR: (c) => relative(site, c.componentsDir),
      CROMBOLO_COMPONENTS_CACHE_DIR: (c) => relative(site, c.componentsCacheDir),
      CROMBOLO_RENDER_TIMEOUT_MS: (c) => c.renderTimeoutMs,
      CROMBOLO_MEDIA_DIR: (c) => relative(site, c.mediaDir),
      CROMBOLO_ALLOW_MEMBER_REGISTRATION: (c) => c.allowMemberRegistration,
      CROMBOLO_MEMBER_REGISTRATION_TYPE: (c) => c.memberRegistrationType,
      CROMBOLO_MEMBER_SESSION_MINUTES: (c) => c.memberSessionMinutes,
      CROMBOLO_MAX_FAILED_PASSWORD_ATTEMPTS: (c) => c.maxFailedPasswordAttempts,
      CROMBOLO_INDEXABLE: (c) => c.seo.indexable ?? true,
      CROMBOLO_SITEMAP: (c) => c.seo.sitemap ?? true,
      CROMBOLO_TRACK_REDIRECTS: (c) => c.trackRedirects,
      CROMBOLO_DELIVERY_API: (c) => c.deliveryApi.enabled ?? false,
      CROMBOLO_DELIVERY_API_PUBLIC: (c) => c.deliveryApi.publicAccess ?? true,
      CROMBOLO_DELIVERY_API_MEDIA: (c) => c.deliveryApi.media?.enabled ?? false,
      CROMBOLO_REMOTE_ENABLED: (c) => c.remote.enabled,
      CROMBOLO_REMOTE_ENVIRONMENT: (c) => c.remote.environment,
      CROMBOLO_REMOTE_PROTECTED: (c) => c.remote.protected,
      CROMBOLO_REMOTE_APPROVALS: (c) => c.remote.approvals,
      CROMBOLO_REMOTE_MAX_UPLOAD_GB: (c) => c.remote.maxUploadBytes / 1024 ** 3,
      CROMBOLO_LOGS_DIR: (c) => relative(site, c.logsDir),
      CROMBOLO_LOG_LEVEL: (c) => c.logLevel,
      CROMBOLO_LOG_TO_CONSOLE: (c) => c.logToConsole,
      CROMBOLO_TRACE_REQUESTS: (c) => c.diagnostics.traceRequests,
      CROMBOLO_HEAP_INTERVAL_SECONDS: (c) => c.diagnostics.heapIntervalSeconds,
    }

    test.each(Object.entries(fields))('%s', (name, field) => {
      const declared = SETTINGS.find((entry) => entry.env === name)
      expect(declared?.default).toBeDefined()
      expect(String(field(loadConfig({}, site)))).toBe(declared?.default as string)
    })
  })
})

describe('setting', () => {
  test('reads the environment as it is now', () => {
    const previous = Bun.env.CROMBOLO_SITE_NAME
    try {
      Bun.env.CROMBOLO_SITE_NAME = 'Now'
      expect(setting('CROMBOLO_SITE_NAME')).toBe('Now')
      delete Bun.env.CROMBOLO_SITE_NAME
      expect(setting('CROMBOLO_SITE_NAME')).toBeUndefined()
    } finally {
      if (previous === undefined) delete Bun.env.CROMBOLO_SITE_NAME
      else Bun.env.CROMBOLO_SITE_NAME = previous
    }
  })

  test('refuses a name the list does not declare', () => {
    expect(() => setting('CROMBOLO_NOT_A_SETTING' as never)).toThrow(/not a declared setting/)
  })
})

describe('settingsMarkdown', () => {
  const markdown = settingsMarkdown()

  test('has a table per section, in order, with every setting once', () => {
    const headings = [...markdown.matchAll(/^### (.+)$/gm)].map((match) => match[1])
    expect(headings).toEqual([...SETTING_SECTIONS])
    for (const entry of SETTINGS)
      expect(markdown.split(`\n| \`${entry.env}\` |`).length - 1).toBe(1)
  })

  test('shows values, defaults and notes', () => {
    expect(markdown).toContain('| `CROMBOLO_DB` | `sqlite`, `postgres` | `sqlite` |')
    expect(markdown).toContain('| `CROMBOLO_SITEMAP` | `true` / `false` | `true` |')
    expect(markdown).toMatch(/\| `CROMBOLO_POSTGRES_URL` \| string \| — \| [^\n]*never printed/)
    expect(markdown).toMatch(/\| `CROMBOLO_ACTOR` \|[^\n]*Read by the command line\./)
  })

  test('is what docs/configuration.md carries', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'configuration.md'), 'utf8')
    const region = doc.match(/<!-- settings:start -->([\s\S]*?)<!-- settings:end -->/)
    expect(region, 'docs/configuration.md has lost its settings markers').not.toBeNull()
    expect(region?.[1]?.trim(), 'run `bun run docs:config`').toBe(markdown)
  })
})
