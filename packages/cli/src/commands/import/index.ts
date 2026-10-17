import { basename } from 'node:path'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import {
  counted,
  describeBundle,
  describePlaced,
  findingsOf,
  here,
  printTransferFindings,
} from '../../support/describe.ts'
import { backupTaken } from '../../support/flags.ts'
import { confirm, passphraseForPeople, passphraseToOpen } from '../../support/prompt.ts'
import { siteConfig } from '../../support/site.ts'

/**
 * Replace this site with a whole-site file (story 105). It always says first
 * what would be replaced, and changes nothing without `--replace` or
 * `--replace-all`.
 */
export default class Import extends BaseCommand {
  static override summary = 'replace this site with a whole-site file; says what first'
  static override description = [
    "Changes nothing without a mode. --replace recycles content and media the file lacks and keeps this site's people; --replace-all deletes them, and people the file lacks (typed confirmation, or --yes).",
    'Domains, the secret key and settings always stay. Undone with `content revert <run>`.',
  ].join('\n\n')
  static override examples = [
    '<%= config.bin %> import site.tgz',
    '<%= config.bin %> import site.tgz --replace',
  ]
  static override args = {
    file: Args.string({
      required: true,
      description: 'a whole-site file (crombolo export --site)',
    }),
  }
  static override flags = {
    replace: Flags.boolean({
      summary: 'replace this site: what it loses is recycled, people kept',
    }),
    'replace-all': Flags.boolean({
      summary: 'make it exactly the file: what it loses is deleted, people too',
    }),
    yes: Flags.boolean({ summary: "with --replace-all: don't ask" }),
    'allow-missing-media': Flags.boolean({
      summary: 'import media items whose files the file does not carry',
    }),
    'backup-taken': backupTaken,
  }
  static override audit = { category: 'content', action: 'Import', entityType: 'Bundle' } as const
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    confirmationBypassArg: '--yes',
    outputFields: [
      { name: 'bundle', type: 'object' },
      { name: 'brings', type: 'object' },
      { name: 'leaving', type: 'object' },
      { name: 'filesRemoved', type: 'array', items: { type: 'string' } },
      { name: 'runId', type: 'string', nullable: true },
      { name: 'backup', type: 'string', nullable: true },
    ],
    errors: ['usage', 'confirmation_required', 'refused', 'auth', 'not_found'],
  } as const

  async run() {
    const { args, flags } = await this.parse(Import)
    if (args.file === 'umbraco')
      this.fail(
        'usage',
        'import umbraco needs report or apply.',
        '`crombolo import umbraco --help` says more.',
      )
    const config = await siteConfig()
    const replace: ops.ReplaceMode | undefined = flags['replace-all']
      ? 'replace-all'
      : flags.replace
        ? 'replace'
        : undefined
    const dir = await ops.unpackBundle(args.file, config.siteDir)
    const carriesPeople = ops.readBundle(dir, config.siteDir).set.manifest.people !== undefined
    const passphrase = carriesPeople
      ? await passphraseForPeople()
      : await passphraseToOpen(dir, config)
    const allowMissingBlobs = flags['allow-missing-media']

    const { check, summary } = await ops.siteReplaceCheck(config, {
      bundle: dir,
      passphrase,
      replace: replace ?? 'replace',
      allowMissingBlobs,
    })
    describeBundle(this, check.bundle)
    const c = check.check.counts
    this.say(`  brings   ${c.create} new, ${c.update} changed, ${c.unchanged} unchanged`)
    const fate = replace === 'replace-all' ? 'deleted' : 'recycled'
    if (Object.keys(summary.leaving).length > 0)
      this.say(`  ${fate.padEnd(8)} ${counted(summary.leaving)} not in the file`)
    if (summary.filesRemoved.length > 0) {
      this.say(
        `  removes  ${summary.filesRemoved.length} file(s) not in the file, kept for a revert:`,
      )
      for (const path of summary.filesRemoved.slice(0, 20)) this.say(`    ${here(path)}`)
      if (summary.filesRemoved.length > 20)
        this.say(`    … and ${summary.filesRemoved.length - 20} more`)
    }
    if (replace === 'replace-all' && summary.people.members + summary.people.users > 0)
      this.say(
        `  deletes  ${summary.people.members} member(s) and ${summary.people.users} user(s) not in the file`,
      )
    this.say("  keeps    domains, the secret key and this environment's settings")
    for (const problem of check.problems) this.warning(`  ${problem}`)
    const result = {
      bundle: check.bundle,
      brings: c,
      leaving: summary.leaving,
      filesRemoved: summary.filesRemoved.map(here),
      runId: null as string | null,
      backup: null as string | null,
    }

    if (!replace)
      this.fail(
        'usage',
        'Nothing was changed: a mode says how to replace this site.',
        'Pass --replace (what it loses is recycled, people kept), or --replace-all to make it exactly the file (deleted, people too).',
      )
    if (replace === 'replace-all' && !flags.yes)
      await confirm(
        `  This deletes for good. Type the site's name (${config.siteName}) to go on:`,
        {
          bypass: '--yes',
          answer: config.siteName,
        },
      )

    const imported = await ops.contentImport(config, {
      bundle: dir,
      passphrase,
      replace,
      allowMissingBlobs,
      label: `${replace} from ${basename(args.file)}`,
      backupTaken: flags['backup-taken'],
    })
    for (const problem of imported.problems) this.warning(`  ${problem}`)
    if (imported.backup.path) this.progress(`  backup   ${imported.backup.path}`)
    if (!imported.runId) {
      printTransferFindings(this, imported.check)
      this.fail(
        'refused',
        'replace refused. Nothing was changed.',
        undefined,
        findingsOf(imported.check.outstanding),
      )
    }
    const counts = imported.check.counts
    this.say(`  run      ${imported.runId}`)
    this.say(
      `  applied  ${counts.create} created, ${counts.update} updated, ${counts.unchanged} unchanged`,
    )
    const placed = describePlaced(imported.blobs)
    if (placed) this.say(`  media    ${placed}`)
    if (imported.sections?.schema) this.say(`  schema   ${imported.sections.schema.action}`)
    if (imported.published > 0) this.say(`  published ${imported.published} page(s)`)
    for (const failure of imported.publishFailures)
      this.warning(`  not published  ${failure.key}: ${failure.reason}`)
    this.say(
      replace === 'replace-all'
        ? `\nDone. \`crombolo content revert ${imported.runId}\` puts the files and the pages it changed back; what was deleted is in the backup.`
        : `\nDone. \`crombolo content revert ${imported.runId}\` puts it back.`,
    )
    return { ...result, runId: imported.runId, backup: imported.backup.path ?? null }
  }
}
