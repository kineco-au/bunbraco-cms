/**
 * The staging database: a faithful SQLite copy of the Umbraco database, which
 * everything else reads with plain SQL and never writes.
 *
 * A `.bacpac` is converted into one by `@kineco-au/bacpac-importer`, which
 * knows nothing about Umbraco. A native Umbraco SQLite file already is one.
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convert, openBacpac, SqliteWriter } from '@kineco-au/bacpac-importer'

/**
 * Tables the importer reads. Only these are converted from a `.bacpac`: the
 * rest are logs, caches and tokens that cost time and hold nothing to migrate,
 * and a plugin's table may use a column type the converter cannot decode.
 */
const WANTED_TABLES = [
  'umbracoNode',
  'umbracoContent',
  'umbracoContentVersion',
  'umbracoContentVersionCultureVariation',
  'umbracoContentVersionCleanupPolicy',
  'umbracoContentSchedule',
  'umbracoDocument',
  'umbracoDocumentVersion',
  'umbracoDocumentCultureVariation',
  'umbracoDocumentUrl',
  'umbracoElement',
  'umbracoElementVersion',
  'umbracoElementCultureVariation',
  'umbracoMediaVersion',
  'umbracoPropertyData',
  'umbracoDataType',
  'umbracoLanguage',
  'umbracoDomain',
  'umbracoKeyValue',
  'umbracoRedirectUrl',
  'umbracoAccess',
  'umbracoAccessRule',
  'umbracoUser',
  'umbracoUserGroup',
  'umbracoExternalLogin',
  'umbracoTwoFactorLogin',
  'umbracoWebhook',
  'umbracoCreatedPackageSchema',
  'cmsContentType',
  'cmsContentType2ContentType',
  'cmsContentTypeAllowedContentType',
  'cmsDocumentType',
  'cmsPropertyType',
  'cmsPropertyTypeGroup',
  'cmsTemplate',
  'cmsDictionary',
  'cmsLanguageText',
  'cmsMember',
  'cmsMemberType',
  'cmsMember2MemberGroup',
]

export type SourceKind = 'bacpac' | 'sqlite'

export interface Source {
  readonly kind: SourceKind
  readonly path: string
  /** Every table in the source database, not only the ones that were staged. */
  readonly tables: readonly string[]
  /** What the export says about itself, when it says. */
  readonly exportedAt?: string
  readonly serverVersion?: string
  has(table: string): boolean
  hasColumn(table: string, column: string): boolean
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined
  count(table: string, where?: string): number
  close(): void
}

export interface OpenSourceOptions {
  /** Keep the staging database at this path instead of a temporary one that is removed. */
  staging?: string
}

/** A uuid as the rest of bunbraco spells it. Native Umbraco SQLite stores them upper case. */
export const key = (value: unknown): string => String(value ?? '').toLowerCase()

/** A stored date as `YYYY-MM-DD HH:MM:SS`, whichever of the two source spellings it arrived in. */
export function wallClock(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).replace('T', ' ')
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text} 00:00:00` : text.slice(0, 19)
}

class SqliteSource implements Source {
  readonly #db: Database
  readonly #staged: Set<string>
  readonly #columns = new Map<string, Set<string>>()
  readonly #cleanup: (() => void) | undefined

  constructor(
    readonly kind: SourceKind,
    readonly path: string,
    db: Database,
    readonly tables: readonly string[],
    extra: { exportedAt?: string; serverVersion?: string; cleanup?: () => void } = {},
  ) {
    this.#db = db
    this.exportedAt = extra.exportedAt
    this.serverVersion = extra.serverVersion
    this.#cleanup = extra.cleanup
    this.#staged = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name.toLowerCase()),
    )
  }

  readonly exportedAt?: string
  readonly serverVersion?: string

  has(table: string): boolean {
    return this.#staged.has(table.toLowerCase())
  }

  hasColumn(table: string, column: string): boolean {
    if (!this.has(table)) return false
    let columns = this.#columns.get(table)
    if (!columns) {
      columns = new Set(
        this.#db
          .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((row) => row.name.toLowerCase()),
      )
      this.#columns.set(table, columns)
    }
    return columns.has(column.toLowerCase())
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.#db.query(sql).all(...(params as never[])) as T[]
  }

  one<T>(sql: string, ...params: unknown[]): T | undefined {
    return (this.#db.query(sql).get(...(params as never[])) as T | null) ?? undefined
  }

  count(table: string, where?: string): number {
    if (!this.has(table)) return 0
    const row = this.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM "${table}"${where ? ` WHERE ${where}` : ''}`,
    )
    return Number(row?.n ?? 0)
  }

  close(): void {
    this.#db.close()
    this.#cleanup?.()
  }
}

async function isSqliteFile(path: string): Promise<boolean> {
  const head = await Bun.file(path).slice(0, 16).text()
  return head.startsWith('SQLite format 3')
}

/** Opens an Umbraco database backup: a `.bacpac`, or Umbraco's own SQLite file. */
export async function openSource(path: string, options: OpenSourceOptions = {}): Promise<Source> {
  if (!existsSync(path)) throw new Error(`No file at ${path}.`)

  if (await isSqliteFile(path)) {
    const db = new Database(path, { readonly: true })
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
    return new SqliteSource('sqlite', path, db, tables)
  }

  let bacpac: Awaited<ReturnType<typeof openBacpac>>
  try {
    bacpac = await openBacpac(path)
  } catch (error) {
    throw new Error(
      `${path} is neither a .bacpac nor a SQLite database (${error instanceof Error ? error.message : error}). ` +
        'A SQL Server .bak or a live database is not supported: export a .bacpac from it.',
    )
  }

  const temporary = options.staging ? undefined : mkdtempSync(join(tmpdir(), 'bunbraco-import-'))
  const staging = options.staging ?? join(temporary as string, 'staging.sqlite')
  try {
    const tables = bacpac.tables.map((table) => table.name)
    const wanted = new Set(WANTED_TABLES.map((name) => name.toLowerCase()))
    await convert(bacpac, new SqliteWriter(staging, { overwrite: true }), {
      include: tables.filter((name) => wanted.has(name.toLowerCase())),
    })
    return new SqliteSource('bacpac', path, new Database(staging, { readonly: true }), tables, {
      exportedAt: bacpac.origin.exportedAt,
      serverVersion: bacpac.origin.serverVersion,
      cleanup: temporary ? () => rmSync(temporary, { recursive: true, force: true }) : undefined,
    })
  } catch (error) {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    throw error
  } finally {
    await bacpac.close()
  }
}
