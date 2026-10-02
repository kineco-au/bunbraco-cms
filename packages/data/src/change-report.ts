/**
 * Findings, persisted. A run upserts by `(code, subject, property, culture)`
 * within its own `(source, scope)` and resolves whatever it no longer reports,
 * so the dashboard shows items disappearing as they are fixed.
 *
 * `source` is required rather than defaulted: the sweep resolves what a run
 * omits, so a caller that forgot to say which findings it owns would silently
 * resolve somebody else's. `scope` narrows it again — one bundle's findings do
 * not resolve another's.
 */
import type { Db } from './database.ts'
import { DbDate } from './dialect.ts'

export type FindingKind = 'auto' | 'person' | 'blocking'

/** Who a run of findings belongs to. Scopes the resolve sweep. */
export type FindingSource = 'upgrade' | 'transfer'

export interface Finding {
  kind: FindingKind
  /** Stable machine name: 'mandatory-missing', 'value-conversion', … */
  code: string
  subjectType:
    | 'document'
    | 'document-type'
    | 'property'
    | 'migration'
    | 'file'
    | 'data-type'
    | 'media'
    | 'element'
    | 'bundle'
    | 'dictionary-item'
  subjectKey: string
  subjectName: string
  propertyAlias: string | null
  culture: string | null
  message: string
  /** A backoffice URL, when the subject has one. */
  link: string | null
}

export interface ReportedFinding extends Finding {
  id: number
  runId: string
  source: FindingSource
  /** What within the source these findings are about: a bundle id, or null for an upgrade. */
  scope: string | null
  status: 'open' | 'resolved'
  firstSeen: Date
  lastSeen: Date
  resolvedAt: Date | null
}

export interface WriteReportOptions {
  source: FindingSource
  scope?: string | null
  runId?: string
}

export interface ReadReportOptions {
  includeResolved?: boolean
  source?: FindingSource
  scope?: string | null
}

const identity = (f: Finding) =>
  `${f.code}|${f.subjectKey}|${f.propertyAlias ?? ''}|${f.culture ?? ''}`

/** Records a run: new findings inserted, seen ones refreshed, absent ones resolved. Returns the run id. */
export async function writeReport(
  db: Db,
  findings: readonly Finding[],
  options: WriteReportOptions,
): Promise<string> {
  const { source } = options
  const scope = options.scope ?? null
  const runId = options.runId ?? crypto.randomUUID()
  const now = DbDate.toDb(new Date())
  const open = await readReport(db, { source, scope })
  const openByIdentity = new Map(open.map((f) => [identity(f), f]))
  const seen = new Set<string>()
  for (const finding of findings) {
    const key = identity(finding)
    seen.add(key)
    const existing = openByIdentity.get(key)
    if (existing) {
      await db.exec(
        'UPDATE change_report SET run_id = ?, kind = ?, subject_name = ?, message = ?, link = ?, last_seen = ? WHERE id = ?',
        [runId, finding.kind, finding.subjectName, finding.message, finding.link, now, existing.id],
      )
    } else {
      await db.exec(
        `INSERT INTO change_report (run_id, source, scope, kind, code, subject_type, subject_key, subject_name, property_alias, culture, message, link, status, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        [
          runId,
          source,
          scope,
          finding.kind,
          finding.code,
          finding.subjectType,
          finding.subjectKey,
          finding.subjectName,
          finding.propertyAlias,
          finding.culture,
          finding.message,
          finding.link,
          now,
          now,
        ],
      )
    }
  }
  for (const [key, existing] of openByIdentity) {
    if (seen.has(key)) continue
    await db.exec("UPDATE change_report SET status = 'resolved', resolved_at = ? WHERE id = ?", [
      now,
      existing.id,
    ])
  }
  return runId
}

export async function readReport(
  db: Db,
  options: ReadReportOptions = {},
): Promise<ReportedFinding[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (!options.includeResolved) where.push("status = 'open'")
  if (options.source !== undefined) {
    where.push('source = ?')
    params.push(options.source)
  }
  // `scope` is meaningful when null, so only an explicit key filters.
  if ('scope' in options) {
    const scope = options.scope ?? null
    where.push(scope === null ? 'scope IS NULL' : 'scope = ?')
    if (scope !== null) params.push(scope)
  }
  const rows = await db.query(
    `SELECT id, run_id, source, scope, kind, code, subject_type, subject_key, subject_name, property_alias, culture, message, link, status, first_seen, last_seen, resolved_at
     FROM change_report ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`,
    params,
  )
  return rows.map((row) => ({
    id: Number(row.id),
    runId: String(row.run_id),
    source: String(row.source) as FindingSource,
    scope: (row.scope as string | null) ?? null,
    kind: String(row.kind) as FindingKind,
    code: String(row.code),
    subjectType: String(row.subject_type) as Finding['subjectType'],
    subjectKey: String(row.subject_key),
    subjectName: String(row.subject_name ?? ''),
    propertyAlias: (row.property_alias as string | null) ?? null,
    culture: (row.culture as string | null) ?? null,
    message: String(row.message),
    link: (row.link as string | null) ?? null,
    status: String(row.status) as 'open' | 'resolved',
    firstSeen: DbDate.fromDb(row.first_seen) ?? new Date(0),
    lastSeen: DbDate.fromDb(row.last_seen) ?? new Date(0),
    resolvedAt: DbDate.fromDb(row.resolved_at) ?? null,
  }))
}
