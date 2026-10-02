/**
 * The Published Status dashboard's three operations. Umbraco separates
 * reloading the in-memory cache from rebuilding the database cache it reads;
 * there is no such table here, so the difference is when the snapshot is built
 * — lazily on the next read, or before the response.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { PublishedCache, type PublishedNode } from '@bunbraco/render'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

/** A source that counts how often the cache asked it to load. */
function countingSource() {
  let builds = 0
  return {
    get builds() {
      return builds
    },
    loadPublished: async (): Promise<PublishedNode[]> => {
      builds += 1
      return []
    },
  }
}

describe('the published cache admin operations', () => {
  test('a reload defers the rebuild to the next read', async () => {
    const source = countingSource()
    const cache = new PublishedCache(source)
    await cache.snapshot()
    expect(source.builds).toBe(1)

    // A second read is served from the snapshot.
    await cache.snapshot()
    expect(source.builds).toBe(1)

    cache.invalidate()
    expect(source.builds).toBe(1)
    await cache.snapshot()
    expect(source.builds).toBe(2)
  })

  test('a rebuild pays the cost before it answers', async () => {
    const source = countingSource()
    const cache = new PublishedCache(source)
    await cache.snapshot()
    expect(source.builds).toBe(1)

    // What the rebuild handler does: drop it, then build it.
    cache.invalidate()
    await cache.snapshot()
    expect(source.builds).toBe(2)

    // Nothing is left for the next read to do.
    await cache.snapshot()
    expect(source.builds).toBe(2)
  })
})

describe('the published cache endpoints', () => {
  test('reload, rebuild and the status the client polls', async () => {
    const h = await signedInServer()
    open.push(h)

    expect((await h.post(`${V1}/published-cache/reload`, {})).status).toBe(200)
    expect((await h.post(`${V1}/published-cache/rebuild`, {})).status).toBe(200)

    // The client polls this until it is false, so it must never report true
    // once a rebuild has returned.
    const status = await h.json<{ isRebuilding: boolean }>(`${V1}/published-cache/rebuild/status`)
    expect(status).toEqual({ isRebuilding: false })
  })

  test('a reload leaves the site serving the same published content', async () => {
    const h = await signedInServer()
    open.push(h)
    const before = await h.call('/')
    expect((await h.post(`${V1}/published-cache/reload`, {})).status).toBe(200)
    const after = await h.call('/')
    expect(after.status).toBe(before.status)
  })
})
