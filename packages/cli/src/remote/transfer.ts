/**
 * `crombolo pull` and `crombolo push` as functions (story 108): they take a
 * signed-in client and options, and return what happened; the binary prints.
 *
 * A pull is a job on the remote ending in a sealed file, opened here with a
 * passphrase made for that one pull and kept in memory. A push exports this
 * site sealed the same way, checks with the remote what it would replace, and
 * uploads it as a job — which the remote may hold for approval.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bootstrapDatabase,
  type CromboloConfig,
  exportSite,
  extractTarball,
  type MediaStore,
  mediaStoreFor,
} from '@crombolo/server'
import { type BundleBlob, loadBundle } from '@crombolo/transfer'
import { type Job, problemOf, type RemoteClient, RemoteError, sha256File } from './client.ts'

export type MediaMode = 'included' | 'omitted' | 'referenced'

/** A passphrase for one transfer: never shown, never stored. */
export const transferPassphrase = () => randomBytes(24).toString('base64url')

/** Refused before anything was sent: the CLI's own guard, exit code 2. */
export class RefusedBeforeSending extends Error {}

export interface PullResult {
  job: Job
  file: string
  passphrase: string
  size: number
}

/** Asks the remote for its site and downloads the file to `out`. */
export async function pullFile(
  client: RemoteClient,
  options: {
    environment: string
    out: string
    full?: boolean
    media?: MediaMode
    onProgress?(job: Job): void
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
): Promise<PullResult> {
  const environments = await client.environments()
  const env = environments.find((e) => e.id === options.environment)
  if (!env)
    throw new RefusedBeforeSending(
      `${client.discovery.name} has no environment "${options.environment}": it has ${environments.map((e) => e.id).join(', ')}.`,
    )
  if (!env.may.pull) throw new RefusedBeforeSending(`You may not pull from ${env.name}.`)
  if (options.full && !env.may.pullFull)
    throw new RefusedBeforeSending(
      `You may not pull a full copy of ${env.name}; pull without --full for an anonymised one.`,
    )
  if (options.media === 'referenced' && !client.discovery.capabilities.includes('media-fetch'))
    throw new RefusedBeforeSending(
      `${client.discovery.name} does not serve media by reference; pull without --media-info-only.`,
    )
  const passphrase = transferPassphrase()
  const started = await client.post<Job>(`environments/${env.id}/pulls`, {
    passphrase,
    full: options.full === true,
    media: options.media ?? 'included',
  })
  const job = await client.settle(started.id, {
    onProgress: options.onProgress,
    timeoutMs: options.timeoutMs,
    sleep: options.sleep,
  })
  if (job.state !== 'done') throw new RemoteError(job.problem ?? jobProblem(job))
  const { size } = await client.download(job, options.out)
  return { job, file: options.out, passphrase, size }
}

const jobProblem = (job: Job) => ({
  status: 0,
  code: job.state,
  title: `The ${job.kind} ended ${job.state}`,
})

/** What the local site has already fetched of a remote's media, by key: the remote's etag. */
const FETCHED_FILE = join('.crombolo', 'remote-media-fetched.json')

function readFetched(siteDir: string): Record<string, string> {
  const file = join(siteDir, FETCHED_FILE)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

export interface MediaFetchResult {
  fetched: number
  skipped: number
  bytes: number
  failed: string[]
}

/**
 * Fetches the media files a file names by reference into the local store, a
 * batch of links at a time and a few files at once. A file already fetched at
 * the same etag is skipped, so a second pull downloads only what changed.
 */
export async function fetchReferencedMedia(
  client: RemoteClient,
  options: {
    environment: string
    blobs: readonly Pick<BundleBlob, 'key' | 'etag'>[]
    store: MediaStore
    siteDir: string
    onProgress?(done: number, total: number): void
    http?: typeof fetch
  },
): Promise<MediaFetchResult> {
  const fetched = readFetched(options.siteDir)
  const result: MediaFetchResult = { fetched: 0, skipped: 0, bytes: 0, failed: [] }
  const wanted: string[] = []
  for (const blob of options.blobs) {
    const have = await options.store.get(blob.key)
    if (have && blob.etag && fetched[blob.key] === blob.etag) result.skipped++
    else wanted.push(blob.key)
  }
  let done = 0
  for (let at = 0; at < wanted.length; at += 200) {
    const batch = wanted.slice(at, at + 200)
    const { links } = await client.post<{
      links: Record<string, { url: string; etag: string; size: number } | null>
    }>(`environments/${options.environment}/media/links`, { keys: batch })
    const queue = [...batch]
    const worker = async () => {
      for (;;) {
        const key = queue.shift()
        if (!key) return
        const link = links[key]
        try {
          if (!link) throw new Error('not on the remote')
          // A link through the API needs the sign-in; a presigned one does not.
          const response = link.url.startsWith(client.discovery.api)
            ? await client.call(link.url)
            : await (options.http ?? fetch)(link.url)
          if (!response.ok) throw await problemOf(response)
          const body = await response.blob()
          await options.store.put(key, body)
          fetched[key] = link.etag
          result.fetched++
          result.bytes += body.size
        } catch {
          result.failed.push(key)
        }
        options.onProgress?.(++done, wanted.length)
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
  }
  mkdirSync(join(options.siteDir, '.crombolo'), { recursive: true })
  writeFileSync(join(options.siteDir, FETCHED_FILE), `${JSON.stringify(fetched, null, 2)}\n`)
  return result
}

/** The blobs a file names by reference, read from its manifest. */
export async function referencedBlobs(file: string): Promise<BundleBlob[]> {
  const dir = mkdtempSync(join(tmpdir(), 'crombolo-pulled-'))
  try {
    await extractTarball(file, dir)
    const manifest = loadBundle(join(dir, 'content')).set?.manifest
    return manifest?.media === 'referenced' ? manifest.blobs : []
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface PushCheck {
  environment: string
  recycles: Record<string, number>
  removesFiles: string[]
  keepsPeople: boolean
  /** Whether the remote answered it, or it is only what this side is sending. */
  fromRemote: boolean
  sending: { counts: Record<string, number>; files: number; media: number }
}

export interface PushResult {
  check: PushCheck
  job: Job
}

/**
 * Exports this site and sends it. `confirm` is asked with the check for a
 * protected environment unless `autoApprove`; `onApproval` hears the job when
 * the remote holds it for approval. The flags are this side's guard against a
 * slip, never authority: the remote decides.
 */
export async function pushSite(
  config: CromboloConfig,
  client: RemoteClient,
  options: {
    environment: string
    force?: boolean
    autoApprove?: boolean
    mediaInfoOnly?: boolean
    confirm?(check: PushCheck): Promise<boolean>
    onCheck?(check: PushCheck): void
    onProgress?(job: Job): void
    onApproval?(job: Job): void | Promise<void>
    onMedia?(done: number, total: number): void
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
): Promise<PushResult> {
  const environments = await client.environments()
  const env = environments.find((e) => e.id === options.environment)
  if (!env)
    throw new RefusedBeforeSending(
      `${client.discovery.name} has no environment "${options.environment}".`,
    )
  if (!env.may.push) throw new RefusedBeforeSending(`You may not push to ${env.name}.`)
  if (env.protected && !options.force)
    throw new RefusedBeforeSending(
      `${env.name} is protected: pushing replaces what people rely on. Pass --force to go on.`,
    )
  if (options.mediaInfoOnly && !client.discovery.capabilities.includes('media-fetch'))
    throw new RefusedBeforeSending(
      `${client.discovery.name} does not take media by reference; push without --media-info-only.`,
    )

  const work = mkdtempSync(join(tmpdir(), 'crombolo-push-'))
  try {
    const out = join(work, 'site.tgz')
    const passphrase = transferPassphrase()
    const { db } = await bootstrapDatabase(config)
    try {
      await exportSite(db, config, {
        out,
        sealContent: true,
        passphrase,
        media: options.mediaInfoOnly ? 'referenced' : true,
      })
    } finally {
      await db.close()
    }
    const unpacked = join(work, 'unpacked')
    await extractTarball(out, unpacked)
    const loaded = loadBundle(join(unpacked, 'content'))
    const manifest = loaded.set?.manifest
    if (!manifest) throw new Error('The export could not be read back.')
    const sending = {
      counts: { ...manifest.counts } as Record<string, number>,
      files: loaded.files.size,
      media: manifest.blobs.length,
    }
    const check: PushCheck = client.discovery.capabilities.includes('push-check')
      ? {
          ...(await client.post<Omit<PushCheck, 'fromRemote' | 'sending'>>(
            `environments/${env.id}/pushes/check`,
            {
              nodes: (loaded.set?.nodes ?? []).map((node) => node.key),
              files: [...loaded.files.keys()],
            },
          )),
          fromRemote: true,
          sending,
        }
      : {
          environment: env.id,
          recycles: {},
          removesFiles: [],
          keepsPeople: true,
          fromRemote: false,
          sending,
        }
    options.onCheck?.(check)
    if (env.protected && !options.autoApprove) {
      const yes = (await options.confirm?.(check)) ?? false
      if (!yes) throw new RefusedBeforeSending('Nothing was sent.')
    }

    if (options.mediaInfoOnly && manifest.blobs.length > 0) {
      const store = await mediaStoreFor(config)
      const { have } = await client.post<{ have: string[] }>(`environments/${env.id}/media/have`, {
        blobs: manifest.blobs.map((blob) => ({ key: blob.key, etag: blob.etag ?? undefined })),
      })
      const present = new Set(have)
      const missing = manifest.blobs.filter((blob) => !present.has(blob.key))
      let done = 0
      for (const blob of missing) {
        const file = await store.get(blob.key)
        if (file) {
          const bytes = await file.bytes()
          const response = await client.api(
            `environments/${env.id}/media/${blob.key.split('/').map(encodeURIComponent).join('/')}`,
            {
              method: 'PUT',
              headers: {
                'crombolo-sha256': new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
              },
              body: bytes as BodyInit,
            },
          )
          if (!response.ok) throw await problemOf(response)
        }
        options.onMedia?.(++done, missing.length)
      }
    }

    const response = await client.api(`environments/${env.id}/pushes`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/gzip',
        'crombolo-sha256': await sha256File(out),
        'crombolo-passphrase': passphrase,
      },
      body: Bun.file(out),
    })
    if (!response.ok) throw await problemOf(response)
    const started = (await response.json()) as Job
    const job = await client.settle(started.id, {
      onProgress: options.onProgress,
      onApproval: options.onApproval,
      timeoutMs: options.timeoutMs,
      sleep: options.sleep,
    })
    return { check, job }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
