/**
 * Exercises the whole server in-process, the way the backoffice does when it
 * boots. `createServer()` returns the fetch handler, so these run without
 * binding a port.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BACKOFFICE_PATH as BACKOFFICE } from '@bunbraco/core'
import { createServer } from '@bunbraco/server'
import { ROOT } from '../scripts/packages.ts'

const server = await createServer()
const { fetch: handler, paths } = server
// Its poller and background jobs would otherwise run on into later test files,
// against the database they share on Postgres
afterAll(() => server.close())
const vendored = existsSync(join(paths.vendorDir, 'umbraco-package.json'))
const V1 = '/umbraco/management/api/v1'

const get = (path: string, init?: RequestInit) =>
  handler(new Request(`http://localhost${path}`, init))

describe('boot sequence', () => {
  test('server/status is anonymous and reports Run', async () => {
    const response = await get(`${V1}/server/status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ serverStatus: 'Run' })
  })

  test('server/configuration is anonymous and complete', async () => {
    // A failure of either boot probe hard-redirects the client to its error page.
    const response = await get(`${V1}/server/configuration`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual([
      'allowLocalLogin',
      'allowPasswordReset',
      'signalR',
      'umbracoCssPath',
      'versionCheckPeriod',
    ])
    expect(typeof body.signalR.skipNegotiation).toBe('boolean')
  })

  test('reports skipNegotiation so the client can use a plain WebSocket', async () => {
    const body = await (await get(`${V1}/server/configuration`)).json()
    expect(body.signalR.skipNegotiation).toBe(true)
  })

  test('manifest/manifest/public is anonymous', async () => {
    const response = await get(`${V1}/manifest/manifest/public`)
    expect(response.status).toBe(200)
    expect(Array.isArray(await response.json())).toBe(true)
  })

  test('the token endpoint rejects definitively when there is no session', async () => {
    // A 400 with a JSON `error` member stops the client retrying; any other
    // shape is treated as transient and leaves the editor hanging.
    const response = await get(`${V1}/security/back-office/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&client_id=umbraco-back-office&refresh_token=%5Bredacted%5D',
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('invalid_grant')
  })

  test('secured boot endpoints 401 while unauthenticated', async () => {
    for (const path of [
      `${V1}/user/current`,
      `${V1}/manifest/manifest/private`,
      `${V1}/server/information`,
    ]) {
      const response = await get(path)
      expect(response.status).toBe(401)
    }
  })

  test('serves the committed contract so the client can be regenerated', async () => {
    const response = await get('/umbraco/management/api/openapi.json')
    expect(response.status).toBe(200)
    const spec = await response.json()
    expect(spec.info.title).toBe('Umbraco Management API')
  })
})

describe('shell', () => {
  test('is served for the SPA routes', async () => {
    for (const path of [
      BACKOFFICE,
      `${BACKOFFICE}/section/content`,
      `${BACKOFFICE}/oauth_complete`,
    ]) {
      const response = await get(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('<umb-app')
    }
  })

  test('is not served for an unrelated path under /umbraco', async () => {
    expect((await get(`${BACKOFFICE}/nonsense`)).status).toBe(404)
  })

  test('the front end 404s until Phase 4', async () => {
    expect((await get('/')).status).toBe(404)
  })
})

describe.skipIf(!vendored)('vendored assets over HTTP', () => {
  test('serves the entry module with a JavaScript content type', async () => {
    const response = await get(`${paths.assetsPath}/apps/app/app.element.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
  })

  test('honours If-None-Match', async () => {
    const first = await get(`${paths.assetsPath}/css/light.css`)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const second = await get(`${paths.assetsPath}/css/light.css`, {
      headers: { 'if-none-match': etag as string },
    })
    expect(second.status).toBe(304)
  })

  test('serves the branding graphics the shells reference', async () => {
    const response = await get(`${V1}/security/back-office/graphics/login-logo`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('svg')
  })

  /**
   * The strongest automated proxy for "the backoffice boots without console
   * errors": walk every module reachable from the entry point, resolving bare
   * specifiers through the served import map, and assert nothing 404s and
   * nothing is left unresolvable.
   *
   * This is the check that catches the class of breakage described in
   * docs/04-backoffice-hosting.md — npm shipping re-export stubs, and Vite-only
   * import suffixes.
   */
  test('the entire module graph resolves', async () => {
    const shell = await (await get(BACKOFFICE)).text()
    const importmap: Record<string, string> = JSON.parse(
      /<script type="importmap">([\s\S]*?)<\/script>/.exec(shell)?.[1] as string,
    ).imports
    const entry = /<script type="module" src="([^"]+)"/.exec(shell)?.[1] as string

    const transpiler = new Bun.Transpiler({ loader: 'js' })
    const seen = new Set<string>()
    const broken: string[] = []
    const unmapped = new Set<string>()
    const queue = [entry]

    while (queue.length > 0) {
      const url = queue.pop() as string
      if (seen.has(url)) continue
      seen.add(url)
      const response = await get(url)
      if (!response.ok) {
        broken.push(`${response.status} ${url}`)
        continue
      }
      if (!(response.headers.get('content-type') ?? '').includes('javascript')) continue
      for (const { path } of transpiler.scanImports(await response.text())) {
        if (path.startsWith('.')) queue.push(new URL(path, `http://localhost${url}`).pathname)
        else if (path.startsWith('/')) queue.push(path)
        else if (importmap[path]) queue.push(importmap[path] as string)
        else unmapped.add(path)
      }
    }

    expect(broken).toEqual([])
    expect([...unmapped]).toEqual([])
    // Guards against the crawl silently collapsing to a handful of modules. It
    // crawled over 6,000 before the client was bundled; what is served now is
    // the import map's entry points and their shared chunks, around 1,900.
    expect(seen.size).toBeGreaterThan(1000)
  }, 60_000)
})

/**
 * The other end of booting. These read the CLI rather than send it a signal: the
 * failure they guard against only appears as PID 1 of a container, where the
 * kernel drops a signal no handler was registered for — so what matters is that
 * the handlers exist at all, which outside a container no behaviour reveals.
 */
describe('shutting down', () => {
  const cli = readFileSync(join(ROOT, 'packages/cli/bin/bunbraco.ts'), 'utf8')

  test('handles both signals, because as PID 1 nothing else will', () => {
    // `bun` is PID 1 under `docker compose run`, and an unhandled SIGINT or
    // SIGTERM there is discarded rather than fatal: Ctrl-C did nothing at all,
    // and `docker stop` waited out its grace period and then sent SIGKILL.
    expect(cli).toContain("for (const signal of ['SIGINT', 'SIGTERM'] as const)")
    expect(cli).toContain('process.on(signal, () => stop(signal))')
  })

  test('closes the server rather than only the listener', () => {
    // `close()` is what stops the job runner, the event hubs, the component
    // watcher and the poller, and closes the database. Dropping the listener
    // alone would leave every one of them to die with the process.
    expect(cli).toContain('await server.close()')
  })

  test('closes live connections with it, which would otherwise never end', () => {
    // The live-update sockets are meant to stay open, so a drain that waited for
    // them would wait for ever.
    expect(cli).toContain('listening.stop(true)')
  })

  test('is registered as soon as it listens, leaving no deaf window', () => {
    const serving = cli.indexOf('Bun.serve(server.serveOptions)')
    const registered = cli.indexOf('stopOnSignal(listening, server)')
    expect(serving).toBeGreaterThan(0)
    expect(registered).toBeGreaterThan(serving)
    // Before the banner, which is the slow part of coming up.
    expect(registered).toBeLessThan(cli.indexOf('banner(lines)'))
  })

  test('gives up rather than hanging, on a second signal or a stuck close', () => {
    expect(cli).toContain('if (stopping) process.exit(130)')
    expect(cli).toMatch(/setTimeout\(\(\) => process\.exit\(130\), SHUTDOWN_MS\)\.unref\(\)/)
  })

  test('the handle it closes really has a close to call', async () => {
    // A rename upstream would make the assertions above pass and the shutdown
    // throw, so this is the one that holds them to something real.
    const fresh = await createServer()
    expect(typeof fresh.close).toBe('function')
    await fresh.close()
  })
})
