/**
 * View snapshots as real processes: a template change reaching a renderer, and
 * the resources that change costs being bounded.
 *
 * `tests/view-snapshots.test.ts` holds the mechanism with a clock the test
 * moves; `tests/views-reload.test.ts` holds two servers in one process. What
 * only separate processes can show is the part that matters here: each node has
 * its own module registry and its own snapshot directory, so a change has to
 * travel, and the generations it leaves behind must not accumulate without end.
 *
 * The resource case is the reason the budget exists. A template is server-side
 * code, so anyone who can save one can already run code here — the cap is not a
 * privilege boundary, it is protection against an accident: an autosave loop, a
 * flapping sync job, a stuck deploy. Left unbounded each distinct tree leaks a
 * generation into the runtime's registry for the life of the process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'packages/cli/bin/bunbraco.ts')
interface Run {
  code: number
  out: string
}

interface Serving {
  url: string
  banner: string
  cacheDir: string
  stop(): Promise<void>
}

describe('view snapshots, across processes', () => {
  let dir: string
  const site = () => join(dir, 'site')
  const running: Serving[] = []
  let web: Serving

  const viewsDir = () => join(site(), 'Views')

  function environment(
    role: string | undefined,
    cacheDir?: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const inherited = { ...(process.env as Record<string, string>) }
    for (const name of [
      'BUNBRACO_VIEWS_DIR',
      'BUNBRACO_SCHEMA_DIR',
      'BUNBRACO_MEDIA_DIR',
      'BUNBRACO_CSS_DIR',
      'BUNBRACO_SCRIPTS_DIR',
      'BUNBRACO_SITE_NAME',
    ])
      delete inherited[name]
    return {
      ...inherited,
      BUNBRACO_DB: 'sqlite',
      BUNBRACO_SQLITE_FILE: join(dir, 'shared.sqlite'),
      BUNBRACO_LOGS_DIR: join(dir, 'logs', role ?? 'all'),
      BUNBRACO_LOG_TO_CONSOLE: 'false',
      BUNBRACO_ADMIN_PASSWORD: 'integration-password',
      // A short gate, so a change nobody announced is noticed inside a test
      // rather than after the production interval.
      BUNBRACO_VIEWS_GATE_MS: '100',
      ...(cacheDir ? { BUNBRACO_VIEWS_CACHE_DIR: cacheDir } : {}),
      ...(role ? { BUNBRACO_ROLE: role } : {}),
      ...extra,
    }
  }

  async function collect(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<Run> {
    const timer = setTimeout(() => proc.kill(), 120_000)
    try {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { code: await proc.exited, out: `${out}${err}` }
    } finally {
      clearTimeout(timer)
    }
  }

  const cli = (role: string | undefined, ...args: string[]): Promise<Run> =>
    collect(
      Bun.spawn(['bun', CLI, ...args], {
        cwd: site(),
        env: environment(role),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )

  async function serve(
    role: string,
    options: { env?: Record<string, string>; args?: string[] } = {},
  ): Promise<Serving> {
    const args = options.args ?? []
    // Its own directory, as a deployed node has: a shared one would let one
    // node's boot clear generations another is serving.
    const cacheDir = join(dir, 'snapshots', `${role}-${running.length}`)
    const proc = Bun.spawn(['bun', CLI, 'start', '--keep-admin', ...args], {
      cwd: site(),
      env: {
        ...environment(role, cacheDir, options.env),
        NODE_ENV: 'production',
        PORT: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 120_000)
    const decoder = new TextDecoder()
    let banner = ''
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      banner += decoder.decode(chunk)
      if (banner.includes('└─')) break
    }
    clearTimeout(timer)
    const url = /(?:site|backoffice)\s+(http:\/\/[^\s/]+)/.exec(banner)?.[1] ?? ''
    if (!url) {
      const error = await new Response(proc.stderr).text()
      proc.kill()
      await proc.exited
      throw new Error(`the ${role} node did not start:\n${banner}${error}`)
    }
    const server: Serving = {
      url,
      banner,
      cacheDir,
      async stop() {
        proc.kill()
        await proc.exited
        const index = running.indexOf(server)
        if (index >= 0) running.splice(index, 1)
      },
    }
    running.push(server)
    return server
  }

  const page = async (node: Serving): Promise<string> =>
    await (await fetch(new URL('/', node.url))).text()

  const health = async (node: Serving) =>
    (await (await fetch(new URL('/health', node.url))).json()) as {
      views: { hash: string; generations: number; frozen: boolean; refused: string | null }
    }

  /** Polls until `check` passes: a change travels through the filesystem. */
  async function until(what: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (await check()) return
      await Bun.sleep(200)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  beforeAll(async () => {
    mkdirSync(join(ROOT, 'output'), { recursive: true })
    dir = mkdtempSync(join(ROOT, 'output', 'view-snapshots-'))
    mkdirSync(site(), { recursive: true })
    const init = await cli(undefined, 'init', '--name', 'Snapshot Site', '--template', 'basic')
    expect(init.code, init.out).toBe(0)
    // A layout the template goes through, so a component-only change is testable.
    mkdirSync(join(viewsDir(), 'components'), { recursive: true })
    writeFileSync(
      join(viewsDir(), 'components', 'layout.tsx'),
      'export const Layout = ({ children }) => <main data-layout="first">{children}</main>\n',
    )
    writeFileSync(
      join(viewsDir(), 'homePage.tsx'),
      `import { Layout } from './components/layout.tsx'
export default function Home({ model }) {
  return <Layout><h1>{model.value('title')}</h1></Layout>
}
`,
    )
    // The api node migrates and publishes the bundle; the renderer is what this
    // suite then watches, so the api node is only ever started, never asserted.
    await serve('api', { args: ['--bundle', 'bundles/basic', '--publish'] })
    web = await serve('web')
  }, 300_000)

  afterAll(async () => {
    for (const server of [...running]) await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a node names the generation it is serving, and keeps it on disk', async () => {
    const reported = (await health(web)).views
    expect(reported.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(reported.frozen).toBe(false)
    expect(existsSync(join(web.cacheDir, reported.hash))).toBe(true)
    // Started after the views were written, so it renders them.
    expect(await page(web)).toContain('data-layout="first"')
  }, 60_000)

  test('a component changed on disk reaches a running renderer, with no restart', async () => {
    const before = (await health(web)).views.hash
    writeFileSync(
      join(viewsDir(), 'components', 'layout.tsx'),
      'export const Layout = ({ children }) => <main data-layout="second">{children}</main>\n',
    )

    await until('the renderer to pick up the new layout', async () =>
      (await page(web)).includes('data-layout="second"'),
    )
    // A new generation, because the tree's content changed.
    expect((await health(web)).views.hash).not.toBe(before)
  }, 120_000)

  /**
   * The source stays the truth. `Views/` is what the template editor, `views
   * list` and `views check` read; a snapshot is only ever an import target, and
   * nothing user-facing should mention it.
   */
  test('the CLI reads the views, never the snapshot of them', async () => {
    const listed = await cli('api', 'views', 'list')
    expect(listed.code, listed.out).toBe(0)
    expect(listed.out).toContain('homePage')
    expect(listed.out).not.toContain('.bunbraco')

    const checked = await cli('api', 'views', 'check')
    expect(checked.code, checked.out).toBe(0)
    expect(checked.out).not.toContain('.bunbraco')

    // `status` names both, because which directory a node snapshots into is
    // something a deploy may need to set.
    const reported = await cli('api', 'status')
    expect(reported.out).toContain('snapshots in')
  }, 120_000)

  test('reverting a change returns to a generation already loaded', async () => {
    const first = (await health(web)).views.hash
    writeFileSync(
      join(viewsDir(), 'components', 'layout.tsx'),
      'export const Layout = ({ children }) => <main data-layout="third">{children}</main>\n',
    )
    await until('the third layout', async () => (await page(web)).includes('data-layout="third"'))
    const third = (await health(web)).views.hash
    expect(third).not.toBe(first)

    writeFileSync(
      join(viewsDir(), 'components', 'layout.tsx'),
      'export const Layout = ({ children }) => <main data-layout="second">{children}</main>\n',
    )
    await until('the second layout again', async () =>
      (await page(web)).includes('data-layout="second"'),
    )
    // The same hash as before, so flapping between two versions costs two
    // generations in total rather than one per write.
    expect((await health(web)).views.hash).toBe(first)
  }, 180_000)

  /**
   * The resource case. A node is driven past its generation budget with distinct
   * trees, and has to stop growing rather than keep loading: the views in use
   * keep serving, newer ones are refused, and the directory does not fill up.
   */
  describe('a node driven past its budget', () => {
    let bounded: Serving
    const limit = 4

    beforeAll(async () => {
      // A small budget and a small keep, so the behaviour is reachable in a test
      // rather than after 250 generations.
      bounded = await serve('web', {
        env: {
          BUNBRACO_VIEWS_GENERATION_LIMIT: String(limit),
          BUNBRACO_VIEWS_KEEP: '2',
          // No coalescing floor, so each distinct tree counts: the floor is what
          // would otherwise absorb this churn, and the budget is what has to
          // hold when it does not.
          BUNBRACO_VIEWS_SWAP_MS: '0',
        },
      })
    }, 180_000)

    afterAll(async () => {
      await bounded.stop()
    })

    test('keeps serving, stops loading, and leaves the disk bounded', async () => {
      const seen = new Set<string>()
      let frozenAt: string | undefined

      // Far more distinct trees than the node will load.
      for (let i = 0; i < 40; i++) {
        writeFileSync(
          join(viewsDir(), 'components', 'layout.tsx'),
          `export const Layout = ({ children }) => <main data-layout="v${i}">{children}</main>\n`,
        )
        // Every write is a render, as traffic would be.
        const body = await page(bounded)
        expect(body).toContain('data-layout=')
        const state = (await health(bounded)).views
        seen.add(state.hash)
        if (state.frozen && !frozenAt) frozenAt = state.hash
        await Bun.sleep(150)
      }

      const state = (await health(bounded)).views
      // It froze rather than loading one generation per write.
      expect(state.frozen).toBe(true)
      expect(state.refused).toContain('restart the node')
      expect(state.generations).toBeLessThanOrEqual(limit + 1)

      // Still serving, and serving the generation it froze on.
      const body = await page(bounded)
      expect(body).toContain('data-layout=')
      expect(state.hash).toBe(frozenAt as string)

      // And the orphans are gone: the current generation plus the few kept, not
      // one directory per write.
      const onDisk = readdirSync(bounded.cacheDir)
      expect(onDisk.length).toBeLessThanOrEqual(limit + 1)
      expect(onDisk.some((name) => name.startsWith('.partial-'))).toBe(false)
    }, 300_000)

    test('still answers health as ok, so a frozen node is not drained', async () => {
      const response = await fetch(new URL('/health', bounded.url))
      // A stale template must not become an outage: every node would freeze at
      // once under the same writer, and draining them all serves nothing.
      expect(response.status).toBe(200)
      expect((await response.json()).ok).toBe(true)
    }, 60_000)
  })
})
