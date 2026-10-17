import { readSignIn } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { readRemotes } from '../../remote/remotes-file.ts'
import { keychain } from '../../support/remote.ts'
import { cwd } from '../../support/site.ts'

export default class RemoteList extends BaseCommand {
  static override summary = 'the remotes in remotes.toml, and whether you are signed in to each'
  static override spec = {
    effects: 'read_only',
    cardinality: 'bounded',
    // One item of `items`, as clispec reads a collection.
    outputFields: [
      { name: 'name', type: 'string' },
      { name: 'url', type: 'string' },
      { name: 'environment', type: 'string', nullable: true },
      { name: 'signedIn', type: 'boolean' },
    ],
  } as const

  async run() {
    await this.parse(RemoteList)
    const remotes = readRemotes(cwd())
    if (remotes.length === 0) this.say('  No remotes yet: `crombolo remote add <name> <url>`.')
    const items = []
    for (const remote of remotes) {
      const signedIn =
        (await readSignIn(keychain(), remote.url).catch(() => undefined)) !== undefined
      this.say(
        `  ${remote.name.padEnd(12)} ${remote.url}${remote.environment ? `  env ${remote.environment}` : ''}${signedIn ? '' : '  (not signed in)'}`,
      )
      items.push({
        name: remote.name,
        url: remote.url,
        environment: remote.environment ?? null,
        signedIn,
      })
    }
    return { items }
  }
}
