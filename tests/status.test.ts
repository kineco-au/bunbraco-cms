/**
 * `bunbraco status`: what an environment is, asked without starting it.
 *
 * The rule that matters most is the one that is easy to break by accident:
 * reading the status must never change anything. Everything else is reporting
 * what the other suites already hold the system to.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bunbracoPlan, connect, INITIAL_STATE, pendingMigrations, readState } from '@bunbraco/data'
import { loadConfig, siteStatus } from '@bunbraco/server'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer } from './support/harness.ts'

const TYPE = `[document-type]
key = "6d1f9a70-2c55-4a7e-9f3b-1b2c3d4e5f60"
alias = "page"
name = "Page"
allow-at-root = true
components = ["page"]
default-component = "page"

[[property]]
key = "6d1f9a70-2c55-4a7e-9f3b-1b2c3d4e5f61"
alias = "title"
name = "Title"
type = "textstring"
`

const VIEW = `export default function Page({ model }) {
  return <main>{model.text('title')}</main>
}
`

describe(`status (${dialectUnderTest})`, () => {
  const open: Harness[] = []
  const dirs: string[] = []

  afterEach(async () => {
    while (open.length > 0) await open.pop()?.db.close()
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  function site(version = '1.0.0'): string {
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    const root = mkdtempSync(join(process.cwd(), 'output', 'status-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(root, 'components'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), `[schema]\nversion = "${version}"\n`)
    writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE)
    writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
    return root
  }

  const configFor = (root: string, overrides: Record<string, unknown> = {}) =>
    loadConfig(
      {
        siteName: 'Status Test',
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        ...overrides,
      },
      root,
    )

  // The two cases below are about a database file, which only SQLite has: a
  // Postgres environment always has a database to connect to.
  const sqliteOnly = test.skipIf(dialectUnderTest !== 'sqlite')

  sqliteOnly('says there is no database yet, and does not make one', async () => {
    const root = site()
    const file = join(root, 'absent.sqlite')
    const report = await siteStatus(configFor(root, { sqliteFile: file }))

    expect(report.problems.join('\n')).toContain('no database yet')
    // Opening a SQLite file creates it, so status does not open one: asking a
    // node what it is must never be what changes it.
    expect(existsSync(file)).toBe(false)
    // The site's own facts are known without a database at all.
    expect(report.site.name).toBe('Status Test')
    expect(report.schema.files).toBe('1.0.0')
    expect(report.versions.bunbraco).toMatch(/^\d+\.\d+\.\d+$/)
  })

  sqliteOnly('reads a database that exists with nothing in it, and installs nothing', async () => {
    const root = site()
    const file = join(root, 'empty.sqlite')
    // An empty file, as a half-finished install would leave.
    await (await connect({ file })).close()

    const report = await siteStatus(configFor(root, { sqliteFile: file }))
    expect(report.database.reachable).toBe(true)
    expect(report.database.installed).toBe(false)
    expect(report.framework.pending.length).toBeGreaterThan(0)
    expect(report.problems.join('\n')).toContain('not installed')

    // `bootstrapDatabase` would have migrated and seeded by now; this must not.
    const db = await connect({ file })
    try {
      expect(await readState(db)).toBe(INITIAL_STATE)
      expect((await pendingMigrations(db, bunbracoPlan)).length).toBeGreaterThan(0)
    } finally {
      await db.close()
    }
  })

  test('reports an installed site: its schema state, its content and its versions', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const root = site()
    // A file, not `:memory:`: status opens its own connection, so an in-memory
    // database would be a different, empty one.
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        sqliteFile: join(root, 'site.sqlite'),
      },
    })
    open.push(h)

    const report = await siteStatus(h.server.config)
    expect(report.database.installed).toBe(true)
    expect(report.framework.pending).toEqual([])
    expect(report.schema.database?.version).toBe('1.0.0')
    expect(report.schema.compatibilityMode).toBe(false)
    expect(report.schema.pending).toBe(false)
    expect(report.content.documents).toBe(0)
    expect(report.problems).toEqual([])
  })

  test('says so when the database is ahead of these files, which is a read-only node', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const root = site('2.0.0')
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        sqliteFile: join(root, 'site.sqlite'),
      },
    })
    open.push(h)

    // The same database, read by a node whose files are older: what a node left
    // behind by a deploy sees.
    const older = site('1.0.0')
    const report = await siteStatus(
      loadConfig(
        {
          siteDir: older,
          schemaDir: join(older, 'schema'),
          componentsDir: join(older, 'components'),
          sqliteFile: h.server.config.sqliteFile,
        },
        older,
      ),
    )
    expect(report.schema.compatibilityMode).toBe(true)
    expect(report.problems.join('\n')).toContain('reads only')
  })

  test('and when the files are ahead, which is a deploy waiting to be applied', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const root = site('1.0.0')
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        sqliteFile: join(root, 'site.sqlite'),
      },
    })
    open.push(h)

    const newer = site('1.1.0')
    const report = await siteStatus(
      loadConfig(
        {
          siteDir: newer,
          schemaDir: join(newer, 'schema'),
          componentsDir: join(newer, 'components'),
          sqliteFile: h.server.config.sqliteFile,
        },
        newer,
      ),
    )
    expect(report.schema.pending).toBe(true)
    expect(report.schema.compatibilityMode).toBe(false)
    expect(report.problems.join('\n')).toContain('upgrade check')
  })
})
