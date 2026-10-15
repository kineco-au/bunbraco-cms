/**
 * Story 086: the paths a large site makes slow, held to a cost that does not
 * grow with it — a page of the tree, the published cache's reads — and a cache
 * that builds once for everyone waiting on it. The timings themselves are the
 * release pipeline's (tests/load/large-site.load.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ComponentRepository,
  ContentTypeRepository,
  type Db,
  DocumentRepository,
  publishedValueRows,
} from '@crombolo/data'
import { PublishedCache, type PublishedNode } from '@crombolo/render'
import { type Harness, signedInServer } from './support/harness.ts'

const PAGE_TOML = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** The database as given, every statement counted. */
function counted(db: Db) {
  let statements = 0
  const wrapped: Db = {
    dialect: db.dialect,
    locks: db.locks,
    query: (sql, params) => {
      statements += 1
      return db.query(sql, params)
    },
    exec: (sql, params) => {
      statements += 1
      return db.exec(sql, params)
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  }
  return {
    db: wrapped,
    async during<T>(run: () => Promise<T>): Promise<number> {
      const before = statements
      await run()
      return statements - before
    },
  }
}

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'large-site-paths-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), 'export default () => <main />\n')
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const db = h.server.db
  const nodeState = h.server.schema.nodeState
  const typeKey = (await new ContentTypeRepository(db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(db).byAlias('page'))?.key as string
  const docs = new DocumentRepository(db, { nodeState })
  const page = async (name: string, parentKey: string | null) => {
    const doc = await docs.create({
      key: crypto.randomUUID(),
      contentTypeKey: typeKey,
      componentKey,
      parentKey,
      variants: [{ culture: null, segment: null, name }],
      values: [{ alias: 'title', culture: null, segment: null, value: name }],
    })
    await docs.publish(doc.key, null)
    return doc.key
  }
  const watched = counted(db)
  return { h, page, watched, repo: new DocumentRepository(watched.db, { nodeState }) }
}

describe('reads that do not grow with the site', () => {
  test('a page of the tree costs the same for three items as for thirty', async () => {
    const { page, watched, repo } = await site()
    const few = await page('Few', null)
    const many = await page('Many', null)
    for (let n = 0; n < 3; n++) await page(`f${n}`, few)
    for (let n = 0; n < 30; n++) await page(`m${n}`, many)

    const small = (await repo.children(few, 0, 100)).items
    const large = (await repo.children(many, 0, 100)).items
    const forFew = await watched.during(() => repo.treeItems(small))
    const forMany = await watched.during(() => repo.treeItems(large))
    expect(forMany).toBe(forFew)
    expect(forFew).toBeLessThanOrEqual(5)

    const items = await repo.treeItems(large)
    expect(items).toHaveLength(30)
    expect(items[0]).toMatchObject({
      name: 'm0',
      parentKey: many,
      ancestorKeys: [many],
      hasChildren: false,
      variants: [{ culture: null, name: 'm0', state: 'Published' }],
    })
  })

  test('the published cache reads the same number of times for four pages as for forty', async () => {
    const { page, watched, repo } = await site()
    const home = await page('Home', null)
    for (let n = 0; n < 3; n++) await page(`a${n}`, home)
    const before = await watched.during(() => repo.loadPublished())
    for (let n = 0; n < 36; n++) await page(`b${n}`, home)
    const after = await watched.during(() => repo.loadPublished())
    expect(after).toBe(before)
    const published = await repo.loadPublished()
    expect(published).toHaveLength(40)
    expect(published.find((p) => p.name === 'b7')?.values).toMatchObject([
      { alias: 'title', value: 'b7' },
    ])
  })

  test('media for the cache is read the same number of times however much there is', async () => {
    const { h, watched } = await site()
    const media = new DocumentRepository(watched.db, {
      kind: 'media',
      nodeState: h.server.schema.nodeState,
    })
    const make = async (n: number) =>
      new DocumentRepository(h.server.db, {
        kind: 'media',
        nodeState: h.server.schema.nodeState,
      }).create({
        key: crypto.randomUUID(),
        contentTypeKey: 'f38bd2d7-65d0-48e6-95dc-87ce06ec2d3d',
        componentKey: null,
        parentKey: null,
        variants: [{ culture: null, segment: null, name: `m${n}` }],
        values: [],
      })
    await make(0)
    const before = await watched.during(() => media.loadCurrent())
    for (let n = 1; n < 20; n++) await make(n)
    expect(await watched.during(() => media.loadCurrent())).toBe(before)
    expect((await media.loadCurrent()).map((m) => m.name)).toContain('m19')
  })
})

describe('the published values a node shows', () => {
  const row = (id: number, eventId: number, languageId: number | null, propertyTypeId = 1) => ({
    id,
    eventId,
    propertyTypeId,
    languageId,
    segment: null,
  })

  test('invariant values as of the publish, each culture as of its own', () => {
    const history = [
      row(1, 10, null),
      row(2, 20, null),
      row(3, 10, 7),
      row(4, 30, 7),
      row(5, 25, 8),
    ]
    const chosen = publishedValueRows(history, 20, [
      { languageId: 7, eventId: 10 },
      { languageId: 8, eventId: 25 },
    ])
    expect(chosen.map((r) => r.id).sort()).toEqual([2, 3, 5])
  })

  test('an unpublished culture contributes nothing', () => {
    expect(publishedValueRows([row(1, 5, 9)], 10, [])).toEqual([])
  })
})

describe('the published cache under load', () => {
  const node = (key: string, name: string): PublishedNode => ({
    id: 1,
    key,
    parentId: -1,
    level: 1,
    path: '-1,1',
    sortOrder: 0,
    name,
    contentTypeAlias: 'page',
    componentAlias: 'page',
    createDate: new Date(0),
    updateDate: new Date(0),
    cultures: [],
    properties: [],
  })

  test('readers arriving while it builds share the one build', async () => {
    let builds = 0
    const cache = new PublishedCache({
      loadPublished: async () => {
        builds += 1
        await Bun.sleep(20)
        return [node('11111111-1111-4111-8111-111111111111', 'Home')]
      },
    })
    await Promise.all(Array.from({ length: 10 }, () => cache.snapshot()))
    expect(builds).toBe(1)
    await cache.snapshot()
    expect(builds).toBe(1)
  })

  test('a change during a build is not lost, and a slower older build does not win', async () => {
    const names = ['First', 'Second']
    const delays = [40, 0]
    let builds = 0
    const cache = new PublishedCache({
      loadPublished: async () => {
        const n = builds++
        await Bun.sleep(delays[n] ?? 0)
        return [node('11111111-1111-4111-8111-111111111111', names[n] ?? 'Later')]
      },
    })
    const slow = cache.snapshot()
    cache.invalidate()
    const fast = cache.snapshot()
    await Promise.all([slow, fast])
    expect(builds).toBe(2)
    expect((await cache.resolve('localhost', '/'))?.content.name).toBe('Second')
    // Settled on the newer build: nothing builds again.
    expect(builds).toBe(2)
  })
})
