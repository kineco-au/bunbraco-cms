#!/usr/bin/env bun
/**
 * Publishes the product site's content bundle to the platform.
 *
 *   bun run brochureware:publish              publish it
 *   bun run brochureware:publish --dry-run    say what it would do, send nothing
 *   bun run brochureware:publish --no-wait    return once accepted
 *
 * What is published is the committed bundle under
 * `sites/crombolo/bundles/demo-crombolo`, written by `bun run build:template`, so
 * the platform gets what the repository holds rather than whatever a laptop's
 * copy of the site happens to have in its database.
 *
 * It goes through the ordinary customer path: an upload ticket, a PUT straight
 * to the store, then a publish, authenticated with a scoped `deploy` token.
 * The platform runs our own site as an ordinary tenant, and a private path for
 * ourselves would stop us testing the real one.
 *
 * A release publishes to **preview**, never straight to production. The live
 * marketing site is promoted by hand once somebody has looked at it.
 *
 * See `docs/stories/.../115-we-are-our-own-first-customer.md` in
 * crombolo-enterprise for why this is a release step rather than a chore.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { readBundlePackage } from '@crombolo/backoffice-host'
import { writeZip, type ZipEntry } from '../packages/server/src/zip.ts'
import { SITES_DIR, slugOf } from './sites.ts'

/** The site whose bundle is the product site. */
export const TEMPLATE = 'demo/crombolo'

export const BUNDLE_DIR = join(SITES_DIR, 'crombolo', 'bundles', slugOf(TEMPLATE))

/** Where the bundle is sent. Every one is required: a default would guess. */
export const VARIABLES = {
  url: 'CROMBOLO_PLATFORM_URL',
  token: 'CROMBOLO_PLATFORM_TOKEN',
  organisation: 'CROMBOLO_PLATFORM_ORGANISATION',
  site: 'CROMBOLO_PLATFORM_SITE',
  environment: 'CROMBOLO_PLATFORM_ENVIRONMENT',
} as const

export interface Target {
  /** The control plane's base address, without a trailing slash. */
  url: string
  token: string
  organisation: string
  site: string
  environment: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The target, or why there isn't one.
 *
 * The ids are checked for shape rather than only for presence: two of the three
 * are adjacent in the workflow, and a swapped pair would otherwise surface as a
 * 404 against a name nobody can read.
 */
export function parseTarget(env: Record<string, string | undefined>): Target | { error: string } {
  const missing = Object.values(VARIABLES).filter((name) => !env[name]?.trim())
  if (missing.length > 0) return { error: `Set ${missing.join(', ')}.` }

  const url = (env[VARIABLES.url] as string).trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { error: `${VARIABLES.url} is not a URL: ${url}` }
  }
  // Anything but localhost carries a deploy token over the wire.
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost')
    return { error: `${VARIABLES.url} must be https, not ${parsed.protocol}` }

  for (const key of ['organisation', 'site', 'environment'] as const) {
    const value = (env[VARIABLES[key]] as string).trim()
    if (!UUID.test(value)) return { error: `${VARIABLES[key]} is not an id: ${value}` }
  }

  return {
    url,
    token: (env[VARIABLES.token] as string).trim(),
    organisation: (env[VARIABLES.organisation] as string).trim(),
    site: (env[VARIABLES.site] as string).trim(),
    environment: (env[VARIABLES.environment] as string).trim(),
  }
}

/** Every file in the bundle, relative and sorted, so the archive is stable. */
export function bundleFiles(dir: string): string[] {
  const found: string[] = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) found.push(relative(dir, path).split(sep).join('/'))
    }
  }
  walk(dir)
  return found.sort()
}

export interface Archive {
  bytes: Uint8Array<ArrayBuffer>
  sha256: string
  files: string[]
}

/**
 * The bundle package as one zip: its `package.json` and the payload beside it.
 *
 * Deterministic: `writeZip` fixes every timestamp, and the entries are sorted,
 * so unchanged content produces identical bytes and the hash below is a real
 * identity for the content rather than for the moment it was packed.
 */
export function archiveOf(dir = BUNDLE_DIR): Archive {
  const files = bundleFiles(dir)
  const { bundle, problems } = readBundlePackage(dir)
  if (!bundle?.carries.content)
    throw new Error(
      `${dir} is not a bundle package with content${problems.length > 0 ? `: ${problems.join('; ')}` : ''}.`,
    )
  const entries: ZipEntry[] = files.map((path) => ({
    path,
    bytes: new Uint8Array(readFileSync(join(dir, path))),
  }))
  const bytes = writeZip(entries)
  return {
    bytes,
    sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    files,
  }
}

const environmentPath = (target: Target) =>
  `${target.url}/v1/organisations/${target.organisation}/sites/${target.site}/environments/${target.environment}`

const authorised = (target: Target) => ({
  authorization: `Bearer ${target.token}`,
  'content-type': 'application/json',
})

export interface Call {
  url: string
  init: RequestInit
}

/** Somewhere to upload to. The size is checked before a ticket is issued. */
export function ticketCall(target: Target, upload: { filename: string; bytes: number }): Call {
  return {
    url: `${environmentPath(target)}/bundles`,
    init: { method: 'POST', headers: authorised(target), body: JSON.stringify(upload) },
  }
}

/** The bundle goes straight into the store, never through the control plane. */
export function uploadCall(ticket: { url: string }, bytes: Uint8Array<ArrayBuffer>): Call {
  return {
    url: ticket.url,
    init: {
      method: 'PUT',
      headers: { 'content-type': 'application/zip' },
      body: bytes,
    },
  }
}

export function publishCall(target: Target, bundle: string, sha256: string): Call {
  return {
    url: `${environmentPath(target)}/publishes`,
    init: { method: 'POST', headers: authorised(target), body: JSON.stringify({ bundle, sha256 }) },
  }
}

export function jobCall(target: Target, jobId: string): Call {
  return {
    url: `${target.url}/v1/jobs/${jobId}`,
    init: { method: 'GET', headers: { authorization: `Bearer ${target.token}` } },
  }
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead'

/** Still working, or finished. `dead` is finished — it has run out of retries. */
export function settled(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'dead'
}

export class PublishError extends Error {
  /** `status` is 0 for a failure the platform reported rather than refused. */
  constructor(
    readonly step: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(status ? `${step} failed with ${status}: ${detail}` : `${step} failed: ${detail}`)
  }
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface PublishOptions {
  fetch: Fetcher
  /** Poll until the job settles. Off returns as soon as it is accepted. */
  wait?: boolean
  timeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

export interface Published {
  bundle: string
  publishId: string
  jobId: string
  /** Absent when the run did not wait. */
  state?: JobState
}

async function send(step: string, call: Call, fetcher: Fetcher): Promise<Response> {
  const response = await fetcher(call.url, call.init)
  if (!response.ok)
    throw new PublishError(step, response.status, (await response.text()).slice(0, 500))
  return response
}

/**
 * Upload, publish, and wait for the platform to finish.
 *
 * Waiting is the point of running this in a release: a publish is a job, and
 * returning on the 202 would make a release green while the bundle was being
 * refused. The platform checks the bundle on the environment's own operations
 * node before touching the running site, so a refusal leaves the site as it was
 * and this reports it.
 */
export async function publish(
  target: Target,
  archive: Archive,
  options: PublishOptions,
): Promise<Published> {
  const {
    fetch: fetcher,
    wait = true,
    timeoutMs = 10 * 60_000,
    pollMs = 5_000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    log = () => {},
  } = options

  const ticket = (await (
    await send(
      'Asking for an upload ticket',
      ticketCall(target, {
        filename: 'bundle.zip',
        bytes: archive.bytes.byteLength,
      }),
      fetcher,
    )
  ).json()) as { bundle: string; url: string }
  log(`Uploading ${archive.files.length} files (${archive.bytes.byteLength} bytes).`)

  await send('Uploading the bundle', uploadCall(ticket, archive.bytes), fetcher)

  const accepted = (await (
    await send('Publishing', publishCall(target, ticket.bundle, archive.sha256), fetcher)
  ).json()) as { publish: { id: string }; job: { id: string } }
  const published: Published = {
    bundle: ticket.bundle,
    publishId: accepted.publish.id,
    jobId: accepted.job.id,
  }
  log(`Accepted as publish ${published.publishId}, job ${published.jobId}.`)
  if (!wait) return published

  const deadline = now() + timeoutMs
  for (;;) {
    const job = (await (
      await send('Reading the job', jobCall(target, published.jobId), fetcher)
    ).json()) as {
      state: string
      error?: string
    }
    if (settled(job.state)) {
      if (job.state !== 'succeeded')
        throw new PublishError('The publish', 0, `${job.state}${job.error ? `: ${job.error}` : ''}`)
      log('Published.')
      return { ...published, state: job.state as JobState }
    }
    if (now() >= deadline)
      throw new PublishError(
        'Waiting for the publish',
        0,
        `still ${job.state} after ${Math.round(timeoutMs / 1000)}s`,
      )
    await sleep(pollMs)
  }
}

export const USAGE = `bun run brochureware:publish [--dry-run] [--no-wait] [--timeout <seconds>]

Publishes ${TEMPLATE}'s bundle to the platform. Requires:
${Object.values(VARIABLES)
  .map((name) => `  ${name}`)
  .join('\n')}`

export interface Flags {
  dryRun: boolean
  wait: boolean
  timeoutMs: number
}

export function parseFlags(argv: readonly string[]): Flags | { error: string } {
  const flags: Flags = { dryRun: false, wait: true, timeoutMs: 10 * 60_000 }
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i] as string
    if (argument === '--dry-run') flags.dryRun = true
    else if (argument === '--no-wait') flags.wait = false
    else if (argument === '--timeout') {
      const seconds = Number(argv[++i])
      if (!Number.isFinite(seconds) || seconds <= 0)
        return { error: '--timeout takes a number of seconds.' }
      flags.timeoutMs = seconds * 1000
    } else return { error: `There is no flag "${argument}".` }
  }
  return flags
}

if (import.meta.main) {
  const flags = parseFlags(Bun.argv.slice(2))
  if ('error' in flags) {
    console.error(`${flags.error}\n\n${USAGE}`)
    process.exit(2)
  }

  const archive = archiveOf()
  const target = parseTarget(Bun.env)

  if (flags.dryRun) {
    console.log(`Would publish ${archive.files.length} files, ${archive.bytes.byteLength} bytes.`)
    console.log(`sha256 ${archive.sha256}`)
    console.log(
      'error' in target ? `Not configured: ${target.error}` : `To ${environmentPath(target)}`,
    )
    process.exit(0)
  }

  if ('error' in target) {
    console.error(`${target.error}\n\n${USAGE}`)
    process.exit(2)
  }

  try {
    await publish(target, archive, {
      fetch,
      wait: flags.wait,
      timeoutMs: flags.timeoutMs,
      log: (line) => console.log(line),
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
