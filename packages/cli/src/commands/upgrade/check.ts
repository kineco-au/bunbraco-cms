import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import { findingsOf, printFindings } from '../../support/describe.ts'
import { backupTaken, many } from '../../support/flags.ts'
import { siteConfig } from '../../support/site.ts'
import { parseSet, upgradeCheck } from '../../support/types.ts'

export default class UpgradeCheck extends BaseCommand {
  static override summary = "what the deployed schema/ would do to this database's data"
  static override description = [
    'Exits 21 when a finding needs a person first.',
    '--fix backs up, then applies the additive part and every conversion early, so the cut-over is short.',
  ].join('\n\n')
  static override flags = {
    fix: Flags.boolean({
      summary: 'back up, then apply the additive part and every conversion early',
    }),
    set: many('a value for a new mandatory property: <type>.<property>=<value>', '<t.p=v>'),
    'backup-taken': backupTaken,
  }
  static override audit = { category: 'system', action: 'UpgradeFix' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'classification', type: 'string' },
      { name: 'findings', type: 'array', items: { type: 'object' } },
      { name: 'blocking', type: 'boolean' },
      { name: 'applied', type: 'array', items: { type: 'string' } },
      { name: 'backup', type: 'string', nullable: true },
    ],
    outcomes: ['blocked'],
  } as const

  async run() {
    const { flags } = await this.parse(UpgradeCheck)
    const config = await siteConfig()
    const set = parseSet(flags.set)
    if (!flags.fix) {
      this.changedNothing = true
      const report = await upgradeCheck(this, config, set)
      if (report.blocking) this.outcome = 'blocked'
      return {
        classification: report.classification,
        findings: findingsOf(report.findings),
        blocking: report.blocking,
        applied: [],
        backup: null,
      }
    }
    const fix = await ops.upgradeFix(config, { set, backupTaken: flags['backup-taken'] })
    if (fix.backup.path) this.progress(`  backup   ${fix.backup.path}`)
    this.say(
      `  sync     ${fix.sync.action}${fix.sync.deferred.length > 0 ? ` (deferred to the cut-over: ${fix.sync.deferred.join(', ')})` : ''}`,
    )
    for (const name of fix.applied) this.say(`  applied  ${name}`)
    if (fix.skipped > 0)
      this.say(`  skipped  ${fix.skipped} value(s) a converter refused; see the findings`)
    printFindings(this, fix)
    return {
      classification: fix.classification,
      findings: findingsOf(fix.findings),
      blocking: fix.findings.some((f) => f.kind === 'blocking'),
      applied: fix.applied,
      backup: fix.backup.path ?? null,
    }
  }
}
