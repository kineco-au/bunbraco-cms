import { BaseCommand, Flags } from '@crombolo/cli/plugin'

/** A plugin command built only from `@crombolo/cli/plugin`, as a real one is. */
export default class CloudHello extends BaseCommand {
  static override summary = 'say hello from the test plugin'
  static override flags = {
    name: Flags.string({ summary: 'who to greet', default: 'world' }),
    fail: Flags.boolean({ summary: 'fail as a plugin command would' }),
  }
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    outputFields: [{ name: 'greeting', type: 'string' }],
    errors: ['not_found'],
  } as const

  async run() {
    const { flags } = await this.parse(CloudHello)
    if (flags.fail)
      this.fail('not_found', 'There is nobody here by that name.', 'Try another --name.')
    const greeting = `Hello, ${flags.name}`
    this.say(greeting)
    return { greeting }
  }
}
