/** How the CLI says what happened: the lines shared between commands. */
import { relative } from 'node:path'
import type { Finding } from '@crombolo/data'
import type { SyncReport } from '@crombolo/schema'
import { propertyHandle, resolutionsFor, type TransferCheck } from '@crombolo/transfer'
import type * as ops from '../operations/commands.ts'
import type { Job } from '../remote/client.ts'
import { cwd, type Io } from './site.ts'

export function banner(io: Io, lines: string[]): void {
  const width = Math.max(...lines.map((line) => line.length))
  io.say(`┌─${'─'.repeat(width)}─┐`)
  for (const line of lines) io.say(`│ ${line.padEnd(width)} │`)
  io.say(`└─${'─'.repeat(width)}─┘`)
}

export const here = (path: string): string => relative(cwd(), path) || '.'

/** Bytes as somebody reads them, since a bundle of media is measured in them. */
export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export const counted = (counts: Record<string, number>, none = 'nothing'): string => {
  const entries = Object.entries(counts)
  return entries.length > 0 ? entries.map(([kind, n]) => `${n} ${kind}`).join(', ') : none
}

/**
 * Puts the media files a bundle carries into this environment's store.
 *
 * After the content, because the run is what decides whether any of this
 * happened: a refused import leaves the store alone.
 */
export function describePlaced(
  placed: { placed: number; bytes: number } | null,
): string | undefined {
  if (!placed) return undefined
  return `${placed.placed} media file(s) placed, ${describeBytes(placed.bytes)}`
}

export function describeSync(report: SyncReport): string {
  switch (report.action) {
    case 'applied':
    case 'would-apply': {
      const verb = report.action === 'applied' ? 'applied' : 'would apply'
      const c = report.created
      const parts = [
        `${c.types} type(s)`,
        `${c.properties} propert${c.properties === 1 ? 'y' : 'ies'}`,
        `${c.dataTypes} data type(s)`,
        `${c.languages} language(s)`,
      ]
      const extra = [
        report.retired.length > 0 ? `retired ${report.retired.join(', ')}` : '',
        report.retiredTypes.length > 0 ? `retired types ${report.retiredTypes.join(', ')}` : '',
        report.revived.length > 0 ? `revived ${report.revived.join(', ')}` : '',
        report.assignedKeys.length > 0 ? `${report.assignedKeys.length} key(s) assigned` : '',
      ].filter(Boolean)
      return `${verb} ${report.state?.version ?? ''}: created ${parts.join(', ')}${extra.length > 0 ? `; ${extra.join('; ')}` : ''}`
    }
    case 'skipped-same':
      return 'up to date'
    case 'skipped-older':
      return `compatibility mode: ${report.reason ?? ''}`
    case 'refused':
      return `refused: ${report.reason ?? `${report.problems.length} problem(s)`}`
  }
}

export const describeProblem = (p: SyncReport['problems'][number]): string =>
  `${p.file}${p.path ? ` (${p.path})` : ''}: ${p.message}`

export function printProblems(io: Io, problems: SyncReport['problems']): void {
  for (const p of problems) io.warning(`  ${describeProblem(p)}`)
}

export function describeBundle(io: Io, bundle: ops.BundleSummary): void {
  io.say(
    `  bundle   ${bundle.id} from ${bundle.from || 'elsewhere'} ` +
      `(schema ${bundle.schemaVersion}+${bundle.schemaRevision}, ` +
      `${bundle.snapshot} snapshot, ${bundle.nodes} node(s))`,
  )
  if (bundle.blobsCarried > 0)
    io.say(
      `  blobs    ${bundle.blobsCarried} media file(s) carried, ${describeBytes(bundle.blobBytes)}`,
    )
}

/** What the carried sections would do, or did. */
export function printSections(io: Io, plan: ops.SectionPlan | undefined): void {
  if (!plan) return
  io.say(`  carries  ${plan.sections.join(', ')}`)
  const counts = new Map<string, number>()
  for (const file of plan.files) counts.set(file.action, (counts.get(file.action) ?? 0) + 1)
  const summary = [...counts].map(([action, n]) => `${n} ${action}`).join(', ')
  if (summary) io.say(`  files    ${summary}`)
  for (const file of plan.files)
    if (file.action === 'overwrite') io.say(`    overwrites ${here(file.target)}`)
  if (plan.dictionaryItems > 0) io.say(`  dict     ${plan.dictionaryItems} file(s)`)
  if (plan.schema) {
    io.say(`  schema   ${plan.schema.classification}`)
    for (const finding of plan.schema.findings) io.say(`    ${finding}`)
  }
}

export function printTransferFindings(io: Io, check: TransferCheck): void {
  const byKind = { blocking: 0, person: 0, auto: 0 }
  for (const f of check.findings) byKind[f.kind] += 1
  const c = check.counts
  io.say(
    `  plan     ${c.create} new, ${c.update} updated, ${c.unchanged} unchanged, ${c.skip} skipped`,
  )
  io.say(
    `  findings ${byKind.blocking} blocking, ${byKind.person} need a person, ${byKind.auto} automatic`,
  )
  for (const f of check.findings) {
    io.say(`  [${f.kind.padEnd(8)}] ${f.message}`)
    // The handle is the CLI's to name; the dashboard offers the same answers as choices.
    if (f.code === 'local-edit' && f.propertyAlias)
      io.say(
        `             answer it as ${f.subjectKey}/${propertyHandle(f.propertyAlias, f.culture)}`,
      )
    for (const suggestion of resolutionsFor(f.code)) io.say(`             → ${suggestion}`)
    if (f.link) io.say(`             ${f.link}`)
  }
}

/** The findings a check reports, as data: what the envelope's `details` carry. */
export const findingsOf = (
  findings: readonly { kind: string; message: string; code?: string; link?: string | null }[],
) =>
  findings.map((f) => ({
    kind: f.kind,
    ...(f.code ? { code: f.code } : {}),
    message: f.message,
    ...(f.link ? { link: f.link } : {}),
  }))

export function printFindings(
  io: Io,
  report: { classification: string; findings: Finding[] },
): void {
  const byKind = { blocking: 0, person: 0, auto: 0 }
  for (const f of report.findings) byKind[f.kind] += 1
  io.say(
    `change: ${report.classification}; findings: ${byKind.blocking} blocking, ${byKind.person} need a person, ${byKind.auto} automatic`,
  )
  for (const f of report.findings) {
    const where = f.link ? `  ${f.link}` : ''
    io.say(`  [${f.kind.padEnd(8)}] ${f.message}${where}`)
  }
}

export const describeJob = (job: Job): string =>
  `  ${job.kind.padEnd(5)} ${job.state}${job.stage ? `, ${job.stage}` : ''}${job.progress != null ? ` (${job.progress}%)` : ''}`

export function describeContentMode(
  io: Io,
  content: 'omitted' | 'sealed' | 'open',
  people?: { members: number; users: number },
): void {
  if (content === 'omitted')
    io.say(
      '  content  not included: pages are placed and named, and no value is written. Pass --include-content to bring the values and media files',
    )
  else if (content === 'sealed') io.say('  content  encrypted: importing needs the passphrase')
  else io.say('  content  unencrypted')
  if (people && people.members + people.users > 0)
    io.say(`  people   ${people.members} member(s), ${people.users} user(s), encrypted`)
}
