/**
 * Writes the CLI's `oclif.manifest.json` (packages/cli/src/manifest.ts).
 *
 *   bun run cli:manifest
 *
 * The publish script writes it into the CLI package for the length of its pack
 * and removes it again, so a working tree never holds one that has gone stale.
 */
import { writeFileSync } from 'node:fs'
import { buildManifest, MANIFEST_FILE } from '../packages/cli/src/manifest.ts'

export const CLI_MANIFEST = MANIFEST_FILE

export async function writeCliManifest(): Promise<string> {
  writeFileSync(CLI_MANIFEST, `${JSON.stringify(await buildManifest(), null, 2)}\n`)
  return CLI_MANIFEST
}

if (import.meta.main) console.log(`wrote ${await writeCliManifest()}`)
