import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import {
  describeBundle,
  describePlaced,
  findingsOf,
  here,
  printTransferFindings,
} from '../../support/describe.ts'
import { backupTaken, transferFlags, transferInput } from '../../support/flags.ts'
import { passphraseToOpen } from '../../support/prompt.ts'
import { siteConfig } from '../../support/site.ts'

export default class ContentImport extends BaseCommand {
  static override summary = "re-check, back up, then apply a bundle's content"
  static override description = [
    'Documents and elements arrive as drafts, media is live. One transaction, so a failure leaves nothing behind.',
    'A bundle carrying its own schema and views installs into a site that has neither. `content revert <run>` puts it back.',
  ].join('\n\n')
  static override aliases = ['bundle:install']
  static override args = {
    bundle: Args.string({
      required: true,
      description: 'a package directory, or the name of a bundle this site depends on',
    }),
  }
  static override flags = {
    ...transferFlags,
    label: Flags.string({ summary: 'a label for the run', helpValue: '<text>' }),
    'backup-taken': backupTaken,
  }
  static override audit = { category: 'content', action: 'Import', entityType: 'Bundle' } as const
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'runId', type: 'string' },
      { name: 'bundle', type: 'object' },
      { name: 'counts', type: 'object' },
      { name: 'backup', type: 'string', nullable: true },
      { name: 'published', type: 'integer' },
      { name: 'notPublished', type: 'array', items: { type: 'object' } },
    ],
    errors: ['refused', 'auth'],
  } as const

  async run() {
    const { args, flags } = await this.parse(ContentImport)
    const config = await siteConfig()
    const result = await ops.contentImport(config, {
      ...transferInput(args.bundle, flags),
      passphrase: await passphraseToOpen(args.bundle, config),
      publish: flags.publish,
      label: flags.label,
      backupTaken: flags['backup-taken'],
    })
    for (const problem of result.problems) this.warning(`  ${problem}`)
    if (result.backup.path) this.progress(`  backup   ${result.backup.path}`)
    describeBundle(this, result.bundle)

    if (!result.runId) {
      printTransferFindings(this, result.check)
      // Staged, then applied in one transaction: a refusal leaves nothing behind.
      this.fail(
        'refused',
        `import refused: ${result.check.outstanding.length || result.problems.length} finding(s) outstanding. Nothing was written.`,
        'Resolve them, or pass --resolve.',
        findingsOf(result.check.outstanding),
      )
    }

    const c = result.check.counts
    this.say(`  run      ${result.runId}`)
    this.say(
      `  applied  ${c.create} created, ${c.update} updated, ${c.unchanged} unchanged, ${c.skip} skipped`,
    )
    const placed = describePlaced(result.blobs)
    if (placed) this.say(`  blobs    ${placed}`)
    if (result.sections) {
      this.say(
        `  files    ${result.sections.written.length} written` +
          (result.sections.replaced.length > 0
            ? `, ${result.sections.replaced.length} replaced`
            : ''),
      )
      if (result.sections.schema) this.say(`  schema   ${result.sections.schema.action}`)
      if (result.sections.dictionary)
        this.say(`  dict     ${result.sections.dictionary.imported} imported`)
      // Named, because this is what makes reverting the install possible.
      if (result.replacedFilesKept)
        this.say(`  kept     ${here(result.replacedFilesKept)}  (the files it replaced)`)
    }
    if (result.published > 0) this.say(`  published ${result.published} node(s)`)
    for (const failure of result.publishFailures)
      this.warning(`  not published  ${failure.key}: ${failure.reason}`)
    for (const finding of result.check.findings.filter((f) => f.kind === 'auto'))
      this.say(`  [auto    ] ${finding.message}`)
    this.say(`\nDone. \`crombolo content revert ${result.runId}\` puts it back.`)
    return {
      runId: result.runId,
      bundle: result.bundle,
      counts: c,
      backup: result.backup.path ?? null,
      published: result.published,
      notPublished: result.publishFailures,
    }
  }
}
