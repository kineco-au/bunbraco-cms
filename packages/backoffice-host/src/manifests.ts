/**
 * Package manifest discovery: the vendored client contributes the core
 * manifest, the framework contributes its own, and each installed npm
 * extension contributes one (`extensions.ts`).
 *
 * The merged importmap is what the shell embeds; without it the backoffice
 * cannot resolve a single bare `@umbraco-cms/backoffice/*` specifier.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledExtension } from './extensions.ts'
import type { BackOfficePaths } from './paths.ts'
import { PLUGIN_PATH_PLACEHOLDER, VENDORED_ASSETS_PATH } from './paths.ts'

export const MANIFEST_FILE_NAME = 'umbraco-package.json'

/**
 * The assistant's own manifest, which the server omits when the feature is not
 * configured — so an unconfigured site serves no drawer and no button.
 */
export const ASSISTANT_MANIFEST_ID = 'Bunbraco.Assistant'

export interface PackageManifestImportmap {
  imports: Record<string, string>
  scopes?: Record<string, Record<string, string>>
}

export interface PackageManifest {
  name: string
  id?: string
  version?: string
  allowPublicAccess?: boolean
  allowTelemetry?: boolean
  allowCacheBusting?: boolean
  extensions: unknown[]
  importmap?: PackageManifestImportmap
}

/** The wire shape of GET /manifest/manifest. */
export interface ManifestResponseModel {
  name: string
  id?: string | null
  version?: string | null
  cacheBuster?: string | null
  extensions: unknown[]
}

function readManifest(file: string): PackageManifest | undefined {
  const content = readFileSync(file, 'utf8')
  if (content.trim().length === 0) return undefined
  return JSON.parse(content) as PackageManifest
}

/** Scans a directory for manifests: one in the root, or one per child directory. */
export function discoverManifests(dir: string): PackageManifest[] {
  if (!existsSync(dir)) return []
  const found: PackageManifest[] = []
  const rootManifest = join(dir, MANIFEST_FILE_NAME)
  if (existsSync(rootManifest)) {
    const manifest = readManifest(rootManifest)
    if (manifest) found.push(manifest)
  }
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry)
    if (!statSync(child).isDirectory()) continue
    const file = join(child, MANIFEST_FILE_NAME)
    if (!existsSync(file)) continue
    const manifest = readManifest(file)
    if (manifest) found.push(manifest)
  }
  return found
}

export interface ManifestSet {
  all: PackageManifest[]
  importmap: PackageManifestImportmap
}

/**
 * Collects the core manifest plus the installed extensions, and rewrites the
 * importmap's virtual directory to the cache-busted assets path — exactly what
 * Umbraco's HtmlHelperBackOfficeExtensions does with a string replace.
 *
 * `omit` drops a framework manifest by id, which is how an optional feature
 * leaves no trace in the backoffice when it is not configured.
 */
export function collectManifests(
  paths: BackOfficePaths,
  extensions: readonly InstalledExtension[] = [],
  options: { omit?: readonly string[] } = {},
): ManifestSet {
  const omit = new Set(options.omit ?? [])
  const all = [...discoverManifests(paths.vendorDir), ...frameworkManifests(paths)].filter(
    (manifest) => !omit.has(manifest.id ?? ''),
  )
  all.push(...extensions.map((extension) => extension.manifest))

  const imports: Record<string, string> = {}
  const scopes: Record<string, Record<string, string>> = {}
  for (const manifest of all) {
    if (!manifest.importmap) continue
    for (const [specifier, target] of Object.entries(manifest.importmap.imports)) {
      imports[specifier] = rewriteAssetPath(target, paths)
    }
    for (const [scope, scopeImports] of Object.entries(manifest.importmap.scopes ?? {})) {
      const rewritten: Record<string, string> = {}
      for (const [specifier, target] of Object.entries(scopeImports)) {
        rewritten[specifier] = rewriteAssetPath(target, paths)
      }
      scopes[rewriteAssetPath(scope, paths)] = rewritten
    }
  }
  const importmap: PackageManifestImportmap = { imports }
  if (Object.keys(scopes).length > 0) importmap.scopes = scopes
  return { all, importmap }
}

/** The framework's own package, its element paths rewritten to wherever the backoffice is mounted. */
function frameworkManifests(paths: BackOfficePaths): PackageManifest[] {
  return discoverManifests(paths.pluginDir).map((manifest) => {
    const text = JSON.stringify(manifest).replaceAll(
      `"${PLUGIN_PATH_PLACEHOLDER}/`,
      `"${paths.pluginPath}/`,
    )
    return JSON.parse(text) as PackageManifest
  })
}

function rewriteAssetPath(target: string, paths: BackOfficePaths): string {
  return target.startsWith(VENDORED_ASSETS_PATH)
    ? `${paths.assetsPath}${target.slice(VENDORED_ASSETS_PATH.length)}`
    : target
}

/** Public manifests are the ones the login screen may load before sign-in. */
export function toResponseModels(
  manifests: readonly PackageManifest[],
  cacheBuster: string,
  visibility: 'all' | 'public' | 'private' = 'all',
): ManifestResponseModel[] {
  return manifests
    .filter((m) => {
      if (visibility === 'all') return true
      const isPublic = m.allowPublicAccess === true
      return visibility === 'public' ? isPublic : !isPublic
    })
    .map((m) => ({
      name: m.name,
      id: m.id ?? null,
      version: m.version ?? null,
      cacheBuster: m.allowCacheBusting === false ? null : cacheBuster,
      extensions: m.extensions ?? [],
    }))
}
