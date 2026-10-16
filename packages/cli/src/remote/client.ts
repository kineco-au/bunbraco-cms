/**
 * The CLI's side of the remote protocol (story 108, `docs/remote-protocol.md`):
 * discovery, signing in by the device grant, and the API — jobs, downloads,
 * uploads and media — under a sign-in kept in the keychain and refreshed as it
 * runs out.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { freshAccessToken, type Keychain, readSignIn, saveSignIn } from '@crombolo/server'

export const PROTOCOL_VERSION = '1'

export interface Discovery {
  protocol: string
  versions: string[]
  name: string
  api: string
  auth: { deviceAuthorization: string; token: string; clientId: string; grantType: string }
  capabilities: string[]
  environments: Array<{ id: string; name: string; protected: boolean }>
}

export interface Problem {
  status: number
  code: string
  title: string
  detail?: string
  items?: string[]
}

export class RemoteError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title)
  }
}

export interface Job {
  id: string
  kind: 'pull' | 'push'
  environment: string
  state: 'queued' | 'running' | 'approval-required' | 'done' | 'failed' | 'refused'
  stage?: string | null
  progress?: number | null
  pollAfter?: number
  approvalUrl?: string
  download?: { url: string; expiresAt: string; size: number | null; sha256: string | null }
  problem?: Problem
  runId?: string
}

/** Reads a remote's discovery document; refuses a site that is not a remote, or one speaking only other versions. */
export async function discover(url: string, http: typeof fetch = fetch): Promise<Discovery> {
  const origin = new URL(url).origin
  let response: Response
  try {
    response = await http(`${origin}/.well-known/crombolo-remote`)
  } catch (error) {
    throw new Error(
      `${origin} could not be reached: ${error instanceof Error ? error.message : error}`,
    )
  }
  if (response.status === 404) throw new Error(`${origin} is not a crombolo remote.`)
  if (!response.ok)
    throw new Error(`${origin} answered ${response.status} for its discovery document.`)
  const body = (await response.json()) as Discovery
  if (body.protocol !== 'crombolo-remote') throw new Error(`${origin} is not a crombolo remote.`)
  if (!body.versions?.includes(PROTOCOL_VERSION))
    throw new Error(
      `${origin} speaks protocol ${body.versions?.join(', ') || 'none'}; this crombolo speaks ${PROTOCOL_VERSION}.`,
    )
  return body
}

/**
 * Signs in by the device grant (RFC 8628): `onCode` shows the person the code
 * and the page to approve it on, then this polls until they decide. The tokens
 * go into the keychain.
 */
export async function signIn(
  discovery: Discovery,
  keychain: Keychain,
  options: {
    clientName: string
    onCode(code: string, url: string): void | Promise<void>
    http?: typeof fetch
    sleep?: (ms: number) => Promise<void>
  },
): Promise<void> {
  const http = options.http ?? fetch
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const form = (url: string, fields: Record<string, string>) =>
    http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })
  const started = await form(discovery.auth.deviceAuthorization, {
    client_id: discovery.auth.clientId,
    client_name: options.clientName,
  })
  if (!started.ok) throw new Error(`The remote would not start a sign-in (${started.status}).`)
  const codes = (await started.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    verification_uri_complete?: string
    expires_in: number
    interval: number
  }
  await options.onCode(codes.user_code, codes.verification_uri_complete ?? codes.verification_uri)
  let interval = codes.interval * 1000
  const deadline = Date.now() + codes.expires_in * 1000
  for (;;) {
    await sleep(interval)
    const polled = await form(discovery.auth.token, {
      grant_type: discovery.auth.grantType,
      device_code: codes.device_code,
      client_id: discovery.auth.clientId,
    })
    const body = (await polled.json().catch(() => ({}))) as {
      error?: string
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (polled.ok && body.access_token) {
      await saveSignIn(keychain, discovery.api, {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? '',
        expiresAt: Date.now() + (body.expires_in ?? 0) * 1000,
        tokenUrl: discovery.auth.token,
        clientId: discovery.auth.clientId,
      })
      return
    }
    if (body.error === 'slow_down') interval += 5000
    else if (body.error === 'access_denied') throw new Error('The sign-in was declined.')
    else if (body.error === 'expired_token' || Date.now() > deadline)
      throw new Error('The code expired before it was approved. Sign in again.')
    else if (body.error !== 'authorization_pending')
      throw new Error(`The sign-in failed: ${body.error ?? polled.status}`)
  }
}

/** The protocol's API for one remote, as the signed-in person. */
export class RemoteClient {
  readonly discovery: Discovery
  #keychain: Keychain
  #http: typeof fetch

  constructor(discovery: Discovery, keychain: Keychain, http: typeof fetch = fetch) {
    this.discovery = discovery
    this.#keychain = keychain
    this.#http = http
  }

  async signedIn(): Promise<boolean> {
    return (await readSignIn(this.#keychain, this.discovery.api)) !== undefined
  }

  /** One authorised request; a 401 refreshes the sign-in once and tries again. */
  async call(url: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (force: boolean) => {
      const token = await freshAccessToken(this.#keychain, this.discovery.api, this.#http, force)
      if (!token)
        throw new RemoteError({
          status: 401,
          code: 'sign-in-required',
          title: `Not signed in to ${new URL(this.discovery.api).origin}`,
          detail: 'Run `crombolo login` first.',
        })
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${token}`)
      return this.#http(url, { ...init, headers })
    }
    const first = await attempt(false)
    if (first.status !== 401) return first
    return attempt(true)
  }

  async api(path: string, init: RequestInit = {}): Promise<Response> {
    return this.call(`${this.discovery.api}/${path}`, init)
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.api(path, init)
    if (!response.ok) throw await problemOf(response)
    return (await response.json()) as T
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  environments() {
    return this.json<
      Array<{
        id: string
        name: string
        protected: boolean
        may: { pull: boolean; pullFull: boolean; push: boolean }
      }>
    >('environments')
  }

  /** Waits for a job to stop moving, reporting each change; `onApproval` hears it once. */
  async settle(
    id: string,
    options: {
      onProgress?(job: Job): void
      onApproval?(job: Job): void | Promise<void>
      timeoutMs?: number
      sleep?: (ms: number) => Promise<void>
    } = {},
  ): Promise<Job> {
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000)
    let announced = false
    let last = ''
    for (;;) {
      const job = await this.json<Job>(`jobs/${id}`)
      const seen = `${job.state}|${job.stage ?? ''}|${job.progress ?? ''}`
      if (seen !== last) options.onProgress?.(job)
      last = seen
      if (job.state === 'approval-required' && !announced) {
        announced = true
        await options.onApproval?.(job)
      }
      if (job.state !== 'queued' && job.state !== 'running' && job.state !== 'approval-required')
        return job
      if (Date.now() > deadline) throw new TimedOut(job)
      await sleep((job.pollAfter ?? 2) * 1000)
    }
  }

  /** Streams a finished pull to `path`, checking it against the hash the job stated. */
  async download(job: Job, path: string): Promise<{ size: number }> {
    if (!job.download) throw new Error('The job has nothing to download.')
    const response = await this.call(job.download.url)
    if (!response.ok || !response.body) throw await problemOf(response)
    const hasher = createHash('sha256')
    const sink = createWriteStream(path)
    let size = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hasher.update(value)
      size += value.length
      if (!sink.write(value)) await new Promise((r) => sink.once('drain', r))
    }
    await new Promise<void>((resolve, reject) =>
      sink.end((error?: Error | null) => (error ? reject(error) : resolve())),
    )
    if (job.download.sha256 && hasher.digest('hex') !== job.download.sha256)
      throw new Error('The download does not match the hash the remote stated; try again.')
    return { size }
  }
}

/** A job still moving when the client stopped waiting. */
export class TimedOut extends Error {
  constructor(readonly job: Job) {
    super(`Still ${job.state} when the wait ran out.`)
  }
}

export async function problemOf(response: Response): Promise<RemoteError> {
  const body = (await response.json().catch(() => ({}))) as Partial<Problem>
  return new RemoteError({
    status: response.status,
    code: body.code ?? `http-${response.status}`,
    title: body.title ?? `The remote answered ${response.status}`,
    ...(body.detail ? { detail: body.detail } : {}),
    ...(body.items ? { items: body.items } : {}),
  })
}

/** SHA-256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hasher = createHash('sha256')
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest('hex')
}
