/**
 * Starter templates: what `bunbraco init` writes, and the catalogue
 * `--template list` prints.
 *
 * A template is a directory under `templates/`, one or two levels deep so a
 * family can share a prefix (`demo/harbourstone`):
 *
 *   template.json   name and description, for the catalogue
 *   files/          copied verbatim into the new site
 *   bundle/         a content bundle, which the scaffolded `start` script
 *                   applies; it carries its own media, so nothing else does
 *
 * Content arrives as a bundle rather than as seed code so that it is the same
 * artifact `content export` produces: reviewable, committed with the site, and
 * applied by the one import path that is already tested.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { siteMediaTypeFiles } from '@bunbraco/schema'
import { VERSION } from '@bunbraco/server'

/** `templates/`, beside `src/` and `bin/` in the published package. */
export const TEMPLATES_DIR = join(import.meta.dir, '..', 'templates')

export interface SiteTemplate {
  /** `basic`, or `demo/harbourstone` for one of a family. */
  id: string
  name: string
  description: string
  dir: string
  /** `bundles/<slug>` in the new site, when the template ships content. */
  bundle?: string
}

const MANIFEST = 'template.json'

function read(dir: string, id: string): SiteTemplate | undefined {
  const manifest = join(dir, MANIFEST)
  if (!existsSync(manifest)) return undefined
  const raw = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    dir,
    bundle: existsSync(join(dir, 'bundle')) ? `bundles/${id.replaceAll('/', '-')}` : undefined,
  }
}

/** Every template, in id order; a directory without a manifest is a family. */
export function listTemplates(root = TEMPLATES_DIR): SiteTemplate[] {
  if (!existsSync(root)) return []
  const out: SiteTemplate[] = []
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry)
    if (!statSync(dir).isDirectory()) continue
    const own = read(dir, entry)
    if (own) {
      out.push(own)
      continue
    }
    for (const child of readdirSync(dir).sort()) {
      const nested = read(join(dir, child), `${entry}/${child}`)
      if (nested) out.push(nested)
    }
  }
  return out
}

export function findTemplate(id: string, root = TEMPLATES_DIR): SiteTemplate | undefined {
  return listTemplates(root).find((t) => t.id === id)
}

export interface ScaffoldOptions {
  /** `--name`; also the package name, slugified. */
  siteName?: string
  /** `--postgres`: write a `.env` naming the Postgres variables instead of using the SQLite default. */
  postgres?: boolean
  template?: SiteTemplate
}

/** One file to write: literal text, or a path to copy (template media and bundles). */
export interface ScaffoldFile {
  /** Relative to the new site, `/`-separated. */
  path: string
  text?: string
  copyFrom?: string
}

const DEFAULT_SITE_NAME = 'My Site'

/** Kept in step with the root `package.json`, which is what the views are checked with. */
const TYPESCRIPT_VERSION = '^7.0.2'

/** Single quotes, because the file is TypeScript the site's own formatter owns. */
const quote = (value: string): string => `'${value.replace(/[\\']/g, '\\$&')}'`

/** A directory name npm accepts: lowercase, no spaces, no leading punctuation. */
export function packageNameFor(siteName: string): string {
  const slug = siteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'my-site'
}

function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        jsxImportSource: 'bunbraco',
        strict: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        types: ['bun'],
      },
    },
    null,
    2,
  )}\n`
}

function packageJson(options: { name: string; start: string }): string {
  return `${JSON.stringify(
    {
      name: options.name,
      private: true,
      type: 'module',
      scripts: { start: options.start, dev: 'bun --watch server.ts' },
      dependencies: { bunbraco: `^${VERSION}` },
      // So the tsconfig written beside this has something to run it, and
      // `bunbraco views check` checks types as well as compiling. The version
      // is the one bunbraco itself is checked with.
      devDependencies: { typescript: TYPESCRIPT_VERSION },
    },
    null,
    2,
  )}\n`
}

/** Every file in a scaffolded site, template files last so they win on a clash. */
export function scaffoldFiles(options: ScaffoldOptions = {}): ScaffoldFile[] {
  const siteName = options.siteName?.trim() || DEFAULT_SITE_NAME
  const bundle = options.template?.bundle
  const files: ScaffoldFile[] = [
    {
      path: 'package.json',
      text: packageJson({
        name: packageNameFor(siteName),
        // The import is a boot step rather than a config setting so that it is
        // visible here, and so that dropping it is editing one line.
        start: bundle ? `bunbraco start --bundle ${bundle} --publish` : 'bunbraco start',
      }),
    },
    {
      path: 'bunbraco.config.ts',
      text: `import { defineConfig } from 'bunbraco'

export default defineConfig({
  siteName: ${quote(siteName)},
})
`,
    },
    {
      path: 'server.ts',
      text: `import { bunbraco } from 'bunbraco'

export default await bunbraco()
`,
    },
    { path: 'tsconfig.json', text: tsconfig() },
    { path: 'schema/schema.toml', text: '[schema]\nversion = "1.0.0"\n' },
    // The media types a site owns as files rather than inheriting silently.
    ...Object.entries(siteMediaTypeFiles()).map(([path, text]) => ({ path, text })),
    { path: 'Views/.gitkeep', text: '' },
    { path: 'App_Plugins/.gitkeep', text: '' },
    {
      path: '.gitignore',
      // `.bunbraco/` holds the view snapshots: pure cache, rebuilt from `Views/`
      // at every boot, and per node.
      text: '*.sqlite\n*.sqlite-*\nnode_modules/\n.env\n.bunbraco/\nmedia/\nlogs/\n',
    },
  ]

  if (options.postgres)
    files.push({
      path: '.env',
      text: `BUNBRACO_DB=postgres
BUNBRACO_POSTGRES_URL=postgres://bunbraco:bunbraco@localhost:5432/${packageNameFor(siteName)}

# Postgres has no file to copy, so anything that writes needs a backup first:
# a command that takes one, or --backup-taken to vouch that you have.
# BUNBRACO_PG_DUMP=pg_dump "$BUNBRACO_POSTGRES_URL" -f "backup-$BUNBRACO_BACKUP_STAMP.sql"
`,
    })

  for (const file of templateFiles(options.template)) files.push(file)
  // One entry per path, the last winning, so a template's own `schema.toml` is
  // the one written rather than being skipped as a file that already exists.
  return [...new Map(files.map((file) => [file.path, file])).values()]
}

/** `files/` into the site root, `bundle/` under `bundles/<slug>`. */
export function templateFiles(template: SiteTemplate | undefined): ScaffoldFile[] {
  if (!template) return []
  const out: ScaffoldFile[] = []
  const walk = (dir: string, target: (path: string) => string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const source = join(entry.parentPath, entry.name)
      out.push({ path: target(relative(dir, source).split(sepRe).join('/')), copyFrom: source })
    }
  }
  walk(join(template.dir, 'files'), (path) => path)
  if (template.bundle) walk(join(template.dir, 'bundle'), (path) => `${template.bundle}/${path}`)
  return out
}

const sepRe = /[\\/]/
