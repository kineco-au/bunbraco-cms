import { recordInLedger } from '@crombolo/data'
import { backupBefore, bootstrapDatabase } from '@crombolo/server'
import {
  isRevertResolution,
  REVERT_RESOLUTIONS,
  type RevertResolution,
  revertResolutionsFor,
  revertRun,
} from '@crombolo/transfer'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import { here } from '../../support/describe.ts'
import { backupTaken, many } from '../../support/flags.ts'
import { siteConfig } from '../../support/site.ts'

export default class ContentRevert extends BaseCommand {
  static override summary = 'put an import back, restoring what the site served'
  static override description = [
    'Values and published state are restored; nodes the run created are unpublished and recycled.',
    'A revert is itself a run, so it can be reverted in turn.',
  ].join('\n\n')
  static override args = {
    run: Args.string({
      required: true,
      description: 'the run id: `crombolo content runs` lists them',
    }),
  }
  static override flags = {
    resolve: many(`answer a finding: <key>=${REVERT_RESOLUTIONS.join('|')}`, '<answer>'),
    'resolve-all': Flags.string({
      summary: 'answer every finding the same way',
      options: [...REVERT_RESOLUTIONS],
    }),
    force: Flags.boolean({ summary: 'revert over changes made since the run' }),
    'backup-taken': backupTaken,
  }
  static override audit = { category: 'content', action: 'Revert', entityType: 'Document' } as const
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'runId', type: 'string' },
      { name: 'reverted', type: 'string' },
      { name: 'restored', type: 'array', items: { type: 'string' } },
      { name: 'recycled', type: 'array', items: { type: 'string' } },
      { name: 'files', type: 'object' },
      { name: 'backup', type: 'string', nullable: true },
    ],
    errors: ['usage', 'refused', 'not_found'],
  } as const

  async run() {
    const { args, flags } = await this.parse(ContentRevert)
    const runId = args.run
    this.auditKey = runId
    const resolutions: Record<string, RevertResolution> = {}
    for (const pair of flags.resolve) {
      const eq = pair.indexOf('=')
      const choice = eq >= 0 ? pair.slice(eq + 1) : ''
      if (eq < 0 || !isRevertResolution(choice))
        this.fail('usage', `--resolve wants <key>=${REVERT_RESOLUTIONS.join('|')}, not "${pair}".`)
      resolutions[pair.slice(0, eq)] = choice
    }
    const config = await siteConfig()
    const backup = await backupBefore(config, {
      reason: 'content-revert',
      backupTaken: flags['backup-taken'],
    })
    if (backup.path) this.progress(`  backup   ${backup.path}`)

    const { db } = await bootstrapDatabase(config)
    try {
      const started = performance.now()
      const result = await revertRun(db, runId, {
        resolutions,
        resolveAll: flags['resolve-all'] as RevertResolution | undefined,
        force: flags.force,
        nodeId: config.nodeId,
        backOfficePath: config.backOfficePath,
      })

      if (!result.runId)
        this.fail(
          'refused',
          'revert refused. Nothing was changed.',
          'Answer the findings with --resolve, or pass --force.',
          result.check.findings.map((f) => ({
            kind: f.kind,
            code: f.code,
            message: f.message,
            answers: revertResolutionsFor(f.code),
          })),
        )

      // The files an install replaced come back from the run's own copies, not
      // from git: these files are editable in the backoffice, so a site need not
      // be a checkout at all.
      const files = await ops.revertSections(db, config, runId)
      for (const file of files.restored) this.say(`  restored ${here(file)}`)
      for (const file of files.removed) this.say(`  removed  ${here(file)}  (created by that run)`)
      if (files.schema) this.say(`  schema   ${files.schema}`)
      if (files.dictionary) this.say('  restored the dictionary')

      for (const key of result.restored) this.say(`  restored ${key}`)
      for (const key of result.recycled) this.say(`  recycled ${key}  (created by that run)`)
      for (const entry of result.check.plan.filter((p) => p.action === 'skip'))
        this.say(`  left     ${entry.name}`)
      await recordInLedger(db, {
        name: `content revert ${runId}`,
        kind: 'revert',
        durationMs: Math.round(performance.now() - started),
        appliedBy: config.nodeId,
        note: `run ${result.runId}`,
      })
      this.say(
        `\nReverted ${runId} as run ${result.runId}. ` +
          `\`crombolo content revert ${result.runId}\` would put it back again.`,
      )
      return {
        runId: result.runId,
        reverted: runId,
        restored: result.restored,
        recycled: result.recycled,
        files: {
          restored: files.restored.map(here),
          removed: files.removed.map(here),
          schema: files.schema ?? null,
          dictionary: Boolean(files.dictionary),
        },
        backup: backup.path ?? null,
      }
    } finally {
      await db.close()
    }
  }
}
