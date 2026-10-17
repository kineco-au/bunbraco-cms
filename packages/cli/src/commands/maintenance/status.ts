import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import { siteConfig } from '../../support/site.ts'

export default class MaintenanceStatus extends BaseCommand {
  static override summary = 'whether editing is paused, by whom and why'
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    outputFields: [
      {
        name: 'paused',
        type: 'object',
        nullable: true,
        fields: [
          { name: 'at', type: 'string' },
          { name: 'by', type: 'string', nullable: true },
          { name: 'reason', type: 'string', nullable: true },
        ],
      },
    ],
  } as const

  async run() {
    await this.parse(MaintenanceStatus)
    const paused = await ops.editingPaused(await siteConfig())
    this.say(
      paused
        ? `Editing paused since ${paused.at}${paused.by ? ` by ${paused.by}` : ''}${paused.reason ? `: ${paused.reason}` : ''}.`
        : 'Editing is not paused.',
    )
    return { paused: paused ?? null }
  }
}
