import { Args } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { appliedFields, rewriteDomains } from '../../support/domains.ts'
import { siteConfig } from '../../support/site.ts'

export default class DomainsClear extends BaseCommand {
  static override summary = 'unbind a page, in the file and in the database'
  static override args = {
    page: Args.string({ required: true, description: 'a path, a uuid, or / for the root page' }),
  }
  static override audit = {
    category: 'settings',
    action: 'ClearDomains',
    entityType: 'Domain',
  } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    outputFields: [{ name: 'wrote', type: 'string' }, ...appliedFields],
    errors: ['not_found', 'refused'],
  } as const

  async run() {
    const { args } = await this.parse(DomainsClear)
    return rewriteDomains(this, await siteConfig(), args.page, [])
  }
}
