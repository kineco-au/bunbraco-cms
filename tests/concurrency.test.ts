/**
 * Story 081: lock contention is recognised, retried where safe and answered as
 * a retryable 503; the tree invariants hold. The load test that drives this at
 * scale is tests/load/concurrency.load.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { ObjectTypes } from '@crombolo/core'
import {
  ContentBusyError,
  checkTreeInvariants,
  classifyContention,
  connect,
  LockQueue,
  Locks,
  loadTreeSnapshot,
  retryContention,
  type TreeSnapshot,
} from '@crombolo/data'
import { busyResponse } from '@crombolo/server'
import { createPage, type TreeSite, treeOps, treeSite } from './support/content-tree.ts'
import { dialectUnderTest } from './support/db.ts'
import { V1 } from './support/harness.ts'

const sites: TreeSite[] = []
afterEach(async () => {
  while (sites.length > 0) await sites.pop()?.close()
})

const noSleep = { attempts: 2, backoffMs: 1, sleep: async () => {} }

describe('recognising contention', () => {
  test.each([
    [{ code: '40P01' }, 'deadlock'],
    [{ code: '40001' }, 'deadlock'],
    [{ code: '55P03' }, 'lockTimeout'],
    [{ code: 'ERR_POSTGRES_SERVER_ERROR', errno: '55P03' }, 'lockTimeout'],
    [{ code: 'SQLITE_BUSY' }, 'busy'],
    [{ code: 'SQLITE_BUSY_SNAPSHOT' }, 'busy'],
    [{ errno: 5 }, 'busy'],
    [new Error('database is locked'), 'busy'],
    [new ContentBusyError('lockTimeout'), 'lockTimeout'],
  ])('%p is %s', (error, kind) => {
    expect(classifyContention(error)).toBe(kind as never)
  })

  test.each([
    ['an ordinary error', new Error('boom')],
    ['a constraint violation', { code: '23505' }],
    ['null', null],
    ['a string', 'text'],
  ])('%s is not contention', (_label, error) => {
    expect(classifyContention(error)).toBeUndefined()
  })
})

describe('retrying contention', () => {
  test('a deadlock is retried once and then succeeds', async () => {
    let calls = 0
    const result = await retryContention(async () => {
      calls++
      if (calls === 1) throw { code: '40P01' }
      return 'done'
    }, noSleep)
    expect(result).toBe('done')
    expect(calls).toBe(2)
  })

  test('a deadlock that persists becomes a busy error', async () => {
    let calls = 0
    const attempt = retryContention(async () => {
      calls++
      throw { code: '40P01' }
    }, noSleep)
    await expect(attempt).rejects.toBeInstanceOf(ContentBusyError)
    expect(calls).toBe(2)
  })

  test('a lock timeout is not retried: the wait has been spent', async () => {
    let calls = 0
    const attempt = retryContention(async () => {
      calls++
      throw { code: '55P03' }
    }, noSleep)
    await expect(attempt).rejects.toMatchObject({ contention: 'lockTimeout' })
    expect(calls).toBe(1)
  })

  test('anything else passes through untouched', async () => {
    const failure = new Error('constraint')
    await expect(
      retryContention(async () => {
        throw failure
      }, noSleep),
    ).rejects.toBe(failure)
  })

  test('the wait between attempts grows with each attempt', async () => {
    const waits: number[] = []
    const policy = { attempts: 3, backoffMs: 10, sleep: async (ms: number) => void waits.push(ms) }
    await retryContention(async () => {
      if (waits.length < 2) throw { code: '40001' }
      return true
    }, policy).catch(() => {})
    expect(waits).toEqual([10, 20])
  })
})

describe('the lock queue', () => {
  test('waiters run one at a time, in arrival order', async () => {
    const queue = new LockQueue()
    const order: string[] = []
    let inside = 0
    let most = 0
    const job = (name: string) =>
      queue.hold(1, 1000, async () => {
        inside++
        most = Math.max(most, inside)
        await Bun.sleep(2)
        order.push(name)
        inside--
      })
    await Promise.all([job('a'), job('b'), job('c')])
    expect(order).toEqual(['a', 'b', 'c'])
    expect(most).toBe(1)
  })

  test('a waiter that times out leaves the line, and the next one still runs', async () => {
    const queue = new LockQueue()
    let release!: () => void
    const held = queue.hold(1, 1000, () => new Promise<void>((resolve) => (release = resolve)))
    const impatient = queue.hold(1, 10, async () => 'never')
    const patient = queue.hold(1, 1000, async () => 'ran')
    await expect(impatient).rejects.toBeInstanceOf(ContentBusyError)
    release()
    await held
    expect(await patient).toBe('ran')
  })

  test('different locks do not wait for each other', async () => {
    const queue = new LockQueue()
    let release!: () => void
    const held = queue.hold(1, 1000, () => new Promise<void>((resolve) => (release = resolve)))
    expect(await queue.hold(2, 10, async () => 'other')).toBe('other')
    release()
    await held
  })
})

describe('the busy response', () => {
  test('contention is a 503 with Retry-After and a message an editor can act on', async () => {
    const response = busyResponse(new ContentBusyError('lockTimeout', 3)) as Response
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('3')
    const problem = (await response.json()) as { detail: string; operationStatus: string }
    expect(problem.operationStatus).toBe('Busy')
    expect(problem.detail).toBe(
      'Someone else is changing this content right now. Try again in a moment.',
    )
  })

  test('a raw driver error is answered the same way', () => {
    expect(busyResponse({ code: '40P01' })?.status).toBe(503)
  })

  test('anything else is left to propagate', () => {
    expect(busyResponse(new Error('boom'))).toBeUndefined()
  })
})

const DOC = ObjectTypes.Document
const node = (id: number, parentId: number, path: string, level: number, extra = {}) => ({
  id,
  parentId,
  path,
  level,
  sortOrder: id,
  trashed: false,
  objectType: DOC,
  ...extra,
})

/** Root, a published page under it and an unpublished child: consistent. */
function consistent(): TreeSnapshot {
  return {
    nodes: [
      { ...node(-1, -1, '-1', 0), objectType: ObjectTypes.SystemRoot },
      { ...node(-20, -1, '-1,-20', 0), objectType: ObjectTypes.ContentRecycleBin },
      node(1, -1, '-1,1', 1),
      node(2, 1, '-1,1,2', 2),
    ],
    documents: [
      { nodeId: 1, published: true },
      { nodeId: 2, published: false },
    ],
    versions: [
      { id: 10, nodeId: 1, current: true, published: true },
      { id: 11, nodeId: 2, current: true, published: false },
    ],
    contentNodeIds: [1, 2],
  }
}

const rules = (snapshot: TreeSnapshot) => checkTreeInvariants(snapshot).map((v) => v.rule)

describe('tree invariants', () => {
  test('a consistent tree breaks no rule', () => {
    expect(checkTreeInvariants(consistent())).toEqual([])
  })

  test('a node whose parent is gone is an orphan', () => {
    const s = consistent()
    expect(rules({ ...s, nodes: s.nodes.filter((n) => n.id !== 1) })).toContain('orphan')
  })

  test('a path or level that disagrees with the parent is caught', () => {
    const s = consistent()
    const nodes = s.nodes.map((n) => (n.id === 2 ? { ...n, path: '-1,2', level: 1 } : n))
    expect(rules({ ...s, nodes })).toEqual(['path', 'level'])
  })

  test('a trashed branch sits under the bin, and its children must be trashed too', () => {
    const s = consistent()
    const nodes = s.nodes.map((n) =>
      n.id === 1
        ? { ...n, parentId: -20, path: '-1,-20,1', trashed: true }
        : n.id === 2
          ? { ...n, path: '-1,-20,1,2' }
          : n,
    )
    expect(
      rules({ ...s, nodes: nodes.map((n) => (n.id === 1 ? { ...n, path: '-1,1' } : n)) }),
    ).toContain('path')
    const documents = s.documents.map((d) => ({ ...d, published: false }))
    expect(rules({ ...s, nodes, documents })).toEqual(['trashed'])
    const both = nodes.map((n) => (n.id === 2 ? { ...n, trashed: true } : n))
    expect(rules({ ...s, nodes: both, documents })).toEqual([])
  })

  test('siblings sharing a sort order are caught', () => {
    const s = consistent()
    const nodes = [...s.nodes, node(3, 1, '-1,1,3', 2, { sortOrder: 2 })]
    const documents = [...s.documents, { nodeId: 3, published: false }]
    expect(rules({ ...s, nodes, documents, contentNodeIds: [1, 2, 3] })).toEqual(['sort-order'])
  })

  test('two current versions of one page are caught', () => {
    const s = consistent()
    const versions = [...s.versions, { id: 12, nodeId: 2, current: true, published: false }]
    expect(rules({ ...s, versions })).toEqual(['current-version'])
  })

  test('a published page under an unpublished one is allowed, as Umbraco allows it', () => {
    const s = consistent()
    const documents = [
      { nodeId: 1, published: false },
      { nodeId: 2, published: true },
    ]
    const versions = s.versions.map((v) => ({ ...v, published: v.nodeId === 2 }))
    expect(rules({ ...s, documents, versions })).toEqual([])
  })

  test('a published page must have exactly one published version, and not be trashed', () => {
    const s = consistent()
    const versions = s.versions.map((v) => ({ ...v, published: false }))
    expect(rules({ ...s, versions })).toEqual(['published-version'])
  })

  test('a page missing its document or content row is caught', () => {
    const s = consistent()
    expect(rules({ ...s, contentNodeIds: [1] })).toEqual(['content-row'])
  })

  test('the loader reads a real tree the checker finds consistent', async () => {
    const site = await treeSite()
    sites.push(site)
    const ops = treeOps(site)
    const home = await createPage(site, 'Home')
    const about = await createPage(site, 'About', home)
    const team = await createPage(site, 'Team', about)
    expect((await ops.publish(home)).status).toBe(200)
    expect((await ops.publish(about)).status).toBe(200)
    expect((await ops.move(team, null)).status).toBe(200)
    expect((await ops.trash(about)).status).toBe(200)
    expect((await ops.restore(about)).status).toBe(200)
    const snapshot = await loadTreeSnapshot(site.h.server.db)
    expect(snapshot.nodes.filter((n) => n.objectType === DOC)).toHaveLength(3)
    expect(checkTreeInvariants(snapshot)).toEqual([])
  })
})

describe('the recycle bin keeps the tree true', () => {
  test('restoring a branch leaves a page trashed from inside it in the bin', async () => {
    const site = await treeSite()
    sites.push(site)
    const ops = treeOps(site)
    const home = await createPage(site, 'Home')
    const about = await createPage(site, 'About', home)
    expect((await ops.trash(about)).status).toBe(200)
    expect((await ops.trash(home)).status).toBe(200)
    expect((await ops.restore(home)).status).toBe(200)
    const bin = await site.h.json<{ items: Array<{ id: string }> }>(
      `${V1}/recycle-bin/document/root?skip=0&take=10`,
    )
    expect(bin.items.map((i) => i.id)).toEqual([about])
    expect(checkTreeInvariants(await loadTreeSnapshot(site.h.server.db))).toEqual([])
  })

  test('moving a page out of the bin restores it', async () => {
    const site = await treeSite()
    sites.push(site)
    const ops = treeOps(site)
    const home = await createPage(site, 'Home')
    const about = await createPage(site, 'About')
    expect((await ops.trash(about)).status).toBe(200)
    expect((await ops.move(about, home)).status).toBe(200)
    const doc = await site.h.json<{ isTrashed: boolean }>(`${V1}/document/${about}`)
    expect(doc.isTrashed).toBe(false)
    expect(checkTreeInvariants(await loadTreeSnapshot(site.h.server.db))).toEqual([])
  })

  test('a page cannot be created under one in the bin', async () => {
    const site = await treeSite()
    sites.push(site)
    const home = await createPage(site, 'Home')
    expect((await treeOps(site).trash(home)).status).toBe(200)
    const refused = await treeOps(site).create('Orphan', home)
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('The parent is in the recycle bin.')
  })

  test('pages trashed one after another take their own places in the bin', async () => {
    const site = await treeSite()
    sites.push(site)
    const ops = treeOps(site)
    for (const name of ['One', 'Two', 'Three'])
      expect((await ops.trash(await createPage(site, name))).status).toBe(200)
    expect(checkTreeInvariants(await loadTreeSnapshot(site.h.server.db))).toEqual([])
  })
})

describe('contention through the server', () => {
  const withLockTimeout = async <T>(seconds: string, fn: () => Promise<T>): Promise<T> => {
    const before = Bun.env.CROMBOLO_LOCK_TIMEOUT_SECONDS
    Bun.env.CROMBOLO_LOCK_TIMEOUT_SECONDS = seconds
    try {
      return await fn()
    } finally {
      if (before === undefined) delete Bun.env.CROMBOLO_LOCK_TIMEOUT_SECONDS
      else Bun.env.CROMBOLO_LOCK_TIMEOUT_SECONDS = before
    }
  }

  test('a save that cannot get the content lock in time answers 503, not 500', async () => {
    const site = await withLockTimeout('0.2', () => treeSite())
    sites.push(site)
    const key = await createPage(site, 'Home')
    let release!: () => void
    const holding = site.h.server.db.locks.withLock(
      Locks.ContentTree,
      () => new Promise<void>((resolve) => (release = resolve)),
    )
    const response = await treeOps(site)
      .save(key, 'Home', 'blocked')
      .finally(() => release())
    await holding
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(((await response.json()) as { detail: string }).detail).toContain('Try again')
    expect((await treeOps(site).save(key, 'Home', 'after')).status).toBe(200)
  })

  test('concurrent saves of one page leave one current version and the last save on top', async () => {
    const site = await treeSite()
    sites.push(site)
    const key = await createPage(site, 'Home')
    const ops = treeOps(site)
    const titles = Array.from({ length: 8 }, (_, i) => `title ${i}`)
    const responses = await Promise.all(titles.map((t) => ops.save(key, t, t)))
    expect(responses.map((r) => r.status)).toEqual(titles.map(() => 200))
    expect(checkTreeInvariants(await loadTreeSnapshot(site.h.server.db))).toEqual([])
    const doc = await site.h.json<{
      values: Array<{ alias: string; value: string }>
      variants: Array<{ name: string }>
    }>(`${V1}/document/${key}`)
    // Saves are serialised, so the name and the value come from the same one.
    expect(doc.values.find((v) => v.alias === 'title')?.value).toBe(doc.variants[0]?.name)
  })

  test.skipIf(dialectUnderTest !== 'postgres')(
    'another node holding the lock times the wait out through Postgres itself',
    async () => {
      const site = await withLockTimeout('0.3', () => treeSite())
      sites.push(site)
      const key = await createPage(site, 'Home')
      const other = await connect()
      let release!: () => void
      let held!: () => void
      const locked = new Promise<void>((resolve) => (held = resolve))
      const holding = other.locks.withLock(Locks.ContentTree, async () => {
        held()
        await new Promise<void>((resolve) => (release = resolve))
      })
      await locked
      try {
        const response = await treeOps(site).save(key, 'Home', 'blocked')
        expect(response.status).toBe(503)
      } finally {
        release()
        await holding
        await other.close()
      }
    },
  )

  test.skipIf(dialectUnderTest !== 'postgres')(
    'waiters queue in-process, so a small pool cannot starve the holder',
    async () => {
      const db = await connect({ poolSize: 2 })
      try {
        const runs = Array.from({ length: 6 }, (_, i) =>
          db.locks.withLock(Locks.ContentTree, async () => {
            const rows = await db.query<{ n: number }>('SELECT ? AS n', [i])
            return Number(rows[0]?.n)
          }),
        )
        expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5])
      } finally {
        await db.close()
      }
    },
  )
})
