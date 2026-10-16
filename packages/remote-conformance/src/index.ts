/**
 * The conformance suite for the Crombolo remote protocol, version 1 (story
 * 107): what any implementation is held to, run against its own endpoint. It
 * needs nothing but `fetch`, so a host that is not this CMS runs it unchanged.
 * The specification is `docs/remote-protocol.md`.
 *
 * Read-only unless `push` is given: a push replaces the environment it goes to.
 * The checks that a push is refused for a wrong hash are always run, since a
 * conforming remote changes nothing for them.
 */

export interface ConformanceOptions {
  /** The site's origin, e.g. `https://example.com`. */
  url: string
  /** A bearer token from the device grant, for someone allowed to pull. */
  token: string
  /** The environment to test; the first one discovery names, when not given. */
  environment?: string
  /** At least 12 characters; the pulled file is sealed with it. */
  passphrase?: string
  /** Push the pulled file back, replacing the environment with itself. */
  push?: boolean
  /** How long to wait for a job, in milliseconds. */
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface ConformanceCheck {
  name: string
  ok: boolean
  skipped?: boolean
  detail?: string
}

export interface ConformanceReport {
  passed: boolean
  checks: ConformanceCheck[]
}

class Failed extends Error {}

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Failed(message)
}

type Json = Record<string, unknown>

export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const http = options.fetch ?? fetch
  const origin = options.url.replace(/\/+$/, '')
  const passphrase = options.passphrase ?? 'conformance suite passphrase'
  const timeout = options.timeoutMs ?? 5 * 60 * 1000
  const checks: ConformanceCheck[] = []
  const state: {
    discovery?: Json
    api?: string
    environment?: string
    may?: Json
    pulled?: { bytes: Uint8Array; sha256: string }
  } = {}

  const check = async (name: string, run: () => Promise<undefined | 'skip'>) => {
    try {
      const outcome = await run()
      checks.push(outcome === 'skip' ? { name, ok: true, skipped: true } : { name, ok: true })
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const authorised = (init: RequestInit = {}): RequestInit => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${options.token}`)
    return { ...init, headers }
  }
  const api = (path: string, init?: RequestInit) => http(`${state.api}/${path}`, authorised(init))
  const isProblem = (response: Response) =>
    (response.headers.get('content-type') ?? '').includes('application/problem+json')
  const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

  const settle = async (id: string): Promise<Json> => {
    const deadline = Date.now() + timeout
    for (;;) {
      const response = await api(`jobs/${id}`)
      assert(response.status === 200, `polling a job answered ${response.status}`)
      const job = (await response.json()) as Json
      if (job.state !== 'queued' && job.state !== 'running') return job
      assert(Date.now() < deadline, `the job was still ${job.state} after ${timeout} ms`)
      await Bun.sleep(Math.max(250, Number(job.pollAfter ?? 1) * 1000))
    }
  }

  await check('discovery names the protocol, versions, sign-in and environments', async () => {
    const response = await http(`${origin}/.well-known/crombolo-remote`)
    assert(response.status === 200, `answered ${response.status}`)
    const body = (await response.json()) as Json
    assert(body.protocol === 'crombolo-remote', 'protocol is not "crombolo-remote"')
    assert(
      Array.isArray(body.versions) && body.versions.includes('1'),
      'versions does not include "1"',
    )
    assert(typeof body.api === 'string', 'api is missing')
    const auth = body.auth as Json | undefined
    for (const field of ['deviceAuthorization', 'token', 'clientId'])
      assert(typeof auth?.[field] === 'string', `auth.${field} is missing`)
    const environments = body.environments as Json[] | undefined
    assert(Array.isArray(environments) && environments.length > 0, 'no environments')
    for (const env of environments ?? [])
      assert(
        typeof env.id === 'string' &&
          typeof env.name === 'string' &&
          typeof env.protected === 'boolean',
        'an environment lacks id, name or protected',
      )
    state.discovery = body
    state.api = String(body.api).replace(/\/+$/, '')
    state.environment = options.environment ?? String((environments?.[0] as Json | undefined)?.id)
  })
  if (!state.api) return { passed: false, checks }

  await check('the device authorization endpoint hands out codes', async () => {
    const auth = state.discovery?.auth as Json
    const response = await http(String(auth.deviceAuthorization), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: String(auth.clientId) }).toString(),
    })
    assert(response.status === 200, `answered ${response.status}`)
    const body = (await response.json()) as Json
    for (const field of ['device_code', 'user_code', 'verification_uri'])
      assert(typeof body[field] === 'string', `${field} is missing`)
    for (const field of ['expires_in', 'interval'])
      assert(typeof body[field] === 'number', `${field} is missing`)
  })

  await check('the API refuses a request without a token, as a problem', async () => {
    const response = await http(`${state.api}/environments`)
    assert(response.status === 401, `answered ${response.status}`)
    assert(isProblem(response), 'not application/problem+json')
  })

  await check('environments lists what the token may do', async () => {
    const response = await api('environments')
    assert(response.status === 200, `answered ${response.status}`)
    const list = (await response.json()) as Json[]
    const env = list.find((e) => e.id === state.environment)
    assert(env, `"${state.environment}" is not listed`)
    const may = env?.may as Json | undefined
    for (const field of ['pull', 'pullFull', 'push'])
      assert(typeof may?.[field] === 'boolean', `may.${field} is missing`)
    state.may = may
  })

  await check('an unknown job is not found', async () => {
    const response = await api(`jobs/${crypto.randomUUID()}`)
    assert(response.status === 404, `answered ${response.status}`)
    assert(isProblem(response), 'not application/problem+json')
  })

  await check('a pull without a passphrase is refused', async () => {
    if (!state.may?.pull) return 'skip'
    const response = await api(`environments/${state.environment}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert(response.status === 400, `answered ${response.status}`)
    assert(isProblem(response), 'not application/problem+json')
  })

  await check('a pull runs as a job and ends in a download whose hash it states', async () => {
    if (!state.may?.pull) return 'skip'
    const started = await api(`environments/${state.environment}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    })
    assert(started.status === 202, `starting answered ${started.status}`)
    const job = await settle(String(((await started.json()) as Json).id))
    assert(job.state === 'done', `the job ended ${job.state}: ${JSON.stringify(job.problem ?? {})}`)
    const download = job.download as Json | undefined
    assert(typeof download?.url === 'string', 'download.url is missing')
    const file = await http(String(download?.url), authorised())
    assert(file.status === 200, `the download answered ${file.status}`)
    const bytes = new Uint8Array(await file.arrayBuffer())
    assert(bytes[0] === 0x1f && bytes[1] === 0x8b, 'the download is not gzip')
    assert(sha256(bytes) === download?.sha256, 'the download does not match download.sha256')
    state.pulled = { bytes, sha256: sha256(bytes) }
  })

  await check('media links answer null for a file the remote does not have', async () => {
    const capabilities = (state.discovery?.capabilities as string[] | undefined) ?? []
    if (!capabilities.includes('media-fetch') || !state.may?.pull) return 'skip'
    const response = await api(`environments/${state.environment}/media/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: ['conformance/not-there.png'] }),
    })
    assert(response.status === 200, `answered ${response.status}`)
    const body = (await response.json()) as { links?: Record<string, unknown> }
    assert(body.links?.['conformance/not-there.png'] === null, 'the missing file was not null')
  })

  await check('a push whose file does not match its hash is refused', async () => {
    if (!state.may?.push || !state.pulled) return 'skip'
    const response = await api(`environments/${state.environment}/pushes`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/gzip',
        'crombolo-sha256': '0'.repeat(64),
        'crombolo-passphrase': passphrase,
      },
      body: state.pulled.bytes as BodyInit,
    })
    assert(response.status === 400, `answered ${response.status}`)
    assert(isProblem(response), 'not application/problem+json')
  })

  await check(
    'a push of the pulled file replaces the environment, or waits for approval',
    async () => {
      if (!options.push || !state.may?.push || !state.pulled) return 'skip'
      const response = await api(`environments/${state.environment}/pushes`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/gzip',
          'crombolo-sha256': state.pulled.sha256,
          'crombolo-passphrase': passphrase,
        },
        body: state.pulled.bytes as BodyInit,
      })
      assert(response.status === 202, `answered ${response.status}`)
      const started = (await response.json()) as Json
      if (started.state === 'approval-required') {
        assert(typeof started.approvalUrl === 'string', 'approvalUrl is missing')
        return
      }
      const job = await settle(String(started.id))
      assert(
        job.state === 'done',
        `the job ended ${job.state}: ${JSON.stringify(job.problem ?? {})}`,
      )
    },
  )

  return { passed: checks.every((c) => c.ok), checks }
}
