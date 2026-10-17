import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import { backupTaken, dryRun } from '../../support/flags.ts'
import { confirm } from '../../support/prompt.ts'
import { siteConfig } from '../../support/site.ts'

/**
 * Drops a bundle's tables and forgets its state. Taking a bundle out of
 * `bundles` leaves them in place, so re-adding it resumes; this is the
 * deliberate act that does not.
 */
export default class BundlePurge extends BaseCommand {
  static override summary = "back up, then drop a bundle's tables and clear its state"
  static override description =
    'Refused while crombolo.config.ts still wires the bundle. Asks for the id to be typed back, unless --yes.'
  static override args = { id: Args.string({ required: true, description: "the bundle's id" }) }
  static override flags = {
    yes: Flags.boolean({ summary: "don't ask: drop them" }),
    'dry-run': dryRun,
    'backup-taken': backupTaken,
  }
  static override audit = { category: 'system', action: 'Purge', entityType: 'Bundle' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    confirmationBypassArg: '--yes',
    outputFields: [
      { name: 'id', type: 'string' },
      { name: 'tables', type: 'array', items: { type: 'string' } },
      { name: 'dropped', type: 'array', items: { type: 'string' } },
      { name: 'backup', type: 'string', nullable: true },
      { name: 'changed', type: 'boolean' },
    ],
    errors: ['confirmation_required', 'refused'],
  } as const

  async run() {
    const { args, flags } = await this.parse(BundlePurge)
    const id = args.id
    this.auditKey = id
    const config = await siteConfig()
    const plan = await ops.bundlePurgePlan(config, id)
    if (plan.tables.length === 0) this.say(`  The bundle "${id}" has no tables in this database.`)
    else {
      this.say(`  This drops ${plan.tables.length} table(s), and every row in them:`)
      for (const table of plan.tables) this.say(`    ${table}`)
    }
    if (flags['dry-run']) {
      this.changedNothing = true
      return { id, tables: plan.tables, dropped: [], backup: null, changed: false }
    }
    if (!flags.yes)
      await confirm(`  Purge the bundle "${id}"? Type its id to confirm:`, {
        bypass: '--yes',
        answer: id,
        declined: 'Nothing was dropped.',
      })
    const result = await ops.bundlePurge(config, id, { backupTaken: flags['backup-taken'] })
    if (result.backup.path) this.progress(`  backup   ${result.backup.path}`)
    for (const table of result.dropped) this.say(`  dropped  ${table}`)
    this.say(`  The bundle "${id}"'s state is cleared; adding it again starts its tables afresh.`)
    return {
      id,
      tables: plan.tables,
      dropped: result.dropped,
      backup: result.backup.path ?? null,
      changed: result.dropped.length > 0,
    }
  }
}
