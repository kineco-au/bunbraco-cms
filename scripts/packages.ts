/**
 * Reads the workspace manifests. Shared by the version and publish scripts and
 * by tests/packaging.test.ts, so all three agree on what ships and in what order.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ROOT = join(import.meta.dir, '..')

/** Versioned to the Umbraco release it vendors, not to bunbraco's version. */
export const BACKOFFICE_DIST = '@bunbraco/backoffice-dist'

/** The generated artefacts a package cannot be published without. */
export const GENERATED: Record<string, string> = {
  '@bunbraco/contracts': 'generated/management-api.d.ts',
  [BACKOFFICE_DIST]: 'dist/umbraco-package.json',
}

export interface Manifest {
  name: string
  version: string
  private?: boolean
  description?: string
  license?: string
  files?: string[]
  engines?: Record<string, string>
  repository?: { type?: string; url?: string; directory?: string }
  exports?: Record<string, string | Record<string, string>>
  bin?: Record<string, string>
  dependencies?: Record<string, string>
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

export function publishablePackages(): WorkspacePackage[] {
  return workspacePackages().filter((pkg) => pkg.manifest.private !== true)
}

/**
 * Dependencies before dependents, so a consumer never resolves against a version
 * of a sibling the registry has not accepted yet.
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

  for (const pkg of packages) visit(pkg)
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

/** The version every package shares, `@bunbraco/backoffice-dist` excepted. */
export function sharedVersion(): string {
  const main = workspacePackages().find((pkg) => pkg.name === 'bunbraco')
  if (!main) throw new Error('The bunbraco package is missing from packages/')
  return main.manifest.version
}
