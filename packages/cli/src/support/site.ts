/** The site the CLI runs in: the current directory and its `crombolo.config.ts`. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type CromboloConfig, loadConfig } from '@crombolo/server'

export const cwd = (): string => process.cwd()

export async function siteConfig(): Promise<CromboloConfig> {
  const file = join(cwd(), 'crombolo.config.ts')
  const overrides = existsSync(file)
    ? ((await import(file)).default as Partial<CromboloConfig>)
    : {}
  return loadConfig(overrides, cwd())
}

export const hasSite = (): boolean => existsSync(join(cwd(), 'crombolo.config.ts'))

/** Where a command says things: its result on stdout, everything else on stderr. */
export interface Io {
  /** A line of the result, for people; nothing in JSON mode, where the result is returned. */
  say(line?: string): void
  /** Progress and narration, on stderr in every mode. */
  progress(line: string): void
  /** A problem that does not stop the command, on stderr. */
  warning(line: string): void
}
