/**
 * Content-addressed snapshots of the views tree.
 *
 * Every case here is one the design was changed to handle, so each is a claim
 * about behaviour rather than a claim about code: a component-only change is
 * picked up, a burst collapses, flapping is cheap, an oversized tree is refused
 * and a node that has loaded its budget freezes rather than growing.
 *
 * The clock is supplied, so a TTL or a coalescing window is a number this test
 * moves rather than a sleep it waits out.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type SnapshotLimits, ViewSnapshots } from '@bunbraco/render'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const view = (marker: string) => `export default function P() { return '${marker}' }\n`

function site(files: Record<string, string> = { 'homePage.tsx': view('first') }) {
  mkdirSync(join(process.cwd(), 'output'), { recursive: true })
  const root = mkdtempSync(join(process.cwd(), 'output', 'snapshots-'))
  dirs.push(root)
  const sourceDir = join(root, 'components')
  for (const [name, content] of Object.entries(files)) {
    const file = join(sourceDir, name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  return { root, sourceDir, cacheDir: join(root, '.bunbraco', 'components') }
}

/** A clock the test moves, so no case waits for a real interval. */
function clock(start = 1_000_000) {
  let value = start
  return { now: () => value, advance: (ms: number) => (value += ms) }
}

async function snapshots(
  where: ReturnType<typeof site>,
  limits: Partial<SnapshotLimits> = {},
  time = clock(),
) {
  const taken = new ViewSnapshots({
    sourceDir: where.sourceDir,
    cacheDir: where.cacheDir,
    // Off by default: a test that cares about coalescing sets it.
    limits: { minSwapIntervalMs: 0, ...limits },
    now: time.now,
  })
  await taken.prepare()
  return { taken, time }
}

/** The gate is only consulted on a render, so this is what a render does. */
async function look(taken: ViewSnapshots, time: ReturnType<typeof clock>, ms = 10_000) {
  time.advance(ms)
  taken.directory()
  await taken.settle()
  return taken.directory()
}

describe('a views snapshot', () => {
  test('is a copy of the tree, named for its content', async () => {
    const where = site({ 'homePage.tsx': view('first'), 'components/layout.tsx': view('l') })
    const { taken } = await snapshots(where)
    const dir = taken.directory() as string

    expect(dir.startsWith(where.cacheDir)).toBe(true)
    expect(existsSync(join(dir, 'homePage.tsx'))).toBe(true)
    // Structure preserved, or a view's own relative imports would not resolve.
    expect(existsSync(join(dir, 'components', 'layout.tsx'))).toBe(true)
    expect(taken.status().hash).toBe(dir.split('/').at(-1))
    expect(taken.status().generations).toBe(1)
  })

  test('does not move while the tree does not', async () => {
    const where = site()
    const { taken, time } = await snapshots(where)
    const first = taken.directory()
    expect(await look(taken, time)).toBe(first as string)
    expect(taken.status().generations).toBe(1)
  })

  test('moves when a template changes', async () => {
    const where = site()
    const { taken, time } = await snapshots(where)
    const first = taken.directory()

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    const second = await look(taken, time)
    expect(second).not.toBe(first)
    expect(await Bun.file(join(second as string, 'homePage.tsx')).text()).toContain('second')
  })

  /** The case a per-file hash cannot see: the template's own bytes are identical. */
  test('moves when only a component a template imports changes', async () => {
    const where = site({
      'homePage.tsx': "import './components/layout.tsx'\nexport default () => 'p'\n",
      'components/layout.tsx': view('l1'),
    })
    const { taken, time } = await snapshots(where)
    const first = taken.directory()
    const template = await Bun.file(join(where.sourceDir, 'homePage.tsx')).text()

    writeFileSync(join(where.sourceDir, 'components', 'layout.tsx'), view('l2'))
    const second = await look(taken, time)

    expect(second).not.toBe(first)
    // Unchanged, which is exactly why the tree and not the file is the unit.
    expect(await Bun.file(join(second as string, 'homePage.tsx')).text()).toBe(template)
    expect(await Bun.file(join(second as string, 'components', 'layout.tsx')).text()).toContain(
      'l2',
    )
  })

  test('is the same generation again when a change is reverted', async () => {
    const where = site()
    const { taken, time } = await snapshots(where)
    const first = taken.directory()

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    const second = await look(taken, time)
    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('first'))
    const third = await look(taken, time)

    expect(second).not.toBe(first)
    // Flapping between two versions costs two generations in total, not four.
    expect(third).toBe(first as string)
    expect(taken.status().generations).toBe(2)
  })

  test('ignores a touch that changes no bytes', async () => {
    const where = site()
    const { taken, time } = await snapshots(where)
    const first = taken.directory()
    // A new mtime moves the gate; the content hash does not follow.
    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('first'))
    expect(await look(taken, time)).toBe(first as string)
    expect(taken.status().generations).toBe(1)
  })
})

describe('the gate in front of a snapshot', () => {
  test('is not consulted again until its interval has passed', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { gateTtlMs: 5_000 })
    const first = taken.directory()

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    expect(await look(taken, time, 1_000)).toBe(first as string)
    expect(await look(taken, time, 5_000)).not.toBe(first as string)
  })

  test('is consulted at once when a write is announced', async () => {
    const where = site()
    const { taken } = await snapshots(where, { gateTtlMs: 60_000 })
    const first = taken.directory()

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    taken.announce()
    // No time passed: the announcement is what makes this look.
    taken.directory()
    await taken.settle()
    expect(taken.directory()).not.toBe(first as string)
  })

  test('stops looking eagerly once it reaches the hash it was told about', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { gateTtlMs: 60_000 })

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    taken.announce()
    taken.directory()
    await taken.settle()
    const reached = taken.status().hash as string

    taken.announce(reached)
    taken.directory()
    await taken.settle()
    // Already there, so the window closes and the TTL governs again.
    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('third'))
    expect(await look(taken, time, 1_000)).toBe(
      taken.status().hash && (taken.directory() as string),
    )
    expect(await Bun.file(join(taken.directory() as string, 'homePage.tsx')).text()).toContain(
      'second',
    )
  })

  /**
   * A superseded hash must not keep a node eager for ever: it announces one
   * version, another writer lands a different one, and the announced hash is
   * now a state that never existed here.
   */
  test('gives up on a hash that is never reached when the window closes', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { gateTtlMs: 60_000, eagerWindowMs: 30_000 })
    const page = join(where.sourceDir, 'homePage.tsx')
    const marker = async () =>
      await Bun.file(join(taken.directory() as string, 'homePage.tsx')).text()

    // A hash no tree here will ever have: another writer landed a different one.
    taken.announce('a-hash-that-no-tree-here-has')

    // Inside the window every look checks, so this is picked up with no time
    // passing — and it converges on what is really there, not what it was told.
    writeFileSync(page, view('second'))
    taken.directory()
    await taken.settle()
    expect(await marker()).toContain('second')

    time.advance(1_000)
    writeFileSync(page, view('third'))
    taken.directory()
    await taken.settle()
    expect(await marker()).toContain('third')

    // Past the window the node stops looking eagerly, so the TTL governs again
    // and a change inside it is not seen.
    time.advance(30_000)
    const settled = taken.directory()
    writeFileSync(page, view('fourth'))
    expect(await look(taken, time, 1_000)).toBe(settled as string)
    expect(await marker()).toContain('third')

    // And is seen once the TTL has passed, which is the floor it falls back to.
    expect(await look(taken, time, 60_000)).not.toBe(settled as string)
    expect(await marker()).toContain('fourth')
  })
})

describe('the limits on a snapshot', () => {
  test('collapse a burst of writes into one generation, of the latest tree', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { minSwapIntervalMs: 10_000 })

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    await look(taken, time, 1_000)
    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('third'))
    await look(taken, time, 1_000)
    // Both writes fell inside the window, so neither has been taken yet.
    expect(taken.status().generations).toBe(1)

    await look(taken, time, 10_000)
    expect(taken.status().generations).toBe(2)
    expect(await Bun.file(join(taken.directory() as string, 'homePage.tsx')).text()).toContain(
      'third',
    )
  })

  /**
   * An editor must see their own save, not the template from ten seconds ago.
   * The floor is there to absorb a flapping sync, which nothing announces.
   */
  test('are skipped for a write this node made, which is not a burst', async () => {
    const where = site()
    const { taken } = await snapshots(where, { minSwapIntervalMs: 10_000 })
    const first = taken.directory()

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    const hash = await taken.refresh()

    expect(taken.directory()).not.toBe(first as string)
    // The hash reported is the one the write produced, so the node that wrote it
    // can tell the others where to arrive.
    expect(hash).toBe(taken.status().hash as string)
    expect(await Bun.file(join(taken.directory() as string, 'homePage.tsx')).text()).toContain(
      'second',
    )
  })

  test('refuse a tree with too many files, and keep serving the one in use', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { maxFiles: 1 })
    const first = taken.directory()

    writeFileSync(join(where.sourceDir, 'second.tsx'), view('second'))
    expect(await look(taken, time)).toBe(first as string)
    expect(taken.status().refused).toContain('over the 1')
    expect(taken.status().frozen).toBe(false)
  })

  test('refuse a tree that is too large, and keep serving the one in use', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { maxBytes: 32 })
    const first = taken.directory()

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('x'.repeat(200)))
    expect(await look(taken, time)).toBe(first as string)
    expect(taken.status().refused).toContain('KB a snapshot allows')
  })

  test('freeze at the generation budget rather than growing without end', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { maxGenerations: 2 })

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    const second = await look(taken, time)
    expect(taken.status().generations).toBe(2)

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('third'))
    const frozen = await look(taken, time)

    // The views in use keep serving; the newer tree is refused and said so.
    expect(frozen).toBe(second as string)
    expect(taken.status().frozen).toBe(true)
    expect(taken.status().refused).toContain('restart the node')
  })

  test('still return to a generation already loaded while frozen', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { maxGenerations: 2 })
    const first = taken.directory()

    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('second'))
    await look(taken, time)
    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('third'))
    await look(taken, time)
    expect(taken.status().frozen).toBe(true)

    // Back to the first tree: its modules are already in the registry, so this
    // costs nothing and must not be refused.
    writeFileSync(join(where.sourceDir, 'homePage.tsx'), view('first'))
    expect(await look(taken, time)).toBe(first as string)
  })

  test('leave only the generations worth keeping on disk', async () => {
    const where = site()
    const { taken, time } = await snapshots(where, { keep: 1 })
    for (const marker of ['second', 'third', 'fourth']) {
      writeFileSync(join(where.sourceDir, 'homePage.tsx'), view(marker))
      await look(taken, time)
    }
    // The current generation plus the one kept.
    expect(readdirSync(where.cacheDir).length).toBe(2)
  })
})

describe('a snapshot directory', () => {
  test('is cleared at boot, so a crashed copy is never imported', async () => {
    const where = site()
    mkdirSync(where.cacheDir, { recursive: true })
    const partial = join(where.cacheDir, '.partial-abc12345')
    mkdirSync(partial, { recursive: true })
    writeFileSync(join(partial, 'homePage.tsx'), view('half-written'))
    const stale = join(where.cacheDir, 'deadbeefdeadbeef')
    mkdirSync(stale, { recursive: true })

    const { taken } = await snapshots(where)
    expect(existsSync(partial)).toBe(false)
    expect(existsSync(stale)).toBe(false)
    expect(readdirSync(where.cacheDir)).toEqual([taken.status().hash as string])
  })

  test('is refused inside the views it copies, which would snapshot itself', () => {
    const where = site()
    expect(
      () =>
        new ViewSnapshots({
          sourceDir: where.sourceDir,
          cacheDir: join(where.sourceDir, '.cache'),
        }),
    ).toThrow(/must sit outside/)
  })
})
