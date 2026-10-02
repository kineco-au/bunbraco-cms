/**
 * Validates the vendored backoffice the way a browser links it.
 *
 * The boot crawl in tests/boot.test.ts proves every module resolves and is served.
 * A browser additionally checks *bindings*, and fails with
 * "Export 'X' is not defined in module" when a named import is missing from its
 * target — which resolution alone cannot catch.
 *
 * Sources are run through Bun's transpiler first so comments cannot be mistaken
 * for code (the npm package's JSDoc contains example import statements).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const VENDOR = join(ROOT, 'packages/backoffice-dist/dist')
const BASE = '/umbraco/backoffice'
const transpiler = new Bun.Transpiler({ loader: 'js' })

const EXPORT_STAR = /export\s*\*\s*from\s*["']([^"']+)["']/g
const NAMED_FROM = /(?:import|export)\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g

interface ModuleInfo {
  own: Set<string>
  starFrom: string[]
  namedFrom: Map<string, Set<string>>
  allImports: string[]
  /** Set when the module is not valid ESM — see `unparseable` in the report. */
  parseError: string | undefined
}

function bindingsOf(clause: string): string[] {
  return clause
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.split(/\s+as\s+/)[0] as string).trim())
    .filter((name) => name.length > 0 && name !== 'type')
}

function parse(file: string): ModuleInfo {
  const source = readFileSync(file, 'utf8')
  const scanned = transpiler.scan(source)
  let clean: string
  let parseError: string | undefined
  try {
    clean = transpiler.transformSync(source)
  } catch (error) {
    // A module that will not transpile will not link either. This is the check
    // that catches an export clause whose bindings do not exist — the shape a
    // browser reports as "Export 'X' is not defined in module".
    clean = source
    parseError = (error as Error).message.split('\n')[0]
  }

  const starFrom: string[] = []
  for (const match of clean.matchAll(EXPORT_STAR)) starFrom.push(match[1] as string)

  const namedFrom = new Map<string, Set<string>>()
  for (const match of clean.matchAll(NAMED_FROM)) {
    const target = match[2] as string
    const set = namedFrom.get(target) ?? new Set<string>()
    for (const name of bindingsOf(match[1] as string)) set.add(name)
    namedFrom.set(target, set)
  }

  return {
    own: new Set(scanned.exports),
    starFrom,
    namedFrom,
    allImports: scanned.imports.map((entry) => entry.path),
    parseError,
  }
}

// Loaded lazily: the vendor script imports this module before the build has
// produced the manifest, and importing must not require the dist to exist.
let importMapCache: Record<string, string> | undefined
function importMap(): Record<string, string> {
  if (!importMapCache) {
    importMapCache = JSON.parse(readFileSync(join(VENDOR, 'umbraco-package.json'), 'utf8'))
      .importmap.imports as Record<string, string>
  }
  return importMapCache
}

function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(fromFile), specifier)
    return existsSync(target) ? target : undefined
  }
  if (specifier.startsWith('/')) {
    const target = join(VENDOR, specifier.slice(BASE.length + 1))
    return existsSync(target) ? target : undefined
  }
  const mapped = importMap()[specifier]
  if (!mapped) return undefined
  const target = join(VENDOR, mapped.slice(BASE.length + 1))
  return existsSync(target) ? target : undefined
}

const cache = new Map<string, ModuleInfo>()
const infoFor = (file: string): ModuleInfo => {
  const cached = cache.get(file)
  if (cached) return cached
  const info = parse(file)
  cache.set(file, info)
  return info
}

function exportsOf(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return new Set()
  seen.add(file)
  const info = infoFor(file)
  const all = new Set(info.own)
  for (const specifier of info.starFrom) {
    const target = resolveSpecifier(specifier, file)
    if (!target) continue
    for (const name of exportsOf(target, seen)) all.add(name)
  }
  return all
}

const short = (file: string) => file.slice(VENDOR.length + 1)

export interface GraphReport {
  moduleCount: number
  missingExports: string[]
  unresolved: string[]
  unparseable: string[]
}

export function checkModuleGraph(): GraphReport {
  const entry = join(VENDOR, 'apps/app/app.element.js')
  const queue = [entry]
  const visited = new Set<string>()
  const missingExports: string[] = []
  const unresolved = new Set<string>()
  const unparseable: string[] = []

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (visited.has(file)) continue
    visited.add(file)
    const info = infoFor(file)
    if (info.parseError) unparseable.push(`${short(file)}: ${info.parseError}`)

    for (const specifier of info.allImports) {
      const target = resolveSpecifier(specifier, file)
      if (!target) {
        unresolved.add(`${specifier} (from ${short(file)})`)
        continue
      }
      queue.push(target)
    }

    for (const [specifier, names] of info.namedFrom) {
      const target = resolveSpecifier(specifier, file)
      if (!target) continue
      const available = exportsOf(target)
      for (const name of names) {
        if (name === 'default' || available.has(name)) continue
        missingExports.push(
          `${short(file)} imports '${name}' from '${specifier}' -> ${short(target)} does not export it`,
        )
      }
    }
  }

  return { moduleCount: visited.size, missingExports, unresolved: [...unresolved], unparseable }
}

if (import.meta.main) {
  const report = checkModuleGraph()
  console.log(`checked ${report.moduleCount} modules`)
  console.log(`missing named exports: ${report.missingExports.length}`)
  for (const problem of report.missingExports.slice(0, 40)) console.log(`  ${problem}`)
  console.log(`unresolved specifiers: ${report.unresolved.length}`)
  for (const specifier of report.unresolved.slice(0, 20)) console.log(`  ${specifier}`)
  console.log(`modules that will not link: ${report.unparseable.length}`)
  for (const problem of report.unparseable.slice(0, 20)) console.log(`  ${problem}`)
  if (
    report.missingExports.length > 0 ||
    report.unresolved.length > 0 ||
    report.unparseable.length > 0
  ) {
    process.exit(1)
  }
}
