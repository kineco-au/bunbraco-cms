import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import { siteConfig } from '../../support/site.ts'

/** The cluster-wide pause on editing that a restore or a swap needs: a database flag every node reads. */
export default class MaintenancePause extends BaseCommand {
  static override summary = "refuse every editor's save, on every node, until resumed"
  static override description = 'Readers are unaffected and no node drains.'
  static override flags = {
    reason: Flags.string({ summary: 'what editors are told', helpValue: '<text>' }),
  }
  static override audit = { category: 'system', action: 'PauseEditing' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'paused', type: 'boolean' },
      { name: 'reason', type: 'string', nullable: true },
    ],
  } as const

  async run() {
    const { flags } = await this.parse(MaintenancePause)
    const paused = await ops.pauseEditing(await siteConfig(), { reason: flags.reason })
    this.say(`Editing paused${paused.reason ? `: ${paused.reason}` : ''}.`)
    return { paused: true, reason: paused.reason ?? null }
  }
}
