/**
 * What an environment actually resolved to, without booting it.
 *
 * Everything here is already knowable — which database, which schema state,
 * what is pending, what is outstanding — but until now only by starting a
 * server and reading its banner, which is no use when the question is *why* it
 * will not start.
 *
 * Nothing in here writes. `bootstrapDatabase` migrates and seeds, so it is
 * deliberately not used: asking a production node how it is must never be the
 * thing that changes it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ObjectTypes } from '@bunbraco/core'
import {
  bunbracoPlan,
  connect,
  currentSchemaState,
  type Db,
  INITIAL_STATE,
  pendingMigrations,
  readLedger,
  readReport,
  readState,
  TransferRunRepository,
} from '@bunbraco/data'
import { loadSchemaDirectory } from '@bunbraco/schema'
import { type BunbracoConfig, describeDatabase, VERSION } from './config.ts'
import { type EmailAvailability, emailAvailability, resolveEmailPort } from './email.ts'
import { assertViewRuntime } from './view-runtime.ts'

export interface SiteStatus {
  site: {
    name: string
    dir: string
    views: string
    schema: string
    /** Where views are snapshotted so an edit needs no restart. */
    viewsCache: string
  }
  database: {
    dialect: string
    description: string
    reachable: boolean
    /** Why it could not be read, when it could not. */
    problem?: string
    installed: boolean
  }
  schema: {
    /** The version in `schema/schema.toml`, and the revision this node deploys at. */
    files?: string
    revision: string
    /** What the database is at, when it is installed. */
    database?: { version: string; revision: string }
    /** The database is ahead of the files: this node reads and refuses writes. */
    compatibilityMode: boolean
    /** The files are ahead: a sync or an upgrade is pending. */
    pending: boolean
  }
  framework: { pending: string[] }
  content: { documents: number; media: number; elements: number; lastImport?: string }
  /**
   * Open findings by kind. `auto` ones are reported, not counted against the
   * site: "this page is new here" is a note, not a thing to fix.
   */
  findings: { blocking: number; person: number; auto: number; resolved: number }
  versions: { bunbraco: string; backoffice?: string; bun: string }
  /**
   * Whether e-mail can leave this site, and what is unavailable when it cannot.
   * Not a problem — no e-mail is a valid configuration — so it is reported
   * rather than counted against the site.
   */
  email: EmailAvailability
  /** Anything that would stop this site working, in the order worth fixing. */
  problems: string[]
}

/** `1.1.0` against `1.0.0`: which way round the two versions are. */
function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split('.').map((part) => Number(part) || 0)
  const [left, right] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

async function contentCounts(db: Db): Promise<SiteStatus['content']> {
  const rows = await db.query<{ node_object_type: string; n: number }>(
    `SELECT node_object_type, COUNT(*) AS n FROM node
     WHERE trashed = ? GROUP BY node_object_type`,
    [db.dialect.boolValue(false)],
  )
  const of = (objectType: string) =>
    Number(rows.find((row) => row.node_object_type === objectType)?.n ?? 0)
  return {
    documents: of(ObjectTypes.Document),
    media: of(ObjectTypes.Media),
    elements: of(ObjectTypes.Element),
  }
}

/** The vendored client's version, which is a fact about this deployment too. */
function backofficeVersion(): string | undefined {
  for (const base of [join(import.meta.dir, '..', '..'), process.cwd()]) {
    const file = join(base, 'backoffice-dist', 'package.json')
    if (!existsSync(file)) continue
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version
    } catch {
      return undefined
    }
  }
  return undefined
}

export async function siteStatus(config: BunbracoConfig): Promise<SiteStatus> {
  const loaded = existsSync(config.schemaDir) ? loadSchemaDirectory(config.schemaDir) : undefined
  const status: SiteStatus = {
    site: {
      name: config.siteName,
      dir: config.siteDir,
      views: config.viewsDir,
      schema: config.schemaDir,
      viewsCache: config.viewsCacheDir,
    },
    database: {
      dialect: config.dialect,
      description: describeDatabase(config),
      reachable: false,
      installed: false,
    },
    schema: {
      files: loaded?.set.version,
      revision: config.schemaRevision,
      compatibilityMode: false,
      pending: false,
    },
    framework: { pending: [] },
    content: { documents: 0, media: 0, elements: 0 },
    findings: { blocking: 0, person: 0, auto: 0, resolved: 0 },
    versions: { bunbraco: VERSION, backoffice: backofficeVersion(), bun: Bun.version },
    email: emailAvailability(resolveEmailPort(config)),
    problems: [],
  }

  // Opening a SQLite file creates it, which is a change — and the question
  // "what is this environment?" must not be the thing that makes one.
  // Checked here as well as at boot, so a deploy learns before it serves: a
  // views cache the JSX runtime does not resolve from fails every render.
  try {
    assertViewRuntime(config.viewsCacheDir)
  } catch (error) {
    status.problems.push((error as Error).message.split('\n')[0] as string)
  }

  if (
    config.dialect === 'sqlite' &&
    config.sqliteFile !== ':memory:' &&
    !existsSync(config.sqliteFile)
  ) {
    status.database.reachable = true
    status.problems.push('there is no database yet; `bunbraco start` will create one')
    return status
  }

  let db: Db | undefined
  try {
    db = await connect({ file: config.sqliteFile })
    status.database.reachable = true
    try {
      status.database.installed = (await readState(db)) !== INITIAL_STATE
    } catch {
      // Reachable, with no tables in it at all: not installed, rather than
      // unreachable. A half-finished install looks like this.
      status.database.installed = false
    }

    status.framework.pending = (await pendingMigrations(db, bunbracoPlan)).map((m) => m.name)
    if (!status.database.installed) {
      status.problems.push('the database is not installed yet; `bunbraco start` will install it')
      return status
    }
    if (status.framework.pending.length > 0 && !config.development)
      status.problems.push(
        `${status.framework.pending.length} framework migration(s) pending: run \`bunbraco upgrade\``,
      )

    const state = await currentSchemaState(db)
    status.schema.database = { version: state.version, revision: state.revision }
    if (loaded) {
      const difference = compareVersions(loaded.set.version, state.version)
      status.schema.compatibilityMode = difference < 0
      status.schema.pending =
        difference > 0 || (difference === 0 && config.schemaRevision > state.revision)
      if (status.schema.compatibilityMode)
        status.problems.push(
          `the database is at ${state.version} and these files are ${loaded.set.version}: reads only, writes refused with 409`,
        )
      if (status.schema.pending)
        status.problems.push(
          'schema/ is ahead of the database: run `bunbraco upgrade check` to see what it would do',
        )
      for (const problem of loaded.problems)
        status.problems.push(`${problem.file}: ${problem.message}`)
    }

    status.content = await contentCounts(db)
    const [run] = await new TransferRunRepository(db).recent(1)
    if (run) status.content.lastImport = run.startedAt.toISOString()

    const open = await readReport(db)
    const all = await readReport(db, { includeResolved: true })
    const of = (kind: string) => open.filter((finding) => finding.kind === kind).length
    status.findings = {
      blocking: of('blocking'),
      person: of('person'),
      auto: of('auto'),
      resolved: all.length - open.length,
    }
    const wanting = status.findings.blocking + status.findings.person
    if (wanting > 0)
      status.problems.push(
        `${wanting} finding(s) need somebody: \`bunbraco upgrade check\` or the Changes dashboard`,
      )
    // Read so that a database whose ledger cannot be read is noticed here
    // rather than at the next upgrade.
    await readLedger(db)
  } catch (error) {
    status.database.problem = (error as Error).message
    status.problems.push(
      status.database.reachable
        ? `the database could not be read: ${(error as Error).message}`
        : `the database cannot be reached: ${(error as Error).message}`,
    )
  } finally {
    // One exit, so a connection is never left open: on Postgres a leaked
    // session blocks the next `DROP SCHEMA`, and the symptom is a test run
    // that slows to a crawl rather than anything that looks like this.
    await db?.close()
  }
  return status
}
