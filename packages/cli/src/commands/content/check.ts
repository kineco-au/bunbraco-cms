import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RESOLUTIONS_FILE, writeResolutions } from '@crombolo/transfer'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import {
  describeBundle,
  findingsOf,
  here,
  printSections,
  printTransferFindings,
} from '../../support/describe.ts'
import { transferFlags, transferInput } from '../../support/flags.ts'
import { passphraseToOpen } from '../../support/prompt.ts'
import { siteConfig } from '../../support/site.ts'

export default class ContentCheck extends BaseCommand {
  static override summary = "read-only: what installing a bundle's content here would do"
  static override description = [
    'Says what it needs from a person first, and writes it to the Changes dashboard. --save writes the answers given into the bundle.',
    'An encrypted bundle asks for its passphrase, or reads CROMBOLO_BUNDLE_PASSPHRASE. Exits 21 when a finding would stop an import.',
  ].join('\n\n')
  static override aliases = ['bundle:check']
  static override args = {
    bundle: Args.string({
      required: true,
      description: 'a package directory, or the name of a bundle this site depends on',
    }),
  }
  static override flags = {
    ...transferFlags,
    save: Flags.boolean({ summary: 'write the answers into the bundle' }),
  }
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    outputFields: [
      { name: 'bundle', type: 'object' },
      { name: 'under', type: 'string', nullable: true },
      { name: 'counts', type: 'object' },
      { name: 'findings', type: 'array', items: { type: 'object' } },
      { name: 'outstanding', type: 'integer' },
      { name: 'clean', type: 'boolean' },
      { name: 'wouldNotPublish', type: 'array', items: { type: 'object' } },
      { name: 'saved', type: 'string', nullable: true },
    ],
    errors: ['refused', 'auth'],
    outcomes: ['blocked'],
  } as const

  async run() {
    const { args, flags } = await this.parse(ContentCheck)
    const config = await siteConfig()
    const result = await ops.contentCheck(config, {
      ...transferInput(args.bundle, flags),
      passphrase: await passphraseToOpen(args.bundle, config),
    })
    for (const problem of result.problems) this.warning(`  ${problem}`)
    describeBundle(this, result.bundle)
    if (result.under) this.say(`  under    ${result.under}`)
    printSections(this, result.sections)
    printTransferFindings(this, result.check)
    // The reasons are publish's own: the check rehearsed the import to find them.
    for (const refusal of result.publishRefusals)
      this.say(`  would not publish  ${refusal.key}: ${refusal.reason}`)

    let saved: string | null = null
    if (flags.save) {
      const target = join(result.payloadDir, RESOLUTIONS_FILE)
      await writeFile(
        target,
        writeResolutions({
          bundleId: result.bundle.id,
          under: flags.under ?? null,
          all: result.decisions.all,
          byNode: result.decisions.byNode,
        }),
      )
      saved = here(target)
      this.say(`  wrote    ${saved}`)
    }

    if (result.clean) this.say('\nNothing outstanding: this bundle would import cleanly.')
    else {
      this.say(
        `\n${result.check.outstanding.length} finding(s) would stop an import. Resolve them, or pass --resolve.`,
      )
      this.outcome = 'blocked'
    }
    return {
      bundle: result.bundle,
      under: result.under ?? null,
      counts: result.check.counts,
      findings: findingsOf(result.check.findings),
      outstanding: result.check.outstanding.length,
      clean: result.clean,
      wouldNotPublish: result.publishRefusals,
      saved,
    }
  }
}
