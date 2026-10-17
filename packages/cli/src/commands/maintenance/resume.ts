import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import { siteConfig } from '../../support/site.ts'

export default class MaintenanceResume extends BaseCommand {
  static override summary = 'let editors save again'
  static override audit = { category: 'system', action: 'ResumeEditing' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [{ name: 'paused', type: 'boolean' }],
  } as const

  async run() {
    await this.parse(MaintenanceResume)
    await ops.resumeEditing(await siteConfig())
    this.say('Editing resumed.')
    return { paused: false }
  }
}
