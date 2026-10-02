/**
 * Framework migrations, hardened: the ledger, expand/contract linting, the
 * recorded plan, the newer-database refusal, production refusing to upgrade
 * at boot, and schema operations on the dialect seam. docs/10, "Schema migrations".
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  bunbracoPlan,
  type Db,
  INITIAL_STATE,
  type Migration,
  MigrationPlan,
  migrate,
  pendingMigrations,
  planUpgrade,
  readLedger,
  readState,
  STATE_MEMBER_PROPERTY_TYPE,
  schemaOps,
  seedContent,
  stampFinalState,
  UpgradeStateError,
} from '@bunbraco/data'
import {
  BackupRequiredError,
  backupBefore,
  loadConfig,
  UpgradePendingError,
  VERSION,
} from '@bunbraco/server'
import {
  canConnect,
  dialectUnderTest,
  freshDb,
  undoMigrationsSinceContentEditing,
} from './support/db.ts'

const S1 = '{11111111-0000-4000-8000-000000000001}'
const S2 = '{11111111-0000-4000-8000-000000000002}'
const S3 = '{11111111-0000-4000-8000-000000000003}'

const open: Db[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function db(): Promise<Db> {
  const d = await freshDb()
  open.push(d)
  return d
}

const expand = (over: Partial<Migration> = {}): Migration => ({
  from: INITIAL_STATE,
  to: S1,
  name: 'AddWidgets',
  kind: 'expand',
  release: '1.0.0',
  async up(d) {
    const t = d.dialect.types
    await d.exec(`CREATE TABLE widget (id ${t.identity}, name ${t.text})`)
  },
  ...over,
})

describe('migration plan lint', () => {
  test('a contract must name an expand from an earlier release', () => {
    const contract: Migration = {
      from: S1,
      to: S2,
      name: 'DropWidgets',
      kind: 'contract',
      release: '2.0.0',
      contracts: 'AddWidgets',
      up: async (d) => schemaOps(d).dropTable('widget'),
    }
    expect(() => new MigrationPlan([expand(), contract])).not.toThrow()
    expect(() => new MigrationPlan([expand(), { ...contract, contracts: undefined }])).toThrow(
      /must name the expand/,
    )
    expect(() => new MigrationPlan([expand(), { ...contract, release: '1.0.0' }])).toThrow(
      /earlier release/,
    )
    expect(() => new MigrationPlan([expand({ release: undefined }), contract])).toThrow(
      /declare a release/,
    )
  })

  test('the shipped plan is all expand, each with a release', () => {
    for (const m of bunbracoPlan.migrations) {
      expect(m.kind).toBe('expand')
      expect(m.release).toBeDefined()
    }
  })

  test('no step claims a release that does not exist yet', () => {
    // A migration declaring a release ahead of the version being built is a
    // number nobody can act on: it lands in the ledger as `release 0.9.0` of a
    // 0.3.0 install, and a later contract would compare against it wrongly. The
    // numbers drifted exactly this way before the repository was split.
    const ordinal = (version: string) =>
      version
        .split(/[.+-]/)
        .slice(0, 3)
        .map(Number)
        .reduce((a, part) => a * 1000 + part, 0)
    for (const m of bunbracoPlan.migrations)
      expect([m.name, ordinal(m.release as string) <= ordinal(VERSION)]).toEqual([m.name, true])
  })
})

describe(`migrations (${dialectUnderTest})`, () => {
  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`cannot connect to ${dialectUnderTest}`)
  })

  test('every applied step is ledgered with its kind, states and release', async () => {
    const d = await db()
    const result = await migrate(d, bunbracoPlan, { by: 'node-x' })
    expect(result.applied).toHaveLength(bunbracoPlan.migrations.length)
    const ledger = await readLedger(d)
    expect(ledger.map((r) => [r.name, r.kind, r.appliedBy, r.note])).toEqual(
      bunbracoPlan.migrations.map((m) => [m.name, 'expand', 'node-x', `release ${m.release}`]),
    )
    expect(ledger[0]?.fromState).toBe(INITIAL_STATE)
    expect(ledger.at(-1)?.toState).toBe(bunbracoPlan.finalState)
    // A second run adds nothing to the ledger
    await migrate(d, bunbracoPlan)
    expect(await readLedger(d)).toHaveLength(bunbracoPlan.migrations.length)
  })

  test('the plan records the DDL of every pending step without running it', async () => {
    const d = await db()
    const steps = await planUpgrade(d, bunbracoPlan)
    expect(steps.map((s) => s.name)).toEqual(bunbracoPlan.migrations.map((m) => m.name))
    expect(steps.every((s) => s.statements && s.statements.length > 0 && !s.unplannable)).toBe(true)
    expect(steps[2]?.statements?.some((sql) => /CREATE TABLE property_value/.test(sql))).toBe(true)
    // Nothing ran
    expect(await readState(d)).toBe(INITIAL_STATE)
    const tables = await d.query<{ n: number }>(
      dialectUnderTest === 'sqlite'
        ? "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'node'"
        : "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = 'node'",
    )
    expect(Number(tables[0]?.n)).toBe(0)

    // Once applied, the plan is empty
    await migrate(d, bunbracoPlan)
    expect(await planUpgrade(d, bunbracoPlan)).toEqual([])
  })

  test('a step that reads data is reported as unplannable, not guessed at', async () => {
    const d = await db()
    const reads: Migration = {
      from: S1,
      to: S2,
      name: 'Backfill',
      kind: 'expand',
      release: '1.1.0',
      async up(tx) {
        const rows = await tx.query('SELECT id FROM widget')
        for (const row of rows)
          await tx.exec('UPDATE widget SET name = ? WHERE id = ?', ['x', row.id])
      },
    }
    const steps = await planUpgrade(d, new MigrationPlan([expand(), reads]))
    expect(steps[0]?.statements).toHaveLength(1)
    expect(steps[1]?.statements).toBeUndefined()
    expect(steps[1]?.unplannable).toContain('reads data')
  })

  test('a database newer than the code is refused by name, not "stalled"', async () => {
    const d = await db()
    const newer = new MigrationPlan([
      expand(),
      expand({ from: S1, to: S2, name: 'Later', up: async () => {} }),
    ])
    await migrate(d, newer)
    const older = new MigrationPlan([expand()])
    await expect(pendingMigrations(d, older)).rejects.toBeInstanceOf(UpgradeStateError)
    await expect(migrate(d, older)).rejects.toThrow(/newer version/)
    // and a stamped install is simply current
    const d2 = await db()
    await stampFinalState(d2, older)
    expect(await pendingMigrations(d2, older)).toEqual([])
  })

  test('schema operations run on both dialects', async () => {
    const d = await db()
    await migrate(d, new MigrationPlan([expand()]))
    const ops = schemaOps(d)
    await ops.addColumn('widget', 'colour', `${d.dialect.types.varchar(20)}`)
    await ops.addIndex('ix_widget_colour', 'widget', ['colour'])
    await d.exec('INSERT INTO widget (name, colour) VALUES (?, ?)', ['w', 'red'])
    await ops.renameColumn('widget', 'colour', 'hue')
    await ops.dropIndex('ix_widget_colour', 'widget')
    expect((await d.query<{ hue: string }>('SELECT hue FROM widget'))[0]?.hue).toBe('red')
    await ops.dropColumn('widget', 'hue')
    await ops.renameTable('widget', 'gadget')
    expect((await d.query<{ name: string }>('SELECT name FROM gadget'))[0]?.name).toBe('w')
    await ops.dropTable('gadget')
  })

  test('a contract only runs after its expand, and is ledgered as a contract', async () => {
    const d = await db()
    const plan = new MigrationPlan([
      expand(),
      {
        from: S1,
        to: S2,
        name: 'AddWidgetColour',
        kind: 'expand',
        release: '1.1.0',
        up: (tx) => schemaOps(tx).addColumn('widget', 'colour', tx.dialect.types.text),
      },
      {
        from: S2,
        to: S3,
        name: 'DropWidgetColour',
        kind: 'contract',
        release: '2.0.0',
        contracts: 'AddWidgetColour',
        up: (tx) => schemaOps(tx).dropColumn('widget', 'colour'),
      },
    ])
    await migrate(d, plan)
    expect((await readLedger(d)).map((r) => r.kind)).toEqual(['expand', 'expand', 'contract'])
  })
})

describe('boot and backup rules', () => {
  test('production refuses to boot with steps pending on an existing database, but installs a fresh one', async () => {
    if (dialectUnderTest !== 'sqlite') return
    const dir = mkdtempSync(join(process.cwd(), 'output', 'upgrade-'))
    dirs.push(dir)
    const file = join(dir, 'site.sqlite')
    const { bootstrapDatabase } = await import('@bunbraco/server')
    const prod = loadConfig({
      sqliteFile: file,
      development: false,
      viewsDir: dir,
      schemaDir: join(dir, 'schema'),
    })

    // Fresh: installs
    const first = await bootstrapDatabase(prod)
    await first.db.close()

    // Newer code with one more step: production refuses; development applies
    const { connect } = await import('@bunbraco/data')
    const d = await connect({ dialect: 'sqlite', file })
    await d.exec("UPDATE key_value SET value = ? WHERE key = 'Bunbraco.Core.Upgrader.State'", [
      bunbracoPlan.migrations.at(-2)?.to as string,
    ])
    await d.close()
    let failure: unknown
    try {
      const boot = await bootstrapDatabase(prod)
      await boot.db.close()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(UpgradePendingError)
    expect((failure as Error).message).toContain(bunbracoPlan.migrations.at(-1)?.name as string)

    // Wait — that state already has the tables; a real re-run of 003 would fail on them.
    // Point the state back at the final one so the development boot proves the branch only.
    const d2 = await connect({ dialect: 'sqlite', file })
    await d2.exec("UPDATE key_value SET value = ? WHERE key = 'Bunbraco.Core.Upgrader.State'", [
      bunbracoPlan.finalState,
    ])
    await d2.close()
    const dev = await bootstrapDatabase({ ...prod, development: true })
    await dev.db.close()
  })

  test('a SQLite backup is a timestamped copy beside the file; Postgres needs a dump command or a promise', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'output', 'backup-'))
    dirs.push(dir)
    const file = join(dir, 'site.sqlite')
    await Bun.write(file, 'not really a database')
    const sqlite = loadConfig({ sqliteFile: file, dialect: 'sqlite' })
    const copy = await backupBefore(sqlite, { reason: 'test' })
    expect(copy.kind).toBe('sqlite-copy')
    expect(existsSync(copy.path as string)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.test.bak'))).toHaveLength(1)

    const pg = loadConfig({ dialect: 'postgres', pgDump: undefined })
    await expect(backupBefore(pg, { reason: 'test' })).rejects.toBeInstanceOf(BackupRequiredError)
    expect((await backupBefore(pg, { reason: 'test', backupTaken: true })).kind).toBe('operator')
    const dumped = await backupBefore({ ...pg, pgDump: 'true' }, { reason: 'test' })
    expect(dumped.kind).toBe('pg-dump')
    await expect(backupBefore({ ...pg, pgDump: 'false' }, { reason: 'test' })).rejects.toThrow(
      /exited with 1/,
    )
  })
})

describe(`migration 009 (${dialectUnderTest})`, () => {
  test('corrects the rich text editor UI a database was seeded with, and leaves a customised one alone', async () => {
    const d = await db()
    await migrate(d, bunbracoPlan)
    await seedContent(d)
    const RICHTEXT = 'ca90c950-0aff-4e72-b976-a30b1ac57dad'
    const read = async () =>
      (
        await d.query<{ editor_ui_alias: string; config: string }>(
          'SELECT editor_ui_alias, config FROM data_type WHERE node_id = (SELECT id FROM node WHERE unique_id = ?)',
          [RICHTEXT],
        )
      )[0]
    // A fresh seed is already right
    expect((await read())?.editor_ui_alias).toBe('Umb.PropertyEditorUi.Tiptap')

    const rewind = async () => {
      // Before migration 010, too
      await undoMigrationsSinceContentEditing(d)
      await d.exec("UPDATE key_value SET value = ? WHERE key = 'Bunbraco.Core.Upgrader.State'", [
        STATE_MEMBER_PROPERTY_TYPE,
      ])
    }
    // Seeded by an older version: the guessed alias, no configuration
    await d.exec(
      "UPDATE data_type SET editor_ui_alias = 'Umb.PropertyEditorUi.RichText', config = '{}' WHERE node_id = (SELECT id FROM node WHERE unique_id = ?)",
      [RICHTEXT],
    )
    await rewind()
    await migrate(d, bunbracoPlan)
    const fixed = await read()
    expect(fixed?.editor_ui_alias).toBe('Umb.PropertyEditorUi.Tiptap')
    expect(JSON.parse(fixed?.config ?? '{}').toolbar).toBeDefined()

    // A site that chose another UI keeps it
    await d.exec(
      "UPDATE data_type SET editor_ui_alias = 'My.Custom.Editor' WHERE node_id = (SELECT id FROM node WHERE unique_id = ?)",
      [RICHTEXT],
    )
    await rewind()
    await migrate(d, bunbracoPlan)
    expect((await read())?.editor_ui_alias).toBe('My.Custom.Editor')
  })
})
