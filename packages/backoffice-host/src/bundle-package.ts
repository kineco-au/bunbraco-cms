/**
 * A bundle is an npm package whose `package.json` carries the bundle manifest in
 * its `crombolo` field. `docs/bundles.md`.
 *
 * This is the one place that field is read and validated, so discovery, the
 * marketplace, the server half and the installer cannot disagree about what a
 * bundle is.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import type { PackageManifestImportmap } from './manifests.ts'

/** The package a bundle declares its peer range on. */
export const CORE_PACKAGE = '@crombolo/crombolo'

/**
 * A bundle's id: its route segment, its log name, and the prefix of anything
 * else it owns. Lowercase, no dots or slashes, so it cannot climb out of a
 * namespace however it is spelled.
 */
export const BUNDLE_ID = /^[a-z][a-z0-9-]{1,38}$/

/** The `content` payload: always `bundle.json` inside the named directory. */
export const PAYLOAD_MANIFEST = 'bundle.json'

/** An exported binding name: what a site imports to wire the server half. */
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The `crombolo` field, as a bundle declares it. */
export interface CromboloField {
  id: string
  name?: string
  allowPublicAccess?: boolean
  allowTelemetry?: boolean
  /** The backoffice half: Umbraco extension manifests. */
  extensions?: unknown[]
  importmap?: PackageManifestImportmap
  /** A directory inside the package holding a `bundle.json` payload. */
  content?: string
  /** The factory the package exports for the server half. Never imported by core. */
  server?: string
  /**
   * What this release's table steps promise a running site, for a bundle that
   * owns tables: `breaking` exactly when it ships a contract.
   */
  migrations?: 'compatible' | 'breaking'
}

/** A bundle as read from its package. */
export interface BundlePackage {
  packageName: string
  version: string
  directory: string
  id: string
  name: string
  /** `peerDependencies["@crombolo/crombolo"]`. */
  peerRange: string
  private: boolean
  field: CromboloField
  /** Absolute path of the payload directory, when the bundle carries content. */
  contentDir: string | undefined
  carries: { extensions: boolean; content: boolean; server: boolean }
}

export interface PackageJson {
  name?: string
  version?: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  crombolo?: unknown
}

export function readPackageJson(file: string): PackageJson | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PackageJson)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a package's `crombolo` field declares a bundle at all.
 *
 * Core's own umbrella package carries a `crombolo` field too — its release
 * declaration — so the core package is never a bundle, whatever it holds.
 */
export function declaresBundle(json: PackageJson | undefined): boolean {
  return Boolean(json?.crombolo) && json?.name !== CORE_PACKAGE
}

/** A relative path that stays inside the package. */
function insidePackage(directory: string, relative: string): string | undefined {
  if (relative === '' || isAbsolute(relative) || relative.includes('\0')) return undefined
  const root = directory.endsWith(sep) ? directory : `${directory}${sep}`
  const target = normalize(join(directory, relative))
  return target === normalize(directory) || target.startsWith(root) ? target : undefined
}

/**
 * Every reason a package's manifest is not a bundle, reported together.
 *
 * `directory` is where the package lives, so `content` can be checked against
 * what is really there; a packument read from the registry has none, and only
 * the declaration is checked.
 */
export function validateBundlePackage(json: PackageJson, directory?: string): string[] {
  const problems: string[] = []
  const field = json.crombolo
  if (!field || typeof field !== 'object' || Array.isArray(field))
    return ['its package.json has no "crombolo" field, so it is not a bundle']
  const f = field as Record<string, unknown>

  if (typeof f.id !== 'string' || !BUNDLE_ID.test(f.id))
    problems.push(
      `"crombolo.id" must be 2–39 lowercase letters, digits and hyphens starting with a letter${
        typeof f.id === 'string' ? `, not "${f.id}"` : ''
      }`,
    )
  if (f.name !== undefined && (typeof f.name !== 'string' || f.name.trim() === ''))
    problems.push('"crombolo.name" must be a non-empty string')
  if (typeof json.name !== 'string' || json.name === '')
    problems.push('its package.json has no "name"')
  if (typeof json.version !== 'string' || json.version === '')
    problems.push('its package.json has no "version"')

  if (f.extensions !== undefined && !Array.isArray(f.extensions))
    problems.push('"crombolo.extensions" must be a list of extension manifests')
  if (f.migrations !== undefined && f.migrations !== 'compatible' && f.migrations !== 'breaking')
    problems.push('"crombolo.migrations" is "compatible" or "breaking"')
  if (f.server !== undefined && (typeof f.server !== 'string' || !EXPORT_NAME.test(f.server)))
    problems.push('"crombolo.server" must name the factory the package exports')
  if (f.content !== undefined) {
    if (typeof f.content !== 'string') problems.push('"crombolo.content" must be a directory')
    else if (directory) {
      const target = insidePackage(directory, f.content)
      if (!target) problems.push(`"crombolo.content" (${f.content}) is outside the package`)
      else if (!existsSync(join(target, PAYLOAD_MANIFEST)))
        problems.push(`"crombolo.content" (${f.content}) holds no ${PAYLOAD_MANIFEST}`)
    } else if (isAbsolute(f.content) || f.content.split(/[\\/]/).includes('..'))
      problems.push(`"crombolo.content" (${f.content}) is outside the package`)
  }

  const hasExtensions = Array.isArray(f.extensions) && f.extensions.length > 0
  if (!hasExtensions && f.content === undefined && f.server === undefined)
    problems.push(
      'it declares no "extensions", "content" or "server", so it is a bundle that does nothing',
    )

  const peer = json.peerDependencies?.[CORE_PACKAGE]
  if (typeof peer !== 'string' || peer.trim() === '')
    problems.push(`its package.json declares no peerDependencies["${CORE_PACKAGE}"]`)
  return problems
}

/**
 * The package at a directory, read as a bundle.
 *
 * `undefined` with no problems means the package is not a bundle at all — an
 * ordinary dependency. Problems mean it claims to be one and is malformed.
 */
export function readBundlePackage(directory: string): {
  bundle: BundlePackage | undefined
  problems: string[]
} {
  const json = readPackageJson(join(directory, 'package.json'))
  if (!declaresBundle(json)) return { bundle: undefined, problems: [] }
  const problems = validateBundlePackage(json as PackageJson, directory)
  if (problems.length > 0) return { bundle: undefined, problems }
  const pkg = json as Required<Pick<PackageJson, 'name' | 'version'>> & PackageJson
  const field = pkg.crombolo as CromboloField
  return {
    bundle: {
      packageName: pkg.name,
      version: pkg.version,
      directory,
      id: field.id,
      name: field.name ?? pkg.name,
      peerRange: pkg.peerDependencies?.[CORE_PACKAGE] as string,
      private: pkg.private === true,
      field,
      contentDir: field.content ? insidePackage(directory, field.content) : undefined,
      carries: {
        extensions: Array.isArray(field.extensions) && field.extensions.length > 0,
        content: field.content !== undefined,
        server: field.server !== undefined,
      },
    },
    problems: [],
  }
}

const COMPARATOR = /^(?:[~^]|[<>]=?|=)?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?$/

/** A semver range, token by token: Bun's own matcher accepts nonsense and matches it. */
export function isSemverRange(range: string): boolean {
  const tokens = range.trim().split(/\s+/)
  return tokens.length > 0 && tokens.every((t) => t === '||' || t === '-' || COMPARATOR.test(t))
}

/** Whether a bundle's peer range admits a core version; a reason when it does not. */
export function peerRangeProblem(bundle: BundlePackage, coreVersion: string): string | undefined {
  // A workspace link is resolved to this very tree, so it is this version by construction.
  if (bundle.peerRange.startsWith('workspace:')) return undefined
  const satisfied =
    isSemverRange(bundle.peerRange) && Bun.semver.satisfies(coreVersion, bundle.peerRange)
  return satisfied
    ? undefined
    : `${bundle.packageName} (${bundle.id}) is written for ${CORE_PACKAGE} ${bundle.peerRange}, and this site runs ${coreVersion}`
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

export interface DiscoveredBundles {
  bundles: BundlePackage[]
  /** A declared dependency that claims to be a bundle and is not a valid one. */
  problems: { packageName: string; problems: string[] }[]
}

/**
 * Every declared dependency of the site that is a bundle.
 *
 * Only declared dependencies are read, never a walk of `node_modules`, so a
 * transitive dependency cannot claim to be a bundle the site never asked for.
 */
export function discoverBundles(siteDir: string): DiscoveredBundles {
  const json = readPackageJson(join(siteDir, 'package.json'))
  const found: DiscoveredBundles = { bundles: [], problems: [] }
  if (!json?.dependencies) return found
  for (const name of Object.keys(json.dependencies).sort()) {
    const directory = resolvePackageDir(siteDir, name)
    if (!directory) continue
    const read = readBundlePackage(directory)
    if (read.bundle) found.bundles.push(read.bundle)
    else if (read.problems.length > 0)
      found.problems.push({ packageName: name, problems: read.problems })
  }
  return found
}

/** Whether a path is a directory, for telling a package path from a package name. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
