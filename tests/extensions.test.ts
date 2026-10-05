/**
 * Backoffice extensions as npm dependencies, which replaced `App_Plugins`.
 * docs/17-packages.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectManifests,
  createBackOfficePaths,
  createExtensionRegistry,
  discoverExtensions,
  EXTENSION_KEYWORD,
  EXTENSION_PATH,
  resolveExtensionFile,
  resolvePackageDir,
  resolveStaticFile,
} from '@bunbraco/backoffice-host'
import { warnAboutAppPlugins } from '@bunbraco/server'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const dirs: string[] = []
const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

interface FixturePackage {
  /** What goes in the dependency's own package.json. */
  json: Record<string, unknown>
  /** Files to write inside the package, by relative path. */
  files?: Record<string, string>
}

/**
 * A site directory with a package.json and a node_modules holding the fixtures.
 *
 * Under `output/` rather than the system temp directory: a site's views cache
 * has to resolve `bunbraco/jsx-runtime` by walking up to a `node_modules` that
 * carries it, which nothing outside the repository tree can do.
 */
function siteWith(
  dependencies: Record<string, FixturePackage>,
  options: { declared?: string[] } = {},
): string {
  const parent = join(import.meta.dir, '..', 'output')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'extension-site-'))
  dirs.push(root)
  // Its own empty views tree. Nothing here renders a page, and the suite's
  // shared `output/test-views` is written to by other files as they run — so
  // snapshotting it would put these fixtures in the way of tests that do render.
  mkdirSync(join(root, 'Views'), { recursive: true })
  const declared = options.declared ?? Object.keys(dependencies)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'a-site',
      dependencies: Object.fromEntries(declared.map((name) => [name, '^1.0.0'])),
    }),
  )
  for (const [name, fixture] of Object.entries(dependencies)) {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.2.3', ...fixture.json }),
    )
    for (const [path, content] of Object.entries(fixture.files ?? {})) {
      const file = join(dir, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, content)
    }
  }
  return root
}

const extension = (over: Record<string, unknown> = {}) => ({
  bunbraco: {
    id: 'Acme.Seo',
    extensions: [
      { type: 'dashboard', alias: 'Acme.Dashboard.Seo', name: 'SEO', element: 'dist/seo.js' },
    ],
    ...over,
  },
})

describe('discovery', () => {
  test('finds a dependency that declares extensions', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    const found = discoverExtensions(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.packageName).toBe('@acme/seo')
    expect(found[0]?.version).toBe('1.2.3')
    expect(found[0]?.manifest.id).toBe('Acme.Seo')
  })

  test('ignores a dependency that declares nothing', () => {
    const root = siteWith({ lodash: { json: {} }, '@acme/seo': { json: extension() } })
    expect(discoverExtensions(root).map((e) => e.packageName)).toEqual(['@acme/seo'])
  })

  test('ignores an empty extensions array, which declares nothing either', () => {
    const root = siteWith({ '@acme/seo': { json: { bunbraco: { extensions: [] } } } })
    expect(discoverExtensions(root)).toEqual([])
  })

  /**
   * The point of reading `dependencies` rather than walking `node_modules`: a
   * package someone else depends on cannot put a dashboard in this backoffice.
   */
  test('ignores an installed package the site does not declare', () => {
    const root = siteWith(
      {
        '@acme/seo': { json: extension() },
        '@other/sneaky': { json: extension({ id: 'Sneaky' }) },
      },
      { declared: ['@acme/seo'] },
    )
    expect(discoverExtensions(root).map((e) => e.packageName)).toEqual(['@acme/seo'])
  })

  test('a site with no package.json has no extensions, and does not throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunbraco-bare-'))
    dirs.push(root)
    expect(discoverExtensions(root)).toEqual([])
  })

  test('a site whose dependency is not installed has no extensions', () => {
    const root = siteWith({}, { declared: ['@acme/never-installed'] })
    expect(discoverExtensions(root)).toEqual([])
  })

  test('a malformed package.json is ignored rather than fatal', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    writeFileSync(join(root, 'node_modules', '@acme/seo', 'package.json'), '{ not json')
    expect(discoverExtensions(root)).toEqual([])
  })

  test('resolves a dependency hoisted to a parent node_modules', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    const nested = join(root, 'apps', 'site')
    mkdirSync(nested, { recursive: true })
    writeFileSync(
      join(nested, 'package.json'),
      JSON.stringify({ name: 'nested', dependencies: { '@acme/seo': '^1.0.0' } }),
    )
    expect(discoverExtensions(nested).map((e) => e.packageName)).toEqual(['@acme/seo'])
  })

  test('refuses a dependency name that tries to climb out of node_modules', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    expect(resolvePackageDir(root, '../../etc')).toBeUndefined()
    expect(resolvePackageDir(root, '/etc/passwd')).toBeUndefined()
  })
})

describe('asset paths', () => {
  test('a package-relative element path becomes a /packages path', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    const manifest = discoverExtensions(root)[0]?.manifest
    const first = manifest?.extensions[0] as { element: string }
    expect(first.element).toBe(`${EXTENSION_PATH}/@acme/seo/dist/seo.js`)
  })

  test('rewrites api and js, and leaves labels alone', () => {
    const root = siteWith({
      tool: {
        json: {
          bunbraco: {
            extensions: [
              {
                type: 'propertyEditorUi',
                alias: 'Tool.Editor',
                name: 'dist/not-a-path-but-a-name',
                element: './dist/ui.js',
                api: 'dist/api.js',
                js: '/already/absolute.js',
                meta: { label: 'dist/also-a-label' },
              },
            ],
          },
        },
      },
    })
    const first = discoverExtensions(root)[0]?.manifest.extensions[0] as Record<string, unknown>
    expect(first.element).toBe(`${EXTENSION_PATH}/tool/dist/ui.js`)
    expect(first.api).toBe(`${EXTENSION_PATH}/tool/dist/api.js`)
    // An absolute path is the package's own business, and is left as it is.
    expect(first.js).toBe('/already/absolute.js')
    expect(first.name).toBe('dist/not-a-path-but-a-name')
    expect((first.meta as { label: string }).label).toBe('dist/also-a-label')
  })

  test('rewrites an importmap target', () => {
    const root = siteWith({
      tool: {
        json: {
          bunbraco: {
            extensions: [{ type: 'dashboard', alias: 'a', name: 'a', element: 'a.js' }],
            importmap: { imports: { '@acme/lib': 'dist/lib.js' } },
          },
        },
      },
    })
    expect(discoverExtensions(root)[0]?.manifest.importmap?.imports['@acme/lib']).toBe(
      `${EXTENSION_PATH}/tool/dist/lib.js`,
    )
  })
})

describe('serving an extension file', () => {
  const found = (root: string) => discoverExtensions(root)

  test('serves a file from inside the package', () => {
    const root = siteWith({
      '@acme/seo': { json: extension(), files: { 'dist/seo.js': 'export default 1' } },
    })
    const file = resolveExtensionFile(found(root), `${EXTENSION_PATH}/@acme/seo/dist/seo.js`)
    expect(file).toBe(join(root, 'node_modules', '@acme/seo', 'dist', 'seo.js'))
  })

  test('refuses a path that escapes the package', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    for (const attack of [
      `${EXTENSION_PATH}/@acme/seo/../../../../etc/passwd`,
      `${EXTENSION_PATH}/@acme/seo/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
    ])
      expect(resolveExtensionFile(found(root), attack)).toBeUndefined()
  })

  /** Otherwise `/packages/` would be a file server over the whole of node_modules. */
  test('refuses a package that is not a declared extension', () => {
    const root = siteWith(
      { '@acme/seo': { json: extension() }, lodash: { json: {} } },
      { declared: ['@acme/seo', 'lodash'] },
    )
    expect(resolveExtensionFile(found(root), `${EXTENSION_PATH}/lodash/index.js`)).toBeUndefined()
  })

  test('finds a scoped package whose @ arrived percent-encoded', () => {
    const root = siteWith({
      '@acme/seo': { json: extension(), files: { 'dist/seo.js': 'export default 1' } },
    })
    expect(resolveExtensionFile(found(root), `${EXTENSION_PATH}/%40acme/seo/dist/seo.js`)).toBe(
      join(root, 'node_modules', '@acme/seo', 'dist', 'seo.js'),
    )
  })

  test('refuses a malformed percent escape rather than throwing', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    expect(resolveExtensionFile(found(root), `${EXTENSION_PATH}/%E0%A4%A/seo.js`)).toBeUndefined()
  })

  test('refuses a bare package name with no file, and a foreign path', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    expect(resolveExtensionFile(found(root), `${EXTENSION_PATH}/@acme/seo`)).toBeUndefined()
    expect(resolveExtensionFile(found(root), '/elsewhere/file.js')).toBeUndefined()
  })

  test('the static resolver serves it, and App_Plugins is gone', () => {
    const root = siteWith({
      '@acme/seo': { json: extension(), files: { 'dist/seo.js': 'export default 1' } },
    })
    const paths = createBackOfficePaths()
    const match = resolveStaticFile(paths, `${EXTENSION_PATH}/@acme/seo/dist/seo.js`, {
      extensions: found(root),
    })
    expect(match?.file).toBe(join(root, 'node_modules', '@acme/seo', 'dist', 'seo.js'))
    expect(match?.cacheControl).toBe('no-cache')
    expect(
      resolveStaticFile(paths, '/App_Plugins/@acme/seo/dist/seo.js', { extensions: found(root) }),
    ).toBeUndefined()
  })
})

describe('the registry', () => {
  test('memoizes, and a new install is seen after invalidate', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    const registry = createExtensionRegistry(root)
    expect(registry.list()).toHaveLength(1)

    const added = join(root, 'node_modules', 'later')
    mkdirSync(added, { recursive: true })
    writeFileSync(
      join(added, 'package.json'),
      JSON.stringify({ name: 'later', version: '2.0.0', ...extension({ id: 'Later' }) }),
    )
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'a-site', dependencies: { '@acme/seo': '^1', later: '^2' } }),
    )
    expect(registry.list()).toHaveLength(1)
    registry.invalidate()
    expect(registry.list()).toHaveLength(2)
  })

  test('reads the disk every time when caching is off, which development needs', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    const registry = createExtensionRegistry(root, { cache: false })
    expect(registry.list()).toHaveLength(1)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'a-site', dependencies: {} }))
    expect(registry.list()).toHaveLength(0)
  })
})

describe('manifests', () => {
  test('an installed extension joins the framework manifests', () => {
    const root = siteWith({ '@acme/seo': { json: extension() } })
    const set = collectManifests(createBackOfficePaths(), discoverExtensions(root))
    expect(set.all.some((manifest) => manifest.id === 'Acme.Seo')).toBe(true)
    // And the framework's own is still there.
    expect(set.all.some((manifest) => manifest.id === 'Bunbraco.Core')).toBe(true)
  })

  test('the keyword packages publish is the one the docs name', () => {
    expect(EXTENSION_KEYWORD).toBe('bunbraco-package')
  })
})

describe('over HTTP', () => {
  test('the manifest endpoint carries an installed extension, and its file is served', async () => {
    const root = siteWith({
      '@acme/seo': {
        json: extension(),
        files: { 'dist/seo.js': 'export default class {}' },
      },
    })
    const h = await signedInServer({ config: { siteDir: root, viewsDir: join(root, 'Views') } })
    open.push(h)

    const manifests = await h.json<Array<{ id?: string | null }>>(`${V1}/manifest/manifest`)
    expect(manifests.some((manifest) => manifest.id === 'Acme.Seo')).toBe(true)

    const asset = await h.call(`${EXTENSION_PATH}/@acme/seo/dist/seo.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('export default class {}')
  })

  test('a file outside a declared extension is a 404', async () => {
    const root = siteWith(
      { '@acme/seo': { json: extension() }, lodash: { json: {} } },
      { declared: ['@acme/seo', 'lodash'] },
    )
    const h = await signedInServer({ config: { siteDir: root, viewsDir: join(root, 'Views') } })
    open.push(h)
    expect((await h.call(`${EXTENSION_PATH}/lodash/package.json`)).status).toBe(404)
  })
})

describe('the App_Plugins notice', () => {
  const log = () => {
    const warnings: Array<{ message: string; properties?: Record<string, unknown> }> = []
    return {
      warnings,
      warning: (message: string, properties?: Record<string, unknown>) =>
        warnings.push({ message, properties }),
    }
  }

  test('warns when a site still has files in App_Plugins', () => {
    const root = siteWith({})
    mkdirSync(join(root, 'App_Plugins', 'old-package'), { recursive: true })
    writeFileSync(join(root, 'App_Plugins', 'old-package', 'umbraco-package.json'), '{}')
    const sink = log()
    warnAboutAppPlugins(root, sink)
    expect(sink.warnings).toHaveLength(1)
    expect(sink.warnings[0]?.message).toContain('no longer read')
    expect(sink.warnings[0]?.properties?.count).toBe(1)
  })

  test('says nothing when the directory is absent or empty', () => {
    const root = siteWith({})
    const absent = log()
    warnAboutAppPlugins(root, absent)
    expect(absent.warnings).toEqual([])

    mkdirSync(join(root, 'App_Plugins'), { recursive: true })
    writeFileSync(join(root, 'App_Plugins', '.gitkeep'), '')
    const empty = log()
    warnAboutAppPlugins(root, empty)
    expect(empty.warnings).toEqual([])
  })
})
