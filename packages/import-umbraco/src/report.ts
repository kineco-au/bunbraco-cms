/** The compatibility report: what will come across, and what will not, before anything is written. */
import { CLASS_ORDER, CLASS_TITLES, type Finding, type FindingClass } from './findings.ts'
import type { SourceKind } from './source.ts'
import type { DetectedVersion } from './version.ts'

export interface ImportReport {
  generatedAt: string
  source: {
    path: string
    kind: SourceKind
    exportedAt?: string
    serverVersion?: string
    /** Whether the site's files were inspected as well as its database. */
    siteFiles: boolean
  }
  umbraco: DetectedVersion
  /** Whether `apply` would run: no blocking finding. */
  ready: boolean
  counts: Record<FindingClass, number>
  findings: Finding[]
}

const ITEM_LIMIT = 25

export function buildReport(
  source: ImportReport['source'],
  umbraco: DetectedVersion,
  findings: readonly Finding[],
): ImportReport {
  const counts = Object.fromEntries(
    CLASS_ORDER.map((name) => [name, findings.filter((f) => f.class === name).length]),
  ) as Record<FindingClass, number>
  const ordered = [...findings].sort(
    (a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class),
  )
  return {
    generatedAt: new Date().toISOString(),
    source,
    umbraco,
    ready: counts.blocking === 0,
    counts,
    findings: ordered,
  }
}

export function reportJson(report: ImportReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

const INTRO: Record<FindingClass, string> = {
  blocking: 'The import will not run until these are dealt with.',
  'needs-a-person':
    'These come across, but somebody has work to do before they behave as they did.',
  'cannot-migrate': 'These have no equivalent in Bunbraco. Nothing is imported for them.',
  'not-yet': 'These could be imported, but this version of the importer does not do it.',
  dropped: 'These are left behind on purpose.',
  migrates: 'These are converted, with nothing to do.',
}

export function reportMarkdown(report: ImportReport): string {
  const { umbraco, source } = report
  const lines: string[] = ['# Umbraco import report', '']
  lines.push(
    `- **Source:** \`${source.path}\` (${source.kind === 'bacpac' ? '.bacpac' : 'SQLite'})`,
  )
  lines.push(
    `- **Umbraco version:** ${umbraco.version ?? 'not recognised'}${umbraco.state ? ` (upgrade state \`${umbraco.state}\`)` : ''}`,
  )
  if (source.exportedAt) lines.push(`- **Exported:** ${source.exportedAt}`)
  if (source.serverVersion) lines.push(`- **Database server:** ${source.serverVersion}`)
  lines.push(`- **Site files inspected:** ${source.siteFiles ? 'yes' : 'no'}`)
  lines.push(
    `- **Verdict:** ${report.ready ? 'ready to import' : `blocked by ${report.counts.blocking} finding(s)`}`,
    '',
  )

  for (const name of CLASS_ORDER) {
    const findings = report.findings.filter((finding) => finding.class === name)
    if (findings.length === 0) continue
    lines.push(`## ${CLASS_TITLES[name]}`, '', INTRO[name], '')
    for (const finding of findings) {
      const count = finding.count === undefined ? '' : ` (${finding.count})`
      lines.push(`### ${finding.title}${count}`, '')
      if (finding.detail) lines.push(finding.detail, '')
      const items = finding.items ?? []
      for (const item of items.slice(0, ITEM_LIMIT)) lines.push(`- ${item}`)
      if (items.length > ITEM_LIMIT) lines.push(`- … and ${items.length - ITEM_LIMIT} more`)
      if (items.length > 0) lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** The report as a few lines for a terminal. */
export function reportSummary(report: ImportReport): string[] {
  const lines = [
    `Umbraco ${report.umbraco.version ?? '(version not recognised)'}, from a ${report.source.kind === 'bacpac' ? '.bacpac' : 'SQLite database'}`,
  ]
  for (const name of CLASS_ORDER) {
    const findings = report.findings.filter((finding) => finding.class === name)
    if (findings.length === 0) continue
    lines.push('', `${CLASS_TITLES[name]}:`)
    for (const finding of findings)
      lines.push(`  ${finding.title}${finding.count === undefined ? '' : ` (${finding.count})`}`)
  }
  return lines
}
