import { BaseCommand } from '../../base.ts'
import { appliedFields, applyDomains } from '../../support/domains.ts'
import { siteConfig } from '../../support/site.ts'

export default class DomainsApply extends BaseCommand {
  static override summary = 'apply domains.toml here, as a boot does'
  static override audit = {
    category: 'settings',
    action: 'ApplyDomains',
    entityType: 'Domain',
  } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    outputFields: appliedFields,
    errors: ['refused'],
  } as const

  async run() {
    await this.parse(DomainsApply)
    return applyDomains(this, await siteConfig())
  }
}
