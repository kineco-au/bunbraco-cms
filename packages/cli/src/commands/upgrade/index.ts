import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import { findingsOf } from '../../support/describe.ts'
import { backupTaken, many } from '../../support/flags.ts'
import { siteConfig } from '../../support/site.ts'
import { parseSet } from '../../support/types.ts'

export default class Upgrade extends BaseCommand {
  static override summary = 'back up, apply pending framework migrations, cut over, and record them'
  static override description = [
    'Re-checks first, and refuses while a finding is outstanding; `upgrade check --fix` resolves what it can early.',
    '--plan prints the DDL each pending migration would run, and changes nothing.',
  ].join('\n\n')
  static override flags = {
    plan: Flags.boolean({
      summary: 'print the DDL pending framework migrations would run, and stop',
    }),
    force: Flags.string({
      summary: 'go on over outstanding findings, saying why',
      helpValue: '<reason>',
    }),
    set: many('a value for a new mandatory property: <type>.<property>=<value>', '<t.p=v>'),
    'backup-taken': backupTaken,
  }
  static override audit = { category: 'system', action: 'Upgrade' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'action', type: 'string' },
      { name: 'changed', type: 'boolean' },
      { name: 'backup', type: 'string', nullable: true },
      { name: 'frameworkApplied', type: 'array', items: { type: 'string' } },
      { name: 'bundlesApplied', type: 'array', items: { type: 'object' } },
      { name: 'schema', type: 'object', nullable: true },
      { name: 'plan', type: 'object', nullable: true },
    ],
    errors: ['refused'],
  } as const

  async run() {
    const { flags } = await this.parse(Upgrade)
    const config = await siteConfig()
    if (flags.plan) {
      this.changedNothing = true
      const plan = await ops.upgradePlan(config)
      if (plan.steps.length === 0) this.say('No framework migration is pending.')
      const printStep = (step: ops.PlannedStepResult, indent = '') => {
        this.say(
          `\n${indent}== ${step.name} (${step.kind}${step.release ? `, release ${step.release}` : ''})`,
        )
        if (step.unplannable) this.say(`${indent}  unplannable: ${step.unplannable}`)
        for (const sql of step.statements) this.say(`${indent}  ${sql};`)
      }
      for (const step of plan.steps) printStep(step)
      // After core's, in the order `bundles` lists them, because that is the order they run.
      for (const bundle of plan.bundles) {
        this.say(
          `\nbundle ${bundle.id} (${bundle.name}): ${bundle.steps.length === 0 ? 'nothing pending' : `${bundle.steps.length} step(s)`}`,
        )
        for (const step of bundle.steps) printStep(step, '  ')
      }
      this.say(
        plan.site.checked
          ? `\nsite schema: ${plan.site.action} (${plan.site.classification})`
          : '\nsite schema: checked once the framework migrations have run',
      )
      return {
        action: 'plan',
        changed: false,
        backup: null,
        frameworkApplied: [],
        bundlesApplied: [],
        schema: null,
        plan,
      }
    }
    const result = await ops.upgradeRun(config, {
      force: flags.force,
      set: parseSet(flags.set),
      backupTaken: flags['backup-taken'],
    })
    if (result.backup.path) this.progress(`  backup   ${result.backup.path}`)
    if (result.action === 'refused')
      this.fail(
        'refused',
        `upgrade refused: ${result.reasons.length} outstanding finding(s).`,
        'Run `crombolo upgrade check --fix`, resolve what needs a person, and try again.',
        findingsOf(result.reasons),
      )
    if (result.action === 'nothing') {
      this.say('Nothing to upgrade: the database is at this version.')
      return {
        action: result.action,
        changed: false,
        backup: result.backup.path ?? null,
        frameworkApplied: [],
        bundlesApplied: [],
        schema: null,
        plan: null,
      }
    }
    for (const name of result.frameworkApplied) this.say(`  applied  ${name}`)
    for (const bundle of result.bundlesApplied)
      for (const name of bundle.applied) this.say(`  applied  [${bundle.id}] ${name}`)
    this.say(
      `  schema   ${result.schema?.action} ${result.schema?.version ?? ''}+${result.schema?.revision ?? ''}`,
    )
    return {
      action: result.action,
      changed: true,
      backup: result.backup.path ?? null,
      frameworkApplied: result.frameworkApplied,
      bundlesApplied: result.bundlesApplied,
      schema: result.schema ?? null,
      plan: null,
    }
  }
}
