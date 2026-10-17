import { loadValueMigrations, validateSchemaSet } from '@crombolo/schema'
import { componentAliasesIn, formTypesFor } from '@crombolo/server'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { describeProblem, findingsOf } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'
import { loadTypes, needSchemaDir, staticProblems, upgradeCheck } from '../../support/types.ts'

export default class TypesCheck extends BaseCommand {
  static override summary = 'validate schema/ and report what a sync would do to this database'
  static override description =
    '--static checks the files alone, with no database: the check for a pull request. Exits 20 when it finds problems, 21 when a finding needs a person.'
  static override aliases = ['schema:check']
  static override deprecateAliases = true
  static override flags = {
    static: Flags.boolean({ summary: 'validate the files only, no database' }),
  }
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    outputFields: [
      { name: 'version', type: 'string' },
      {
        name: 'counts',
        type: 'object',
        fields: [
          { name: 'contentTypes', type: 'integer' },
          { name: 'mediaTypes', type: 'integer' },
          { name: 'dataTypes', type: 'integer' },
          { name: 'languages', type: 'integer' },
        ],
      },
      { name: 'problems', type: 'array', items: { type: 'string' } },
      { name: 'classification', type: 'string', nullable: true },
      { name: 'findings', type: 'array', items: { type: 'object' } },
    ],
    errors: ['not_found'],
    outcomes: ['problems_found', 'blocked'],
  } as const

  async run() {
    const { flags } = await this.parse(TypesCheck)
    const config = await siteConfig()
    needSchemaDir(config)
    const loaded = loadTypes(config)
    const counts = {
      contentTypes: loaded.set.contentTypes.length,
      mediaTypes: (loaded.set.mediaTypes ?? []).length,
      dataTypes: loaded.set.dataTypes.length,
      languages: loaded.set.languages.length,
    }
    const result = {
      version: loaded.set.version,
      counts,
      problems: [] as string[],
      classification: null as string | null,
      findings: [] as ReturnType<typeof findingsOf>,
    }
    result.problems = [
      ...loaded.problems,
      ...validateSchemaSet(loaded.set, {
        componentAliases: componentAliasesIn(config.componentsDir),
        types: formTypesFor(config),
      }),
    ].map(describeProblem)
    if (result.problems.length > 0) {
      this.say(`${result.problems.length} problem(s):`)
      for (const problem of result.problems) this.say(`  ${problem}`)
      this.outcome = 'problems_found'
      return result
    }
    this.say(
      `schema ${loaded.set.version}: ${counts.contentTypes} content type(s), ${counts.mediaTypes} media type(s), ${counts.dataTypes} data type(s), ${counts.languages} language(s) — valid`,
    )
    if (flags.static) {
      result.problems = staticProblems(loaded, await loadValueMigrations(config.schemaDir))
      for (const issue of result.problems) this.say(`  ${issue}`)
      if (result.problems.length > 0) this.outcome = 'problems_found'
      return result
    }
    // The same check an upgrade runs, over the site's own diff.
    const report = await upgradeCheck(this, config, {})
    result.classification = report.classification
    result.findings = findingsOf(report.findings)
    if (report.blocking) this.outcome = 'blocked'
    return result
  }
}
