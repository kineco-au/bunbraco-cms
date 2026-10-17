/**
 * The CLI's commands, with the optional plugins found beside it (story 158).
 *
 * oclif loads a plugin only when the CLI's own `package.json` depends on it,
 * and warns when one is missing; an optional plugin is neither. So each name in
 * `oclif.optionalPlugins` is looked for here — in the site's `node_modules`,
 * then beside the CLI, as a global install puts it — loaded when it is found,
 * and passed over in silence when it is not.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Config, Plugin } from '@oclif/core'
import { CLI_DIR } from './manifest.ts'

/** The directory a package is installed in, looked for from each of `from` upward. */
export function findInstalled(name: string, from: readonly string[]): string | undefined {
  for (const start of from) {
    let dir = start
    for (;;) {
      const candidate = join(dir, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

export function optionalPlugins(): string[] {
  const pjson = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')) as {
    oclif?: { optionalPlugins?: string[] }
  }
  return pjson.oclif?.optionalPlugins ?? []
}

export interface LoadedCli {
  config: Config
  /** The optional plugins that are not installed. */
  missing: string[]
}

export async function loadCli(cwd: string = process.cwd()): Promise<LoadedCli> {
  const root = new Plugin({ root: CLI_DIR, isRoot: true, type: 'core' })
  await root.load()
  const plugins = new Map<string, Plugin>([[root.name, root]])
  const missing: string[] = []
  for (const name of optionalPlugins()) {
    const dir = findInstalled(name, [cwd, CLI_DIR])
    if (!dir) {
      missing.push(name)
      continue
    }
    const plugin = new Plugin({ root: dir, name, type: 'core' })
    await plugin.load()
    plugins.set(plugin.name, plugin)
  }
  return { config: await Config.load({ root: CLI_DIR, plugins }), missing }
}
