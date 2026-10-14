/**
 * The migration-compatibility declaration a release publishes, so a platform can
 * tell whether it may roll an upgrade under live traffic before installing it
 * (docs/10-packaging-and-upgrades.md, "The release declaration").
 *
 * It lives in the `@crombolo/crombolo` umbrella's package.json — `"crombolo": {
 * "migrations": "compatible" | "breaking" }` — because that is readable both
 * from an installed package and from the registry, for any version, without
 * installing anything. The value is derived from the migration plan, never
 * typed: `release:version` writes it, the suite fails when it drifts, and the
 * publish refuses a manifest that disagrees.
 */
import { join } from 'node:path'
import { cromboloPlan, type MigrationCompatibility, migrationCompatibility } from '@crombolo/data'
import { ROOT } from './packages.ts'

export const UMBRELLA_MANIFEST = join(ROOT, 'packages/crombolo/package.json')

const DECLARATION = /("crombolo":\s*\{\s*"migrations":\s*)"[^"]*"/
const VERSION_LINE = /^(\s*"version":\s*"[^"]*",\n)/m

/** What the plan says a release of `version` is. */
export function expectedCompatibility(version: string): MigrationCompatibility {
  return migrationCompatibility(cromboloPlan, version)
}

/** What a manifest declares, or undefined when it declares nothing. */
export function declaredCompatibility(manifest: unknown): string | undefined {
  const field = (manifest as { crombolo?: { migrations?: unknown } } | null)?.crombolo?.migrations
  return typeof field === 'string' ? field : undefined
}

/** Writes the declaration into a manifest's text, keeping its formatting. */
export function writeDeclaration(source: string, value: MigrationCompatibility): string {
  if (DECLARATION.test(source)) return source.replace(DECLARATION, `$1"${value}"`)
  if (!VERSION_LINE.test(source)) throw new Error('No version field to place the declaration after')
  return source.replace(VERSION_LINE, `$1  "crombolo": {\n    "migrations": "${value}"\n  },\n`)
}
