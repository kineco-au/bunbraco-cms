import { undoDomainsFile } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { here } from '../../support/describe.ts'
import { appliedFields, applyDomains } from '../../support/domains.ts'
import { siteConfig } from '../../support/site.ts'

export default class DomainsUndo extends BaseCommand {
  static override summary = 'put back the file the last write replaced, and apply it'
  static override audit = {
    category: 'settings',
    action: 'UndoDomains',
    entityType: 'Domain',
  } as const
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'bounded',
    outputFields: [{ name: 'restored', type: 'string' }, ...appliedFields],
    errors: ['not_found', 'refused'],
  } as const

  async run() {
    await this.parse(DomainsUndo)
    const config = await siteConfig()
    const undone = await undoDomainsFile(config.siteDir)
    if (!undone.ok) this.fail('not_found', undone.message ?? 'There is nothing to undo.')
    this.say(`  restored ${here(undone.file)}`)
    return { restored: here(undone.file), ...(await applyDomains(this, config)) }
  }
}
