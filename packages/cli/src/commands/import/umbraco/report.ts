import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../../base.ts'
import { here } from '../../../support/describe.ts'
import {
  deprecated,
  loadImporter,
  planUmbraco,
  umbracoArgs,
  umbracoFlags,
} from '../../../support/umbraco.ts'

export default class ImportUmbracoReport extends BaseCommand {
  static override summary =
    'read-only: what importing an Umbraco backup would bring, and what it would not'
  static override description =
    'Packages, Razor and custom code are reported, not brought. Exits 21 when something blocks the import. Deprecated: story 074 replaces it.'
  static override args = umbracoArgs
  static override flags = {
    ...umbracoFlags,
    out: Flags.string({ summary: 'also write report.md and report.json here', helpValue: '<dir>' }),
  }
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    stdoutSchema: { type: 'object', description: "the importer's report" },
    errors: ['not_found', 'refused'],
    outcomes: ['blocked'],
    stability: 'deprecated',
  } as const

  async run() {
    const { args, flags } = await this.parse(ImportUmbracoReport)
    deprecated(this, this.jsonEnabled())
    const importer = await loadImporter()
    // A report writes no bundle, so what it would seal with is never kept.
    const sealing = flags['with-members'] || flags['with-users']
    const { report } = await planUmbraco(
      importer,
      args.backup,
      flags,
      flags['include-content'] ? 'open' : 'omitted',
      sealing ? crypto.randomUUID() : undefined,
    )
    for (const line of importer.reportSummary(report)) this.say(`  ${line}`)
    if (flags.out) {
      await mkdir(flags.out, { recursive: true })
      await writeFile(join(flags.out, 'report.md'), importer.reportMarkdown(report))
      await writeFile(join(flags.out, 'report.json'), importer.reportJson(report))
      this.say(`\n  wrote    ${here(join(flags.out, 'report.md'))}`)
    }
    if (!report.ready) this.outcome = 'blocked'
    return JSON.parse(importer.reportJson(report)) as Record<string, unknown>
  }
}
