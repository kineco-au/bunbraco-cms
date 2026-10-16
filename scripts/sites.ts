/**
 * The sites this repository builds: one directory each under `sites/`.
 *
 * A site here is a real site — its own `package.json` (a private
 * workspace, so `@crombolo/crombolo` resolves to the working tree), config, schema,
 * components and committed content bundle — and is not published by default.
 * One that sets `"distribute": true` in its `site.json` is staged into
 * `@crombolo/cli`'s `templates/` while the CLI is packed, so `crombolo init
 * --template <id>` can write it.
 *
 *   site.json     id, name, description; `distribute` and the server `bundles`
 *                 its scaffold wires, as in a template's `template.json`
 *   bundles/      the content bundle, a private package at `bundles/<slug>` as a
 *                 scaffold puts it
 *   CREDITS.md    where its images came from, shipped beside the template
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { siteMediaTypeFiles } from '@crombolo/schema'
import { VERSION } from '@crombolo/server'
import { type BundlePackageInfo, bundleIdFor } from '@crombolo/transfer'
import { ROOT } from './packages.ts'

export const SITES_DIR = join(ROOT, 'sites')

const MANIFEST = 'site.json'

/** What a template carries as `files/`; everything else in a site is its own. */
const TEMPLATE_FILES = ['components', 'css', 'schema']

/** Shipped beside `template.json` rather than copied into a new site. */
const TEMPLATE_EXTRAS = ['CREDITS.md']

export interface RepoSite {
  /** The template id it ships as, e.g. `demo/harbourstone`. */
  id: string
  name: string
  description: string
  dir: string
  /** Staged into the published CLI when true. */
  distribute: boolean
  /** The server bundles a scaffold of it wires, verbatim from `site.json`. */
  bundles: unknown[]
  /** `bundles/<slug>`, relative to the site. */
  bundle: string
}

export const slugOf = (id: string): string => id.replaceAll('/', '-')

/**
 * The private package a template's or a site's content is committed as. Never
 * published — it is applied from its directory by `start --bundle` — so its
 * name only has to say what it is.
 */
export function contentPackage(target: { id: string; name: string }): BundlePackageInfo {
  const slug = slugOf(target.id)
  return {
    name: slug,
    version: '1.0.0',
    id: bundleIdFor(slug),
    label: target.name,
    private: true,
    peerRange: `^${VERSION}`,
  }
}

function read(dir: string): RepoSite | undefined {
  const manifest = join(dir, MANIFEST)
  if (!existsSync(manifest)) return undefined
  const raw = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
  if (typeof raw.id !== 'string' || !raw.id) throw new Error(`${manifest} names no "id"`)
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    description: typeof raw.description === 'string' ? raw.description : '',
    dir,
    distribute: raw.distribute === true,
    bundles: Array.isArray(raw.bundles) ? raw.bundles : [],
    bundle: `bundles/${slugOf(raw.id)}`,
  }
}

/** Every site, in id order; a directory without a `site.json` is not one. */
export function listSites(root = SITES_DIR): RepoSite[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((dir) => statSync(dir).isDirectory())
    .flatMap((dir) => read(dir) ?? [])
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** By template id, or by its directory under `sites/`. */
export function findSite(name: string, root = SITES_DIR): RepoSite | undefined {
  return listSites(root).find((site) => site.id === name || relative(root, site.dir) === name)
}

/**
 * Copies what a site ships as a template's `files/` into `dir`. The media types
 * `init` writes for itself are left out, so a shipped copy can never go stale
 * against the CLI's own.
 */
export function copyTemplateFiles(site: RepoSite, dir: string): void {
  const generated = new Set(Object.keys(siteMediaTypeFiles()).map((path) => join(site.dir, path)))
  // A directory holding only generated files is left out too: an empty
  // `schema/media-types/` is not the same schema as none at all.
  const shipped = (path: string): boolean =>
    statSync(path).isDirectory()
      ? readdirSync(path, { recursive: true, withFileTypes: true }).some(
          (entry) => entry.isFile() && !generated.has(join(entry.parentPath, entry.name)),
        )
      : !generated.has(path)
  mkdirSync(dir, { recursive: true })
  for (const entry of TEMPLATE_FILES) {
    const source = join(site.dir, entry)
    if (!existsSync(source)) continue
    cpSync(source, join(dir, entry), { recursive: true, filter: shipped })
  }
}

/** Writes a site out as a template under `<into>/<id>`, in the layout `@crombolo/cli` reads. */
export function stageTemplate(site: RepoSite, into: string): string {
  const target = join(into, site.id)
  if (existsSync(target)) throw new Error(`${target} already exists; refusing to overwrite it`)
  try {
    copyTemplateFiles(site, join(target, 'files'))
    cpSync(join(site.dir, site.bundle), join(target, 'bundle'), { recursive: true })
    for (const extra of TEMPLATE_EXTRAS)
      if (existsSync(join(site.dir, extra))) cpSync(join(site.dir, extra), join(target, extra))
    const manifest = {
      name: site.name,
      description: site.description,
      ...(site.bundles.length > 0 ? { bundles: site.bundles } : {}),
    }
    writeFileSync(join(target, 'template.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    unstage([target], into)
    throw error
  }
  return target
}

/** Stages each site, the distributed ones by default; `unstage` takes them away again. */
export function stageTemplates(
  into: string,
  sites = listSites().filter((site) => site.distribute),
): string[] {
  const staged: string[] = []
  try {
    for (const site of sites) staged.push(stageTemplate(site, into))
  } catch (error) {
    unstage(staged, into)
    throw error
  }
  return staged
}

/** Removes what `stageTemplates` wrote, and any family directory it left empty. */
export function unstage(staged: readonly string[], into: string): void {
  for (const dir of staged) {
    rmSync(dir, { recursive: true, force: true })
    for (let parent = dirname(dir); parent.startsWith(`${into}${sep}`); parent = dirname(parent)) {
      if (existsSync(parent) && readdirSync(parent).length > 0) break
      rmSync(parent, { recursive: true, force: true })
    }
  }
}

/** What a site writes as it runs, all gitignored: everything `bun run site --fresh` clears. */
export function runState(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => RUN_STATE.has(name) || name.startsWith('crombolo.sqlite'))
    .map((name) => join(dir, name))
}

const RUN_STATE = new Set(['media', 'logs', '.crombolo'])

/**
 * A site's files without what running it leaves behind: its database, media,
 * logs and view cache, and the workspace link in `node_modules` — the copy
 * resolves the packages from the repository's own, as a scaffold does.
 */
export function copySite(from: string, into: string): void {
  const leftBehind = new Set([...runState(from), join(from, 'node_modules')])
  cpSync(from, into, {
    recursive: true,
    filter: (path) => !leftBehind.has(path) && !basename(path).endsWith('.content-import.bak'),
  })
}
