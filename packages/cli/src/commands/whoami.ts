import { Args } from '@oclif/core'
import { BaseCommand } from '../base.ts'
import { problemOf } from '../remote/client.ts'
import { connectRemote } from '../support/remote.ts'

export default class Whoami extends BaseCommand {
  static override summary = 'who you are signed in as at a remote, and what you may do there'
  static override args = {
    remote: Args.string({ description: 'the remote; the only one, when there is one' }),
  }
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    outputFields: [
      { name: 'name', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'remote', type: 'string' },
      { name: 'environments', type: 'array', items: { type: 'object' } },
    ],
    errors: ['not_found', 'auth', 'unavailable'],
  } as const

  async run() {
    const { args } = await this.parse(Whoami)
    const { entry, client, discovery } = await connectRemote(args.remote, undefined)
    const response = await client.call(
      `${new URL(discovery.api).origin}/umbraco/management/api/v1/user/current`,
    )
    if (!response.ok) throw await problemOf(response)
    const me = (await response.json()) as { name: string; email: string }
    this.say(`  ${me.name} <${me.email}> on ${entry.name}`)
    const environments = await client.environments()
    for (const env of environments) {
      const may = [env.may.pull && 'pull', env.may.pullFull && 'full pull', env.may.push && 'push']
        .filter(Boolean)
        .join(', ')
      this.say(`  ${env.id.padEnd(12)} ${may || 'nothing'}${env.protected ? '  (protected)' : ''}`)
    }
    return { name: me.name, email: me.email, remote: entry.name, environments }
  }
}
