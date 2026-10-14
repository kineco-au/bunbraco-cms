/**
 * Backoffice extensions as npm dependencies. `docs/bundles.md`.
 *
 * A site's extensions are its dependencies: discovery reads the site's own
 * `package.json`, resolves each dependency through `node_modules`, and takes the
 * `crombolo` field from the dependency's `package.json`. There is no directory
 * convention to keep in step, and `bun add` is the install.
 *
 * Only declared dependencies are read, never a walk of `node_modules`, so a
 * transitive dependency cannot put an extension into a backoffice that never
 * asked for it.
 */
import { join, normalize, sep } from 'node:path'
import {
  type BundlePackage,
  type DiscoveredBundles,
  discoverBundles,
  readBundlePackage,
} from './bundle-package.ts'
import type { PackageManifest, PackageManifestImportmap } from './manifests.ts'

/** Where an installed bundle's assets are served from. */
export const EXTENSION_PATH = '/bundles'

/** The npm keyword a bundle publishes so the marketplace can find it. */
export const EXTENSION_KEYWORD = 'crombolo-bundle'

/** A bundle's backoffice half, as the manifest endpoint serves it. */
export interface InstalledExtension {
  /** The npm package name, which is also its segment in the asset path. */
  packageName: string
  version: string
  directory: string
  manifest: PackageManifest
  bundle: BundlePackage
}

/**
 * Asset references inside an extension. Only these carry a path; rewriting
 * every string would corrupt labels and aliases that happen to look like one.
 */
const ASSET_KEYS = new Set(['element', 'api', 'js', 'loader'])

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

/** A bundle's backoffice half, or undefined when it declares no extensions. */
export function extensionOf(bundle: BundlePackage): InstalledExtension | undefined {
  const field = bundle.field
  if (!bundle.carries.extensions) return undefined
  const packageName = bundle.packageName
  return {
    packageName,
    version: bundle.version,
    directory: bundle.directory,
    bundle,
    manifest: {
      name: bundle.name,
      id: bundle.id,
      version: bundle.version,
      allowPublicAccess: field.allowPublicAccess ?? false,
      allowTelemetry: field.allowTelemetry ?? false,
      extensions: (field.extensions ?? []).map((extension) =>
        rewriteAssets(extension, packageName),
      ),
      importmap: rewriteImportmap(field.importmap, packageName),
    },
  }
}

/** One dependency's backoffice half, or undefined when it is no bundle or declares no extensions. */
export function readExtension(directory: string): InstalledExtension | undefined {
  const { bundle } = readBundlePackage(directory)
  return bundle ? extensionOf(bundle) : undefined
}

/** Every declared dependency of the site that is a bundle with a backoffice half. */
export function discoverExtensions(siteDir: string): InstalledExtension[] {
  return discoverBundles(siteDir).bundles.flatMap((bundle) => extensionOf(bundle) ?? [])
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
  /** Every bundle the site depends on, whatever it carries, and the ones that are malformed. */
  bundles(): DiscoveredBundles
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
  let cached: DiscoveredBundles | undefined
  const cache = options.cache ?? true
  const discovered = () => {
    if (!cache) return discoverBundles(siteDir)
    cached ??= discoverBundles(siteDir)
    return cached
  }
  return {
    list: () => discovered().bundles.flatMap((bundle) => extensionOf(bundle) ?? []),
    bundles: discovered,
    invalidate() {
      cached = undefined
    },
  }
}
