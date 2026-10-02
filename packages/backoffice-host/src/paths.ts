import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_BACKOFFICE_PATH as CORE_DEFAULT } from '@bunbraco/core'

/**
 * Path layout for the hosted backoffice.
 *
 * Umbraco serves assets from a cache-busted virtual directory,
 * `/umbraco/backoffice/<hash>/…`, and rewrites the hash away in middleware. We
 * reproduce that because the import map and the shell both embed the hashed
 * path, and long-lived immutable caching depends on it.
 */
export interface BackOfficePaths {
  /** e.g. /umbraco */
  readonly backOfficePath: string
  /** e.g. /umbraco/backoffice */
  readonly virtualDirectory: string
  /** e.g. /umbraco/backoffice/a1b2c3d4 */
  readonly assetsPath: string
  readonly cacheBustHash: string
  /** Directory on disk holding the vendored client. */
  readonly vendorDir: string
  /** e.g. /bunbraco/bunbraco — where the framework's own backoffice package is served. */
  readonly pluginPath: string
  /** Directory on disk holding that package: a manifest and its modules. */
  readonly pluginDir: string
}

export { DEFAULT_BACKOFFICE_PATH } from '@bunbraco/core'

/**
 * Where the vendored client's own manifest says its assets live. The vendor
 * script bakes this literal in, so it is the prefix to rewrite from however the
 * backoffice is mounted — not `virtualDirectory`, which moves with it.
 */
export const VENDORED_ASSETS_PATH = '/umbraco/backoffice'

/**
 * The stand-in our own manifests use for their element paths, which
 * `collectManifests` rewrites to `pluginPath`. Nothing is ever served from it:
 * the real path moves with wherever the backoffice is mounted, and a manifest on
 * disk cannot know that, so it names this instead.
 */
export const PLUGIN_PATH_PLACEHOLDER = '/bunbraco-plugin'

export interface BackOfficePathOptions {
  backOfficePath?: string
  vendorDir?: string
  pluginDir?: string
}

/** The framework's backoffice package: the Changes dashboard and the read-only banner. */
export function defaultPluginDir(): string {
  return join(import.meta.dir, '../plugin')
}

/** Derived from the vendored VERSION so a re-vendor invalidates browser caches. */
export function cacheBustHash(vendorDir: string): string {
  const versionFile = join(vendorDir, 'VERSION')
  const seed = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : 'unvendored'
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

/**
 * The built client ships as its own package, `@bunbraco/backoffice-dist`, so it
 * is resolved like any dependency. The fallback is the monorepo layout, for a
 * checkout where the workspace has not been installed yet.
 */
export function defaultVendorDir(): string {
  try {
    return join(
      dirname(Bun.resolveSync('@bunbraco/backoffice-dist/package.json', import.meta.dir)),
      'dist',
    )
  } catch {
    return join(import.meta.dir, '../../backoffice-dist/dist')
  }
}

export function createBackOfficePaths(options: BackOfficePathOptions = {}): BackOfficePaths {
  const backOfficePath = (options.backOfficePath ?? CORE_DEFAULT).replace(/\/+$/, '')
  const vendorDir = options.vendorDir ?? defaultVendorDir()
  const virtualDirectory = `${backOfficePath}/backoffice`
  const hash = cacheBustHash(vendorDir)
  return {
    backOfficePath,
    virtualDirectory,
    assetsPath: `${virtualDirectory}/${hash}`,
    cacheBustHash: hash,
    vendorDir,
    pluginPath: `${backOfficePath}/bunbraco`,
    pluginDir: options.pluginDir ?? defaultPluginDir(),
  }
}

/**
 * Client-side routes the SPA owns. Umbraco constrains its catch-all to these,
 * so anything else under /umbraco is a genuine 404 rather than the shell.
 */
export const SPA_ROUTES = [
  'section',
  'preview',
  'upgrade',
  'install',
  'oauth_complete',
  'logout',
  'error',
] as const

export function isSpaRoute(backOfficePath: string, pathname: string): boolean {
  if (pathname === backOfficePath || pathname === `${backOfficePath}/`) return true
  if (!pathname.startsWith(`${backOfficePath}/`)) return false
  const rest = pathname.slice(backOfficePath.length + 1)
  const first = rest.split('/')[0] ?? ''
  return SPA_ROUTES.includes(first as (typeof SPA_ROUTES)[number])
}
