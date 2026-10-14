/**
 * Reads the workspace manifests. Shared by the version and publish scripts and
 * by tests/packaging.test.ts, so all three agree on what ships and in what order.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ROOT = join(import.meta.dir, '..')

/** Versioned to the Umbraco release it vendors, not to crombolo's version. */
export const BACKOFFICE_DIST = '@crombolo/backoffice-dist'

/** The generated artefacts a package cannot be published without. */
export const GENERATED: Record<string, string> = {
  '@crombolo/contracts': 'generated/management-api.d.ts',
  [BACKOFFICE_DIST]: 'dist/umbraco-package.json',
}

export interface Manifest {
  name: string
  version: string
  private?: boolean
  description?: string
  license?: string
  keywords?: string[]
  files?: string[]
  engines?: Record<string, string>
  repository?: { type?: string; url?: string; directory?: string }
  exports?: Record<string, string | Record<string, string>>
  bin?: Record<string, string>
  dependencies?: Record<string, string>
  /** What a bundle declares for the backoffice; see `backoffice-host/src/extensions.ts`. */
  crombolo?: { id?: string; name?: string; extensions?: unknown[] }
}

export interface WorkspacePackage {
  name: string
  /** Absolute path to the package directory. */
  dir: string
  /** Path from the repository root, matching `repository.directory`. */
  relative: string
  manifest: Manifest
}

export function workspacePackages(): WorkspacePackage[] {
  const base = join(ROOT, 'packages')
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(base, entry.name)
      const file = join(dir, 'package.json')
      return { dir, relative: `packages/${entry.name}`, file }
    })
    .filter(({ file }) => Bun.file(file).size > 0)
    .map(({ dir, relative, file }) => {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest
      return { name: manifest.name, dir, relative, manifest }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The package a site installs, which depends on the rest. */
export const UMBRELLA = '@crombolo/crombolo'

export function publishablePackages(): WorkspacePackage[] {
  return workspacePackages().filter((pkg) => pkg.manifest.private !== true)
}

/**
 * Dependencies before dependents, so a consumer never resolves against a version
 * of a sibling the registry has not accepted yet. The umbrella goes last, after
 * the opt-in bundles it does not depend on, so `bun add` of it never races a
 * release still in flight.
 */
export function publishOrder(packages: WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const ordered: WorkspacePackage[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()

  const visit = (pkg: WorkspacePackage) => {
    if (done.has(pkg.name)) return
    if (visiting.has(pkg.name)) throw new Error(`Dependency cycle at ${pkg.name}`)
    visiting.add(pkg.name)
    for (const name of Object.keys(pkg.manifest.dependencies ?? {})) {
      const dependency = byName.get(name)
      if (dependency) visit(dependency)
    }
    visiting.delete(pkg.name)
    done.add(pkg.name)
    ordered.push(pkg)
  }

  for (const pkg of packages) if (pkg.name !== UMBRELLA) visit(pkg)
  for (const pkg of packages) if (pkg.name === UMBRELLA) visit(pkg)
  return ordered
}

const LOCK_ENTRY =
  /"((?:packages|apps)\/[^"]+)":\s*\{\s*"name":\s*"[^"]*",\s*"version":\s*"([^"]*)"/g

/**
 * The version bun.lock records for each workspace package, by path. `bun pm pack`
 * substitutes `workspace:*` from here, not from the manifest, so the two have to
 * agree before anything is published.
 */
export function lockedVersions(): Map<string, string> {
  const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8')
  return new Map(
    [...lock.matchAll(LOCK_ENTRY)].map((match) => [match[1] as string, match[2] as string]),
  )
}

/** The version every package shares, `@crombolo/backoffice-dist` excepted. */
export function sharedVersion(): string {
  const main = workspacePackages().find((pkg) => pkg.name === UMBRELLA)
  if (!main) throw new Error('The crombolo package is missing from packages/')
  return main.manifest.version
}
