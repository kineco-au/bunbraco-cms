/**
 * Tables a bundle owns, against a real database: its chain, its ledger, the
 * capability over its tables, the guards that keep the capability inside them,
 * and the guarantee that core's own upgrades never touch them. story 062,
 * docs/bundles.md Part 4. Run under both dialects.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyBundleStepsUnledgered,
  type BundleStep,
  BundleStepEditedError,
  bundlePlan,
  bundleTablesIn,
  compileBundleTables,
  connect,
  createTablesCapability,
  cromboloPlan,
  type Db,
  defineBundleTables,
  MigrationPlan,
  migrate,
  objectsNamed,
  pendingMigrations,
  planUpgrade,
  purgeBundleTables,
  readLedger,
  readState,
  UpgradeStateError,
} from '@crombolo/data'
import {
  attachDatabase,
  backupBefore,
  bootstrapDatabase,
  bundleChains,
  loadConfig,
  UpgradePendingError,
} from '@crombolo/server'
import { canConnect, dialectUnderTest, freshDb } from './support/db.ts'
import { TASKS_ID, tasksBundle, tasksPackage, tasksV1, tasksV2 } from './support/fixture-bundle.ts'

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

beforeAll(async () => {
  if (!(await canConnect())) throw new Error(`cannot connect to ${dialectUnderTest}`)
})

async function db(): Promise<Db> {
  const d = await freshDb()
  open.push(d)
  return d
}

const compiledV1 = compileBundleTables(tasksV1, '1.1.0')
const compiledV2 = compileBundleTables(tasksV2, '2.0.0')
const planV1 = () => bundlePlan(compiledV1)
const planV2 = () => bundlePlan(compiledV2)

/** A database with core installed and the fixture at 1.x. */
async function installed(): Promise<Db> {
  const d = await db()
  await migrate(d, cromboloPlan)
  await migrate(d, planV1())
  return d
}

const KEY = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe(`the chain (${dialectUnderTest})`, () => {
  test('applies after core, ledgered against the bundle, with each step’s checksum', async () => {
    const d = await installed()
    const ledger = await readLedger(d)
    const core = ledger.filter((row) => row.bundle === null)
    const bundle = ledger.filter((row) => row.bundle === TASKS_ID)
    expect(core).toHaveLength(cromboloPlan.migrations.length)
    expect(bundle.map((row) => [row.name, row.kind, row.checksum])).toEqual(
      compiledV1.steps.map((step) => [step.name, 'expand', step.checksum]),
    )
    // Core's own rows are what they always were.
    expect(core.every((row) => row.checksum === row.name)).toBe(true)
    expect(await readState(d, planV1())).toBe(planV1().finalState)
    expect(await bundleTablesIn(d, TASKS_ID)).toEqual(['bundle_acme_tasks__task'])
  })

  test('the plan shows each step’s statements, and a backfill as unplannable', async () => {
    const d = await db()
    await migrate(d, cromboloPlan)
    const steps = await planUpgrade(d, planV1())
    expect(steps[0]?.statements?.[0]).toContain('CREATE TABLE "bundle_acme_tasks__task"')
    expect(steps[0]?.unplannable).toBeUndefined()
    expect(steps[1]?.statements?.some((sql) => sql.includes('ADD COLUMN "priority"'))).toBe(true)
    expect(steps[1]?.unplannable).toContain('backfills data')
    expect(await bundleTablesIn(d, TASKS_ID)).toEqual([])
  })

  test('a backfill runs in its step, over the tables as that step leaves them', async () => {
    const d = await db()
    await migrate(d, cromboloPlan)
    const first = new MigrationPlan(planV1().migrations.slice(0, 1), {
      stateKey: compiledV1.stateKey,
      initialState: compiledV1.initialState,
      bundle: TASKS_ID,
    })
    await migrate(d, first)
    const early = createTablesCapability(d, compiledV1.steps[0]?.after as never)
    await (early as never as { task: { insert(rows: unknown[]): Promise<void> } }).task.insert([
      { id: KEY(1), node_key: KEY(10), status: 'urgent' },
      { id: KEY(2), node_key: KEY(10) },
    ])
    await migrate(d, planV1())
    const tables = createTablesCapability<NonNullable<(typeof tasksV1)['__shape']>>(
      d,
      compiledV1.schema,
    )
    const rows = await tables.task.select({ orderBy: { id: 'asc' } })
    expect(rows.map((row) => row.priority)).toEqual([9, 0])
  })

  test('upgrades across the bundle’s major, ledgering the contract', async () => {
    const d = await installed()
    await migrate(d, planV2())
    const kinds = (await readLedger(d))
      .filter((row) => row.bundle === TASKS_ID)
      .map((row) => row.kind)
    expect(kinds).toEqual(['expand', 'expand', 'contract'])
    const tables = createTablesCapability<NonNullable<(typeof tasksV2)['__shape']>>(
      d,
      compiledV2.schema,
    )
    await tables.task.insert({ id: KEY(3), node_key: KEY(10) })
    expect(Object.keys((await tables.task.select())[0] ?? {})).not.toContain('legacy')
  })

  test('a step edited after it shipped is refused, by name', async () => {
    const d = await installed()
    // The same table with one column more: harmless-looking, and not what ran here.
    const shipped = tasksV1.steps[0] as BundleStep
    const edited = defineBundleTables(TASKS_ID, [
      {
        ...shipped,
        up: (s) => {
          const op = shipped.up(s) as { columns: Record<string, unknown> }
          return { ...op, columns: { ...op.columns, extra: s.text().nullable().spec } } as never
        },
      },
      ...tasksV1.steps.slice(1),
      {
        name: 'later',
        release: '1.2.0',
        up: (s) => s.addColumn('task', 'note', s.text().nullable()),
      },
    ])
    const error = await migrate(d, bundlePlan(compileBundleTables(edited))).catch((e) => e)
    expect(error).toBeInstanceOf(BundleStepEditedError)
    expect((error as Error).message).toContain('"tasks"')
  })

  test('a database ahead of the bundle’s code is refused, naming the bundle and both states', async () => {
    const d = await installed()
    await migrate(d, planV2())
    const error = await pendingMigrations(d, planV1()).catch((e) => e)
    expect(error).toBeInstanceOf(UpgradeStateError)
    expect((error as Error).message).toContain(`"${TASKS_ID}"`)
    expect((error as Error).message).toContain(planV2().finalState)
    expect((error as Error).message).toContain(planV1().finalState)
  })
})

describe(`the tables capability (${dialectUnderTest})`, () => {
  const capability = (d: Db) =>
    createTablesCapability<NonNullable<(typeof tasksV1)['__shape']>>(d, compiledV1.schema)

  test('selects with equality, in, comparisons, null tests, and/or, order and limit', async () => {
    const d = await installed()
    const t = capability(d).task
    const soon = new Date('2026-10-20T00:00:00.000Z')
    const later = new Date('2026-12-01T00:00:00.000Z')
    await t.insert([
      { id: KEY(1), node_key: KEY(10), status: 'open', due: soon, assignee: KEY(99) },
      { id: KEY(2), node_key: KEY(10), status: 'open', due: later },
      { id: KEY(3), node_key: KEY(11), status: 'done', done: true, detail: { tags: ['a'], n: 1 } },
    ])
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id)
    expect(ids(await t.select({ where: { status: 'open' }, orderBy: { due: 'asc' } }))).toEqual([
      KEY(1),
      KEY(2),
    ])
    expect(ids(await t.select({ where: { status: 'open', due: { lt: later } } }))).toEqual([KEY(1)])
    expect(
      ids(await t.select({ where: { id: { in: [KEY(2), KEY(3)] } }, orderBy: { id: 'asc' } })),
    ).toEqual([KEY(2), KEY(3)])
    expect(ids(await t.select({ where: { assignee: null }, orderBy: { id: 'asc' } }))).toEqual([
      KEY(2),
      KEY(3),
    ])
    expect(ids(await t.select({ where: { assignee: { notNull: true } } }))).toEqual([KEY(1)])
    expect(
      ids(
        await t.select({
          where: { or: [{ status: 'done' }, { due: { gte: later } }] },
          orderBy: { id: 'desc' },
        }),
      ),
    ).toEqual([KEY(3), KEY(2)])
    expect(await t.select({ limit: 1, offset: 2, orderBy: { id: 'asc' } })).toHaveLength(1)
    expect(await t.count({ where: { node_key: KEY(10) } })).toBe(2)

    const done = (await t.select({ where: { id: KEY(3) } }))[0]
    expect(done?.done).toBe(true)
    expect(done?.detail).toEqual({ tags: ['a'], n: 1 })
    expect((await t.select({ where: { id: KEY(1) } }))[0]?.due?.toISOString()).toBe(
      soon.toISOString(),
    )
  })

  test('update and delete need a where; an unfiltered write is truncate', async () => {
    const d = await installed()
    const t = capability(d).task
    await t.insert([
      { id: KEY(1), node_key: KEY(10) },
      { id: KEY(2), node_key: KEY(10) },
    ])
    await expect(t.update({ set: { status: 'x' } } as never)).rejects.toThrow(/needs a "where"/)
    await expect(t.delete({} as never)).rejects.toThrow(/needs a "where"/)
    await t.update({ where: { id: KEY(1) }, set: { status: 'done' } })
    expect((await t.select({ where: { status: 'done' } })).map((row) => row.id)).toEqual([KEY(1)])
    await t.delete({ where: { id: KEY(1) } })
    expect(await t.count()).toBe(1)
    await t.truncate()
    expect(await t.count()).toBe(0)
  })

  test('a transaction commits together, or not at all', async () => {
    const d = await installed()
    const tables = capability(d)
    await tables.transaction(async (t) => {
      await t.task.insert({ id: KEY(1), node_key: KEY(10) })
      await t.task.update({ where: { id: KEY(1) }, set: { status: 'done' } })
    })
    await expect(
      tables.transaction(async (t) => {
        await t.task.insert({ id: KEY(2), node_key: KEY(10) })
        throw new Error('changed my mind')
      }),
    ).rejects.toThrow('changed my mind')
    expect((await tables.task.select()).map((row) => [row.id, row.status])).toEqual([
      [KEY(1), 'done'],
    ])
  })

  test('refuses a row that does not fit, before it reaches the database', async () => {
    const d = await installed()
    const t = capability(d).task
    await expect(t.insert({ node_key: KEY(10) } as never)).rejects.toThrow(/needs "id"/)
    await expect(t.insert({ id: 'not-a-key', node_key: KEY(10) })).rejects.toThrow(/takes a uuid/)
    await expect(
      t.insert({ id: KEY(1), node_key: KEY(10), status: 'x'.repeat(33) }),
    ).rejects.toThrow(/at most 32/)
    await expect(t.insert({ id: KEY(1), node_key: KEY(10), done: 'yes' as never })).rejects.toThrow(
      /true or false/,
    )
  })
})

describe(`guards (${dialectUnderTest})`, () => {
  /** A connection that records every statement the capability sends, then sends it. */
  function spied(d: Db, statements: string[]): Db {
    const wrap = (inner: Db): Db => ({
      dialect: inner.dialect,
      locks: inner.locks,
      query: (sql, params) => {
        statements.push(sql)
        return inner.query(sql, params)
      },
      exec: (sql, params) => {
        statements.push(sql)
        return inner.exec(sql, params)
      },
      transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
      close: () => inner.close(),
    })
    return wrap(d)
  }

  test('no Db is reachable from the capability, a table or a transaction', async () => {
    const d = await installed()
    const seen = new Set<unknown>()
    const reachable = (value: unknown, depth = 0): unknown[] => {
      if (
        !value ||
        (typeof value !== 'object' && typeof value !== 'function') ||
        seen.has(value) ||
        depth > 4
      )
        return []
      seen.add(value)
      const found: unknown[] = [value]
      for (
        let o: object | null = value as object;
        o && o !== Object.prototype && o !== Function.prototype;
        o = Object.getPrototypeOf(o)
      )
        for (const key of Reflect.ownKeys(o)) {
          const descriptor = Object.getOwnPropertyDescriptor(o, key)
          found.push(...reachable(descriptor?.value, depth + 1))
        }
      return found
    }
    const tables = createTablesCapability(d, compiledV1.schema)
    let inTransaction: unknown[] = []
    await tables.transaction(async (t) => {
      inTransaction = reachable(t)
    })
    for (const value of [...reachable(tables), ...inTransaction]) {
      expect(value === d).toBe(false)
      for (const member of ['query', 'exec', 'raw', 'dialect', 'locks', 'close'])
        expect(Object.hasOwn(value as object, member), member).toBe(false)
    }
    expect(Object.isFrozen(tables)).toBe(true)
    expect(Object.isFrozen(tables.task)).toBe(true)
    expect(Object.getPrototypeOf(tables.task)).toBeNull()
  })

  test('hostile names, keys and nesting are refused, or bound as values, never written as identifiers', async () => {
    const d = await installed()
    const statements: string[] = []
    const tables = createTablesCapability(
      spied(d, statements),
      compiledV1.schema,
    ) as unknown as Record<
      string,
      { select(q?: unknown): Promise<unknown[]>; update(q: unknown): Promise<void> }
    >
    // Another bundle's tables, core's, and look-alikes are simply not members.
    for (const name of [
      'bundle_other__task',
      'other__task',
      'node',
      'umbraco_user',
      'key_value',
      'migration_history',
      'tаsk', // a Cyrillic а
      '"task"',
      'task; DROP TABLE node',
    ])
      expect(tables[name], name).toBeUndefined()

    const task = tables.task as (typeof tables)[string]
    const refusedColumns = [
      'node',
      '"status"',
      'status"; DROP TABLE node; --',
      'status /* x */',
      'stаtus',
      'umbraco_user.id',
    ]
    for (const column of refusedColumns) {
      await expect(task.select({ where: { [column]: 'x' } }), column).rejects.toThrow(
        /has no column/,
      )
      await expect(task.select({ orderBy: { [column]: 'asc' } }), column).rejects.toThrow(
        /has no column/,
      )
      await expect(
        task.update({ where: { id: KEY(1) }, set: { [column]: 'x' } }),
        column,
      ).rejects.toThrow(/has no column/)
    }
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
      const where = JSON.parse(`{"${key}": "x"}`)
      await expect(task.select({ where }), key).rejects.toThrow(/has no column/)
      await expect(
        task.update({ where: { id: KEY(1) }, set: JSON.parse(`{"${key}": 1}`) }),
        key,
      ).rejects.toThrow(/has no column/)
    }
    let deep: Record<string, unknown> = { status: 'open' }
    for (let i = 0; i < 12; i++) deep = { and: [deep] }
    await expect(task.select({ where: deep })).rejects.toThrow(/nested more than/)

    // A hostile *value* is only ever a bound parameter.
    const value = `x'); DROP TABLE "node"; --`
    expect(await task.select({ where: { status: value } })).toEqual([])
    for (const sql of statements) {
      expect(sql).not.toContain('DROP')
      for (const name of objectsNamed(TASKS_ID, sql))
        expect(name.startsWith('bundle_acme_tasks__')).toBe(true)
    }
  })

  test('any filter at all is refused or reaches only this bundle’s table, as the guard sees it', async () => {
    const d = await installed()
    const statements: string[] = []
    const t = (
      createTablesCapability(spied(d, statements), compiledV1.schema) as unknown as Record<
        string,
        { select(q?: unknown): Promise<unknown[]>; count(q?: unknown): Promise<number> }
      >
    ).task as { select(q?: unknown): Promise<unknown[]>; count(q?: unknown): Promise<number> }
    // A seeded generator, so a failure reproduces.
    let seed = 0x062062
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
    const keys = [
      'id',
      'status',
      'due',
      'done',
      'detail',
      'assignee',
      'priority',
      'and',
      'or',
      'node',
      '__proto__',
      'constructor',
      'x"y',
      'STATUS',
      '',
      'status;',
      'tаsk',
    ]
    const values = (): unknown =>
      pick([
        'open',
        KEY(1),
        3,
        -1,
        2.5,
        true,
        null,
        new Date(0),
        [],
        ['a'],
        { in: [KEY(1)] },
        { lt: 5 },
        { isNull: true },
        { notNull: false },
        { eq: 'x' },
        { nope: 1 },
        { in: [] },
        "'; DROP TABLE node; --",
        { gte: new Date(0) },
        Number.NaN,
        undefined,
        { lt: { lt: 1 } },
      ])
    const filter = (depth: number): unknown => {
      const out: Record<string, unknown> = {}
      const n = Math.floor(random() * 3)
      for (let i = 0; i < n; i++) {
        const key = pick(keys)
        out[key] =
          (key === 'and' || key === 'or') && depth < 10
            ? Array.from({ length: 1 + Math.floor(random() * 2) }, () => filter(depth + 1))
            : values()
      }
      return random() < 0.05 ? pick([null, 'x', [out], 7]) : out
    }
    let refused = 0
    let ran = 0
    for (let i = 0; i < 400; i++) {
      try {
        await (i % 2 ? t.count({ where: filter(0) }) : t.select({ where: filter(0), limit: 5 }))
        ran++
      } catch (error) {
        // Refused before SQL, or by the database over a bound value — never anything else.
        expect((error as Error).message).toMatch(
          /Bundle "acme-tasks"|invalid input|operator does not exist/,
        )
        refused++
      }
    }
    expect(ran).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
    for (const sql of statements)
      for (const name of objectsNamed(TASKS_ID, sql)) expect(name).toBe('bundle_acme_tasks__task')
  })
})

describe(`the core-upgrade guarantee (${dialectUnderTest})`, () => {
  /** The fixture's rows and columns, exactly as the database holds them. */
  const snapshot = async (d: Db) => {
    const rows = await d.query(`SELECT * FROM "bundle_acme_tasks__task" ORDER BY id`)
    return rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])),
    )
  }

  test('installed at core’s first state, its tables and data survive the whole core plan', async () => {
    const d = await db()
    await migrate(d, new MigrationPlan(cromboloPlan.migrations.slice(0, 1)))
    await applyBundleStepsUnledgered(d, compiledV2)
    await d.exec(
      `INSERT INTO "bundle_acme_tasks__task" (id, node_key, status, priority) VALUES (?, ?, 'open', 3)`,
      [KEY(1), KEY(10)],
    )
    const before = await snapshot(d)
    await migrate(d, cromboloPlan)
    expect(await readState(d)).toBe(cromboloPlan.finalState)
    expect(await snapshot(d)).toEqual(before)
    expect(await bundleTablesIn(d, TASKS_ID)).toEqual(['bundle_acme_tasks__task'])
  })

  test('installed at core’s final state, it upgrades across its own minor and major', async () => {
    const d = await installed()
    await createTablesCapability(d, compiledV1.schema).task?.insert({
      id: KEY(1),
      node_key: KEY(10),
    })
    await migrate(d, planV2())
    expect(await createTablesCapability(d, compiledV2.schema).task?.count()).toBe(1)
    expect(await pendingMigrations(d, cromboloPlan)).toEqual([])
  })

  test('core reserves the bundle_ prefix: no core migration names a bundle_ table', async () => {
    const d = await db()
    const steps = await planUpgrade(d, cromboloPlan)
    const offending: string[] = []
    const positions =
      /\b(?:TABLE|INTO|FROM|UPDATE|JOIN|ON|REFERENCES|INDEX)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?(bundle_\w*)/gi
    for (const step of steps)
      for (const sql of step.statements ?? [])
        for (const match of sql.matchAll(positions)) offending.push(`${step.name}: ${match[1]}`)
    expect(steps.every((step) => step.statements !== undefined)).toBe(true)
    expect(offending).toEqual([])
  })
})

describe(`purge (${dialectUnderTest})`, () => {
  test('drops exactly the bundle’s tables, clears its state, and a re-add starts afresh', async () => {
    const d = await installed()
    const other = compileBundleTables(
      defineBundleTables('acme', [
        {
          name: 'one',
          release: '1.0.0',
          up: (s) => s.createTable('task', { id: s.uuid().primaryKey() }),
        },
      ]),
    )
    await migrate(d, bundlePlan(other))
    const dropped = await purgeBundleTables(d, TASKS_ID, { stateKey: compiledV1.stateKey })
    expect(dropped).toEqual(['bundle_acme_tasks__task'])
    expect(await bundleTablesIn(d, TASKS_ID)).toEqual([])
    expect(await bundleTablesIn(d, 'acme')).toEqual(['bundle_acme__task'])
    expect(await pendingMigrations(d, cromboloPlan)).toEqual([])
    expect(await readState(d, planV1())).toBe(compiledV1.initialState)
    const ledger = (await readLedger(d)).filter((row) => row.bundle === TASKS_ID)
    expect(ledger.at(-1)?.kind).toBe('purge')

    // A purge starts the chain again: the rows before it are history, not a checksum to match.
    await migrate(d, planV2())
    expect(await bundleTablesIn(d, TASKS_ID)).toEqual(['bundle_acme_tasks__task'])
  })

  test('taking a bundle out of the wiring leaves its tables, and putting it back resumes', async () => {
    const d = await installed()
    // Unwired: nothing touches the tables. Rewired at 2.0.0: it resumes from its recorded state.
    expect(await bundleTablesIn(d, TASKS_ID)).toEqual(['bundle_acme_tasks__task'])
    const result = await migrate(d, planV2())
    expect(result.applied).toEqual(['drop-legacy'])
  })
})

describe('boot and backup (sqlite)', () => {
  const site = () => {
    const dir = mkdtempSync(join(process.cwd(), 'output', 'bundle-boot-'))
    dirs.push(dir)
    return loadConfig({
      sqliteFile: join(dir, 'site.sqlite'),
      development: false,
      componentsDir: dir,
      schemaDir: join(dir, 'schema'),
      dialect: 'sqlite',
    })
  }
  const v1 = () => bundleChains([tasksBundle(tasksV1)], [tasksPackage('1.1.0')])
  const v2 = () => bundleChains([tasksBundle(tasksV2)], [tasksPackage('2.0.0')])

  test('production refuses while a bundle step is pending; development applies it', async () => {
    if (dialectUnderTest !== 'sqlite') return
    const config = site()
    const first = await bootstrapDatabase(config, v1())
    await first.db.close()

    const failure = await bootstrapDatabase(config, v2()).catch((error) => error)
    expect(failure).toBeInstanceOf(UpgradePendingError)
    expect((failure as Error).message).toContain(`"${TASKS_ID}"`)
    expect((failure as Error).message).toContain('drop-legacy')

    // A web node neither applies a bundle's steps nor checks them.
    const web = await attachDatabase(config)
    await web.db.close()

    const dev = await bootstrapDatabase({ ...config, development: true }, v2())
    expect((await readLedger(dev.db)).at(-1)?.name).toBe('drop-legacy')
    await dev.db.close()

    // And code behind the database is refused, naming both states.
    const behind = await bootstrapDatabase({ ...config, development: true }, v1()).catch((e) => e)
    expect(behind).toBeInstanceOf(UpgradeStateError)
    expect((behind as Error).message).toContain(TASKS_ID)
  })

  test('the pre-upgrade backup holds the bundle’s tables, because they are in the same database', async () => {
    if (dialectUnderTest !== 'sqlite') return
    const config = site()
    const boot = await bootstrapDatabase(config, v1())
    await createTablesCapability(boot.db, compiledV1.schema).task?.insert({
      id: KEY(1),
      node_key: KEY(10),
    })
    await boot.db.close()
    const backup = await backupBefore(config, { reason: 'upgrade' })
    expect(existsSync(backup.path as string)).toBe(true)
    const copy = await connect({ dialect: 'sqlite', file: backup.path as string })
    open.push(copy)
    expect(await createTablesCapability(copy, compiledV1.schema).task?.count()).toBe(1)
  })
})
