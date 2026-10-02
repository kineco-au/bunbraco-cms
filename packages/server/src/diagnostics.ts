/**
 * Runtime diagnostics for a live node: a trace of every request, and a regular
 * report of the heap, memory and in-flight work. Off unless configured; the dev
 * stack turns both on (compose.yaml).
 *
 * The report counts in-flight requests twice, and the difference is the point.
 * Bun's `pendingRequests` holds a request until its response has been written;
 * ours releases it when the handler returns a `Response`. Bun's count staying
 * high while ours is idle means responses are being returned and never finished
 * — a stall in the transport, not in any handler.
 */
import { heapStats } from 'bun:jsc'
import { logger } from './logging.ts'

export interface DiagnosticsOptions {
  /** Log every request as it arrives and as its handler returns. */
  traceRequests: boolean
  /** Seconds between reports; 0 turns them off. */
  heapIntervalSeconds: number
  /** A handler still running after this long is named in the report. */
  slowRequestMs?: number
}

/** The part of Bun's server the report reads. */
export interface ServerCounts {
  readonly pendingRequests: number
  readonly pendingWebSockets: number
}

export interface DiagnosticsSample {
  /** What the JS heap has reserved. */
  heapMb: number
  /** What was live at the last collection, so it can read low just after one. */
  liveMb: number
  /** Memory held outside the heap by heap objects: buffers, file bodies. */
  externalMb: number
  rssMb: number
  /** Requests Bun has not finished, response bodies included. */
  pendingInBun: number | undefined
  pendingWebSockets: number | undefined
  /** Requests whose handler has not yet returned. */
  inHandlers: number
  slow: { method: string; path: string; ms: number }[]
}

type Fetch<S> = (request: Request, server: S) => Promise<Response | undefined>

export interface Diagnostics {
  /** `fetch`, traced and counted. Returns it unchanged when tracing and reports are both off. */
  wrap<S extends ServerCounts>(fetch: Fetch<S>): Fetch<S>
  sample(): DiagnosticsSample
  stop(): void
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const http = logger('http')
  const log = logger('diagnostics')
  const slowMs = options.slowRequestMs ?? 5_000
  const inFlight = new Map<number, { method: string; path: string; started: number }>()
  let next = 0
  let server: ServerCounts | undefined

  const sample = (): DiagnosticsSample => {
    const heap = heapStats()
    const now = performance.now()
    return {
      heapMb: mb(heap.heapCapacity),
      liveMb: mb(heap.heapSize),
      externalMb: mb(heap.extraMemorySize),
      rssMb: mb(process.memoryUsage().rss),
      pendingInBun: server?.pendingRequests,
      pendingWebSockets: server?.pendingWebSockets,
      inHandlers: inFlight.size,
      slow: [...inFlight.values()]
        .map((request) => ({
          method: request.method,
          path: request.path,
          ms: Math.round(now - request.started),
        }))
        .filter((request) => request.ms >= slowMs)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 10),
    }
  }

  const timer =
    options.heapIntervalSeconds > 0
      ? setInterval(() => {
          const s = sample()
          log.info(
            'Heap {heapMb} MB ({liveMb} MB live), external {externalMb} MB, RSS {rssMb} MB; requests pending in Bun {pendingInBun}, in handlers {inHandlers}; websockets {pendingWebSockets}',
            { ...s, slow: undefined },
          )
          for (const request of s.slow) {
            log.warning('Still in its handler after {ms} ms: {method} {path}', request)
          }
        }, options.heapIntervalSeconds * 1_000)
      : undefined
  timer?.unref()

  return {
    wrap(fetch) {
      if (!options.traceRequests && !timer) return fetch
      return async (request, bunServer) => {
        server = bunServer
        const id = next++
        const url = new URL(request.url)
        const path = `${url.pathname}${url.search}`
        const started = performance.now()
        inFlight.set(id, { method: request.method, path, started })
        if (options.traceRequests) http.debug('→ {method} {path}', { method: request.method, path })
        try {
          const response = await fetch(request, bunServer)
          if (options.traceRequests) {
            http.debug('← {status} {method} {path} {ms} ms', {
              status: response?.status ?? 'upgrade',
              method: request.method,
              path,
              ms: Math.round(performance.now() - started),
            })
          }
          return response
        } catch (error) {
          http.error('✗ {method} {path} threw after {ms} ms', {
            method: request.method,
            path,
            ms: Math.round(performance.now() - started),
            error,
          })
          throw error
        } finally {
          inFlight.delete(id)
        }
      }
    },
    sample,
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}
