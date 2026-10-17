/** What the remote commands share: the remote a command names, and the browser it opens. */
import { osKeychain } from '@crombolo/server'
import { CliError } from '../errors.ts'
import { discover, RemoteClient } from '../remote/client.ts'
import { pickRemote, readRemotes } from '../remote/remotes-file.ts'
import { cwd } from './site.ts'

export const keychain = () => osKeychain()

export function openInBrowser(url: string, disabled: boolean): void {
  if (disabled) return
  const opener =
    process.platform === 'darwin'
      ? ['open']
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '']
        : ['xdg-open']
  try {
    Bun.spawn([...opener, url], { stdout: 'ignore', stderr: 'ignore' })
  } catch {
    // Printed already; opening it is a convenience.
  }
}

/** The remote a command names, signed in or not, with the environment it goes to. */
export async function connectRemote(name: string | undefined, env: string | undefined) {
  const entry = pickRemote(cwd(), name)
  if (!entry) {
    const known = readRemotes(cwd())
    if (known.length === 0)
      throw new CliError('not_found', 'No remotes yet.', {
        hint: '`crombolo remote add <name> <url>` adds one.',
      })
    throw new CliError(
      name ? 'not_found' : 'usage',
      name ? `There is no remote "${name}".` : 'Which remote?',
      { hint: `Name one of: ${known.map((r) => r.name).join(', ')}.` },
    )
  }
  const discovery = await discover(entry.url)
  const client = new RemoteClient(discovery, keychain())
  const environment =
    env ??
    entry.environment ??
    (discovery.environments.length === 1 ? discovery.environments[0]?.id : undefined)
  return { entry, discovery, client, environment }
}

/** The environment, or a usage error naming the ones there are. */
export function needEnvironment(
  environment: string | undefined,
  discovery: { environments: { id: string }[] },
): string {
  if (environment) return environment
  throw new CliError('usage', 'Which environment?', {
    hint: `Pass --env with one of: ${discovery.environments.map((e) => e.id).join(', ')}.`,
  })
}
