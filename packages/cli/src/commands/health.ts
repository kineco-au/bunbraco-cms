import {
  bootstrapDatabase,
  createDiagnosticsPort,
  mediaStoreFor,
  resolveEmailPort,
} from '@crombolo/server'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../base.ts'
import { siteConfig } from '../support/site.ts'

/** The checks the Settings section's Health Check dashboard runs, for a monitor or a deploy to gate on. */
export default class Health extends BaseCommand {
  static override summary = "run the site's health checks"
  static override description =
    'The same checks as Settings › Health Check. Exits 20 when a check fails; a warning is reported, not counted.'
  static override flags = {
    group: Flags.string({ summary: 'only this group of checks', helpValue: '<name>' }),
  }
  static override spec = {
    effects: 'read_only',
    cardinality: 'bounded',
    outputFields: [
      {
        name: 'groups',
        type: 'array',
        items: {
          type: 'object',
          fields: [
            { name: 'name', type: 'string' },
            { name: 'checks', type: 'array', items: { type: 'object' } },
          ],
        },
      },
      { name: 'failed', type: 'integer' },
      { name: 'warnings', type: 'integer' },
    ],
    errors: ['not_found'],
    outcomes: ['problems_found'],
  } as const

  async run() {
    const { flags } = await this.parse(Health)
    const config = await siteConfig()
    const { db } = await bootstrapDatabase(config)
    try {
      const diagnostics = createDiagnosticsPort({
        config,
        db,
        media: await mediaStoreFor(config),
        email: resolveEmailPort(config),
      })
      const groups = diagnostics.groups()
      const chosen = flags.group
        ? groups.filter((group) => group.name.toLowerCase() === flags.group?.toLowerCase())
        : groups
      if (chosen.length === 0)
        this.fail(
          'not_found',
          `There is no group "${flags.group}".`,
          `The groups: ${groups.map((g) => g.name).join(', ')}.`,
        )
      let failed = 0
      let warnings = 0
      const report = []
      for (const group of chosen) {
        const results = (await diagnostics.run(group.name)) ?? []
        const checks = group.checks.map((check) => {
          const found = results.find((result) => result.id === check.id)?.results ?? []
          for (const result of found) {
            if (result.resultType === 'Error') failed += 1
            if (result.resultType === 'Warning') warnings += 1
          }
          return {
            name: check.name,
            results: found.map((r) => ({ type: r.resultType, message: r.message })),
          }
        })
        this.say(group.name)
        for (const check of checks)
          for (const result of check.results)
            this.say(`  [${result.type.padEnd(7)}] ${check.name}: ${result.message}`)
        report.push({ name: group.name, checks })
      }
      if (failed > 0) this.outcome = 'problems_found'
      return { groups: report, failed, warnings }
    } finally {
      await db.close()
    }
  }
}
