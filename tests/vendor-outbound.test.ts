/**
 * The vendored back office sends nothing anywhere on its own: Umbraco's telemetry
 * consent dashboard is not shipped, and no module phones out to another host.
 * docs/backoffice-hosting.md, "Nothing sent out".
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyPatch, EXCLUDED_PACKAGES, UPSTREAM_PATCHES } from '../scripts/vendor-backoffice.ts'

const ROOT = join(import.meta.dir, '..')
const VENDOR = join(ROOT, 'packages/backoffice-dist/dist')
const UPSTREAM = join(ROOT, 'node_modules/@umbraco-cms/backoffice/dist-cms')
const PLUGIN = join(ROOT, 'packages/backoffice-host/plugin')
const vendored = existsSync(join(VENDOR, 'umbraco-package.json'))

/** A request the browser makes by itself to an absolute address. */
const OUTBOUND_CALLS = [
  /\.sendBeacon\(/,
  /\bfetch\(\s*['"`](?:https?:)?\/\//,
  /\bnew\s+(?:WebSocket|EventSource|Worker)\(\s*['"`](?:wss?:|https?:)?\/\//,
  /\.open\(\s*['"`]\w+['"`]\s*,\s*['"`](?:https?:)?\/\//,
  /\bimportScripts\(\s*['"`](?:https?:)?\/\//,
  /\bimport\(\s*['"`](?:https?:)?\/\//,
  /<(?:script|img|iframe|link)\b[^>]*\b(?:src|href)=["'](?:https?:)?\/\//,
]

/** Analytics and telemetry collectors; none has a reason to appear at all. */
const COLLECTORS =
  /telemetry\.umbraco\.com|google-analytics\.com|googletagmanager\.com|segment\.(?:io|com)|sentry\.io|mixpanel\.com|posthog\.com|plausible\.io|hotjar\.com/

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const modules = () =>
  [...new Bun.Glob('**/*.js').scanSync({ cwd: VENDOR })].filter(
    (file) =>
      // TypeScript's own DOM declarations, which the code editor's TypeScript
      // worker carries for completions, describe `sendBeacon` without calling it.
      file !== 'deps/monaco-workers/typescript.js' && !file.startsWith('assets/lang/'),
  )

describe('the screens for what this server has not got are left out at vendor time', () => {
  test('each excluded package is loaded by the client, and the patch stops it', () => {
    const appEntry = readFileSync(join(UPSTREAM, 'apps/app/app.element.js'), 'utf8')
    for (const name of EXCLUDED_PACKAGES) {
      const line = `import('../../packages/${name}/umbraco-package.js')`
      expect(appEntry).toContain(line)
      const patch = UPSTREAM_PATCHES.find((each) => each.find.includes(line))
      expect(patch).toBeDefined()
      expect(applyPatch(appEntry, patch as (typeof UPSTREAM_PATCHES)[number])).not.toContain(line)
    }
  })

  test('telemetry, profiling and the umbraco.com news feed are among them', () => {
    expect([...EXCLUDED_PACKAGES].sort()).toEqual([
      'performance-profiling',
      'telemetry',
      'umbraco-news',
    ])
  })
})

describe.skipIf(!vendored)('the vendored back office sends nothing out', () => {
  test('carries no excluded package', () => {
    for (const name of EXCLUDED_PACKAGES)
      expect(existsSync(join(VENDOR, 'packages', name))).toBe(false)
  })

  test('registers no telemetry, profiling or news dashboard', () => {
    const excluded =
      /Umb\.(?:Dashboard|Bundle)\.(?:Telemetry|Profiling|PerformanceProfiling|UmbracoNews)\b|packages\/(?:telemetry|performance-profiling|umbraco-news)\/|dashboard-telemetry|dashboard-performance-profiling|umbraco-news-dashboard/
    const offenders = [...new Bun.Glob('**/*.js').scanSync({ cwd: VENDOR })].filter((file) =>
      excluded.test(readFileSync(join(VENDOR, file), 'utf8')),
    )
    expect(offenders).toEqual([])
  }, 60_000)

  test('no module requests another host by itself', () => {
    const offenders: string[] = []
    for (const file of modules()) {
      const source = withoutComments(readFileSync(join(VENDOR, file), 'utf8'))
      for (const pattern of OUTBOUND_CALLS) {
        const match = source.match(pattern)
        if (match) offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  }, 60_000)

  test('no module, dictionary or worker names an analytics collector', () => {
    const offenders = [...new Bun.Glob('**/*.js').scanSync({ cwd: VENDOR })].filter((file) =>
      COLLECTORS.test(readFileSync(join(VENDOR, file), 'utf8')),
    )
    expect(offenders).toEqual([])
  }, 60_000)
})

describe("crombolo's own back office plugin", () => {
  test('requests no other host by itself', () => {
    const offenders: string[] = []
    for (const file of new Bun.Glob('**/*.js').scanSync({ cwd: PLUGIN })) {
      const source = withoutComments(readFileSync(join(PLUGIN, file), 'utf8'))
      for (const pattern of OUTBOUND_CALLS) {
        const match = source.match(pattern)
        if (match) offenders.push(`${file}: ${match[0]}`)
      }
      if (COLLECTORS.test(source)) offenders.push(`${file}: names a collector`)
    }
    expect(offenders).toEqual([])
  })
})

describe('the patterns catch what they are for', () => {
  test.each([
    'navigator.sendBeacon("/x", data)',
    "fetch('https://telemetry.example/v1', { method: 'POST' })",
    'fetch(`//stats.example/p`)',
    "xhr.open('POST', 'https://stats.example/p')",
    "new WebSocket('wss://stats.example')",
    'html`<img src="https://stats.example/pixel.gif">`',
  ])('%s', (source) => {
    expect(OUTBOUND_CALLS.some((pattern) => pattern.test(source))).toBe(true)
  })

  test.each([
    "fetch('/umbraco/management/api/v1/server/status')",
    'html`<a href="https://example.com" target="_blank">Docs</a>`',
    "xhr.open('POST', url)",
  ])('not %s', (source) => {
    expect(OUTBOUND_CALLS.some((pattern) => pattern.test(source))).toBe(false)
  })
})
