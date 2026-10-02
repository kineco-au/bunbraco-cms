/**
 * Runtime diagnostics: the request trace and the heap report `docker compose up`
 * turns on. What matters is that the two in-flight counts are honest, since the
 * difference between them is what a stalled response looks like.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { configureLogging, createDiagnostics, loadConfig, logger } from '@bunbraco/server'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const server = (pendingRequests = 0) => ({ pendingRequests, pendingWebSockets: 1 })
const request = (path = '/a') => new Request(`http://localhost${path}`)

describe('the request wrapper', () => {
  test('is the handler itself when tracing and reports are both off', () => {
    const handler = async () => new Response('ok')
    expect(createDiagnostics({ traceRequests: false, heapIntervalSeconds: 0 }).wrap(handler)).toBe(
      handler,
    )
  })

  test('counts a request as in its handler until the handler returns', async () => {
    const diagnostics = createDiagnostics({ traceRequests: true, heapIntervalSeconds: 0 })
    let release: (value: Response) => void = () => {}
    const fetch = diagnostics.wrap(() => new Promise<Response>((resolve) => (release = resolve)))
    const pending = fetch(request(), server(7))
    expect(diagnostics.sample().inHandlers).toBe(1)
    // Bun's own count is read from the server the request arrived on
    expect(diagnostics.sample().pendingInBun).toBe(7)

    release(new Response('ok'))
    expect((await pending)?.status).toBe(200)
    expect(diagnostics.sample().inHandlers).toBe(0)
  })

  test('releases a request whose handler throws, and rethrows', async () => {
    const diagnostics = createDiagnostics({ traceRequests: true, heapIntervalSeconds: 0 })
    const fetch = diagnostics.wrap(async () => {
      throw new Error('boom')
    })
    await expect(fetch(request(), server())).rejects.toThrow('boom')
    expect(diagnostics.sample().inHandlers).toBe(0)
  })

  test('names a handler that has run past the threshold', async () => {
    const diagnostics = createDiagnostics({
      traceRequests: false,
      heapIntervalSeconds: 3600,
      slowRequestMs: 10,
    })
    let release: (value: Response) => void = () => {}
    const fetch = diagnostics.wrap(() => new Promise<Response>((resolve) => (release = resolve)))
    const pending = fetch(request('/slow?x=1'), server())
    await Bun.sleep(30)
    const { slow } = diagnostics.sample()
    expect(slow).toHaveLength(1)
    expect(slow[0]).toMatchObject({ method: 'GET', path: '/slow?x=1' })
    expect(slow[0]?.ms).toBeGreaterThanOrEqual(10)
    release(new Response('ok'))
    await pending
    diagnostics.stop()
  })
})

describe('the heap report', () => {
  test('measures the heap and the process', () => {
    const sample = createDiagnostics({ traceRequests: false, heapIntervalSeconds: 0 }).sample()
    expect(sample.heapMb).toBeGreaterThan(0)
    expect(sample.liveMb).toBeGreaterThanOrEqual(0)
    expect(sample.externalMb).toBeGreaterThanOrEqual(0)
    expect(sample.rssMb).toBeGreaterThan(0)
    // Before any request there is no server to ask
    expect(sample.pendingInBun).toBeUndefined()
  })
})

describe('configuration', () => {
  test('is off unless asked for', () => {
    const saved = { ...Bun.env }
    delete Bun.env.BUNBRACO_TRACE_REQUESTS
    delete Bun.env.BUNBRACO_HEAP_INTERVAL_SECONDS
    try {
      expect(loadConfig().diagnostics).toEqual({ traceRequests: false, heapIntervalSeconds: 0 })
      Bun.env.BUNBRACO_TRACE_REQUESTS = 'true'
      Bun.env.BUNBRACO_HEAP_INTERVAL_SECONDS = '30'
      expect(loadConfig().diagnostics).toEqual({ traceRequests: true, heapIntervalSeconds: 30 })
      Bun.env.BUNBRACO_HEAP_INTERVAL_SECONDS = 'soon'
      expect(loadConfig().diagnostics.heapIntervalSeconds).toBe(0)
    } finally {
      for (const key of ['BUNBRACO_TRACE_REQUESTS', 'BUNBRACO_HEAP_INTERVAL_SECONDS']) {
        if (saved[key] === undefined) delete Bun.env[key]
        else Bun.env[key] = saved[key]
      }
    }
  })

  test('keeps the request trace out of the files the log viewer reads', () => {
    const logsDir = mkdtempSync(join(process.cwd(), 'output', 'diagnostics-logs-'))
    dirs.push(logsDir)
    configureLogging({ logsDir, level: 'debug', console: false })
    logger('http').debug('→ {method} {path}', { method: 'GET', path: '/trace-me' })
    logger('diagnostics').info('Heap {heapMb} MB', { heapMb: 1 })

    const files = existsSync(logsDir) ? readdirSync(logsDir) : []
    const text = files.map((file) => readFileSync(join(logsDir, file), 'utf8')).join('')
    expect(text).toContain('Heap {heapMb} MB')
    expect(text).not.toContain('/trace-me')
  })
})
