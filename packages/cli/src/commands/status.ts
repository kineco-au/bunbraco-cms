import { siteStatus } from '@crombolo/server'
import { BaseCommand } from '../base.ts'
import { siteConfig } from '../support/site.ts'

/**
 * What this environment resolved to, and what is wrong with it, without
 * starting it. Read-only by construction — it opens the database rather than
 * bootstrapping it, so asking a production node how it is never migrates it.
 */
export default class Status extends BaseCommand {
  static override summary =
    'what this environment is, and what is wrong with it, without starting it'
  static override description =
    'Exits 20 when something would stop the site working; the problems are in the output.'
  static override spec = {
    effects: 'read_only',
    cardinality: 'single',
    outputFields: [
      { name: 'site', type: 'object' },
      { name: 'database', type: 'object' },
      { name: 'schema', type: 'object' },
      { name: 'framework', type: 'object' },
      { name: 'bundles', type: 'object' },
      { name: 'content', type: 'object' },
      { name: 'findings', type: 'object' },
      { name: 'email', type: 'object' },
      { name: 'versions', type: 'object' },
      { name: 'problems', type: 'array', items: { type: 'string' } },
    ],
    outcomes: ['problems_found'],
  } as const

  async run() {
    await this.parse(Status)
    const report = await siteStatus(await siteConfig())
    if (report.problems.length > 0) this.outcome = 'problems_found'

    const line = (label: string, value: string) => this.say(`  ${label.padEnd(10)} ${value}`)
    line('site', `${report.site.name}${report.site.dir ? `   ${report.site.dir}` : ''}`)
    line('components', `${report.site.components}   snapshots in ${report.site.componentsCache}`)
    line(
      'database',
      `${report.database.description}   ${
        report.database.reachable
          ? report.database.installed
            ? 'reachable'
            : 'reachable, not installed'
          : 'unreachable'
      }`,
    )
    const files = report.schema.files ?? 'none'
    const database = report.schema.database
      ? `${report.schema.database.version}+${report.schema.database.revision}`
      : 'not installed'
    line(
      'schema',
      `files ${files}  database ${database}   ${
        !report.database.installed
          ? 'nothing applied yet'
          : report.schema.compatibilityMode
            ? 'compatibility mode'
            : report.schema.pending
              ? 'a deploy is pending'
              : 'up to date'
      }`,
    )
    const pending = report.framework.pending
    line(
      'framework',
      pending.length === 0
        ? 'no migration pending'
        : // The whole list is a wall of names on a fresh database; `upgrade --plan`
          // is where somebody goes when they want them.
          pending.length > 3
          ? `${pending.length} pending (\`crombolo upgrade --plan\` lists them)`
          : `${pending.length} pending: ${pending.join(', ')}`,
    )
    line(
      'content',
      `${report.content.documents} document(s), ${report.content.media} media, ${report.content.elements} element(s)` +
        `${report.content.lastImport ? `; last import ${report.content.lastImport}` : ''}`,
    )
    line(
      'email',
      report.email.available
        ? (report.email.description ?? 'configured')
        : report.email.provider === 'log'
          ? 'console only, nothing is sent'
          : `none — ${report.email.affects.join(', ')} unavailable`,
    )
    line(
      'findings',
      `${report.findings.blocking} blocking, ${report.findings.person} need a person, ` +
        `${report.findings.auto} automatic, ${report.findings.resolved} resolved`,
    )
    line(
      'versions',
      `crombolo ${report.versions.crombolo}${report.versions.backoffice ? `, backoffice ${report.versions.backoffice}` : ''}, bun ${report.versions.bun}`,
    )
    for (const problem of report.problems) this.say(`\n  ⚠ ${problem}`)
    return report
  }
}
