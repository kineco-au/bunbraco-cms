/**
 * Story 081's load test: concurrent saves, publishes, moves, sorts, trashes,
 * restores, deletes and creates on overlapping branches, then an invariant pass
 * over the tree and the values. On Postgres two nodes share the database and
 * must agree through the cache instruction poll.
 *
 * Not collected by `bun test`; `bun run test:load` runs it, and the release
 * pipeline runs it on both dialects. CROMBOLO_LOAD_OPS, CROMBOLO_LOAD_WRITERS
 * and CROMBOLO_LOAD_SEED scale and replay a run. docs/testing.md.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { checkTreeInvariants, type Db, loadTreeSnapshot } from '@crombolo/data'
import {
  createPage,
  type TreeSite,
  treeOps,
  treeSite,
  writeTreeSite,
} from '../support/content-tree.ts'
import { dialectUnderTest } from '../support/db.ts'
import { type Harness, V1 } from '../support/harness.ts'

const OPS = Number(Bun.env.CROMBOLO_LOAD_OPS ?? 400)
const WRITERS = Number(Bun.env.CROMBOLO_LOAD_WRITERS ?? 10)
const SEED = Number(Bun.env.CROMBOLO_LOAD_SEED ?? Date.now() % 1_000_000)

/** mulberry32: small, seedable, good enough to pick operations. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Op =
  | 'save'
  | 'publish'
  | 'unpublish'
  | 'move'
  | 'sort'
  | 'trash'
  | 'restore'
  | 'remove'
  | 'create'

const WEIGHTS: Array<[Op, number]> = [
  ['save', 30],
  ['publish', 15],
  ['unpublish', 5],
  ['move', 12],
  ['sort', 8],
  ['trash', 7],
  ['restore', 6],
  ['remove', 4],
  ['create', 13],
]

/** Refusals an editor can get for a target that moved or vanished meanwhile. */
const REFUSALS = new Set([400, 404])

const sites: TreeSite[] = []
const roots: string[] = []
afterAll(async () => {
  while (sites.length > 0) await sites.pop()?.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

async function seedTree(site: TreeSite): Promise<string[]> {
  const ops = treeOps(site)
  const keys: string[] = []
  for (let r = 0; r < 3; r++) {
    const root = await createPage(site, `root-${r}`)
    await ops.publish(root)
    keys.push(root)
    for (let c = 0; c < 4; c++) {
      const child = await createPage(site, `child-${r}-${c}`, root)
      await ops.publish(child)
      keys.push(child)
      for (let g = 0; g < 2; g++) keys.push(await createPage(site, `leaf-${r}-${c}-${g}`, child))
    }
  }
  return keys
}

async function childKeys(h: Harness, parent: string | null): Promise<string[]> {
  const response = await h.call(
    parent
      ? `${V1}/tree/document/children?parentId=${parent}&skip=0&take=100`
      : `${V1}/tree/document/root?skip=0&take=100`,
  )
  if (!response.ok) return []
  return ((await response.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id)
}

/** Every save's name for each page, by key, read straight from the event history. */
async function savedNames(db: Db): Promise<Map<string, Set<string>>> {
  const rows = await db.query<{ unique_id: string; text: string }>(
    `SELECT n.unique_id, cv.text FROM content_version cv JOIN node n ON n.id = cv.node_id`,
  )
  const names = new Map<string, Set<string>>()
  for (const row of rows) {
    const key = String(row.unique_id).toLowerCase()
    const set = names.get(key) ?? new Set<string>()
    set.add(String(row.text))
    names.set(key, set)
  }
  return names
}

describe(`concurrent editing (${dialectUnderTest}, seed ${SEED})`, () => {
  test(
    'leaves the tree and the values consistent, on every node',
    async () => {
      const root = writeTreeSite()
      roots.push(root)
      const multiNode = dialectUnderTest === 'postgres'
      const a = await treeSite({ root, config: { nodeId: 'node-a' } })
      sites.push(a)
      const nodes = [a]
      if (multiNode) {
        const b = await treeSite({ root, keepDatabase: true, config: { nodeId: 'node-b' } })
        sites.push(b)
        nodes.push(b)
      }

      const known = await seedTree(a)
      const trashed = new Set<string>()
      const acked = new Map<string, Set<string>>()
      const statuses = new Map<string, number>()
      const unexpected: string[] = []
      const next = random(SEED)
      const pick = <T>(items: readonly T[]): T | undefined =>
        items[Math.floor(next() * items.length)]
      const total = WEIGHTS.reduce((sum, [, w]) => sum + w, 0)
      const chooseOp = (): Op => {
        let roll = next() * total
        for (const [op, weight] of WEIGHTS) {
          roll -= weight
          if (roll < 0) return op
        }
        return 'save'
      }

      let issued = 0
      const writer = async (index: number) => {
        const site = nodes[index % nodes.length] as TreeSite
        const ops = treeOps(site, site.h)
        while (issued < OPS) {
          const n = issued++
          const op = chooseOp()
          const key = pick(known) as string
          const token = `w${index}-${n}`
          let response: Response
          switch (op) {
            case 'save':
              response = await ops.save(key, token, token)
              if (response.status === 200) {
                const set = acked.get(key) ?? new Set<string>()
                set.add(token)
                acked.set(key, set)
              }
              break
            case 'publish':
              response = await ops.publish(key)
              break
            case 'unpublish':
              response = await ops.unpublish(key)
              break
            case 'move':
              response = await ops.move(key, next() < 0.15 ? null : (pick(known) as string))
              break
            case 'sort': {
              const parent = next() < 0.2 ? null : key
              const children = await childKeys(site.h, parent)
              response = await ops.sort(parent, children.reverse())
              break
            }
            case 'trash':
              response = await ops.trash(key)
              if (response.status === 200) trashed.add(key)
              break
            case 'restore': {
              const target = pick([...trashed]) ?? key
              response = await ops.restore(target)
              if (response.status === 200) trashed.delete(target)
              break
            }
            case 'remove': {
              const target = pick([...trashed]) ?? key
              response = await ops.remove(target)
              if (response.status === 200) trashed.delete(target)
              break
            }
            case 'create': {
              response = await ops.create(token, next() < 0.1 ? null : key)
              const created = response.headers.get('umb-generated-resource')
              if (response.status === 201 && created) known.push(created)
              break
            }
          }
          const label = `${op} ${response.status}`
          statuses.set(label, (statuses.get(label) ?? 0) + 1)
          if (response.status >= 300 && !REFUSALS.has(response.status))
            unexpected.push(`${label} ${key}: ${await response.text()}`)
        }
      }
      await Promise.all(Array.from({ length: WRITERS }, (_, i) => writer(i)))

      console.log(
        `seed ${SEED}: ${OPS} operations, ${WRITERS} writers, ${nodes.length} node(s)`,
        Object.fromEntries([...statuses].sort()),
      )
      // No 500s and no busy answers: nothing deadlocked or waited out its lock.
      expect(unexpected).toEqual([])

      const db = a.h.server.db
      expect(checkTreeInvariants(await loadTreeSnapshot(db))).toEqual([])

      // No lost update: every acknowledged save is in its page's history, and
      // each page's current name and value come from the same save.
      const history = await savedNames(db)
      for (const [key, tokens] of acked) {
        const names = history.get(key.toLowerCase())
        if (!names) continue
        for (const token of tokens) expect(names.has(token)).toBe(true)
        const doc = await a.h.json<{
          values: Array<{ alias: string; value: string }>
          variants: Array<{ name: string }>
        }>(`${V1}/document/${key}`)
        expect(doc.values.find((v) => v.alias === 'title')?.value).toBe(doc.variants[0]?.name)
      }

      // Every node, once it has polled, serves what a fresh load would, and
      // the nodes agree. Published pages under an unpublished parent are
      // unreachable, as in Umbraco, so the database's published set is not it.
      const served = async (site: TreeSite) => {
        const keys: string[] = []
        for (const key of known)
          if (await site.h.server.cache.byKey(key)) keys.push(key.toLowerCase())
        return keys.sort()
      }
      const views: string[][] = []
      for (const site of nodes) {
        for (let i = 0; i < 5 && (await site.h.server.poll()) > 0; i++);
        const polled = await served(site)
        site.h.server.cache.invalidate()
        expect(polled).toEqual(await served(site))
        views.push(polled)
      }
      for (const view of views.slice(1)) expect(view).toEqual(views[0] as string[])
      expect(views[0]?.length).toBeGreaterThan(0)
    },
    10 * 60_000,
  )
})
