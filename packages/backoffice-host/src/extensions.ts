/**
 * Backoffice extensions as npm dependencies. `docs/17-bundles.md`.
 *
 * A site's extensions are its dependencies: discovery reads the site's own
 * `package.json`, resolves each dependency through `node_modules`, and takes the
 * `bunbraco` field from the dependency's `package.json`. There is no directory
 * convention to keep in step, and `bun add` is the install.
 *
 * Only declared dependencies are read, never a walk of `node_modules`, so a
 * transitive dependency cannot put an extension into a backoffice that never
 * asked for it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import type { PackageManifest, PackageManifestImportmap } from './manifests.ts'

/** Where an installed bundle's assets are served from. */
export const EXTENSION_PATH = '/bundles'

/** The npm keyword a bundle publishes so the marketplace can find it. */
export const EXTENSION_KEYWORD = 'bunbraco-bundle'

/**
 * What a dependency declares to become a backoffice extension. The shape is
 * Umbraco's manifest minus the parts the server owns — the name and version
 * come from the package itself.
 */
export interface BunbracoField {
  id?: string
  name?: string
  allowPublicAccess?: boolean
  allowTelemetry?: boolean
  extensions?: unknown[]
  importmap?: PackageManifestImportmap
}

export interface InstalledExtension {
  /** The npm package name, which is also its segment in the asset path. */
  packageName: string
  version: string
  directory: string
  manifest: PackageManifest
}

/**
 * Asset references inside an extension. Only these carry a path; rewriting
 * every string would corrupt labels and aliases that happen to look like one.
 */
const ASSET_KEYS = new Set(['element', 'api', 'js', 'loader'])

interface PackageJson {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  bunbraco?: BunbracoField
}

function readJson(file: string): PackageJson | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : undefined
  } catch {
    return undefined
  }
}

/**
 * The directory a dependency resolves to, walking up as Node does, so a
 * workspace root's hoisted `node_modules` is found from a site inside it.
 */
export function resolvePackageDir(from: string, name: string): string | undefined {
  // A name may not climb out of node_modules, whatever a package.json says.
  if (name.includes('..') || name.startsWith('/') || name.startsWith('.')) return undefined
  let dir = normalize(from)
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** `dist/seo.js` inside `@acme/seo` becomes `/bundles/@acme/seo/dist/seo.js`. */
const assetPath = (packageName: string, target: string): string =>
  target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)
    ? target
    : `${EXTENSION_PATH}/${packageName}/${target.replace(/^\.?\//, '')}`

function rewriteAssets(value: unknown, packageName: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteAssets(item, packageName))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      ASSET_KEYS.has(key) && typeof item === 'string'
        ? assetPath(packageName, item)
        : rewriteAssets(item, packageName)
  }
  return out
}

function rewriteImportmap(
  importmap: PackageManifestImportmap | undefined,
  packageName: string,
): PackageManifestImportmap | undefined {
  if (!importmap) return undefined
  const imports: Record<string, string> = {}
  for (const [specifier, target] of Object.entries(importmap.imports ?? {}))
    imports[specifier] = assetPath(packageName, target)
  const scopes: Record<string, Record<string, string>> = {}
  for (const [scope, scopeImports] of Object.entries(importmap.scopes ?? {})) {
    const rewritten: Record<string, string> = {}
    for (const [specifier, target] of Object.entries(scopeImports))
      rewritten[specifier] = assetPath(packageName, target)
    scopes[assetPath(packageName, scope)] = rewritten
  }
  return Object.keys(scopes).length > 0 ? { imports, scopes } : { imports }
}

/** One dependency's manifest, or undefined when it declares no extensions. */
export function readExtension(
  directory: string,
  packageName: string,
): InstalledExtension | undefined {
  const json = readJson(join(directory, 'package.json'))
  const field = json?.bunbraco
  if (!field || !Array.isArray(field.extensions) || field.extensions.length === 0) return undefined
  return {
    packageName,
    version: json?.version ?? '0.0.0',
    directory,
    manifest: {
      name: field.name ?? packageName,
      id: field.id ?? packageName,
      version: json?.version ?? '0.0.0',
      allowPublicAccess: field.allowPublicAccess ?? false,
      allowTelemetry: field.allowTelemetry ?? false,
      extensions: field.extensions.map((extension) => rewriteAssets(extension, packageName)),
      importmap: rewriteImportmap(field.importmap, packageName),
    },
  }
}

/** Every declared dependency of the site that is a backoffice extension. */
export function discoverExtensions(siteDir: string): InstalledExtension[] {
  const json = readJson(join(siteDir, 'package.json'))
  if (!json?.dependencies) return []
  const found: InstalledExtension[] = []
  for (const name of Object.keys(json.dependencies).sort()) {
    const directory = resolvePackageDir(siteDir, name)
    if (!directory) continue
    const extension = readExtension(directory, name)
    if (extension) found.push(extension)
  }
  return found
}

/**
 * The package a `/packages/…` request names, and the file inside it.
 *
 * The name is matched against the site's own extensions rather than trusted, so
 * this cannot be used to read an arbitrary file out of `node_modules`; a scoped
 * name takes two segments, as npm writes it.
 */
export function resolveExtensionFile(
  extensions: readonly InstalledExtension[],
  pathname: string,
): string | undefined {
  const prefix = `${EXTENSION_PATH}/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  const segments = rest.split('/')
  const take = rest.startsWith('@') || rest.toLowerCase().startsWith('%40') ? 2 : 1
  if (segments.length <= take) return undefined
  // Decoded before matching, so `%40acme/seo` finds the same package the
  // manifest names. Safe because the name is only compared against the known
  // extensions, never joined into a path — the file part is what gets joined.
  let name: string
  try {
    name = decodeURIComponent(segments.slice(0, take).join('/'))
  } catch {
    return undefined
  }
  const relative = segments.slice(take).join('/')
  const extension = extensions.find((candidate) => candidate.packageName === name)
  if (!extension || relative.length === 0) return undefined

  const decoded = decodeURIComponent(relative)
  if (decoded.includes('\0')) return undefined
  const root = extension.directory.endsWith(sep)
    ? extension.directory
    : `${extension.directory}${sep}`
  const target = normalize(join(extension.directory, decoded))
  return target.startsWith(root) ? target : undefined
}

export interface ExtensionRegistry {
  list(): readonly InstalledExtension[]
  /** Called after an install or an uninstall, so the next read sees it. */
  invalidate(): void
}

/**
 * Discovery, memoized.
 *
 * Reading a handful of `package.json` files on every manifest request would be
 * wasteful, but the uncached behaviour is load-bearing in development: an author
 * editing a local extension expects a reload to show it, which is why `cache`
 * is off there rather than everywhere.
 */
export function createExtensionRegistry(
  siteDir: string,
  options: { cache?: boolean } = {},
): ExtensionRegistry {
  let cached: InstalledExtension[] | undefined
  const cache = options.cache ?? true
  return {
    list() {
      if (!cache) return discoverExtensions(siteDir)
      cached ??= discoverExtensions(siteDir)
      return cached
    },
    invalidate() {
      cached = undefined
    },
  }
}
