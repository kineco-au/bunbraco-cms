/**
 * `remotes.toml` at a site's root (story 108): the remotes a team pulls from
 * and pushes to, by name — URLs only, never credentials, so it is committed.
 *
 *   [remotes.production]
 *   url = "https://example.com"
 *   environment = "production"
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REMOTES_FILE = 'remotes.toml'

export interface RemoteEntry {
  name: string
  url: string
  /** The environment a pull or push goes to when `--env` is not given. */
  environment?: string
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/

export function readRemotes(siteDir: string): RemoteEntry[] {
  const file = join(siteDir, REMOTES_FILE)
  if (!existsSync(file)) return []
  const parsed = Bun.TOML.parse(readFileSync(file, 'utf8')) as {
    remotes?: Record<string, { url?: unknown; environment?: unknown }>
  }
  return Object.entries(parsed.remotes ?? {}).flatMap(([name, entry]) =>
    typeof entry?.url === 'string'
      ? [
          {
            name,
            url: entry.url,
            ...(typeof entry.environment === 'string' ? { environment: entry.environment } : {}),
          },
        ]
      : [],
  )
}

const quote = (value: string) => JSON.stringify(value)

export function writeRemotes(siteDir: string, remotes: readonly RemoteEntry[]): void {
  const lines = [
    '# The remotes `crombolo pull` and `push` reach, by name. URLs only: sign-ins',
    '# are kept in your keychain, never here.',
  ]
  for (const remote of remotes) {
    lines.push('', `[remotes.${remote.name}]`, `url = ${quote(remote.url)}`)
    if (remote.environment) lines.push(`environment = ${quote(remote.environment)}`)
  }
  writeFileSync(join(siteDir, REMOTES_FILE), `${lines.join('\n')}\n`)
}

/** Adds or replaces one, refusing a name that would not survive as a TOML key. */
export function addRemote(siteDir: string, remote: RemoteEntry): void {
  if (!NAME.test(remote.name))
    throw new Error(`"${remote.name}" is not a remote name: lower case letters, digits and dashes.`)
  const others = readRemotes(siteDir).filter((r) => r.name !== remote.name)
  writeRemotes(
    siteDir,
    [...others, remote].sort((a, b) => a.name.localeCompare(b.name)),
  )
}

export function removeRemote(siteDir: string, name: string): boolean {
  const remotes = readRemotes(siteDir)
  const kept = remotes.filter((r) => r.name !== name)
  if (kept.length === remotes.length) return false
  writeRemotes(siteDir, kept)
  return true
}

/** The remote a command names, or the only one there is. */
export function pickRemote(siteDir: string, name: string | undefined): RemoteEntry | undefined {
  const remotes = readRemotes(siteDir)
  if (name) return remotes.find((r) => r.name === name)
  return remotes.length === 1 ? remotes[0] : undefined
}
