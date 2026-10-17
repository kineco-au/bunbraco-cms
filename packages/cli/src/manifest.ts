/**
 * The CLI's `oclif.manifest.json`: every command's args, flags and clispec
 * `spec`, cached so a start reads one file rather than importing every command.
 */
import { join } from 'node:path'
import { Config, type Interfaces } from '@oclif/core'

export const CLI_DIR = join(import.meta.dir, '..')
export const MANIFEST_FILE = join(CLI_DIR, 'oclif.manifest.json')

export async function buildManifest(): Promise<Interfaces.Manifest> {
  const config = await Config.load(CLI_DIR)
  const commands = Object.fromEntries(
    config.commands
      .map((command) => [command.id, command] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  // Through JSON, as oclif reads it back: each command's `load` is dropped.
  return JSON.parse(JSON.stringify({ commands, version: config.version })) as Interfaces.Manifest
}

/** The manifest's shape for any loaded config: the CLI's commands and its plugins'. */
export function manifestOf(config: Config): Interfaces.Manifest {
  const commands = Object.fromEntries(
    config.commands
      .map((command) => [command.id, command] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  return JSON.parse(JSON.stringify({ commands, version: config.version })) as Interfaces.Manifest
}
