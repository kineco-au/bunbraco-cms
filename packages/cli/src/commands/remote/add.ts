import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { discover } from '../../remote/client.ts'
import { addRemote, readRemotes } from '../../remote/remotes-file.ts'
import { cwd } from '../../support/site.ts'

export default class RemoteAdd extends BaseCommand {
  static override summary = 'a remote this site pulls from and pushes to, kept in remotes.toml'
  static override description =
    'URLs only: sign-ins are kept in your keychain. Adding the same remote again changes nothing; a different URL for a name already taken needs --force.'
  static override examples = [
    '<%= config.bin %> remote add production https://example.com --env production',
  ]
  static override args = {
    name: Args.string({
      required: true,
      description: 'a name for it: lower case letters, digits and dashes',
    }),
    url: Args.string({ required: true, description: "the site's URL" }),
  }
  static override flags = {
    env: Flags.string({ summary: 'the environment it goes to by default', helpValue: '<id>' }),
    force: Flags.boolean({ summary: 'replace a remote of the same name' }),
  }
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'name', type: 'string' },
      { name: 'url', type: 'string' },
      { name: 'site', type: 'string' },
      { name: 'changed', type: 'boolean' },
      {
        name: 'environments',
        type: 'array',
        items: {
          type: 'object',
          fields: [
            { name: 'id', type: 'string' },
            { name: 'protected', type: 'boolean' },
          ],
        },
      },
    ],
    errors: ['usage', 'conflict', 'unavailable', 'not_found'],
  } as const

  async run() {
    const { args, flags } = await this.parse(RemoteAdd)
    const origin = new URL(args.url).origin
    const entry = { name: args.name, url: origin, environment: flags.env }
    const existing = readRemotes(cwd()).find((remote) => remote.name === args.name)
    const same = existing?.url === origin && existing.environment === flags.env
    if (existing && !same && !flags.force)
      this.fail(
        'conflict',
        `There is already a remote "${args.name}": ${existing.url}${existing.environment ? ` (env ${existing.environment})` : ''}.`,
        'Pass --force to replace it, or choose another name.',
      )
    const discovery = await discover(args.url)
    if (!same) {
      try {
        addRemote(cwd(), entry)
      } catch (error) {
        this.fail('usage', error instanceof Error ? error.message : String(error))
      }
    }
    this.say(`  ${same ? 'exists ' : 'added  '}  ${args.name}  ${discovery.name} (${origin})`)
    const environments = discovery.environments.map((env) => ({
      id: env.id,
      protected: env.protected === true,
    }))
    for (const env of environments)
      this.say(`  env      ${env.id}${env.protected ? '  protected' : ''}`)
    this.say(`\n\`crombolo login ${args.name}\` signs in.`)
    return { name: args.name, url: origin, site: discovery.name, changed: !same, environments }
  }
}
