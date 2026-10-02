/**
 * Checking the views on disk, and the files that sit beside them.
 *
 * A view is reached only through a document type's template alias, and it is
 * loaded when a request renders it — so a view that does not compile is a 500
 * nobody sees until somebody visits that page. This is the check a deploy can
 * run first: every view transpiles, every view imports, and every template a
 * type declares has a file.
 *
 * Types are a separate question. They need the compiler, which a site may not
 * have installed, so they are checked when `typescript` is there and reported
 * as not checked when it is not.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

/** Where a `.tsx` under `Views/` sits, which decides what it is. */
export type ViewKind = 'template' | 'partial' | 'component'

export interface ViewFile {
  kind: ViewKind
  /** The template alias, for a template; the file's base name otherwise. */
  alias: string
  path: string
}

export const PARTIALS_DIR = 'Partials'

const SOURCE = /\.(tsx|jsx)$/

/**
 * Every view on disk.
 *
 * Only the top level of `Views/` holds templates — the same rule the schema
 * validator applies — so `Views/Partials` holds partials and anything else
 * nested is a component a view imports, which is how a shared layout avoids
 * looking like a template nothing uses.
 */
export function listViews(viewsDir: string): ViewFile[] {
  if (!existsSync(viewsDir)) return []
  const out: ViewFile[] = []
  const walk = (dir: string, kind: ViewKind): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (kind === 'template') walk(path, name === PARTIALS_DIR ? 'partial' : 'component')
        continue
      }
      if (!SOURCE.test(name)) continue
      out.push({ kind, alias: basename(name).replace(SOURCE, ''), path })
    }
  }
  walk(viewsDir, 'template')
  return out
}

export interface ViewProblem {
  /** Relative to the site, so the message is one somebody can act on. */
  file: string
  message: string
}

export interface ViewCheckReport {
  views: ViewFile[]
  /** A view that does not compile, or a template a type declares and nothing provides. */
  problems: ViewProblem[]
  /** Whether types were checked, and what the compiler said. */
  types: { checked: boolean; problems: string[]; note?: string }
}

/**
 * Compiles every view, and reports the templates the schema expects.
 *
 * Each file is transpiled first, because that gives the line a syntax error is
 * on, and then imported, because that is what a render does: an import that
 * cannot be resolved is as fatal as a syntax error and shows up nowhere else.
 */
export async function checkViews(options: {
  viewsDir: string
  siteDir: string
  /** Template aliases the schema declares, from `allProperties`'s neighbours. */
  declaredTemplates?: readonly string[]
}): Promise<ViewCheckReport> {
  const views = listViews(options.viewsDir)
  const problems: ViewProblem[] = []
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })

  for (const view of views) {
    const where = relative(options.siteDir, view.path)
    const source = await Bun.file(view.path).text()
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
    // A relative import that climbs out of `Views/` resolves today and breaks
    // the moment the view is rendered from a snapshot, which is a copy of the
    // tree and nothing above it. Refused here, where the message can say why.
    for (const specifier of transpiler.scanImports(source)) {
      if (!specifier.path.startsWith('.')) continue
      const target = resolve(join(view.path, '..'), specifier.path)
      if (!relative(options.viewsDir, target).startsWith('..')) continue
      problems.push({
        file: where,
        message:
          `imports "${specifier.path}", which is outside Views/. A view is rendered from a ` +
          'snapshot of the views tree, so it can only import what the tree contains.',
      })
    }

    try {
      // A query does not bust Bun's module cache, so a path imported once in
      // this process answers from the registry. Harmless: the CLI checks each
      // view once and exits, and each test uses a directory of its own.
      await import(view.path)
    } catch (error) {
      problems.push({ file: where, message: (error as Error).message.trim() })
    }
  }

  const templates = new Set(views.filter((v) => v.kind === 'template').map((v) => v.alias))
  for (const alias of new Set(options.declaredTemplates ?? []))
    if (!templates.has(alias))
      problems.push({
        file: relative(options.siteDir, join(options.viewsDir, `${alias}.tsx`)),
        message: `a document type declares the template "${alias}", and there is no view for it`,
      })

  return { views, problems, types: await checkTypes(options.siteDir) }
}

/**
 * `tsc --noEmit` with the site's own tsconfig, when the site has the compiler.
 *
 * `typescript` is not a dependency of bunbraco — a site that has not installed
 * it is told so rather than being made to carry one.
 */
async function checkTypes(siteDir: string): Promise<ViewCheckReport['types']> {
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

/** A view for a type that declares one, or a partial another view will import. */
export function viewFileFor(viewsDir: string, alias: string, partial = false): string {
  return partial ? join(viewsDir, PARTIALS_DIR, `${alias}.tsx`) : join(viewsDir, `${alias}.tsx`)
}

/** What a partial looks like: a component, taking whatever the view hands it. */
export function partialScaffold(alias: string): string {
  const name = alias.charAt(0).toUpperCase() + alias.slice(1).replace(/[^A-Za-z0-9]/g, '')
  return `import type { PublishedContent } from 'bunbraco'

export function ${name}({ model }: { model: PublishedContent }) {
  return <section>{model.name}</section>
}
`
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
