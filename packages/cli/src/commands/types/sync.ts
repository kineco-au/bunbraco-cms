import { bootstrapDatabase, syncSchemaDirectory } from '@crombolo/server'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { describeProblem, describeSync, printProblems } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'
import { needSchemaDir } from '../../support/types.ts'

export default class TypesSync extends BaseCommand {
  static override summary = 'apply schema/ to the database'
  static override aliases = ['schema:sync']
  static override deprecateAliases = true
  static override flags = {
    'force-retire-types': Flags.boolean({
      summary: 'retire a type the files no longer have even though content uses it',
    }),
  }
  static override audit = { category: 'schema', action: 'Sync', entityType: 'Schema' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      {
        name: 'action',
        type: 'string',
        enum: ['applied', 'would-apply', 'skipped-same', 'skipped-older', 'refused'],
      },
      { name: 'changed', type: 'boolean' },
      { name: 'summary', type: 'string' },
      { name: 'problems', type: 'array', items: { type: 'string' } },
    ],
    errors: ['not_found', 'refused'],
  } as const

  async run() {
    const { flags } = await this.parse(TypesSync)
    const config = await siteConfig()
    needSchemaDir(config)
    const { db } = await bootstrapDatabase(config)
    try {
      const report = await syncSchemaDirectory(
        db,
        config,
        { nodeId: config.nodeId, revision: config.schemaRevision },
        { forceRetireTypes: flags['force-retire-types'] },
      )
      if (report.problems.length > 0) printProblems(this, report.problems)
      const summary = describeSync(report)
      if (report.action === 'refused')
        this.fail(
          'refused',
          `The schema was not applied: ${summary}.`,
          undefined,
          report.problems.map(describeProblem),
        )
      this.say(summary)
      return {
        action: report.action,
        changed: report.action === 'applied',
        summary,
        problems: report.problems.map(describeProblem),
      }
    } finally {
      await db.close()
    }
  }
}
