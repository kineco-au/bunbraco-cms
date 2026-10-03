import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DATA_TYPES } from '@bunbraco/data'
import { checkModuleGraph } from '../scripts/check-module-graph.ts'
import { BACKOFFICE_BASE_PATH, createImportMap } from '../scripts/vendor-backoffice.ts'

const ROOT = join(import.meta.dir, '..')
const VENDOR = join(ROOT, 'packages/backoffice-dist/dist')
const PLUGIN = join(ROOT, 'packages/backoffice-host/plugin')
const vendored = existsSync(join(VENDOR, 'umbraco-package.json'))

/** Files the SPA shell references directly; if any is missing, nothing boots. */
const SHELL_REFERENCES = [
  'apps/app/app.element.js',
  'css/umb-css.css',
  'css/light.css',
  'css/dark.css',
  'css/high-contrast.css',
  'assets/lang/en.js',
  'assets/lang/en-us.js',
]

/**
 * Referenced by the shells, and deliberately absent from the vendored tree: these
 * are Umbraco's own marks, which MIT does not license, so `BRANDED_ASSETS` serves
 * bunbraco's at these paths and the vendored originals are not redistributed.
 * `tests/backoffice-host.test.ts` is where the substitution itself is asserted.
 */
const BRANDED_REFERENCES = [
  'assets/favicon.svg',
  'assets/umbraco-logo.svg',
  'assets/installer-illustration.svg',
]

describe('createImportMap', () => {
  test('maps bare specifiers onto the served backoffice path', () => {
    const map = createImportMap({
      name: '@umbraco-cms/backoffice',
      exports: {
        '.': null,
        './auth': './dist-cms/packages/core/auth/index.js',
        './style': './dist-cms/packages/core/style/index.js',
      },
    })
    expect(map.imports).toEqual({
      '@umbraco-cms/backoffice/auth': `${BACKOFFICE_BASE_PATH}/packages/core/auth/index.js`,
      '@umbraco-cms/backoffice/style': `${BACKOFFICE_BASE_PATH}/packages/core/style/index.js`,
    })
    expect(map.dropped).toEqual([])
  })

  test('drops entries whose target was not produced', () => {
    // R6: monaco is not bundled, so advertising it would fail opaquely at runtime.
    const map = createImportMap(
      {
        name: '@umbraco-cms/backoffice',
        exports: {
          './auth': './dist-cms/packages/core/auth/index.js',
          './external/monaco-editor': './dist-cms/external/monaco-editor/index.js',
        },
      },
      (servedPath) => !servedPath.includes('monaco'),
    )
    expect(Object.keys(map.imports)).toEqual(['@umbraco-cms/backoffice/auth'])
    expect(map.dropped).toEqual(['@umbraco-cms/backoffice/external/monaco-editor'])
  })

  test('skips null and non-js exports, as upstream does', () => {
    const map = createImportMap({
      name: '@umbraco-cms/backoffice',
      exports: { '.': null, './css': './dist-cms/css/umb-css.css', './x': null },
    })
    expect(map.imports).toEqual({})
  })
})

/** Every `Umb.PropertyEditorUi.*` alias the vendored client registers. */
function registeredPropertyEditorUis(): Set<string> {
  const found = new Set<string>()
  for (const file of new Bun.Glob('**/*.js').scanSync(join(VENDOR, 'packages'))) {
    const text = readFileSync(join(VENDOR, 'packages', file), 'utf8')
    for (const m of text.matchAll(/["'](Umb\.PropertyEditorUi\.[A-Za-z0-9.]+)["']/g))
      found.add(m[1] as string)
  }
  return found
}

describe.skipIf(!vendored)('what the server ships, against the vendored client', () => {
  test('every built-in data type names a property editor UI the client registers', () => {
    // A mismatch shows in the editor as "The configured property editor UI could
    // not be found"; this catches it here, and again after an upstream upgrade.
    const registered = registeredPropertyEditorUis()
    const missing = DEFAULT_DATA_TYPES.filter((d) => !registered.has(d.editorUiAlias)).map(
      (d) => `${d.alias}: ${d.editorUiAlias}`,
    )
    expect(missing).toEqual([])
    // Walks the whole vendored client, as the module-graph test below does:
    // over a Docker bind mount the default 5 s timeout is not enough.
  }, 60_000)

  test('shared third-party code is vendored once, not copied into every bundle', () => {
    // ProseMirror refuses to mix copies of itself; each copy carries this message.
    // One copy means Tiptap and its extensions share one ProseMirror.
    const marker = 'Adding different instances of a keyed plugin'
    const copies = [...new Bun.Glob('**/*.js').scanSync(join(VENDOR, 'deps'))].filter((file) =>
      readFileSync(join(VENDOR, 'deps', file), 'utf8').includes(marker),
    )
    expect(copies).toHaveLength(1)
  })

  test('the fonts the UI library themes load are vendored beside them', () => {
    for (const theme of ['light.css', 'dark.css', 'high-contrast.css']) {
      const css = readFileSync(join(VENDOR, 'css', theme), 'utf8')
      for (const m of css.matchAll(/url\((\.\.\/assets\/fonts\/[^)]+)\)/g))
        expect([theme, m[1], existsSync(join(VENDOR, 'css', m[1] as string))]).toEqual([
          theme,
          m[1],
          true,
        ])
    }
  })
})

describe.skipIf(!vendored)('vendored backoffice', () => {
  test("the fonts umb-css.css loads, the code editor's icons among them, are served", () => {
    const css = readFileSync(join(VENDOR, 'css', 'umb-css.css'), 'utf8')
    const fonts = [...css.matchAll(/url\('?(\/umbraco\/backoffice\/[^')]+)'?\)/g)].map(
      (m) => m[1] as string,
    )
    expect(fonts).toContain('/umbraco/backoffice/assets/fonts/codicon/codicon.ttf')
    for (const font of fonts)
      expect([font, existsSync(join(VENDOR, font.slice(BACKOFFICE_BASE_PATH.length + 1)))]).toEqual(
        [font, true],
      )
  })

  test('contains every file the SPA shell references', () => {
    const missing = SHELL_REFERENCES.filter((f) => !existsSync(join(VENDOR, f)))
    expect(missing).toEqual([])
  })

  test("carries none of Umbraco's marks, which are served as bunbraco's instead", () => {
    // Not an oversight in the vendor step: the request for each of these is
    // intercepted before it reaches the vendored tree, so shipping the original
    // would redistribute a trademark for nothing.
    const present = BRANDED_REFERENCES.filter((f) => existsSync(join(VENDOR, f)))
    expect(present).toEqual([])
  })

  test('records the pinned upstream version', () => {
    const version = readFileSync(join(VENDOR, 'VERSION'), 'utf8').trim()
    expect(version).toBe('@umbraco-cms/backoffice@18.2.0')
  })

  test('import map resolves to files that actually exist', () => {
    const manifest = JSON.parse(readFileSync(join(VENDOR, 'umbraco-package.json'), 'utf8'))
    const imports: Record<string, string> = manifest.importmap.imports
    expect(Object.keys(imports).length).toBeGreaterThan(100)
    const dangling = Object.entries(imports)
      .filter(([, path]) => path.startsWith(BACKOFFICE_BASE_PATH))
      .filter(([, path]) => !existsSync(join(VENDOR, path.slice(BACKOFFICE_BASE_PATH.length + 1))))
      .map(([specifier]) => specifier)
    expect(dangling).toEqual([])
  })

  test('the manifest has the shape Umbraco expects', () => {
    const manifest = JSON.parse(readFileSync(join(VENDOR, 'umbraco-package.json'), 'utf8'))
    expect(manifest.name).toBe('@umbraco-cms/backoffice')
    expect(Array.isArray(manifest.extensions)).toBe(true)
    expect(manifest.importmap.imports).toBeDefined()
  })

  test('bundled externals contain no unresolved bare imports', () => {
    // This is the check that would have caught npm shipping re-export stubs:
    // `export * from "lit"` is unresolvable in a browser without an import map
    // entry, and there is none for third-party packages.
    const transpiler = new Bun.Transpiler({ loader: 'js' })
    const offenders: string[] = []
    for (const file of new Bun.Glob('external/*/index.js').scanSync({ cwd: VENDOR })) {
      const source = readFileSync(join(VENDOR, file), 'utf8')
      for (const imported of transpiler.scanImports(source)) {
        const path = imported.path
        if (!path.startsWith('.') && !path.startsWith('/')) {
          offenders.push(`${file} -> ${path}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('the externals the first slice needs are bundled and self-contained', () => {
    for (const name of ['lit', 'rxjs', 'uui']) {
      const file = join(VENDOR, 'external', name, 'index.js')
      expect(existsSync(file)).toBe(true)
      // A stub is a few hundred bytes; a real bundle is tens of kilobytes.
      expect(Bun.file(file).size).toBeGreaterThan(10_000)
    }
  })

  test('monaco and its workers are bundled', () => {
    // R6 was that monaco imports its workers with Vite's `?worker` suffix, which
    // Bun does not implement. The vendoring build translates both `?worker` and
    // `?inline` with a bundler plugin, so the code editor works.
    expect(existsSync(join(VENDOR, 'external/monaco-editor/index.js'))).toBe(true)
    for (const worker of ['editor', 'json', 'css', 'html', 'typescript']) {
      expect(existsSync(join(VENDOR, `deps/monaco-workers/${worker}.js`))).toBe(true)
    }
  })

  /**
   * Resolution is not linking. A browser also checks that every named import is
   * actually exported and that each module is valid ESM, and reports a failure as
   * "Export 'X' is not defined in module".
   *
   * This caught two real defects: Bun tree-shook `uuid`'s re-export barrel down to
   * an export clause whose bindings did not exist, and `packages/sysinfo` imported
   * a JSON module without an import attribute.
   */
  test('every module in the graph links', () => {
    const report = checkModuleGraph()
    expect(report.unparseable).toEqual([])
    expect(report.missingExports).toEqual([])
    expect(report.unresolved).toEqual([])
    // Guards against the walk silently collapsing to a handful of modules. The
    // count was over 6,000 before the client was bundled; what links now is the
    // import map's entry points and their shared chunks, not one file per
    // source module.
    expect(report.moduleCount).toBeGreaterThan(1000)
  }, 60_000)

  test('no module imports JSON, which a browser will not load without an attribute', () => {
    const offenders: string[] = []
    for (const file of new Bun.Glob('**/*.js').scanSync({ cwd: VENDOR })) {
      const source = readFileSync(join(VENDOR, file), 'utf8')
      if (/^\s*import\s+[^;]*from\s*['"][^'"]+\.json['"]/m.test(source)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  }, 60_000)

  test('the client is served as shared chunks, not one file per module', () => {
    // The npm package is tsc output: 7,557 files, of which a sign-in used to
    // fetch 4,583 — 12,964 requests once the three navigations of the login flow
    // each re-linked the graph. Bundling took that to 813. This fails if the
    // bundling stage stops running, which otherwise only shows up as a slow suite.
    const entry = readFileSync(join(VENDOR, 'apps/app/app.element.js'), 'utf8')
    expect(entry).toContain(`/${'chunks'}/`)
    expect([...new Bun.Glob('*.js').scanSync(join(VENDOR, 'chunks'))].length).toBeGreaterThan(100)
  })

  test('every import-map specifier is still a file of its own, for extensions to import', () => {
    // The import map is the public surface: an extension imports
    // `@umbraco-cms/backoffice/<x>` and the browser resolves it against the map.
    // Bundling must therefore keep an entry point at each mapped path — and
    // because those entry points share chunks, the specifier resolves to the same
    // instance the rest of the client uses rather than to a second copy.
    const manifest = JSON.parse(readFileSync(join(VENDOR, 'umbraco-package.json'), 'utf8'))
    const imports: Record<string, string> = manifest.importmap.imports
    const own = Object.entries(imports).filter(([, path]) => /\/(apps|packages|libs)\//.test(path))
    expect(own.length).toBeGreaterThan(100)
    const missing = own
      .filter(([, path]) => !existsSync(join(VENDOR, path.slice(BACKOFFICE_BASE_PATH.length + 1))))
      .map(([specifier]) => specifier)
    expect(missing).toEqual([])
  })

  test('every vendored module the plugin imports by URL is bundled, not raw', () => {
    // `tsx-editors.js` patches a class upstream does not export, by resolving the
    // package entry and walking to the module beside it. That path has to be an
    // entry point of the bundle: otherwise the URL serves the unbundled module,
    // the patch executes a second copy of that subtree, and the duplicate
    // redefines `umb-templating-insert-menu` — which the custom element registry
    // rejects as soon as the template editor opens.
    //
    // Derived from the plugin rather than restated, so adding another patch
    // without adding its entry point fails here instead of in the browser.
    const manifest = JSON.parse(readFileSync(join(VENDOR, 'umbraco-package.json'), 'utf8'))
    const imports: Record<string, string> = manifest.importmap.imports
    const pattern =
      /new URL\(\s*'([^']+)',\s*import\.meta\.resolve\('(@umbraco-cms\/backoffice\/[^']+)'\)/g

    const checked: string[] = []
    for (const file of new Bun.Glob('**/*.js').scanSync(PLUGIN)) {
      const source = readFileSync(join(PLUGIN, file), 'utf8')
      for (const [, relative, specifier] of source.matchAll(pattern)) {
        const target = imports[specifier as string]
        expect([specifier, target]).toEqual([specifier, expect.any(String)])
        const resolved = new URL(relative as string, `https://x${target}`).pathname
        const onDisk = join(VENDOR, resolved.slice(BACKOFFICE_BASE_PATH.length + 1))
        expect([resolved, existsSync(onDisk)]).toEqual([resolved, true])
        // A bundled entry links its chunks; the raw tsc output imports siblings.
        expect([resolved, readFileSync(onDisk, 'utf8').includes(`/${'chunks'}/`)]).toEqual([
          resolved,
          true,
        ])
        checked.push(resolved)
      }
    }
    // The pattern is the whole point of the test, so finding none is a failure.
    expect(checked.length).toBeGreaterThan(0)
  })

  test('bundling the client did not inline a second copy of lit', () => {
    // The client reaches lit by *relative* path 814 times, so bundling inlines a
    // copy unless each of those resolutions is rewritten back to the bare
    // specifier the import map serves. Two copies means two ReactiveElement base
    // classes and two directive registries: components silently fail to render
    // instead of raising anything, and lit's own warning for it ("Multiple
    // versions of Lit loaded") is the string matched here.
    //
    // The uui bundle carrying its own copy predates this and is asserted as-is,
    // so the test fails on a *new* copy rather than on the existing arrangement.
    const marker = 'reactiveElementVersions'
    const copies = [...new Bun.Glob('**/*.js').scanSync(VENDOR)]
      .filter((file) => readFileSync(join(VENDOR, file), 'utf8').includes(marker))
      .sort()
    expect(copies).toEqual(['external/lit/index.js', 'external/uui/index.js'])
  }, 60_000)

  test('the monaco worker shim points at a file that is served', () => {
    const source = readFileSync(join(VENDOR, 'external/monaco-editor/index.js'), 'utf8')
    const urls = [
      ...source.matchAll(/["'](\/umbraco\/backoffice\/deps\/monaco-workers\/[^"']+)["']/g),
    ]
    expect(urls.length).toBeGreaterThan(0)
    for (const [, url] of urls) {
      expect(existsSync(join(VENDOR, (url as string).slice(BACKOFFICE_BASE_PATH.length + 1)))).toBe(
        true,
      )
    }
  })
})
