/**
 * Story 120: on Postgres a cache instruction wakes every node's poller as it is
 * committed, rather than on the next tick; the timer stays as the fallback, and
 * SQLite polls exactly as before.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendCacheInstruction,
  CACHE_INSTRUCTION_CHANNEL,
  type CacheInstructionKind,
  connect,
  cromboloPlan,
  currentSchemaState,
  type Db,
  migrate,
} from '@crombolo/data'
import { CacheInstructionPoller } from '@crombolo/server'
import { dialectUnderTest, freshDb } from './support/db.ts'

const open: Db[] = []
const pollers: CacheInstructionPoller[] = []
afterEach(async () => {
  while (pollers.length > 0) pollers.pop()?.stop()
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
})

async function installed(): Promise<Db> {
  const db = await freshDb()
  open.push(db)
  await migrate(db, cromboloPlan)
  return db
}

/** The database as given, with a listener of our own and every statement counted. */
function observed(db: Db) {
  const statements: string[] = []
  const subscribers = new Map<string, (payload: string) => void>()
  let unlistened = 0
  const wrapped: Db = {
    dialect: db.dialect,
    locks: db.locks,
    query: (sql, params) => {
      statements.push(sql)
      return db.query(sql, params)
    },
    exec: (sql, params) => {
      statements.push(sql)
      return db.exec(sql, params)
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
    listen: async (channel, onNotify) => {
      subscribers.set(channel, onNotify)
      return async () => {
        unlistened += 1
        subscribers.delete(channel)
      }
    },
  }
  return {
    db: wrapped,
    statements,
    notify: (channel: string) => subscribers.get(channel)?.(''),
    listening: (channel: string) => subscribers.has(channel),
    unlistened: () => unlistened,
  }
}

async function pollerOn(db: Db, nodeId: string, intervalMs = 60_000) {
  const state = await currentSchemaState(db)
  const seen: CacheInstructionKind[] = []
  const poller = new CacheInstructionPoller({
    db,
    nodeId,
    nodeState: { version: state.version, revision: state.revision },
    onInstruction: (kind) => seen.push(kind),
  })
  pollers.push(poller)
  await poller.start(intervalMs)
  return { poller, seen }
}

async function within(ms: number, done: () => boolean): Promise<number> {
  const started = performance.now()
  while (!done()) {
    if (performance.now() - started > ms) throw new Error(`not within ${ms}ms`)
    await Bun.sleep(5)
  }
  return performance.now() - started
}

const readsOfInstructions = (statements: string[]) =>
  statements.filter((sql) => sql.includes('FROM cache_instruction WHERE id >')).length

describe(`the poller wakes on notification (${dialectUnderTest})`, () => {
  test('listens where the database can, and a notification polls at once', async () => {
    const db = await installed()
    const watched = observed(db)
    const { seen } = await pollerOn(watched.db, 'node-b')
    expect(watched.listening(CACHE_INSTRUCTION_CHANNEL)).toBe(true)

    await appendCacheInstruction(db, { kind: 'content', by: 'node-a' })
    // The timer is a minute away, so only the notification can deliver it.
    watched.notify(CACHE_INSTRUCTION_CHANNEL)
    await within(1_000, () => seen.length > 0)
    expect(seen).toEqual(['content'])
  })

  test('a burst of wake-ups reads the table twice, not once each', async () => {
    const db = await installed()
    const watched = observed(db)
    const { poller } = await pollerOn(watched.db, 'node-b')
    const before = readsOfInstructions(watched.statements)
    await Promise.all(Array.from({ length: 10 }, () => poller.poll()))
    expect(readsOfInstructions(watched.statements) - before).toBe(2)
  })

  test('an instruction written during a poll is not lost to the coalescing', async () => {
    const db = await installed()
    const watched = observed(db)
    const { poller, seen } = await pollerOn(watched.db, 'node-b')
    const first = poller.poll()
    await appendCacheInstruction(db, { kind: 'schema', by: 'node-a' })
    await Promise.all([first, poller.poll()])
    expect(seen).toEqual(['schema'])
  })

  test('stopping stops listening; with no timer it never listens', async () => {
    const db = await installed()
    const watched = observed(db)
    const { poller } = await pollerOn(watched.db, 'node-b')
    poller.stop()
    await within(1_000, () => watched.unlistened() === 1)

    const manual = observed(db)
    await pollerOn(manual.db, 'node-c', 0)
    expect(manual.listening(CACHE_INSTRUCTION_CHANNEL)).toBe(false)
  })

  test('a database that cannot listen leaves the timer to deliver everything', async () => {
    const db = await installed()
    const { listen: _, ...without } = observed(db).db
    const { seen } = await pollerOn(without as Db, 'node-b', 20)
    await appendCacheInstruction(db, { kind: 'components', by: 'node-a' })
    await within(2_000, () => seen.length > 0)
    expect(seen).toEqual(['components'])
  })
})

describe.skipIf(dialectUnderTest !== 'sqlite')('SQLite (sqlite)', () => {
  test('has nothing to listen on, and appending notifies nobody', async () => {
    const db = await installed()
    expect(db.listen).toBeUndefined()
    const watched = observed(db)
    await appendCacheInstruction(watched.db, { kind: 'content', by: 'node-a' })
    expect(watched.statements.some((sql) => sql.includes('pg_notify'))).toBe(false)
  })
})

describe.skipIf(dialectUnderTest !== 'postgres')('two nodes over one database (postgres)', () => {
  test('a write on one reaches the other well inside its poll interval', async () => {
    const a = await installed()
    const b = await connect({ dialect: 'postgres', poolSize: 2 })
    open.push(b)
    const { seen } = await pollerOn(b, 'node-b')

    await a.transaction((tx) => appendCacheInstruction(tx, { kind: 'content', by: 'node-a' }))
    const took = await within(1_000, () => seen.length > 0)
    expect(seen).toEqual(['content'])
    expect(took).toBeLessThan(1_000)
  })

  test('a write that rolls back wakes nobody', async () => {
    const a = await installed()
    const b = await connect({ dialect: 'postgres', poolSize: 2 })
    open.push(b)
    // The real listener, so the count says what Postgres delivered.
    let woken = 0
    const stop = await b.listen?.(CACHE_INSTRUCTION_CHANNEL, () => {
      woken += 1
    })
    await a
      .transaction(async (tx) => {
        await appendCacheInstruction(tx, { kind: 'content', by: 'node-a' })
        throw new Error('changed my mind')
      })
      .catch(() => {})
    await appendCacheInstruction(a, { kind: 'schema', by: 'node-a' })
    await within(1_000, () => woken > 0)
    await Bun.sleep(100)
    expect(woken).toBe(1)
    await stop?.()
  })
})
