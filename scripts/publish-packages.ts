/**
 * Publishes the workspace to npm as one fixed-version set.
 *
 *   bun run scripts/publish-packages.ts --dry-run
 *   bun run scripts/publish-packages.ts
 *
 * Packs with Bun, which substitutes `workspace:*` for the concrete version, then
 * uploads the tarball with npm, which is what signs provenance. A version the
 * registry already holds is skipped rather than failing the run, so a release
 * that only changes some packages does not need the set trimmed by hand.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  GENERATED,
  type Manifest,
  publishablePackages,
  publishOrder,
  ROOT,
  type WorkspacePackage,
} from './packages.ts'

const REGISTRY = 'https://registry.npmjs.org'
const OUT = join(ROOT, 'output/packages')

/**
 * Copied beside each manifest while packing, then removed again. npm includes a
 * LICENSE automatically; NOTICE it does not, so it is placed explicitly — and in
 * every package rather than only the two that redistribute third-party material.
 * `bunbraco` is what a site installs and what a downstream redistributor reads,
 * and a rule with no exceptions has nothing to drift.
 */
const LICENCE_FILES = ['LICENSE', 'NOTICE'] as const

const args = Bun.argv.slice(2)
const dryRun = args.includes('--dry-run')
const tagIndex = args.indexOf('--tag')
const tag = (tagIndex === -1 ? undefined : args[tagIndex + 1]) ?? 'latest'
// Provenance is signed from the CI identity; npm refuses it anywhere else.
const provenance = Boolean(Bun.env.GITHUB_ACTIONS)

const run = async (command: string[], cwd: string, quiet = false) => {
  const proc = Bun.spawn(command, {
    cwd,
    // Packing the backoffice lists 15,000 files; the summary below says enough.
    stdout: quiet ? 'ignore' : 'inherit',
    stderr: 'inherit',
  })
  if ((await proc.exited) !== 0) throw new Error(`${command.join(' ')} exited ${proc.exitCode}`)
}

/** The manifest as packed, so what the registry will receive is what is checked. */
async function packedManifest(tarball: string): Promise<Manifest> {
  const proc = Bun.spawn(['tar', '-xzOf', tarball, 'package/package.json'], { stdout: 'pipe' })
  const text = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`Could not read ${tarball}`)
  return JSON.parse(text) as Manifest
}

async function publishedVersions(name: string): Promise<Set<string>> {
  const response = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (response.status === 404) return new Set()
  if (!response.ok) throw new Error(`${REGISTRY} answered ${response.status} for ${name}`)
  const body = (await response.json()) as { versions?: Record<string, unknown> }
  return new Set(Object.keys(body.versions ?? {}))
}

/** A missing generated artefact would publish a package that cannot boot. */
function assertGenerated(packages: WorkspacePackage[]) {
  const missing: string[] = []
  for (const pkg of packages) {
    const artefact = GENERATED[pkg.name]
    if (artefact && !existsSync(join(pkg.dir, artefact)))
      missing.push(`${pkg.name} is missing ${artefact}`)
  }
  if (missing.length > 0)
    throw new Error(
      `${missing.join('\n')}\nRun "bun run generate:types" and "bun run vendor:backoffice" first.`,
    )
}

const packages = publishOrder(publishablePackages())
const versions = new Map(packages.map((pkg) => [pkg.name, pkg.manifest.version]))
assertGenerated(packages)

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const published: string[] = []
const skipped: string[] = []

for (const pkg of packages) {
  const { name, version } = pkg.manifest
  if ((await publishedVersions(name)).has(version)) {
    console.log(`skip     ${name}@${version} (already on the registry)`)
    skipped.push(`${name}@${version}`)
    continue
  }

  for (const file of LICENCE_FILES) copyFileSync(join(ROOT, file), join(pkg.dir, file))

  try {
    await run(['bun', 'pm', 'pack', '--destination', OUT], pkg.dir, true)
    const tarball = join(OUT, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)
    if (!existsSync(tarball)) throw new Error(`Expected ${tarball}`)

    const packed = await packedManifest(tarball)
    if (packed.version !== version) throw new Error(`${name} packed as ${packed.version}`)
    for (const [dependency, range] of Object.entries(packed.dependencies ?? {})) {
      if (range.startsWith('workspace:'))
        throw new Error(`${name} kept a workspace range for ${dependency}`)
      // Bun resolves `workspace:*` from bun.lock, which `bun install` does not
      // refresh when a version changes. A mismatch here means the lockfile is
      // stale, and publishing would pin siblings to a version nobody released.
      const expected = versions.get(dependency)
      if (expected && range !== expected)
        throw new Error(
          `${name} depends on ${dependency}@${range}, but this release publishes ${expected}. ` +
            'Run "bun run release:version <version>" to bring bun.lock into line.',
        )
    }

    if (dryRun) {
      console.log(`packed   ${name}@${version}`)
    } else {
      await run(
        [
          'npm',
          'publish',
          tarball,
          '--access',
          'public',
          '--tag',
          tag,
          ...(provenance ? ['--provenance'] : []),
        ],
        ROOT,
      )
      console.log(`publish  ${name}@${version}`)
    }
    published.push(`${name}@${version}`)
  } finally {
    for (const file of LICENCE_FILES) rmSync(join(pkg.dir, file), { force: true })
  }
}

console.log(
  `\n${dryRun ? 'Packed' : 'Published'} ${published.length}, skipped ${skipped.length}, of ${packages.length} packages.`,
)
