import { Args } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { removeRemote } from '../../remote/remotes-file.ts'
import { cwd } from '../../support/site.ts'

export default class RemoteRemove extends BaseCommand {
  static override summary = 'forget a remote; removing one that is not there changes nothing'
  static override args = { name: Args.string({ required: true, description: "the remote's name" }) }
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'name', type: 'string' },
      { name: 'changed', type: 'boolean' },
    ],
  } as const

  async run() {
    const { args } = await this.parse(RemoteRemove)
    const changed = removeRemote(cwd(), args.name)
    this.say(
      changed ? `  removed  ${args.name}` : `  There is no remote "${args.name}"; nothing changed.`,
    )
    return { name: args.name, changed }
  }
}
