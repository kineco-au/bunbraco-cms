/**
 * `bunbraco domains`, through the real CLI, against a site that is serving.
 *
 * `tests/domains.test.ts` tests the file and the sync; this tests the commands
 * and the end of the chain: a hostname written by `domains set` reaching the
 * page it names, over HTTP, in a server booted from that file alone.
 *
 * Named `*.integration.ts`, so `bun test` does not collect it: it spawns
 * processes and boots servers. `bun run test:integration` runs it, and CI does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'packages/cli/bin/bunbraco.ts')
const SITE = 'site'
/** `${SITE_HOST}` written so the linter does not read it as an unescaped template. */
const PLACEHOLDER = `\${SITE_HOST}`

interface Run {
  code: number
  out: string
}

interface Serving {
  url: string
  banner: string
  stop(): Promise<void>
}

describe('hostnames, end to end through the CLI', () => {
  let dir: string
  const running: Serving[] = []

  const siteDir = () => join(dir, SITE)
  const domainsFile = () => join(siteDir(), 'domains.toml')
  const readFile = (name: string) => readFileSync(join(siteDir(), name), 'utf8')

  /**
   * A scaffolded site is meant to work on its own defaults; the test
   * environment aims those at shared directories, so they are cleared.
   */
  function environment(extra: Record<string, string> = {}): Record<string, string> {
    const inherited = { ...(process.env as Record<string, string>) }
    for (const name of [
      'BUNBRACO_SQLITE_FILE',
      'BUNBRACO_VIEWS_DIR',
      'BUNBRACO_SCHEMA_DIR',
      'BUNBRACO_MEDIA_DIR',
      'BUNBRACO_CSS_DIR',
      'BUNBRACO_SITE_NAME',
    ])
      delete inherited[name]
    return {
      ...inherited,
      BUNBRACO_DB: 'sqlite',
      BUNBRACO_LOGS_DIR: join(dir, 'logs'),
      BUNBRACO_LOG_TO_CONSOLE: 'false',
      BUNBRACO_ADMIN_PASSWORD: 'integration-password',
      ...extra,
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

  function cli(args: string[], extra: Record<string, string> = {}): Promise<Run> {
    return collect(
      Bun.spawn(['bun', CLI, ...args], {
        cwd: siteDir(),
        env: environment(extra),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
  }

  async function serve(...args: string[]): Promise<Serving> {
    const proc = Bun.spawn(['bun', CLI, 'start', ...args], {
      cwd: siteDir(),
      env: { ...environment(), NODE_ENV: 'production', PORT: '0' },
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
    const url = /site\s+(http:\/\/\S+)/.exec(banner)?.[1] ?? ''
    if (!url) {
      const error = await new Response(proc.stderr).text()
      await proc.exited
      throw new Error(`the site did not start:\n${banner}${error}`)
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

  /** A request for `host`, sent to wherever the server is actually listening. */
  const visit = (server: Serving, host: string, path = '/') =>
    fetch(new URL(path, server.url), { headers: { host } })

  beforeAll(async () => {
    mkdirSync(join(ROOT, 'output'), { recursive: true })
    dir = mkdtempSync(join(ROOT, 'output', 'domains-cli-'))
    mkdirSync(siteDir(), { recursive: true })

    const init = await cli(['init', '--name', 'Harbourstone', '--template', 'basic'])
    expect(init.code, init.out).toBe(0)
    // One boot to land the template's page, so there is something to bind a
    // hostname to; every command below then runs against a site at rest.
    const first = await serve('--bundle', 'bundles/basic', '--publish')
    expect(first.banner).toContain('bundle')
    await first.stop()
  }, 180_000)

  afterAll(async () => {
    for (const server of [...running]) await server.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('says there is no file before one is written', async () => {
    const listed = await cli(['domains'])
    expect(listed.code, listed.out).toBe(0)
    expect(listed.out).toContain('No domains.toml')
    expect(existsSync(domainsFile())).toBe(false)
  })

  test('set writes the file and applies it in one step', async () => {
    const set = await cli(['domains', 'set', '/', '--host', 'harbourstone.example'])
    expect(set.code, set.out).toBe(0)
    expect(set.out).toContain('wrote    domains.toml')
    expect(set.out).toContain('applied  /')

    const file = readFile('domains.toml')
    expect(file).toContain('[[domain]]')
    expect(file).toContain('node = "/"')
    expect(file).toContain('host = "harbourstone.example"')

    const listed = await cli(['domains'])
    expect(listed.out).toContain('file     /')
    // What the file says, and what the database answers on.
    expect(listed.out).toContain('bound    Home')
    expect(listed.out).toContain('harbourstone.example')
  })

  test('and the site then answers on that hostname, booted from the file alone', async () => {
    const server = await serve()
    try {
      const response = await visit(server, 'harbourstone.example')
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('A new bunbraco site')
    } finally {
      await server.stop()
    }
  }, 60_000)

  test('a hostname from the environment is left unbound where the variable is not set', async () => {
    const set = await cli(['domains', 'set', '/', '--host', PLACEHOLDER])
    // Written, because it is for another environment; not applied here, and
    // the exit code says the command did not do everything it was asked.
    expect(set.out).toContain('wrote    domains.toml')
    expect(set.out).toContain('SITE_HOST')
    expect(set.code).toBe(1)
    expect(readFile('domains.toml')).toContain(PLACEHOLDER)

    const listed = await cli(['domains'])
    expect(listed.out).toContain('not set here')

    // With it set, the same file binds the hostname it was written for.
    const applied = await cli(['domains', 'apply'], { SITE_HOST: 'live.example' })
    expect(applied.code, applied.out).toBe(0)
    expect(applied.out).toContain('applied  /')
    expect(applied.out).toContain('live.example')

    const bound = await cli(['domains'], { SITE_HOST: 'live.example' })
    expect(bound.out).toContain(`${PLACEHOLDER} → live.example`)
    expect(bound.out).toContain('bound    Home')
  })

  test('undo puts back the file the last write replaced, and applies that', async () => {
    const undone = await cli(['domains', 'undo'])
    expect(undone.code, undone.out).toBe(0)
    expect(undone.out).toContain('restored domains.toml')
    expect(undone.out).toContain('harbourstone.example')
    expect(readFile('domains.toml')).toContain('harbourstone.example')

    const listed = await cli(['domains'])
    expect(listed.out).toContain('bound    Home')
    expect(listed.out).toContain('harbourstone.example')
  })

  test('clear unbinds the page, in the file and in the database', async () => {
    const cleared = await cli(['domains', 'clear', '/'])
    expect(cleared.code, cleared.out).toBe(0)
    expect(cleared.out).toContain('removed  1 binding(s)')
    expect(readFile('domains.toml')).not.toContain('[[domain]]')

    const listed = await cli(['domains'])
    expect(listed.out).not.toContain('bound    ')

    // And the site stops answering on it.
    const server = await serve()
    try {
      expect((await visit(server, 'harbourstone.example')).status).toBe(200)
      // No binding means no hostname routing: the request falls through to the
      // ordinary root, which is the behaviour a site without domains has.
      expect(await (await visit(server, 'harbourstone.example')).text()).toContain(
        'A new bunbraco site',
      )
    } finally {
      await server.stop()
    }
  }, 60_000)

  test('refuses a page it cannot find, and writes nothing', async () => {
    const before = existsSync(domainsFile()) ? readFile('domains.toml') : ''
    const refused = await cli(['domains', 'set', '/Nowhere', '--host', 'a.example'])
    expect(refused.code).toBe(1)
    expect(refused.out).toContain('Nowhere')
    expect(existsSync(domainsFile()) ? readFile('domains.toml') : '').toBe(before)
  })

  test('refuses a set with nothing to set', async () => {
    const refused = await cli(['domains', 'set', '/'])
    expect(refused.code).toBe(1)
    expect(refused.out).toContain('--host')
  })
})
