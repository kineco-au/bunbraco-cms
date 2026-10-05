import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * A `.tsx` under the site's `components/` directory.
 *
 * There is one root and one kind of file. What makes a component a *template*
 * is that a document type names it — `components = ["pages/homePage"]` — not
 * where it sits, which is why this carries no kind: the schema already records
 * that, and a directory that restated it could disagree with it.
 *
 * (Umbraco splits these into Templates and Partial Views because Razor needed
 * the distinction for master-template inheritance. A TSX layout is an import,
 * so the split bought nothing and cost a rule about where a file may live.)
 */
export interface ComponentFile {
  /**
   * Its path under the root without the extension, slash-separated — which is
   * exactly the alias a document type names.
   */
  alias: string
  path: string
}

const SOURCE = /\.(tsx|jsx)$/

/** An alias that stays inside the root: no climbing, no absolute path, no drive. */
export function isSafeAlias(alias: string): boolean {
  if (alias.length === 0 || alias.startsWith('/') || alias.includes('\\')) return false
  if (/^[a-zA-Z]:/.test(alias)) return false
  return !alias.split('/').some((part) => part === '' || part === '.' || part === '..')
}

/** Every component on disk, at any depth, in a stable order. */
export function listComponents(root: string): ComponentFile[] {
  if (!existsSync(root)) return []
  const out: ComponentFile[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (!SOURCE.test(name)) continue
      out.push({ alias: aliasOf(root, path), path })
    }
  }
  walk(root)
  return out.sort((a, b) => a.alias.localeCompare(b.alias))
}

/** The alias a file answers to: its path under the root, without the extension. */
export function aliasOf(root: string, path: string): string {
  return relative(root, path).split(sep).join('/').replace(SOURCE, '')
}

export interface ComponentProblem {
  /** Relative to the site, so the message is one somebody can act on. */
  file: string
  message: string
}

export interface ComponentCheckReport {
  components: ComponentFile[]
  /** The aliases a document type names; the rest are only ever imported. */
  declared: readonly string[]
  /** One that does not compile, or a template a type declares and nothing provides. */
  problems: ComponentProblem[]
  /** Whether types were checked, and what the compiler said. */
  types: { checked: boolean; problems: string[]; note?: string }
}

/**
 * Compiles every component, and reports the templates the schema expects.
 *
 * Each file is transpiled first, because that gives the line a syntax error is
 * on, and then imported, because that is what a render does: an import that
 * cannot be resolved is as fatal as a syntax error and shows up nowhere else.
 */
export async function checkComponents(options: {
  componentsDir: string
  siteDir: string
  /** Component aliases the schema declares, from `allProperties`'s neighbours. */
  declaredComponents?: readonly string[]
}): Promise<ComponentCheckReport> {
  const components = listComponents(options.componentsDir)
  const problems: ComponentProblem[] = []
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })

  for (const component of components) {
    const where = relative(options.siteDir, component.path)
    const source = await Bun.file(component.path).text()
    try {
      transpiler.transformSync(source)
    } catch (error) {
      // Bun's message is a bare "Syntax Error"; the line it is on hangs off
      // `position`, and without it the report says nothing anybody can act on.
      const at = (error as { position?: { line?: number; column?: number; lineText?: string } })
        .position
      const where_ = at?.line ? `:${at.line}${at.column === undefined ? '' : `:${at.column}`}` : ''
      const text = at?.lineText?.trim()
      problems.push({
        file: `${where}${where_}`,
        message: `${(error as Error).message.trim()}${text ? `  (${text})` : ''}`,
      })
      continue
    }
    // A relative import that climbs out of the root resolves today and breaks
    // the moment the component is rendered from a snapshot, which is a copy of
    // the tree and nothing above it. Refused here, where the message can say why.
    for (const specifier of transpiler.scanImports(source)) {
      if (!specifier.path.startsWith('.')) continue
      const target = resolve(join(component.path, '..'), specifier.path)
      if (!relative(options.componentsDir, target).startsWith('..')) continue
      problems.push({
        file: where,
        message:
          `imports "${specifier.path}", which is outside components/. A component is rendered ` +
          'from a snapshot of the tree, so it can only import what the tree contains.',
      })
    }

    try {
      // A query does not bust Bun's module cache, so a path imported once in
      // this process answers from the registry. Harmless: the CLI checks each
      // component once and exits, and each test uses a directory of its own.
      await import(component.path)
    } catch (error) {
      problems.push({ file: where, message: (error as Error).message.trim() })
    }
  }

  const present = new Set(components.map((component) => component.alias))
  const declared = [...new Set(options.declaredComponents ?? [])]
  for (const alias of declared) {
    if (!isSafeAlias(alias)) {
      problems.push({
        file: relative(options.siteDir, options.componentsDir),
        message: `a document type declares the component "${alias}", which is not a path inside components/`,
      })
      continue
    }
    if (present.has(alias)) continue
    problems.push({
      file: relative(options.siteDir, componentFileFor(options.componentsDir, alias)),
      message: `a document type declares the component "${alias}", and there is no file for it`,
    })
  }

  return {
    components,
    declared: declared.filter((alias) => present.has(alias)),
    problems,
    types: await checkTypes(options.siteDir),
  }
}

/**
 * `tsc --noEmit` with the site's own tsconfig, when the site has the compiler.
 *
 * `typescript` is not a dependency of bunbraco — a site that has not installed
 * it is told so rather than being made to carry one.
 */
async function checkTypes(siteDir: string): Promise<ComponentCheckReport['types']> {
  const tsc = join(siteDir, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc))
    return {
      checked: false,
      problems: [],
      note: 'types were not checked: `bun add -d typescript` to check them too',
    }
  if (!existsSync(join(siteDir, 'tsconfig.json')))
    return { checked: false, problems: [], note: 'types were not checked: no tsconfig.json here' }

  const proc = Bun.spawn(['bun', tsc, '--noEmit', '-p', siteDir], {
    cwd: siteDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  const lines = `${out}${err}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Found \d+ error/.test(line))
  return { checked: true, problems: lines }
}

/** Where a component with this alias lives. The alias is the path. */
export function componentFileFor(root: string, alias: string): string {
  if (!isSafeAlias(alias)) throw new Error(`"${alias}" is not a path inside components/`)
  return join(root, `${alias}.tsx`)
}

/** What a component looks like: a function, taking whatever imports it hands it. */
export function componentScaffold(alias: string): string {
  const name = componentName(alias)
  return `import type { PublishedContent } from 'bunbraco'

export function ${name}({ model }: { model: PublishedContent }) {
  return <p>{model.name}</p>
}
`
}

/** A PascalCase identifier from an alias, which may be a path. */
export function componentName(alias: string): string {
  const base = alias.split('/').pop() ?? alias
  const cleaned = base.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
    next ? next.toUpperCase() : '',
  )
  const name = cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  return /^[A-Za-z]/.test(name) ? name : `Component${name}`
}

export type AssetKind = 'stylesheet' | 'script'

export interface AssetFile {
  kind: AssetKind
  name: string
  path: string
}

/** Umbraco's places, which the backoffice's own editors read and write. */
export function assetDirs(config: {
  stylesheetsDir: string
  scriptsDir: string
}): Record<AssetKind, { dir: string; extension: string }> {
  return {
    stylesheet: { dir: config.stylesheetsDir, extension: '.css' },
    script: { dir: config.scriptsDir, extension: '.js' },
  }
}

export function listAssets(config: { stylesheetsDir: string; scriptsDir: string }): AssetFile[] {
  const out: AssetFile[] = []
  for (const [kind, where] of Object.entries(assetDirs(config)) as Array<
    [AssetKind, { dir: string; extension: string }]
  >) {
    if (!existsSync(where.dir)) continue
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (name.endsWith(where.extension))
          out.push({ kind, name: relative(where.dir, path), path })
      }
    }
    walk(where.dir)
  }
  return out
}

/** The file `assets new` writes: enough to be valid and obviously a starting point. */
export function assetScaffold(kind: AssetKind, name: string): string {
  return kind === 'stylesheet'
    ? `/* ${name} — linked from a view with <link rel="stylesheet" href="/css/${name}"> */\n`
    : `// ${name} — loaded by a view with <script src="/scripts/${name}"></script>\n`
}
