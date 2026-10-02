/**
 * Builds a browser-runnable Umbraco backoffice into packages/backoffice-dist/dist/ using Bun
 * alone — no Node, no npm scripts, no .NET.
 *
 * The npm package ships the `tsc` output, which is not directly loadable: its
 * external/* modules are bare re-export stubs, and it carries no CSS and no
 * import map. See docs/04-backoffice-hosting.md.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { buildLocalizations } from './build-localizations.ts'
import { checkModuleGraph } from './check-module-graph.ts'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'packages/backoffice-dist/dist')
const PKG = join(ROOT, 'node_modules/@umbraco-cms/backoffice')
const DIST = join(PKG, 'dist-cms')
const UUI_THEMES = join(ROOT, 'node_modules/@umbraco-ui/uui/dist/themes')
const UMBRACO_SRC = Bun.env.UMBRACO_SRC ?? join(ROOT, '../Umbraco-CMS')
const CLIENT_SRC = join(UMBRACO_SRC, 'src/Umbraco.Web.UI.Client/src')
/**
 * The few files that exist only in the Umbraco source tree are committed here
 * (~10 KB) so a fresh clone needs nothing but npm. Refresh them on a version
 * bump with `bun run vendor:refresh-static`.
 */
const STATIC_SEED = join(ROOT, 'packages/backoffice-dist/upstream-static')

/**
 * Files upstream copies from the client source tree; plain static assets, no build.
 *
 * The three SVGs that used to be here — `favicon.svg`, `umbraco-logo.svg` and
 * `installer-illustration.svg` — are Umbraco's own marks and artwork. MIT grants
 * no trademark rights, so they are not redistributed: `BRANDED_ASSETS` in
 * `@bunbraco/backoffice-host` serves bunbraco's own at those paths instead. Do
 * not add them back; `vendor:refresh-static` would re-seed them from
 * `$UMBRACO_SRC` and the repository would carry them again.
 */
const SOURCE_FILES = [
  ['css/umb-css.css', 'css/umb-css.css'],
  ['css/rte-content.css', 'css/rte-content.css'],
  ['css/umbraco-blockgridlayout.css', 'css/umbraco-blockgridlayout.css'],
] as const

const THEMES = ['light.css', 'dark.css', 'high-contrast.css'] as const

/** Handled separately, because it needs the Vite-suffix plugin below. */
const DEFERRED_EXTERNALS = new Set(['monaco-editor'])

/**
 * monaco's worker entry points. Umbraco imports these with Vite's `?worker`
 * suffix, which means "bundle this as a worker and give me a Worker subclass".
 * We build each one separately and hand back an equivalent class.
 */
const MONACO_WORKERS: Record<string, string> = {
  'monaco-editor/esm/vs/editor/editor.worker': 'editor',
  'monaco-editor/esm/vs/language/json/json.worker': 'json',
  'monaco-editor/esm/vs/language/css/css.worker': 'css',
  'monaco-editor/esm/vs/language/html/html.worker': 'html',
  'monaco-editor/esm/vs/language/typescript/ts.worker': 'typescript',
}

const MONACO_WORKER_DIR = 'deps/monaco-workers'

/**
 * Build- and test-time files the npm package ships but a browser never loads.
 * Pruning them keeps the served tree to runtime code, and stops their
 * build-tool imports (`vite`, `@open-wc/testing`) looking like missing runtime
 * dependencies.
 */
const NON_RUNTIME_GLOBS = [
  '**/vite.config.js',
  '**/vite.config.d.ts',
  '**/vite-config-base.js',
  '**/vite-config-base.d.ts',
  '**/openapi-ts.config.js',
  '**/*.test.js',
  '**/*.stories.js',
  '**/*test-utils.js',
  '**/tsconfig.build.json',
  '**/tsconfig.build.tsbuildinfo',
]

export const BACKOFFICE_BASE_PATH = '/umbraco/backoffice'

/**
 * Reimplements devops/importmap/index.js: exports -> bare specifier map.
 *
 * `exists` lets the caller drop entries whose target was not produced (monaco,
 * see R6). An import map that advertises a module which is not served fails at
 * runtime with an opaque module-resolution error, so it is better to not
 * advertise it at all.
 */
export function createImportMap(
  packageJson: { name: string; exports: Record<string, string | null> },
  exists: (servedPath: string) => boolean = () => true,
): { imports: Record<string, string>; dropped: string[] } {
  const imports: Record<string, string> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(packageJson.exports ?? {})) {
    if (!value?.endsWith('.js')) continue
    const moduleName = key.replace(/^\.\//, '')
    const specifier = `${packageJson.name}/${moduleName}`
    const servedPath = value.replace(/^\.\/dist-cms/, BACKOFFICE_BASE_PATH)
    if (exists(servedPath)) imports[specifier] = servedPath
    else dropped.push(specifier)
  }
  return { imports, dropped }
}

/**
 * Resolves a deep path inside a package by locating the package directory and
 * joining, deliberately bypassing the `exports` map.
 *
 * monaco 0.57 declares `"./*": "./esm/vs/*.js"`, which rewrites the deep paths
 * Umbraco imports (`monaco-editor/esm/vs/...`) into a doubled prefix. The files
 * are present; only the exports map disagrees.
 */
function resolveInPackage(specifier: string): string | undefined {
  const parts = specifier.split('/')
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (!packageName) return undefined
  const subPath = specifier.slice(packageName.length + 1)
  let dir: string
  try {
    dir = dirname(Bun.resolveSync(packageName, ROOT))
  } catch {
    return undefined
  }
  const marker = `${sep}${packageName.replaceAll('/', sep)}`
  const index = dir.lastIndexOf(marker)
  if (index < 0) return undefined
  const packageDir = dir.slice(0, index + marker.length)
  const file = join(packageDir, subPath)
  return existsSync(file) ? file : undefined
}

/**
 * Builds external/monaco-editor, translating Vite's `?worker` and `?inline`
 * import suffixes that Bun does not implement natively:
 *   - `x?worker` becomes a Worker subclass pointing at a separately built bundle
 *   - `x?inline` becomes the file's contents as a default-exported string
 */
async function bundleMonaco(): Promise<boolean> {
  for (const [specifier, name] of Object.entries(MONACO_WORKERS)) {
    const entry = resolveInPackage(`${specifier}.js`)
    if (!entry) return false
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(OUT, MONACO_WORKER_DIR),
      target: 'browser',
      format: 'esm',
      minify: true,
      naming: `${name}.[ext]`,
    })
    if (!result.success) return false
  }

  const viteSuffixes: import('bun').BunPlugin = {
    name: 'vite-import-suffixes',
    setup(build) {
      build.onResolve({ filter: /\?worker$/ }, (args) => ({
        path: args.path.replace(/\?worker$/, ''),
        namespace: 'vite-worker',
      }))
      build.onLoad({ filter: /.*/, namespace: 'vite-worker' }, (args) => {
        const name = MONACO_WORKERS[args.path]
        if (!name) throw new Error(`Unmapped ?worker import: ${args.path}`)
        const url = `${BACKOFFICE_BASE_PATH}/${MONACO_WORKER_DIR}/${name}.js`
        return {
          contents: `export default class extends Worker {
  constructor() { super(${JSON.stringify(url)}, { type: 'module' }) }
}`,
          loader: 'js',
        }
      })

      build.onResolve({ filter: /\?inline$/ }, (args) => {
        const path = resolveInPackage(args.path.replace(/\?inline$/, ''))
        if (!path) throw new Error(`Cannot resolve ?inline import: ${args.path}`)
        return { path, namespace: 'vite-inline' }
      })
      build.onLoad({ filter: /.*/, namespace: 'vite-inline' }, (args) => ({
        contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`,
        loader: 'js',
      }))
    },
  }

  const result = await Bun.build({
    entrypoints: [join(DIST, 'external/monaco-editor/index.js')],
    outdir: join(OUT, 'external/monaco-editor'),
    target: 'browser',
    format: 'esm',
    minify: true,
    plugins: [viteSuffixes],
  })
  return result.success
}

/** Every bare specifier the vendored tree imports, excluding the client's own. */
function scanBareSpecifiers(): Set<string> {
  const transpiler = new Bun.Transpiler({ loader: 'js' })
  const found = new Set<string>()
  for (const file of new Bun.Glob('**/*.js').scanSync({ cwd: OUT })) {
    for (const { path } of transpiler.scanImports(readFileSync(join(OUT, file), 'utf8'))) {
      if (path.startsWith('.') || path.startsWith('/')) continue
      if (path.startsWith('@umbraco-cms/backoffice')) continue
      found.add(path)
    }
  }
  return found
}

/**
 * Replaces JSON imports with an inline constant.
 *
 * `packages/sysinfo` does `import packageJson from '../../../../package.json'`
 * for the version it reports. A browser rejects that outright: a JSON module
 * needs an import attribute (`with { type: 'json' }`), and Umbraco never hits it
 * because its Vite build inlines the value. Inlining here does the same thing.
 */
function inlineJsonImports(): number {
  const pattern = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+\.json)["'];?$/gm
  let rewritten = 0
  for (const file of new Bun.Glob('**/*.js').scanSync({ cwd: OUT })) {
    const path = join(OUT, file)
    const source = readFileSync(path, 'utf8')
    if (!source.includes('.json')) continue
    const updated = source.replace(pattern, (match, binding: string, specifier: string) => {
      // The relative path is written for npm's layout, which has an extra
      // `dist-cms` level that we flatten away, so it escapes the served root.
      // Fall back to the same file inside the npm package.
      const candidates = [join(dirname(path), specifier), join(PKG, basename(specifier))]
      const target = candidates.find((candidate) => existsSync(candidate))
      if (!target) return match
      const json = JSON.parse(readFileSync(target, 'utf8')) as unknown
      return `const ${binding} = ${JSON.stringify(json)};`
    })
    if (updated !== source) {
      writeFileSync(path, updated)
      rewritten += 1
    }
  }
  return rewritten
}

/** Whether a module exports a default, following `export * from` chains. */
function hasDefaultExport(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file) || !existsSync(file)) return false
  seen.add(file)
  const source = readFileSync(file, 'utf8')
  const transpiler = new Bun.Transpiler({ loader: 'js' })
  if (transpiler.scan(source).exports.includes('default')) return true
  let clean = source
  try {
    clean = transpiler.transformSync(source)
  } catch {
    // Fall back to the raw source; the regex below is only a heuristic anyway.
  }
  for (const match of clean.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
    const specifier = match[1] as string
    if (!specifier.startsWith('.')) continue
    if (hasDefaultExport(join(dirname(file), specifier), seen)) return true
  }
  return false
}

/**
 * Bundles every unmapped bare specifier, in **one** build with code splitting,
 * into packages/backoffice-dist/dist/deps/, and adds an import map entry for each,
 * mutating `imports`.
 *
 * One build, not one per specifier: many of these share internals — every
 * `@tiptap/extension-*` depends on `@tiptap/core` and ProseMirror — and built
 * separately each would inline its own copy. ProseMirror refuses to mix copies
 * ("Adding different instances of a keyed plugin"), so the rich text editor
 * crashed on load. Splitting emits each shared module once, as a chunk.
 *
 * A generated shim re-exporting the *bare specifier* is used as each entry,
 * rather than the resolved file, for two reasons:
 *
 *  - Bun tree-shakes a pure re-export barrel entry down to nothing, emitting an
 *    export clause whose bindings do not exist. A browser then refuses to link
 *    the module ("Export 'A' is not defined in module"). `uuid` is such a barrel.
 *  - Resolving the path ourselves pins the *Node* build of a package that ships
 *    separate browser and node entries; letting Bun resolve the bare specifier
 *    applies browser export conditions instead.
 */
async function bundleBareDependencies(
  imports: Record<string, string>,
): Promise<{ bundled: string[]; unresolved: string[] }> {
  const unresolved: string[] = []
  const shimDir = join(OUT, '.shims')
  mkdirSync(shimDir, { recursive: true })

  // Entry name (the shim's file name) → the specifier it stands for
  const entries = new Map<string, string>()
  for (const specifier of [...scanBareSpecifiers()].sort()) {
    if (imports[specifier]) continue
    let resolved: string
    try {
      resolved = Bun.resolveSync(specifier, ROOT)
    } catch {
      unresolved.push(specifier)
      continue
    }
    const name = specifier.replaceAll('/', '__').replaceAll('@', '')
    const lines = [`export * from ${JSON.stringify(specifier)}`]
    // `export *` never re-exports a default, so it is named explicitly.
    if (hasDefaultExport(resolved))
      lines.push(`export { default } from ${JSON.stringify(specifier)}`)
    writeFileSync(join(shimDir, `${name}.js`), `${lines.join('\n')}\n`)
    entries.set(name, specifier)
  }

  const bundled: string[] = []
  if (entries.size > 0) {
    const result = await Bun.build({
      entrypoints: [...entries.keys()].map((name) => join(shimDir, `${name}.js`)),
      outdir: join(OUT, 'deps'),
      target: 'browser',
      format: 'esm',
      minify: true,
      splitting: true,
      naming: { entry: '[name].[ext]', chunk: 'chunks/[name]-[hash].[ext]' },
    })
    if (!result.success) {
      for (const log of result.logs) console.error(log)
      unresolved.push(...entries.values())
    } else {
      for (const [name, specifier] of entries) {
        imports[specifier] = `${BACKOFFICE_BASE_PATH}/deps/${name}.js`
        bundled.push(specifier)
      }
    }
  }

  rmSync(shimDir, { recursive: true, force: true })
  return { bundled, unresolved }
}

async function main(): Promise<void> {
  if (!existsSync(DIST)) {
    throw new Error(`@umbraco-cms/backoffice is not installed. Run: bun install`)
  }

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  // 1. the app itself, straight from npm
  for (const dir of ['apps', 'packages', 'libs', 'assets']) {
    cpSync(join(DIST, dir), join(OUT, dir), { recursive: true })
  }
  let pruned = 0
  for (const pattern of NON_RUNTIME_GLOBS) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: OUT })) {
      rmSync(join(OUT, file), { force: true })
      pruned += 1
    }
  }

  // 2. reconstitute the external/* stubs into self-contained browser bundles
  const externals = [...new Bun.Glob('*/index.js').scanSync({ cwd: join(DIST, 'external') })]
  const failed: string[] = []
  for (const entry of externals) {
    const name = dirname(entry)
    if (DEFERRED_EXTERNALS.has(name)) {
      failed.push(name)
      continue
    }
    try {
      const result = await Bun.build({
        entrypoints: [join(DIST, 'external', entry)],
        outdir: join(OUT, 'external', name),
        target: 'browser',
        format: 'esm',
        minify: true,
      })
      if (!result.success) failed.push(name)
    } catch {
      failed.push(name)
    }
  }

  // 2b. monaco needs the Vite-suffix plugin
  if (await bundleMonaco()) {
    const index = failed.indexOf('monaco-editor')
    if (index >= 0) failed.splice(index, 1)
  }
  // umb-css.css loads the code editor's icon font from where Umbraco's static
  // assets keep it, which npm does not ship; monaco-editor does.
  const codicon = resolveInPackage(
    'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf',
  )
  if (codicon) {
    mkdirSync(join(OUT, 'assets/fonts/codicon'), { recursive: true })
    cpSync(codicon, join(OUT, 'assets/fonts/codicon/codicon.ttf'))
  }

  // 3. UUI themes are published to npm
  mkdirSync(join(OUT, 'css'), { recursive: true })
  for (const theme of THEMES) {
    cpSync(join(UUI_THEMES, theme), join(OUT, 'css', theme))
  }
  // The themes load the Lato web fonts from `../assets/fonts/`, which the UI
  // library ships beside them; without these every page logs font 404s.
  cpSync(join(UUI_THEMES, '../assets/fonts'), join(OUT, 'assets/fonts'), { recursive: true })

  // 4. the handful of static files that exist only in the Umbraco source tree
  const missing: string[] = []
  for (const [from, to] of SOURCE_FILES) {
    const src = join(STATIC_SEED, from)
    if (!existsSync(src)) {
      missing.push(from)
      continue
    }
    mkdirSync(dirname(join(OUT, to)), { recursive: true })
    cpSync(src, join(OUT, to))
  }

  const jsonImportsInlined = inlineJsonImports()

  // 5. the import map manifest upstream generates at build time
  const packageJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  const { imports, dropped } = createImportMap(packageJson, (servedPath) =>
    existsSync(join(OUT, servedPath.slice(BACKOFFICE_BASE_PATH.length + 1))),
  )

  // 6. Some packages import third-party deps directly rather than through an
  // external/* wrapper. Umbraco's Vite build inlines those; the npm tsc output
  // leaves the bare specifier, so each one needs bundling and mapping or the
  // browser cannot resolve it.
  const { bundled, unresolved } = await bundleBareDependencies(imports)
  writeFileSync(
    join(OUT, 'umbraco-package.json'),
    JSON.stringify({
      name: packageJson.name,
      version: packageJson.version,
      extensions: [],
      importmap: { imports },
    }),
  )
  writeFileSync(join(OUT, 'VERSION'), `${packageJson.name}@${packageJson.version}\n`)

  // Vendoring is not finished until the result actually links in a browser.
  const graph = checkModuleGraph()

  console.log(
    `vendored ${packageJson.name}@${packageJson.version} -> packages/backoffice-dist/dist`,
  )
  console.log(`  non-runtime files pruned: ${pruned}`)
  console.log(`  json imports inlined: ${jsonImportsInlined}`)
  console.log(`  externals bundled: ${externals.length - failed.length}/${externals.length}`)
  console.log(`  bare deps bundled: ${bundled.length}`)
  console.log(`  import map entries: ${Object.keys(imports).length}`)
  if (dropped.length > 0) console.warn(`  dropped from import map: ${dropped.join(', ')}`)
  if (unresolved.length > 0) {
    console.warn(`  unresolved bare imports: ${unresolved.join(', ')}`)
    console.warn('  add them as dependencies and re-run')
  }
  if (failed.length > 0) console.warn(`  not bundled (deferred or failed): ${failed.join(', ')}`)
  if (missing.length > 0) {
    console.warn(`  missing from ${STATIC_SEED}: ${missing.join(', ')}`)
    console.warn('  run: bun run vendor:refresh-static (needs UMBRACO_SRC)')
  }

  console.log(`  modules linked: ${graph.moduleCount}`)

  // The branding overrides are generated from the dictionaries just vendored, so
  // they would otherwise go stale on every bump.
  console.log(`  localizations branded: ${await buildLocalizations()}`)

  const failures = [...graph.unparseable, ...graph.missingExports, ...graph.unresolved]
  if (failures.length > 0) {
    console.error('')
    console.error(`  ${failures.length} module(s) will not link in a browser:`)
    for (const failure of failures.slice(0, 20)) console.error(`    ${failure}`)
    process.exitCode = 1
  }
}

/**
 * Re-seeds packages/backoffice-dist/upstream-static from an Umbraco-CMS checkout. Only needed when
 * bumping the pinned backoffice version.
 */
export async function refreshStatic(): Promise<void> {
  if (!existsSync(CLIENT_SRC)) {
    throw new Error(
      `No Umbraco client source at ${CLIENT_SRC}. Set UMBRACO_SRC to a checkout at release-18.2.0.`,
    )
  }
  for (const [from] of SOURCE_FILES) {
    const target = join(STATIC_SEED, from)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(CLIENT_SRC, from), target)
  }
  console.log(`seeded ${SOURCE_FILES.length} files into packages/backoffice-dist/upstream-static`)
}

if (import.meta.main) {
  if (Bun.argv.includes('--refresh-static')) await refreshStatic()
  else await main()
}
