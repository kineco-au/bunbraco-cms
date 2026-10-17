import type { DomainDeclaration } from '@crombolo/server'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { appliedFields, rewriteDomains } from '../../support/domains.ts'
import { many } from '../../support/flags.ts'
import { siteConfig } from '../../support/site.ts'

export default class DomainsSet extends BaseCommand {
  static override summary = "write a page's hostnames to domains.toml and apply it"
  static override description =
    `The page's hostnames are replaced, so running it twice is running it once. \${VAR} in a host is read from the environment when it is applied.`
  static override examples = [
    '<%= config.bin %> domains set / --host example.com --host fr.example.com=fr-FR',
  ]
  static override args = {
    page: Args.string({ required: true, description: 'a path, a uuid, or / for the root page' }),
  }
  static override flags = {
    host: many('a hostname, with its culture after =; repeatable', '<host>[=<culture>]'),
    'default-culture': Flags.string({ summary: "the page's fallback culture", helpValue: '<iso>' }),
  }
  static override audit = {
    category: 'settings',
    action: 'SetDomains',
    entityType: 'Domain',
  } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    outputFields: [{ name: 'wrote', type: 'string' }, ...appliedFields],
    errors: ['usage', 'not_found', 'refused'],
  } as const

  async run() {
    const { args, flags } = await this.parse(DomainsSet)
    const defaultCulture = flags['default-culture']
    if (flags.host.length === 0 && !defaultCulture)
      this.fail('usage', 'domains set needs --host <host>[=<culture>], or --default-culture <iso>.')
    const add: DomainDeclaration[] = []
    if (flags.host.length === 0 && defaultCulture)
      add.push({ node: args.page, host: '', defaultCulture })
    for (const [index, entry] of flags.host.entries()) {
      const [host = '', culture] = entry.split('=')
      add.push({
        node: args.page,
        host,
        culture,
        // The node's own fallback culture belongs to the node, so it is written
        // once rather than repeated on every hostname.
        defaultCulture: index === 0 ? defaultCulture : undefined,
      })
    }
    return rewriteDomains(this, await siteConfig(), args.page, add)
  }
}
