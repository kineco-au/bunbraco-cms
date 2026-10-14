/**
 * The rules a bundle's tables are held to before anything runs: names, the
 * builder's own limits, expand and contract, and checksums. story 062,
 * docs/bundles.md Part 4. No database: these are properties of the declaration.
 */
import { describe, expect, test } from 'bun:test'
import {
  assertBundleTables,
  type BundleStep,
  bundleIdProblem,
  bundleTablesCompatibility,
  type Column,
  compileBundleTables,
  defineBundleTables,
  indexName,
  physicalTable,
  schemaBuilder,
} from '@crombolo/data'
import { VERSION, validateServerBundles } from '@crombolo/server'
import { stubBundlePackage } from './support/bundles.ts'
import { TASKS_ID, tasksBundle, tasksPackage, tasksV1, tasksV2 } from './support/fixture-bundle.ts'

const problemsOf = (steps: BundleStep[], version?: string, id = 'acme') =>
  compileBundleTables(defineBundleTables(id, steps), version).problems.join('\n')

const table: BundleStep = {
  name: 'things',
  release: '1.0.0',
  up: (s) => s.createTable('thing', { id: s.uuid().primaryKey(), label: s.text().nullable() }),
}

describe('names', () => {
  test('a physical table is bundle_<id>__<table>, with the id’s hyphens as underscores', () => {
    expect(physicalTable('acme-tasks', 'task')).toBe('bundle_acme_tasks__task')
  })

  test('an index name is generated under the prefix, never chosen', () => {
    expect(indexName('acme-tasks', 'task', ['status'])).toMatch(
      /^bundle_acme_tasks__ix_[0-9a-f]{12}$/,
    )
    expect(indexName('acme-tasks', 'task', ['status'])).not.toBe(
      indexName('acme-tasks', 'task', ['due']),
    )
  })

  test('an id may not contain "--" or end with "-", either of which would make the separator ambiguous', () => {
    expect(bundleIdProblem('acme--tasks')).toContain('"--"')
    expect(bundleIdProblem('acme-')).toContain('ends with')
    expect(bundleIdProblem('acme-tasks')).toBeUndefined()
  })

  test('a table or column name is [a-z][a-z0-9_]* without "__"', () => {
    for (const name of [
      'Thing',
      '1thing',
      'thing-a',
      'a__b',
      'ix_thing',
      'transaction',
      '"x"',
      'thing;',
    ])
      expect(
        problemsOf([{ ...table, up: (s) => s.createTable(name, { id: s.uuid().primaryKey() }) }]),
        name,
      ).not.toBe('')
    for (const name of ['and', 'Or', 'a__b'])
      expect(
        problemsOf([
          {
            ...table,
            up: (s) => s.createTable('thing', { id: s.uuid().primaryKey(), [name]: s.text() }),
          },
        ]),
        name,
      ).not.toBe('')
  })

  test('boot refuses a physical name past Postgres’s 63 characters', () => {
    const long = defineBundleTables('a-rather-long-bundle-identifier', [
      { ...table, up: (s) => s.createTable(`t${'x'.repeat(40)}`, { id: s.uuid().primaryKey() }) },
    ])
    const bundle = { ...tasksBundle(), id: 'a-rather-long-bundle-identifier', tables: long }
    const problems = validateServerBundles(
      [bundle],
      [stubBundlePackage('a-rather-long-bundle-identifier')],
      VERSION,
    ).join('\n')
    expect(problems).toContain('past the 63 Postgres keeps')
  })
})

describe('the builder', () => {
  test('a table has exactly one primary key', () => {
    expect(
      problemsOf([{ ...table, up: (s) => s.createTable('thing', { a: s.text(), b: s.text() }) }]),
    ).toContain('0 primary keys')
  })

  test('a column added under live rows must be nullable or defaulted', () => {
    const add = (column: Column<'text', boolean, boolean>): BundleStep => ({
      name: 'add',
      release: '1.1.0',
      up: (s) => s.addColumn('thing', 'extra', column),
    })
    const s = schemaBuilder
    expect(problemsOf([table, add(s.text())])).toContain('neither nullable nor with a default')
    expect(problemsOf([table, add(s.text().nullable())])).toBe('')
    expect(problemsOf([table, add(s.text().default('x'))])).toBe('')
  })

  test('widening only widens', () => {
    const base: BundleStep = {
      name: 'base',
      release: '1.0.0',
      up: (s) =>
        s.createTable('thing', { id: s.uuid().primaryKey(), code: s.varchar(10), n: s.integer() }),
    }
    const widen = (up: BundleStep['up']): BundleStep[] => [
      base,
      { name: 'widen', release: '1.1.0', up },
    ]
    expect(problemsOf(widen((s) => s.widenColumn('thing', 'code', s.varchar(40))))).toBe('')
    expect(problemsOf(widen((s) => s.widenColumn('thing', 'code', s.text())))).toBe('')
    expect(problemsOf(widen((s) => s.widenColumn('thing', 'n', s.bigint())))).toBe('')
    expect(problemsOf(widen((s) => s.widenColumn('thing', 'code', s.varchar(5))))).toContain(
      'not wider',
    )
    expect(problemsOf(widen((s) => s.widenColumn('thing', 'n', s.text())))).toContain('not wider')
  })

  test('a string default may only hold characters DDL can carry as a literal', () => {
    expect(
      problemsOf([
        {
          ...table,
          up: (s) =>
            s.createTable('thing', {
              id: s.uuid().primaryKey(),
              a: s.text().default("x'; DROP TABLE node; --"),
            }),
        },
      ]),
    ).toContain('characters a default may not hold')
  })

  test('a column an index covers is not dropped until the index is', () => {
    const steps: BundleStep[] = [
      {
        ...table,
        up: (s) =>
          s.createTable('thing', { id: s.uuid().primaryKey(), k: s.text().nullable().indexed() }),
      },
      { name: 'drop', release: '2.0.0', up: (s) => s.dropColumn('thing', 'k') },
    ]
    expect(problemsOf(steps)).toContain('drop the index first')
  })
})

describe('expand and contract, per bundle', () => {
  test('the fixture’s two releases pass, read against their own versions', () => {
    expect(() => assertBundleTables(tasksV1, '1.1.0')).not.toThrow()
    expect(() => assertBundleTables(tasksV2, '2.0.0')).not.toThrow()
  })

  test('a contract is refused in a bundle minor', () => {
    const steps: BundleStep[] = [
      table,
      { name: 'drop', release: '1.2.0', up: (s) => s.dropColumn('thing', 'label') },
    ]
    expect(problemsOf(steps)).toContain('a contract may only ship in a major release of the bundle')
  })

  test('a contract may only remove what an earlier release added', () => {
    const steps: BundleStep[] = [
      { ...table, release: '2.0.0' },
      { name: 'drop', release: '2.0.0', up: (s) => s.dropColumn('thing', 'label') },
    ]
    expect(problemsOf(steps)).toContain('may only remove what an earlier release added')
  })

  test('a step is an expand or a contract, never both', () => {
    const steps: BundleStep[] = [
      table,
      {
        name: 'both',
        release: '2.0.0',
        up: (s) => [
          s.dropColumn('thing', 'label'),
          s.addColumn('thing', 'other', s.text().nullable()),
        ],
      },
    ]
    expect(problemsOf(steps)).toContain('both adds and removes')
  })

  test('no step claims a release later than the bundle’s own version', () => {
    expect(problemsOf([{ ...table, release: '1.4.0' }], '1.3.0')).toContain(
      'later than this release of the bundle',
    )
  })

  test('the compatibility a bundle declares is derived from its plan', () => {
    expect(bundleTablesCompatibility(tasksV2, '2.0.0')).toBe('breaking')
    expect(bundleTablesCompatibility(tasksV2, '1.1.0')).toBe('compatible')
    expect(bundleTablesCompatibility(tasksV1, '1.1.0')).toBe('compatible')
  })

  test('boot reads the lint against the package’s version, not core’s', () => {
    // 2.0.0's contract wired under a 1.1.0 package claims a release that does not exist.
    const problems = validateServerBundles([tasksBundle(tasksV2)], [tasksPackage('1.1.0')], VERSION)
    expect(problems.join('\n')).toContain('later than this release of the bundle (1.1.0)')
    expect(validateServerBundles([tasksBundle(tasksV2)], [tasksPackage('2.0.0')], VERSION)).toEqual(
      [],
    )
  })

  test('the package must declare the compatibility its tables give it', () => {
    const wrong = {
      ...tasksPackage('2.0.0'),
      field: { ...tasksPackage('2.0.0').field, migrations: 'compatible' as const },
    }
    expect(validateServerBundles([tasksBundle(tasksV2)], [wrong], VERSION).join('\n')).toContain(
      'its tables make 2.0.0 "breaking"',
    )
    const missing = { ...tasksPackage('1.1.0'), field: { id: TASKS_ID, server: 'tasks' } }
    expect(validateServerBundles([tasksBundle()], [missing], VERSION).join('\n')).toContain(
      '"crombolo.migrations": null',
    )
  })

  test('the tables capability needs tables, and tables live under the bundle’s own id', () => {
    const noTables = { ...tasksBundle(), tables: undefined }
    expect(
      validateServerBundles([noTables], [tasksPackage('1.1.0')], VERSION).join('\n'),
    ).toContain('declares no tables of its own')
    const elsewhere = { ...tasksBundle(), tables: defineBundleTables('other', [table]) }
    expect(
      validateServerBundles([elsewhere], [tasksPackage('1.1.0')], VERSION).join('\n'),
    ).toContain('under its own id')
  })
})

describe('checksums and states', () => {
  test('a step’s state is derived from its position and name', () => {
    const compiled = compileBundleTables(tasksV2)
    expect(compiled.steps.map((step) => step.to)).toEqual([
      `bundle:${TASKS_ID}:1:tasks`,
      `bundle:${TASKS_ID}:2:task-priority`,
      `bundle:${TASKS_ID}:3:drop-legacy`,
    ])
    expect(compiled.stateKey).toBe(`Crombolo.Bundle.${TASKS_ID}.State`)
  })

  test('a checksum hashes the operations, so an edit changes it and a re-declaration does not', () => {
    const once = compileBundleTables(tasksV1).steps[0]?.checksum
    const again = compileBundleTables(defineBundleTables(TASKS_ID, [...tasksV1.steps])).steps[0]
      ?.checksum
    const edited = compileBundleTables(
      defineBundleTables(TASKS_ID, [
        {
          ...(tasksV1.steps[0] as BundleStep),
          up: (s) => s.createTable('task', { id: s.uuid().primaryKey() }),
        },
      ]),
    ).steps[0]?.checksum
    expect(once).toMatch(/^[0-9a-f]{64}$/)
    expect(again).toBe(once)
    expect(edited).not.toBe(once)
  })
})
