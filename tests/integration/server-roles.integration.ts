/**
 * A split deployment as two real processes, which is what compose runs.
 *
 * `tests/server-roles.test.ts` holds the route gating in one process; this is
 * the part that can only be shown with two: the api node migrates and the web
 * node refuses to start until it has, both answer on their own port, and a
 * publish on the api node reaches the web node's cache through
 * `cache_instruction` rather than through anything they share in memory.
 *
 * SQLite here, with both processes on one file. That is sound for this test —
 * WAL, and every write lands on the api node — but not a topology to deploy:
 * `packages/data/src/locks.ts` coordinates SQLite writers in-process only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'packages/cli/bin/bunbraco.ts')
/** The one page the `basic` template publishes: its node name, and text from its view. */
const HOME = 'Home'
const HOME_TEXT = 'A new bunbraco site'

interface Run {
  code: number
  out: string
}

interface Serving {
  url: string
  banner: string
  stop(): Promise<void>
}

describe('a split deployment, as separate processes', () => {
  let dir: string
  const site = () => join(dir, 'site')
  const running: Serving[] = []
  let api: Serving
  let web: Serving
  /** A second renderer, because an instruction has to reach every node, not one. */
  let web2: Serving

  /**
   * One database for both processes, named explicitly: the suite's environment
   * points SQLite at `:memory:`, which would give each process a database of
   * its own and hide the whole point of the test.
   */
  function environment(role?: string): Record<string, string> {
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
      ...(role ? { BUNBRACO_ROLE: role } : {}),
    }
  }

  async function collect(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<Run> {
    const timer = setTimeout(() => proc.kill(), 60_000)
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

  async function serve(role: string, ...args: string[]): Promise<Serving> {
    // A log file is named for the date and the host, so two nodes of the same
    // role on one machine would otherwise interleave into one file.
    const logs = join(dir, 'logs', `${role}-${running.length}`)
    const proc = Bun.spawn(['bun', CLI, 'start', '--keep-admin', ...args], {
      cwd: site(),
      env: {
        ...environment(role),
        BUNBRACO_LOGS_DIR: logs,
        NODE_ENV: 'production',
        PORT: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 60_000)
    const decoder = new TextDecoder()
    let banner = ''
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      banner += decoder.decode(chunk)
      if (banner.includes('└─')) break
    }
    clearTimeout(timer)
    // `site` on a web node, `backoffice` on an api node: the banner names only
    // what that node serves, so the address is taken from whichever it printed.
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

  beforeAll(async () => {
    mkdirSync(join(ROOT, 'output'), { recursive: true })
    dir = mkdtempSync(join(ROOT, 'output', 'roles-'))
    mkdirSync(site(), { recursive: true })
    // The basic template, because propagation needs a page to publish.
    const init = await cli(undefined, 'init', '--name', 'Split Site', '--template', 'basic')
    expect(init.code, init.out).toBe(0)
  }, 120_000)

  /** Polls until `check` passes, for a change that travels through the database. */
  async function until(what: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      if (await check()) return
      await Bun.sleep(500)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  afterAll(async () => {
    for (const server of [...running]) await server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a web node refuses to start before anything has migrated the database', async () => {
    const attempt = await collect(
      Bun.spawn(['bun', CLI, 'start'], {
        cwd: site(),
        env: { ...environment('web'), PORT: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    expect(attempt.code, attempt.out).not.toBe(0)
    expect(attempt.out).toContain('does not migrate')
  }, 120_000)

  test('the api node migrates, then the web nodes start against it', async () => {
    api = await serve('api', '--bundle', 'bundles/basic', '--publish')
    expect(api.banner).toContain('role        api')
    // The api node is not the public site, so its banner does not offer one.
    expect(api.banner).not.toContain('site        http')

    web = await serve('web')
    web2 = await serve('web')
    expect(web.banner).toContain('role        web')
    expect(web.banner).not.toContain('backoffice  http')
    // Nothing to sign in to here, so nothing is printed — and nothing is reset.
    expect(web.banner).not.toContain('Sign in with')
  }, 180_000)

  test('each node answers on its own port, and only for what it serves', async () => {
    const health = await fetch(new URL('/health', web.url))
    expect(await health.json()).toMatchObject({ role: 'web' })

    const onApi = await fetch(new URL('/umbraco/management/api/v1/server/status', api.url))
    expect(onApi.status).toBe(200)

    // Not a refusal from the API but the absence of it: the site answered, and
    // the site has nothing at that path.
    const onWeb = await fetch(new URL('/umbraco/management/api/v1/server/status', web.url))
    expect(onWeb.status).toBe(404)
    expect(onWeb.headers.get('content-type')).not.toContain('json')
  }, 60_000)

  test('every web node serves what the api node imported and published', async () => {
    for (const node of [web, web2]) {
      const page = await fetch(new URL('/', node.url))
      expect(page.status, node.url).toBe(200)
      expect(await page.text()).toContain(HOME_TEXT)
    }
    // Separate processes, so separate caches behind separate identities.
    const ids = await Promise.all(
      [web, web2].map(
        async (node) => (await (await fetch(new URL('/health', node.url))).json()).nodeId,
      ),
    )
    expect(new Set(ids).size).toBe(2)
  }, 60_000)

  /**
   * The one thing only two processes can show: the web node holds its own
   * published cache, and an editorial change made on the api node reaches it
   * through `cache_instruction` rather than through anything shared in memory.
   */
  test('unpublishing on the api node empties every web node, and publishing fills them', async () => {
    const everyWebNode = async (status: number): Promise<boolean> => {
      const answers = await Promise.all(
        [web, web2].map(async (node) => (await fetch(new URL('/', node.url))).status),
      )
      return answers.every((answer) => answer === status)
    }

    const unpublish = await cli('api', 'content', 'unpublish', HOME)
    expect(unpublish.code, unpublish.out).toBe(0)
    await until('both web nodes to drop the unpublished page', () => everyWebNode(404))

    const publish = await cli('api', 'content', 'publish', HOME)
    expect(publish.code, publish.out).toBe(0)
    await until('both web nodes to serve the republished page', () => everyWebNode(200))
  }, 180_000)
})
