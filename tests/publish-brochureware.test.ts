/**
 * Publishing the product site to the platform.
 *
 * Nothing here reaches the network: the requests are built as data and the
 * fetcher is a fake, so what is asserted is the sequence a release performs —
 * ticket, upload, publish, wait — and that it stops at the first failure rather
 * than reporting a release as green over a refused bundle.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  archiveOf,
  BUNDLE_DIR,
  bundleFiles,
  type Fetcher,
  jobCall,
  PublishError,
  parseFlags,
  parseTarget,
  publish,
  publishCall,
  settled,
  type Target,
  TEMPLATE,
  ticketCall,
  uploadCall,
  VARIABLES,
} from '../scripts/publish-brochureware.ts'
import { findSite, SITES_DIR } from '../scripts/sites.ts'

const TARGET: Target = {
  url: 'https://console.crombolo.com',
  token: 'bbe_secret',
  organisation: '7f3e2a10-4b5c-4d6e-8f90-a1b2c3d4e5f6',
  site: '0c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  environment: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
}

const configured = (over: Record<string, string | undefined> = {}) => ({
  [VARIABLES.url]: TARGET.url,
  [VARIABLES.token]: TARGET.token,
  [VARIABLES.organisation]: TARGET.organisation,
  [VARIABLES.site]: TARGET.site,
  [VARIABLES.environment]: TARGET.environment,
  ...over,
})

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** A fetcher that answers each call in turn and records what it was sent. */
function recorder(responses: Response[]) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const fetcher: Fetcher = async (url, init) => {
    const body = init?.body
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof body === 'string' ? JSON.parse(body) : body,
    })
    const response = responses[calls.length - 1]
    if (!response) throw new Error(`No response prepared for call ${calls.length} to ${url}`)
    return response
  }
  return { fetcher, calls }
}

describe('the configuration', () => {
  test('needs every variable, and names the ones that are missing', () => {
    // A default for any of these would publish somewhere nobody asked for.
    const absent = parseTarget({})
    expect(absent).toHaveProperty('error')
    for (const name of Object.values(VARIABLES))
      expect([name, (absent as { error: string }).error.includes(name)]).toEqual([name, true])

    expect(parseTarget(configured({ [VARIABLES.token]: '   ' }))).toEqual({
      error: `Set ${VARIABLES.token}.`,
    })
  })

  test('refuses an id that is not an id, because a swap would read as a 404', () => {
    // The site and environment variables are adjacent in the workflow.
    expect(parseTarget(configured({ [VARIABLES.site]: 'marketing' }))).toEqual({
      error: `${VARIABLES.site} is not an id: marketing`,
    })
  })

  test('refuses to carry the token over plain http, except to localhost', () => {
    expect(
      parseTarget(configured({ [VARIABLES.url]: 'http://console.crombolo.com' })),
    ).toHaveProperty('error')
    expect(parseTarget(configured({ [VARIABLES.url]: 'http://localhost:3000' }))).toMatchObject({
      url: 'http://localhost:3000',
    })
    expect(parseTarget(configured({ [VARIABLES.url]: 'not a url' }))).toHaveProperty('error')
  })

  test('trims a trailing slash, so no path is ever built with two', () => {
    expect(
      parseTarget(configured({ [VARIABLES.url]: 'https://console.crombolo.com//' })),
    ).toMatchObject({ url: 'https://console.crombolo.com' })
  })

  test('does not check the token against a prefix the platform owns', () => {
    // Deliberate: hard-coding another repository's secret format here would
    // refuse a valid token the day that format changed. The platform refuses
    // what it does not recognise.
    expect(parseTarget(configured({ [VARIABLES.token]: 'anything' }))).toMatchObject({
      token: 'anything',
    })
  })
})

describe('the archive', () => {
  test('is the product site’s committed bundle, not its database', () => {
    // What a laptop's copy of the site holds is whatever was last done to it, so
    // publishing anything but the committed bundle would put that on the live site.
    expect(BUNDLE_DIR).toBe(join(SITES_DIR, 'crombolo', 'bundles', 'demo-crombolo'))
    expect(findSite(TEMPLATE)?.dir).toBe(join(SITES_DIR, 'crombolo'))
    const files = bundleFiles(BUNDLE_DIR)
    expect(files).toContain('bundle.json')
    expect(files.some((path) => path.startsWith('nodes/'))).toBe(true)
  })

  test('lists files sorted, with forward slashes whatever the platform', () => {
    const files = bundleFiles(BUNDLE_DIR)
    expect(files).toEqual([...files].sort())
    for (const path of files) expect([path, path.includes('\\')]).toEqual([path, false])
  })

  test('zips to the same bytes twice, so an unchanged bundle has one identity', () => {
    // `writeZip` fixes every timestamp and the entries are sorted, which is what
    // makes the hash below a hash of the content rather than of the moment.
    const first = archiveOf()
    const second = archiveOf()
    expect(first.sha256).toBe(second.sha256)
    expect(first.bytes.byteLength).toBe(second.bytes.byteLength)
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('refuses a directory that is not a bundle', () => {
    expect(() => archiveOf(join(BUNDLE_DIR, 'nodes'))).toThrow(/bundle\.json/)
  })
})

describe('the calls a publish makes', () => {
  test('ask for a ticket on the environment, with the size checked first', () => {
    // The size is checked before a ticket is issued, so nothing uploads for ten
    // minutes only to be refused.
    const call = ticketCall(TARGET, { filename: 'bundle.zip', bytes: 1234 })
    expect(call.url).toBe(
      `https://console.crombolo.com/v1/organisations/${TARGET.organisation}/sites/${TARGET.site}/environments/${TARGET.environment}/bundles`,
    )
    expect(call.init.method).toBe('POST')
    expect(JSON.parse(call.init.body as string)).toEqual({ filename: 'bundle.zip', bytes: 1234 })
  })

  test('upload straight to the store, carrying no credential', () => {
    // The bundle never streams through the control plane, so the ticket is the
    // authority and the token must not be attached to it.
    const call = uploadCall({ url: 'https://store.example/put?signed' }, new Uint8Array([1, 2]))
    expect(call.url).toBe('https://store.example/put?signed')
    expect(call.init.method).toBe('PUT')
    expect(JSON.stringify(call.init.headers)).not.toContain(TARGET.token)
  })

  test('publish the folder the ticket named, with the hash of what was sent', () => {
    const call = publishCall(TARGET, 'operations/bundles/abc', 'f'.repeat(64))
    expect(call.url).toEndWith('/publishes')
    expect(JSON.parse(call.init.body as string)).toEqual({
      bundle: 'operations/bundles/abc',
      sha256: 'f'.repeat(64),
    })
  })

  test('read the job by id, and send the token to do it', () => {
    const call = jobCall(TARGET, 'job-1')
    expect(call.url).toBe('https://console.crombolo.com/v1/jobs/job-1')
    expect(call.init.method).toBe('GET')
    expect(JSON.stringify(call.init.headers)).toContain(TARGET.token)
  })
})

describe('what a release does', () => {
  const archive = {
    bytes: new Uint8Array([1, 2, 3]),
    sha256: 'a'.repeat(64),
    files: ['bundle.json'],
  }
  const accepted = { publish: { id: 'publish-1' }, job: { id: 'job-1' } }
  const ticket = { bundle: 'operations/bundles/abc', url: 'https://store.example/put?signed' }

  test('tickets, uploads, publishes, then waits for the platform to finish', async () => {
    const { fetcher, calls } = recorder([
      ok(ticket),
      new Response(null, { status: 200 }),
      ok(accepted),
      ok({ state: 'running' }),
      ok({ state: 'succeeded' }),
    ])
    const result = await publish(TARGET, archive, {
      fetch: fetcher,
      sleep: async () => {},
    })
    expect(result).toEqual({
      bundle: ticket.bundle,
      publishId: 'publish-1',
      jobId: 'job-1',
      state: 'succeeded',
    })
    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT', 'POST', 'GET', 'GET'])
    // The hash sent with the publish is the hash of what was uploaded.
    expect(calls[2]?.body).toMatchObject({ sha256: archive.sha256 })
  })

  test('fails when the publish job fails, rather than reporting a green release', async () => {
    // The whole reason the release waits. A 202 means accepted, not applied.
    const { fetcher } = recorder([
      ok(ticket),
      new Response(null, { status: 200 }),
      ok(accepted),
      ok({ state: 'failed', error: 'the bundle was refused' }),
    ])
    const failure = publish(TARGET, archive, { fetch: fetcher, sleep: async () => {} })
    await expect(failure).rejects.toThrow(/failed.*the bundle was refused/)
  })

  test('treats a dead job as finished and failed, not as still running', async () => {
    // `dead` has run out of retries, so waiting for it would wait for ever.
    const { fetcher } = recorder([
      ok(ticket),
      new Response(null, { status: 200 }),
      ok(accepted),
      ok({ state: 'dead' }),
    ])
    await expect(
      publish(TARGET, archive, { fetch: fetcher, sleep: async () => {} }),
    ).rejects.toThrow(/dead/)
    expect(settled('dead')).toBe(true)
    expect(settled('queued')).toBe(false)
    expect(settled('running')).toBe(false)
  })

  test('gives up after the timeout instead of holding the release open', async () => {
    let clock = 0
    const { fetcher } = recorder([
      ok(ticket),
      new Response(null, { status: 200 }),
      ok(accepted),
      ok({ state: 'running' }),
      ok({ state: 'running' }),
    ])
    const failure = publish(TARGET, archive, {
      fetch: fetcher,
      timeoutMs: 10_000,
      sleep: async () => {
        clock += 20_000
      },
      now: () => clock,
    })
    await expect(failure).rejects.toThrow(/still running after 10s/)
  })

  test('stops at the first failure, so nothing is published after a bad upload', async () => {
    const { fetcher, calls } = recorder([ok(ticket), new Response('nope', { status: 403 })])
    const failure = publish(TARGET, archive, { fetch: fetcher, sleep: async () => {} })
    await expect(failure).rejects.toBeInstanceOf(PublishError)
    expect(calls).toHaveLength(2)
  })

  test('says which step failed and what came back', async () => {
    const { fetcher } = recorder([new Response('no such environment', { status: 404 })])
    try {
      await publish(TARGET, archive, { fetch: fetcher, sleep: async () => {} })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PublishError)
      const failure = error as PublishError
      expect(failure.step).toBe('Asking for an upload ticket')
      expect(failure.status).toBe(404)
      expect(failure.detail).toContain('no such environment')
    }
  })

  test('can be told not to wait, for a hand-run publish', async () => {
    const { fetcher, calls } = recorder([
      ok(ticket),
      new Response(null, { status: 200 }),
      ok(accepted),
    ])
    const result = await publish(TARGET, archive, { fetch: fetcher, wait: false })
    expect(result.state).toBeUndefined()
    expect(calls).toHaveLength(3)
  })
})

describe('the flags', () => {
  test('default to waiting and to actually publishing', () => {
    expect(parseFlags([])).toEqual({ dryRun: false, wait: true, timeoutMs: 600_000 })
  })

  test('read each spelling the docstring offers', () => {
    expect(parseFlags(['--dry-run'])).toMatchObject({ dryRun: true })
    expect(parseFlags(['--no-wait'])).toMatchObject({ wait: false })
    expect(parseFlags(['--timeout', '30'])).toMatchObject({ timeoutMs: 30_000 })
  })

  test('refuse an unknown flag rather than ignoring it', () => {
    // A typo that was ignored would publish with the wrong behaviour silently.
    expect(parseFlags(['--no-weight'])).toEqual({ error: 'There is no flag "--no-weight".' })
    expect(parseFlags(['--timeout', 'soon'])).toHaveProperty('error')
    expect(parseFlags(['--timeout', '0'])).toHaveProperty('error')
  })
})
