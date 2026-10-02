/**
 * Sets one version across every published package, and the VERSION constant the
 * server reports. `@bunbraco/backoffice-dist` is excluded: it tracks the Umbraco
 * release it vendors, and is bumped with --backoffice-dist.
 *
 *   bun run scripts/version.ts 0.2.0
 *   bun run scripts/version.ts --backoffice-dist 18.3.0
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  BACKOFFICE_DIST,
  publishablePackages,
  ROOT,
  type WorkspacePackage,
  workspacePackages,
} from './packages.ts'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const PLUGIN_DIR = join(ROOT, 'packages/backoffice-host/plugin')

/**
 * Every `umbraco-package.json` the backoffice host contributes, at the root of the
 * plugin directory and one level down — the same shape `discoverManifests` reads,
 * including the generated `localizations/` one, so a bump needs no regeneration.
 */
function backOfficeManifests(): string[] {
  const found: string[] = []
  const root = join(PLUGIN_DIR, 'umbraco-package.json')
  if (existsSync(root)) found.push(root)
  for (const entry of readdirSync(PLUGIN_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nested = join(PLUGIN_DIR, entry.name, 'umbraco-package.json')
    if (existsSync(nested)) found.push(nested)
  }
  return found
}
const CONFIG = join(ROOT, 'packages/server/src/config.ts')
const VERSION_LINE = /^export const VERSION = '.*'$/m
const VERSION_FIELD = /^(\s*"version":\s*)"[^"]*"/m
const LOCK = join(ROOT, 'bun.lock')

/**
 * bun.lock holds each workspace package's version, and `bun install` will not
 * refresh it on its own — not even with --force. `bun pm pack` resolves
 * `workspace:*` from the lockfile, so skipping this would publish packages whose
 * siblings are pinned to the previous version.
 */
const lockPattern = (relative: string) =>
  new RegExp(`("${relative}":\\s*\\{\\s*"name":\\s*"[^"]*",\\s*"version":\\s*)"[^"]*"`)

const args = Bun.argv.slice(2)
let version: string | undefined
let distVersion: string | undefined
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index] as string
  if (arg === '--backoffice-dist') {
    index += 1
    distVersion = args[index]
  } else if (!arg.startsWith('--')) version ??= arg
}

if (!version && !distVersion) {
  console.error('Usage: bun run scripts/version.ts <version> [--backoffice-dist <version>]')
  process.exit(1)
}
for (const value of [version, distVersion])
  if (value !== undefined && !SEMVER.test(value)) {
    console.error(`"${value}" is not a semantic version`)
    process.exit(1)
  }

const changes: Array<[pkg: WorkspacePackage, value: string]> = []
if (version)
  for (const pkg of publishablePackages())
    if (pkg.name !== BACKOFFICE_DIST) changes.push([pkg, version])

if (distVersion) {
  const dist = workspacePackages().find((pkg) => pkg.name === BACKOFFICE_DIST)
  if (!dist) throw new Error(`${BACKOFFICE_DIST} is missing from packages/`)
  changes.push([dist, distVersion])
}

for (const [pkg, value] of changes) {
  const file = join(pkg.dir, 'package.json')
  const source = readFileSync(file, 'utf8')
  if (!VERSION_FIELD.test(source)) throw new Error(`No version field in ${file}`)
  // Rewritten as text rather than re-serialised, so key order and formatting
  // stay exactly as committed and the diff is one line.
  writeFileSync(file, source.replace(VERSION_FIELD, `$1"${value}"`))
  console.log(`${pkg.name} -> ${value}`)
}

let lock = readFileSync(LOCK, 'utf8')
for (const [pkg, value] of changes) {
  const pattern = lockPattern(pkg.relative)
  if (!pattern.test(lock)) throw new Error(`No ${pkg.relative} entry in bun.lock`)
  lock = lock.replace(pattern, `$1"${value}"`)
}
writeFileSync(LOCK, lock)
console.log(`bun.lock -> ${changes.length} workspace ${changes.length === 1 ? 'entry' : 'entries'}`)

if (version) {
  const config = readFileSync(CONFIG, 'utf8')
  if (!VERSION_LINE.test(config)) throw new Error(`No VERSION constant in ${CONFIG}`)
  writeFileSync(CONFIG, config.replace(VERSION_LINE, `export const VERSION = '${version}'`))
  console.log(`VERSION in packages/server/src/config.ts -> ${version}`)

  // The backoffice package manifests carry a version too, and the client reports
  // it in the manifest response — so leaving them behind means the editor tells
  // you it is running a version that was never released. They are not npm
  // packages, so `publishablePackages()` does not see them.
  for (const file of backOfficeManifests()) {
    const source = readFileSync(file, 'utf8')
    if (!VERSION_FIELD.test(source)) throw new Error(`No version field in ${file}`)
    writeFileSync(file, source.replace(VERSION_FIELD, `$1"${version}"`))
    console.log(`${relative(ROOT, file)} -> ${version}`)
  }
}
