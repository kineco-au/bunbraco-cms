/**
 * Story 086's benchmark: a generated site of realistic size, then the backoffice
 * tree, a published-cache rebuild and page renders timed against their budgets.
 *
 * The site is made through the repository, as a real one is: create, then
 * publish, every page in every culture. Not collected by `bun test`, nor by
 * `test:load`: `bun run test:bench` runs it, and the release pipeline runs it on
 * both dialects. A run fails only past
 * CROMBOLO_BENCH_MARGIN times a budget, so a noisy runner does not block a
 * release. CROMBOLO_BENCH_PAGES, _MEDIA, _WIDE and _SAMPLES scale it; locally,
 * run it small. docs/testing.md, "Large-site budgets".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@crombolo/core'
import { ComponentRepository, ContentTypeRepository, DocumentRepository } from '@crombolo/data'
import { dialectUnderTest } from '../support/db.ts'
import { type Harness, ORIGIN, signedInServer, V1 } from '../support/harness.ts'

const PAGES = Number(Bun.env.CROMBOLO_BENCH_PAGES ?? 25_000)
const MEDIA = Number(Bun.env.CROMBOLO_BENCH_MEDIA ?? 1_000)
const WIDE = Math.min(Number(Bun.env.CROMBOLO_BENCH_WIDE ?? 2_000), Math.max(PAGES - 2, 1))
const SAMPLES = Number(Bun.env.CROMBOLO_BENCH_SAMPLES ?? 50)
const MARGIN = Number(Bun.env.CROMBOLO_BENCH_MARGIN ?? 2)
const CULTURES = ['en-US', 'da-DK', 'de-DE']
const DEPTH = 5
const FAN_OUT = 8

/** Milliseconds, at the 95th percentile. docs/testing.md holds the same table. */
const BUDGETS = {
  'tree root': 100,
  'tree children': 100,
  'tree siblings': 100,
  'cache rebuild': dialectUnderTest === 'postgres' ? 10_000 : 5_000,
  'page render': 20,
} as const

const PAGE_TOML = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"
varies-by-culture = true

[[property]]
alias = "title"
name = "Title"
type = "textstring"
varies-by-culture = true

[[property]]
alias = "summary"
name = "Summary"
type = "textarea"
varies-by-culture = true

[[property]]
alias = "code"
name = "Code"
type = "textstring"
`

const VIEW = `export default function Page({ model, nav }) {
  return (
    <main>
      <h1>{model.text('title')}</h1>
      <p>{model.text('summary')}</p>
      <ul>{nav.children(model).slice(0, 20).map((c) => <li><a href={c.url}>{c.name}</a></li>)}</ul>
    </main>
  )
}
`

interface Made {
  key: string
  parent: string | null
  route: string
}

const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[
    Math.min(samples.length - 1, Math.floor(samples.length * 0.95))
  ] ?? 0

async function time(times: number, run: (n: number) => Promise<unknown>): Promise<number> {
  const samples: number[] = []
  for (let n = 0; n < times; n++) {
    const started = performance.now()
    await run(n)
    samples.push(performance.now() - started)
  }
  return p95(samples)
}

const results: Array<{ name: keyof typeof BUDGETS; ms: number }> = []
const record = (name: keyof typeof BUDGETS, ms: number) => {
  results.push({ name, ms })
  expect(ms, `${name}: ${ms.toFixed(1)} ms against a budget of ${BUDGETS[name]} ms`).toBeLessThan(
    BUDGETS[name] * MARGIN,
  )
}

let h: Harness
let root: string
const made: Made[] = []
let home: Made
let wide: Made
let deep: Made

/** Each page's sections, breadth first: a wide archive under home, then a fan-out to DEPTH. */
async function generate(): Promise<void> {
  const db = h.server.db
  const typeKey = (await new ContentTypeRepository(db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(db).byAlias('page'))?.key as string
  const docs = new DocumentRepository(db, {
    nodeState: h.server.schema.nodeState,
    nodeId: h.server.config.nodeId,
  })
  const make = async (parent: Made | null, n: number): Promise<Made> => {
    const doc = await docs.create({
      key: crypto.randomUUID(),
      contentTypeKey: typeKey,
      componentKey,
      parentKey: parent?.key ?? null,
      variants: CULTURES.map((culture, i) => ({
        culture,
        segment: null,
        name: i === 0 ? `p-${n}` : `p-${n}-${culture.slice(0, 2)}`,
      })),
      values: [
        ...CULTURES.flatMap((culture) => [
          { alias: 'title', culture, segment: null, value: `Page ${n} (${culture})` },
          { alias: 'summary', culture, segment: null, value: `About page ${n}. `.repeat(8) },
        ]),
        { alias: 'code', culture: null, segment: null, value: `P${n}` },
      ],
    })
    await docs.publish(doc.key, [...CULTURES])
    const page = {
      key: doc.key,
      parent: parent?.key ?? null,
      // The first root is the site's home: its children sit at the top of the path.
      route: parent === null ? '/' : `${parent.route}p-${n}/`,
    }
    made.push(page)
    if (made.length % 2_500 === 0) console.log(`  ${made.length} pages`)
    return page
  }

  home = await make(null, 0)
  wide = await make(home, 1)
  for (let n = 0; n < WIDE && made.length < PAGES; n++) await make(wide, made.length)
  let level: Made[] = [home]
  for (let depth = 1; depth < DEPTH && made.length < PAGES; depth++) {
    const next: Made[] = []
    for (const parent of level)
      for (let n = 0; n < FAN_OUT && made.length < PAGES; n++)
        next.push(await make(parent, made.length))
    level = next.length > 0 ? next : level
  }
  // What is left goes under the deepest level, spread evenly.
  for (let n = 0; made.length < PAGES; n++) await make(level[n % level.length] as Made, made.length)
  deep = level[0] as Made

  const media = new DocumentRepository(db, { kind: 'media', nodeState: h.server.schema.nodeState })
  for (let n = 0; n < MEDIA; n++)
    await media.create({
      key: crypto.randomUUID(),
      contentTypeKey: SYSTEM_MEDIA_TYPE_KEYS.Image,
      componentKey: null,
      parentKey: null,
      variants: [{ culture: null, segment: null, name: `m-${n}` }],
      values: [],
    })
}

beforeAll(async () => {
  root = mkdtempSync(join(process.cwd(), 'output', 'large-site-'))
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  for (const iso of CULTURES.slice(1))
    expect(
      (
        await h.post(`${V1}/language`, {
          isoCode: iso,
          name: iso,
          isDefault: false,
          isMandatory: false,
          fallbackIsoCode: null,
        })
      ).status,
    ).toBe(201)
  const started = performance.now()
  await generate()
  console.log(
    `  generated ${made.length} pages in ${CULTURES.length} cultures and ${MEDIA} media on ${dialectUnderTest} in ${((performance.now() - started) / 1000).toFixed(0)} s`,
  )
}, 3_600_000)

afterAll(async () => {
  if (results.length > 0) {
    console.log(`\n  large-site budgets (${dialectUnderTest}, p95, failing past ${MARGIN}x):`)
    for (const { name, ms } of results)
      console.log(
        `  ${name.padEnd(14)} ${ms.toFixed(1).padStart(9)} ms  budget ${String(BUDGETS[name]).padStart(6)} ms  ${ms <= BUDGETS[name] ? 'ok' : ms < BUDGETS[name] * MARGIN ? 'over budget' : 'FAILED'}`,
      )
  }
  await h?.db.close().catch(() => {})
  if (root) rmSync(root, { recursive: true, force: true })
})

describe(`a large site (${dialectUnderTest})`, () => {
  test('the tree root', async () => {
    record(
      'tree root',
      await time(SAMPLES, () => h.json(`${V1}/tree/document/root?skip=0&take=100`)),
    )
  })

  test('a page of children, from the wide section and a deep one', async () => {
    const pages = Math.max(1, Math.floor(WIDE / 100))
    record(
      'tree children',
      await time(SAMPLES, (n) =>
        h.json(
          n % 2 === 0
            ? `${V1}/tree/document/children?parentId=${wide.key}&skip=${(n % pages) * 100}&take=100`
            : `${V1}/tree/document/children?parentId=${deep.key}&skip=0&take=100`,
        ),
      ),
    )
  })

  test('the siblings around a page in the wide section', async () => {
    const archive = made.filter((page) => page.parent === wide.key)
    record(
      'tree siblings',
      await time(SAMPLES, (n) => {
        const target = archive[Math.floor((n / SAMPLES) * archive.length)] ?? archive[0]
        return h.json(`${V1}/tree/document/siblings?target=${target?.key}&before=50&after=50`)
      }),
    )
  })

  test('a full rebuild of the published cache', async () => {
    const snapshot = await h.server.cache.snapshot()
    expect(snapshot).toBeDefined()
    record(
      'cache rebuild',
      await time(3, async () => {
        h.server.cache.invalidate()
        await h.server.cache.snapshot()
      }),
    )
  })

  test('a page render, once the cache is built', async () => {
    await h.server.cache.snapshot()
    const first = await h.server.fetch(new Request(`${ORIGIN}${made[made.length - 1]?.route}`))
    expect(first.status).toBe(200)
    record(
      'page render',
      await time(SAMPLES * 4, async (n) => {
        const page = made[(n * 7919) % made.length]
        const response = await h.server.fetch(new Request(`${ORIGIN}${page?.route ?? '/'}`))
        await response.text()
      }),
    )
  })
})
