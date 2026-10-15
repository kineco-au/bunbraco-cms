import { beforeAll, describe, expect, test } from 'bun:test'
import {
  type Db,
  dialectFor,
  INITIAL_STATE,
  Locks,
  type Migration,
  MigrationPlan,
  MigrationStepError,
  migrate,
  postgresDialect,
  readLedger,
  readState,
  sqliteDialect,
  stampFinalState,
} from '@crombolo/data'
import { canConnect, dialectUnderTest, freshDb } from './support/db.ts'

const STATE_1 = '{11111111-1111-1111-1111-111111111111}'
const STATE_2 = '{22222222-2222-2222-2222-222222222222}'

function testPlan(): MigrationPlan {
  const createNode: Migration = {
    from: INITIAL_STATE,
    to: STATE_1,
    name: 'CreateNode',
    async up(db: Db) {
      const t = db.dialect.types
      await db.exec(
        `CREATE TABLE node (
           id ${t.identity},
           unique_id ${t.uuid} NOT NULL UNIQUE,
           parent_id ${t.integer},
           level ${t.integer},
           path ${t.text},
           sort_order ${t.integer},
           trashed ${t.boolean} NOT NULL,
           text ${t.textCi},
           node_object_type ${t.uuid}
         )`,
      )
    },
  }
  const addIndex: Migration = {
    from: STATE_1,
    to: STATE_2,
    name: 'AddNodePathIndex',
    async up(db: Db) {
      await db.exec('CREATE INDEX ix_node_path ON node (path)')
    },
  }
  return new MigrationPlan([createNode, addIndex])
}

describe('dialects', () => {
  test('sqlite renders ? placeholders unchanged', () => {
    expect(sqliteDialect.render('SELECT * FROM node WHERE id = ? AND path = ?')).toBe(
      'SELECT * FROM node WHERE id = ? AND path = ?',
    )
  })

  test('postgres renumbers ? placeholders positionally', () => {
    expect(postgresDialect.render('SELECT * FROM node WHERE id = ? AND path = ?')).toBe(
      'SELECT * FROM node WHERE id = $1 AND path = $2',
    )
  })

  test('both make text comparison case-insensitive, as Umbraco assumes', () => {
    // Umbraco compares aliases, logins and emails case-insensitively everywhere.
    expect(sqliteDialect.types.textCi).toContain('NOCASE')
    expect(postgresDialect.types.textCi).toBe('CITEXT')
  })

  test('neither stores decimals in a lossy float', () => {
    expect(sqliteDialect.types.numeric).toBe('TEXT')
    expect(postgresDialect.types.numeric).toBe('NUMERIC')
  })

  test('dialectFor resolves by name', () => {
    expect(dialectFor('sqlite').name).toBe('sqlite')
    expect(dialectFor('postgres').name).toBe('postgres')
  })
})

describe('migration plan', () => {
  test('rejects a chain with a gap', () => {
    expect(
      () => new MigrationPlan([{ from: STATE_1, to: STATE_2, name: 'Orphan', up: async () => {} }]),
    ).toThrow(/expects state/)
  })

  test('reports the final state of the chain', () => {
    expect(testPlan().finalState).toBe(STATE_2)
    expect(new MigrationPlan([]).finalState).toBe(INITIAL_STATE)
  })
})

describe(`database (${dialectUnderTest})`, () => {
  let available = true
  beforeAll(async () => {
    available = await canConnect()
    if (!available) {
      console.warn(`skipping ${dialectUnderTest} tests: no reachable server`)
    }
  })

  test('starts at the initial state and walks the plan forward', async () => {
    if (!available) return
    const db = await freshDb()
    try {
      expect(await readState(db)).toBe(INITIAL_STATE)
      const result = await migrate(db, testPlan())
      expect(result.from).toBe(INITIAL_STATE)
      expect(result.to).toBe(STATE_2)
      expect(result.applied).toEqual(['CreateNode', 'AddNodePathIndex'])
      expect(await readState(db)).toBe(STATE_2)
    } finally {
      await db.close()
    }
  })

  test('is idempotent — a second run applies nothing', async () => {
    if (!available) return
    const db = await freshDb()
    try {
      await migrate(db, testPlan())
      const second = await migrate(db, testPlan())
      expect(second.applied).toEqual([])
      expect(second.to).toBe(STATE_2)
    } finally {
      await db.close()
    }
  })

  test('a fresh install stamps the final state so nothing then runs', async () => {
    if (!available) return
    const db = await freshDb()
    try {
      const plan = testPlan()
      await stampFinalState(db, plan)
      expect(await readState(db)).toBe(plan.finalState)
      expect((await migrate(db, plan)).applied).toEqual([])
    } finally {
      await db.close()
    }
  })

  test('the migrated schema round-trips a row', async () => {
    if (!available) return
    const db = await freshDb()
    try {
      await migrate(db, testPlan())
      const uuid = crypto.randomUUID()
      await db.exec(
        'INSERT INTO node (unique_id, parent_id, level, path, sort_order, trashed, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid, -1, 1, '-1,1060', 0, db.dialect.boolValue(false), 'Home'],
      )
      const rows = await db.query<{ text: string; path: string }>(
        'SELECT text, path FROM node WHERE unique_id = ?',
        [uuid],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.text).toBe('Home')
      expect(rows[0]?.path).toBe('-1,1060')
    } finally {
      await db.close()
    }
  })

  test('rolls a failed migration step back', async () => {
    if (!available) return
    const db = await freshDb()
    try {
      const plan = new MigrationPlan([
        {
          from: INITIAL_STATE,
          to: STATE_1,
          name: 'Exploding',
          async up(tx) {
            await tx.exec(`CREATE TABLE half_done (id ${tx.dialect.types.integer})`)
            throw new Error('boom')
          },
        },
      ])
      await expect(migrate(db, plan)).rejects.toThrow('boom')
      expect(await readState(db)).toBe(INITIAL_STATE)
      await expect(db.query('SELECT * FROM half_done')).rejects.toThrow()
    } finally {
      await db.close()
    }
  })

  test('a failed step names itself, keeps the steps before it, and the next run resumes there', async () => {
    if (!available) return
    const db = await freshDb()
    try {
      let broken = true
      const plan = () =>
        new MigrationPlan([
          {
            from: INITIAL_STATE,
            to: STATE_1,
            name: 'First',
            async up(tx) {
              await tx.exec(`CREATE TABLE first_done (id ${tx.dialect.types.integer})`)
            },
          },
          {
            from: STATE_1,
            to: STATE_2,
            name: 'Second',
            async up(tx) {
              if (broken) throw new Error('the disk is full')
              await tx.exec(`CREATE TABLE second_done (id ${tx.dialect.types.integer})`)
            },
          },
        ])
      const failure = await migrate(db, plan()).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(MigrationStepError)
      expect((failure as Error).message).toBe(
        'The upgrade stopped at step Second: the disk is full. Nothing from that step was kept; ' +
          'the 1 step(s) before it are applied. Fix the cause and run the upgrade again: it carries on from this step.',
      )
      expect(await readState(db)).toBe(STATE_1)
      expect((await readLedger(db)).map((row) => row.name)).toContain('First')

      broken = false
      const resumed = await migrate(db, plan())
      expect(resumed.applied).toEqual(['Second'])
      expect(await readState(db)).toBe(STATE_2)
    } finally {
      await db.close()
    }
  })

  test('the lock is re-entrant within one chain, and only while it is held', async () => {
    if (!available) return
    const db = await freshDb()
    try {
      const order: string[] = []
      let resume!: () => void
      const resumed = new Promise<void>((resolve) => {
        resume = resolve
      })
      let leftBehind: Promise<void> | undefined
      await db.locks.withLock(Locks.Schema, async () => {
        await db.locks.withLock(Locks.Schema, async () => {
          order.push('nested')
        })
        leftBehind = resumed.then(() =>
          db.locks.withLock(Locks.Schema, async () => {
            order.push('left behind')
          }),
        )
      })
      // Work the holder started runs after it released: it queues like anyone else.
      await db.locks.withLock(Locks.Schema, async () => {
        resume()
        await Bun.sleep(20)
        order.push('next holder')
      })
      await leftBehind
      expect(order).toEqual(['nested', 'next holder', 'left behind'])
    } finally {
      await db.close()
    }
  })

  test('the lock abstraction serialises concurrent writers', async () => {
    if (!available) return
    const db = await freshDb()
    try {
      const order: string[] = []
      const critical = (label: string) =>
        db.locks.withLock(Locks.ContentTree, async () => {
          order.push(`${label}:enter`)
          await Bun.sleep(10)
          order.push(`${label}:exit`)
        })
      await Promise.all([critical('a'), critical('b')])
      // Interleaving would produce a:enter,b:enter,...; serialised does not. Which
      // of the two wins the lock is a race, so both orders are correct.
      expect(['a:enter,a:exit,b:enter,b:exit', 'b:enter,b:exit,a:enter,a:exit']).toContain(
        order.join(','),
      )
    } finally {
      await db.close()
    }
  })
})
