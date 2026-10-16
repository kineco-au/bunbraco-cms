/**
 * The remote protocol, version 1 (story 107): this server answering a
 * developer's `crombolo` — discovery, its one environment, pulls and pushes of
 * whole-site files as jobs, media by reference, and approval of protected
 * pushes. The contract is `docs/remote-protocol.md`; this is the reference
 * implementation of it.
 *
 * Off unless `remote.enabled`. A job runs in-process on the node that took the
 * request, its state in `remote_job` so any node can answer a poll, its file in
 * the media store so any node can serve the download. A node that stops leaves
 * its job's heartbeat to go stale, and the job is then reported failed.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { Principal } from '@crombolo/api-management'
import { DEVICE_CODE_GRANT, REMOTE_CLIENT_ID } from '@crombolo/auth'
import { MANAGEMENT_API_PATH, RemotePermissions, type RemoteVerb } from '@crombolo/core'
import { type Db, type RemoteJob, RemoteJobRepository } from '@crombolo/data'
import type { ContentSet } from '@crombolo/transfer'
import { recordAudit } from './adapters/audit.ts'
import { installBundleContent } from './bundle-install.ts'
import type { CromboloConfig } from './config.ts'
import { mediaStoreFor } from './media-files.ts'
import { type MediaStore, streamOf } from './media-store.ts'
import { openSecret, sealSecret, usableSecretKey } from './secrets.ts'
import { exportSite } from './site-file.ts'
import { replaceSummary } from './site-replace.ts'
import { extractTarball } from './tar.ts'

export const REMOTE_PROTOCOL_VERSION = '1'
export const REMOTE_DISCOVERY_PATH = '/.well-known/crombolo-remote'
export const REMOTE_API_PATH = '/umbraco/remote/v1'

/** How long a finished job's file stays downloadable, and its row with it. */
const JOB_FILE_SECONDS = 60 * 60
/** A running job not heard from in this long is reported failed. */
const STALE_SECONDS = 10 * 60
/** How long a protected push may wait for its approval. */
const APPROVAL_SECONDS = 24 * 60 * 60
const MIN_PASSPHRASE = 12
const MAX_LINKS = 500
const POLL_SECONDS = 2

export interface RemoteOptions {
  db: Db
  config: CromboloConfig
  authenticate(request: Request): Promise<Principal | undefined>
}

export interface Remote {
  /** Answers a remote path, or undefined when the path is not one. */
  handle(request: Request, url: URL): Promise<Response | undefined>
  /** Whether a request is an upload the remote takes beyond the usual body limit. */
  isUpload(request: Request, url: URL): boolean
}

interface Problem {
  code: string
  title: string
  detail?: string
  items?: string[]
}

const problem = (status: number, body: Problem) =>
  new Response(JSON.stringify({ status, ...body }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })

const may = (principal: Principal, verb: RemoteVerb) =>
  principal.isAdmin || principal.permissions.includes(verb)

/** A cookie-authenticated write must come from this site; a bearer token is a client's own. */
const fromThisSiteOrBearer = (request: Request) => {
  if (request.headers.get('authorization')?.toLowerCase().startsWith('bearer ')) return true
  const site = request.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(request.url).origin
}

/** The media store key of a job's file. */
const jobFileKey = (id: string, name: string) => `.remote/${id}/${name}`

async function sha256Of(path: string): Promise<{ sha256: string; size: number }> {
  const hasher = createHash('sha256')
  let size = 0
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk)
    size += chunk.length
  }
  return { sha256: hasher.digest('hex'), size }
}

export function createRemote(options: RemoteOptions): Remote {
  const { db, config } = options
  const settings = config.remote
  const jobs = new RemoteJobRepository(db)
  const secretKey = usableSecretKey(config.secretKey)
  let storePromise: Promise<MediaStore> | undefined
  const store = () => {
    storePromise ??= mediaStoreFor(config)
    return storePromise
  }

  const environment = () => ({
    id: settings.environment,
    name: settings.environment,
    protected: settings.protected,
  })

  const discovery = (origin: string) => ({
    protocol: 'crombolo-remote',
    versions: [REMOTE_PROTOCOL_VERSION],
    name: config.siteName,
    api: `${origin}${REMOTE_API_PATH}`,
    auth: {
      deviceAuthorization: `${origin}${MANAGEMENT_API_PATH}/security/back-office/device`,
      token: `${origin}${MANAGEMENT_API_PATH}/security/back-office/token`,
      clientId: REMOTE_CLIENT_ID,
      grantType: DEVICE_CODE_GRANT,
    },
    capabilities: ['media-fetch', 'push-check', ...(settings.approvals ? ['approvals'] : [])],
    environments: [environment()],
  })

  const audit = (principal: Principal, request: Request, action: string, detail: string) =>
    recordAudit(db, {
      category: 'system',
      action,
      source: 'request',
      userKey: principal.id,
      userName: principal.name,
      entityType: 'RemoteEnvironment',
      entityName: settings.environment,
      ipAddress: null,
      forwardedFor: request.headers.get('x-forwarded-for'),
      detail,
    })

  /** A job as the protocol shows it; a running one gone quiet is reported as failed. */
  const describe = async (job: RemoteJob, origin: string) => {
    let current = job
    const live = job.state === 'running' || job.state === 'queued'
    if (live && Date.now() - job.heartbeatAt.getTime() > STALE_SECONDS * 1000) {
      const stopped: Problem = {
        code: 'interrupted',
        title: 'The job stopped',
        detail: 'The server running it stopped before it finished. Start it again.',
      }
      await jobs.update(job.id, { state: 'failed', problem: stopped })
      current = { ...job, state: 'failed', problem: stopped }
    }
    const done = current.state === 'done'
    let download:
      | { url: string; expiresAt: string; size: number | null; sha256: string | null }
      | undefined
    // Always through this API, never the store's public URL: a CDN in front of
    // the media store would make a job's file world-readable.
    if (done && current.kind === 'pull' && current.fileKey)
      download = {
        url: `${origin}${REMOTE_API_PATH}/jobs/${current.id}/download`,
        expiresAt: current.expiresAt.toISOString(),
        size: current.fileSize,
        sha256: current.sha256,
      }
    return {
      id: current.id,
      kind: current.kind,
      environment: current.environment,
      state: current.state,
      stage: current.stage,
      progress: current.progress,
      requestedBy: current.requestedByName,
      createdAt: current.createdAt.toISOString(),
      ...(current.state === 'approval-required'
        ? {
            approvalUrl: `${origin}${config.backOfficePath}/remote-approval?job=${current.id}`,
            approvalExpiresAt: current.expiresAt.toISOString(),
          }
        : {}),
      ...(download ? { download } : {}),
      ...(current.runId ? { runId: current.runId } : {}),
      ...(current.problem ? { problem: current.problem } : {}),
      ...(live || current.state === 'approval-required' ? { pollAfter: POLL_SECONDS } : {}),
    }
  }

  /** Deletes jobs past their expiry, and their files. */
  const sweep = async () => {
    const media = await store()
    for (const job of await jobs.expired()) {
      if (job.state === 'approval-required')
        await jobs.update(job.id, {
          state: 'refused',
          secret: null,
          problem: { code: 'approval-expired', title: 'Nobody approved it in time' },
        })
      if (job.fileKey) await media.delete(job.fileKey).catch(() => {})
      // A finished job's row outlives its file by a day, so a late poll still learns why.
      if (Date.now() - job.expiresAt.getTime() > 24 * 60 * 60 * 1000) await jobs.delete(job.id)
    }
  }

  /** Runs a job's work in the background, recording a failure as the job's state. */
  const run = (id: string, work: () => Promise<void>) => {
    void (async () => {
      try {
        await work()
      } catch (error) {
        await jobs
          .update(id, {
            state: 'failed',
            problem: {
              code: 'failed',
              title: 'The job failed',
              detail: error instanceof Error ? error.message : String(error),
            },
          })
          .catch(() => {})
      }
    })()
  }

  const pullWork = (job: RemoteJob, passphrase: string) => async () => {
    const full = job.options.full === true
    const media = job.options.media as 'included' | 'omitted' | 'referenced'
    const out = join(tmpdir(), `crombolo-remote-${job.id}.tgz`)
    try {
      await jobs.update(job.id, { state: 'running', stage: 'exporting', progress: 10 })
      await exportSite(db, config, {
        out,
        media: media === 'included' ? true : media === 'referenced' ? 'referenced' : false,
        anonymise: !full,
        withMembers: full,
        withUsers: full,
        sealContent: true,
        passphrase,
      })
      await jobs.update(job.id, { stage: 'storing', progress: 80 })
      const { sha256, size } = await sha256Of(out)
      const key = jobFileKey(job.id, 'site.tgz')
      await (await store()).put(key, Bun.file(out), { contentType: 'application/gzip' })
      await jobs.update(job.id, {
        state: 'done',
        stage: 'ready',
        progress: 100,
        fileKey: key,
        fileSize: size,
        sha256,
        expiresAt: new Date(Date.now() + JOB_FILE_SECONDS * 1000),
      })
    } finally {
      await rm(out, { force: true })
    }
  }

  const pushWork = (jobId: string, passphrase: string, by: string) => async () => {
    const job = (await jobs.get(jobId)) as RemoteJob
    const local = join(tmpdir(), `crombolo-remote-${job.id}.tgz`)
    const dir = join(config.siteDir, '.crombolo', 'transfer', 'incoming', `remote-${job.id}`)
    try {
      await jobs.update(job.id, {
        state: 'running',
        stage: 'unpacking',
        progress: 10,
        secret: null,
      })
      const media = await store()
      const stored = job.fileKey ? await media.get(job.fileKey) : undefined
      if (!stored) throw new Error('The uploaded file is no longer in the store.')
      if (stored.localPath) await Bun.write(local, Bun.file(stored.localPath))
      else {
        const sink = createWriteStream(local)
        for await (const chunk of streamOf(stored))
          if (!sink.write(chunk)) await new Promise((r) => sink.once('drain', r))
        await new Promise<void>((resolve, reject) =>
          sink.end((error?: Error | null) => (error ? reject(error) : resolve())),
        )
      }
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await extractTarball(local, dir)
      await jobs.update(job.id, { stage: 'replacing', progress: 40 })
      // A backup wherever this server can take one; on Postgres that needs CROMBOLO_PG_DUMP.
      const canBackUp = config.dialect === 'sqlite' || Boolean(config.pgDump)
      const result = await installBundleContent(db, config, {
        bundle: dir,
        replace: 'replace',
        passphrase,
        backupTaken: !canBackUp,
        label: `push from ${by}`,
        by,
      })
      if (!result.runId) {
        const items = [
          ...result.problems,
          ...result.check.outstanding.map((finding) => finding.message),
        ]
        await jobs.update(job.id, {
          state: 'refused',
          stage: null,
          problem: { code: 'import-refused', title: 'The push was refused', items },
        })
        return
      }
      await jobs.update(job.id, {
        state: 'done',
        stage:
          result.backup.kind === 'none' || result.backup.kind === 'operator'
            ? 'replaced, no backup'
            : 'replaced',
        progress: 100,
        runId: result.runId,
        expiresAt: new Date(Date.now() + JOB_FILE_SECONDS * 1000),
      })
      await media.delete(job.fileKey as string).catch(() => {})
    } finally {
      await rm(local, { force: true })
      await rm(dir, { recursive: true, force: true })
    }
  }

  const passphraseProblem = (passphrase: string | null | undefined) =>
    !passphrase || passphrase.length < MIN_PASSPHRASE
      ? problem(400, {
          code: 'passphrase-required',
          title: `A passphrase of at least ${MIN_PASSPHRASE} characters is required`,
          detail: 'The file is sealed with it, so content travels unreadable.',
        })
      : undefined

  async function startPull(request: Request, url: URL, principal: Principal): Promise<Response> {
    if (!may(principal, RemotePermissions.Pull))
      return problem(403, { code: 'forbidden', title: 'You may not pull from this environment' })
    const body = (await request.json().catch(() => ({}))) as {
      full?: unknown
      media?: unknown
      passphrase?: unknown
    }
    const full = body.full === true
    if (full && !may(principal, RemotePermissions.PullFull))
      return problem(403, {
        code: 'forbidden',
        title: 'You may not pull a full copy',
        detail:
          'A full copy carries people; it needs its own permission. Pull an anonymised copy instead.',
      })
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : ''
    const refused = passphraseProblem(passphrase)
    if (refused) return refused
    const media = body.media === 'omitted' || body.media === 'referenced' ? body.media : 'included'
    await sweep()
    const job = {
      id: crypto.randomUUID(),
      kind: 'pull' as const,
      environment: settings.environment,
      requestedBy: principal.id,
      requestedByName: principal.name,
      options: { full, media },
      state: 'queued' as const,
      expiresAt: new Date(Date.now() + JOB_FILE_SECONDS * 1000),
    }
    await jobs.create(job)
    await audit(principal, request, 'RemotePull', `${full ? 'full' : 'anonymised'}, media ${media}`)
    const created = (await jobs.get(job.id)) as RemoteJob
    run(job.id, pullWork(created, passphrase))
    return Response.json(await describe(created, url.origin), { status: 202 })
  }

  /** Streams a request body to a file, hashing it as it goes; undefined when it is not what it claimed. */
  async function receive(
    request: Request,
    path: string,
  ): Promise<{ sha256: string; size: number } | undefined> {
    if (!request.body) return undefined
    const hasher = createHash('sha256')
    let size = 0
    const sink = createWriteStream(path)
    const reader = request.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > settings.maxUploadBytes) throw new Error('too large')
        hasher.update(value)
        if (!sink.write(value)) await new Promise((r) => sink.once('drain', r))
      }
    } finally {
      await new Promise<void>((resolve) => sink.end(() => resolve()))
    }
    return { sha256: hasher.digest('hex'), size }
  }

  async function startPush(request: Request, url: URL, principal: Principal): Promise<Response> {
    if (!may(principal, RemotePermissions.Push))
      return problem(403, { code: 'forbidden', title: 'You may not push to this environment' })
    if (settings.protected && !may(principal, RemotePermissions.PushProtected))
      return problem(403, {
        code: 'forbidden-protected',
        title: 'This environment is protected',
        detail: 'Pushing here replaces something people rely on, and needs its own permission.',
      })
    const declared = request.headers.get('crombolo-sha256')?.toLowerCase()
    const passphrase = request.headers.get('crombolo-passphrase')
    const refused = passphraseProblem(passphrase)
    if (refused) return refused
    if (!declared || !/^[0-9a-f]{64}$/.test(declared))
      return problem(400, { code: 'hash-required', title: 'Crombolo-Sha256 is required' })
    if (settings.protected && settings.approvals && !secretKey)
      return problem(503, {
        code: 'approvals-unavailable',
        title: 'Approvals need CROMBOLO_SECRET_KEY on the server',
      })

    await sweep()
    const id = crypto.randomUUID()
    const local = join(tmpdir(), `crombolo-remote-upload-${id}.tgz`)
    try {
      let received: { sha256: string; size: number } | undefined
      try {
        received = await receive(request, local)
      } catch {
        return problem(413, {
          code: 'too-large',
          title: 'The file is larger than this remote takes',
        })
      }
      if (!received)
        return problem(400, { code: 'body-required', title: 'The request carried no file' })
      if (received.sha256 !== declared)
        return problem(400, {
          code: 'hash-mismatch',
          title: 'The file is not the one described',
          detail:
            'Its SHA-256 does not match Crombolo-Sha256: it was changed or cut short on the way.',
        })
      const key = jobFileKey(id, 'upload.tgz')
      await (await store()).put(key, Bun.file(local), { contentType: 'application/gzip' })
      const waits = settings.protected && settings.approvals
      await jobs.create({
        id,
        kind: 'push',
        environment: settings.environment,
        requestedBy: principal.id,
        requestedByName: principal.name,
        options: {},
        state: waits ? 'approval-required' : 'queued',
        expiresAt: new Date(Date.now() + (waits ? APPROVAL_SECONDS : JOB_FILE_SECONDS) * 1000),
      })
      await jobs.update(id, {
        fileKey: key,
        fileSize: received.size,
        sha256: received.sha256,
        ...(waits && secretKey ? { secret: sealSecret(passphrase as string, secretKey) } : {}),
      })
      await audit(principal, request, 'RemotePush', waits ? 'waiting for approval' : 'started')
      if (!waits) run(id, pushWork(id, passphrase as string, principal.name))
      return Response.json(await describe((await jobs.get(id)) as RemoteJob, url.origin), {
        status: 202,
      })
    } finally {
      await rm(local, { force: true })
    }
  }

  async function decide(
    request: Request,
    url: URL,
    principal: Principal,
    id: string,
    approve: boolean,
  ): Promise<Response> {
    if (!fromThisSiteOrBearer(request)) return new Response('Forbidden', { status: 403 })
    const job = await jobs.get(id)
    if (job?.kind !== 'push')
      return problem(404, { code: 'not-found', title: 'There is no such push' })
    if (job.state !== 'approval-required')
      return problem(409, { code: 'not-waiting', title: 'This push is not waiting for approval' })
    if (!may(principal, RemotePermissions.PushProtected))
      return problem(403, { code: 'forbidden', title: 'You may not approve pushes here' })
    if (job.requestedBy === principal.id)
      return problem(403, {
        code: 'own-push',
        title: 'Someone else has to approve your push',
      })
    if (job.expiresAt.getTime() < Date.now()) {
      await sweep()
      return problem(409, { code: 'approval-expired', title: 'This push waited too long' })
    }
    const moved = await jobs.transition(id, 'approval-required', {
      state: approve ? 'queued' : 'refused',
      decidedBy: principal.id,
      decidedAt: new Date(),
      ...(approve
        ? { expiresAt: new Date(Date.now() + JOB_FILE_SECONDS * 1000) }
        : { secret: null, problem: { code: 'declined', title: `${principal.name} declined it` } }),
    })
    if (!moved) return problem(409, { code: 'not-waiting', title: 'Someone else decided it first' })
    await audit(
      principal,
      request,
      approve ? 'RemotePushApproved' : 'RemotePushDeclined',
      job.requestedByName,
    )
    if (approve && job.secret && secretKey)
      run(id, pushWork(id, openSecret(job.secret, secretKey), job.requestedByName))
    return Response.json(await describe((await jobs.get(id)) as RemoteJob, url.origin))
  }

  /**
   * What a push would do here, from the file's node keys and section paths
   * alone — no upload, nothing written (`push-check`, story 108). Paths are
   * answered by section, never as this server's own.
   */
  async function pushCheck(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { nodes?: unknown; files?: unknown }
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
    const nodes = strings(body.nodes)
    const files = strings(body.files)
    const folders = [
      { section: 'schema', dir: config.schemaDir },
      { section: 'components', dir: config.componentsDir },
      { section: 'styles', dir: config.stylesheetsDir },
      { section: 'scripts', dir: config.scriptsDir },
    ]
    const summary = await replaceSummary(
      db,
      { nodes: nodes.map((key) => ({ key })) } as unknown as ContentSet,
      new Set(files),
      folders,
      'replace',
    )
    const relative = (path: string) => {
      const folder = folders.find((f) => path.startsWith(`${f.dir}${sep}`))
      return folder
        ? `${folder.section}/${path
            .slice(folder.dir.length + 1)
            .split(sep)
            .join('/')}`
        : path
    }
    return Response.json({
      environment: settings.environment,
      recycles: summary.leaving,
      removesFiles: summary.filesRemoved.map(relative).sort(),
      keepsPeople: true,
    })
  }

  /** Short-lived links to media files, for a pull that carries their metadata only. */
  async function mediaLinks(request: Request, url: URL): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { keys?: unknown }
    const keys = Array.isArray(body.keys)
      ? body.keys.filter((k): k is string => typeof k === 'string')
      : []
    if (keys.length > MAX_LINKS)
      return problem(400, { code: 'too-many', title: `At most ${MAX_LINKS} keys at a time` })
    const media = await store()
    const links: Record<string, { url: string; size: number; etag: string } | null> = {}
    for (const key of keys) {
      const found = await media.get(key)
      links[key] = found
        ? {
            url:
              media.publicUrl?.(key) ??
              `${url.origin}${REMOTE_API_PATH}/environments/${settings.environment}/media/${key
                .split('/')
                .map(encodeURIComponent)
                .join('/')}`,
            size: found.size,
            etag: found.etag,
          }
        : null
    }
    return Response.json({ links })
  }

  async function mediaHave(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { blobs?: unknown }
    const blobs = Array.isArray(body.blobs) ? body.blobs.slice(0, MAX_LINKS * 10) : []
    const media = await store()
    const have: string[] = []
    for (const blob of blobs) {
      if (!blob || typeof blob !== 'object') continue
      const { key, etag } = blob as { key?: unknown; etag?: unknown }
      if (typeof key !== 'string') continue
      const found = await media.get(key)
      if (found && (typeof etag !== 'string' || found.etag === etag)) have.push(key)
    }
    return Response.json({ have })
  }

  async function mediaGet(key: string): Promise<Response> {
    const found = await (await store()).get(key)
    if (!found) return problem(404, { code: 'not-found', title: 'There is no such media file' })
    if (found.localPath)
      return new Response(Bun.file(found.localPath), {
        headers: { 'content-type': found.contentType, etag: found.etag },
      })
    const stream = found.stream
      ? await found.stream()
      : new Blob([new Uint8Array(await found.bytes())]).stream()
    return new Response(stream, {
      headers: {
        'content-type': found.contentType,
        'content-length': String(found.size),
        etag: found.etag,
      },
    })
  }

  async function mediaPut(request: Request, key: string): Promise<Response> {
    const declared = request.headers.get('crombolo-sha256')?.toLowerCase()
    if (!declared)
      return problem(400, { code: 'hash-required', title: 'Crombolo-Sha256 is required' })
    const local = join(tmpdir(), `crombolo-remote-media-${crypto.randomUUID()}`)
    try {
      let received: { sha256: string; size: number } | undefined
      try {
        received = await receive(request, local)
      } catch {
        return problem(413, {
          code: 'too-large',
          title: 'The file is larger than this remote takes',
        })
      }
      if (!received)
        return problem(400, { code: 'body-required', title: 'The request carried no file' })
      if (received.sha256 !== declared)
        return problem(400, { code: 'hash-mismatch', title: 'The file is not the one described' })
      await (await store()).put(key, Bun.file(local))
      return new Response(null, { status: 204 })
    } finally {
      await rm(local, { force: true })
    }
  }

  async function download(id: string, principal: Principal): Promise<Response> {
    const job = await jobs.get(id)
    if (job?.kind !== 'pull' || job.requestedBy !== principal.id)
      return problem(404, { code: 'not-found', title: 'There is no such download' })
    if (job.state !== 'done' || !job.fileKey || job.expiresAt.getTime() < Date.now())
      return problem(410, { code: 'gone', title: 'This download has expired' })
    const found = await (await store()).get(job.fileKey)
    if (!found) return problem(410, { code: 'gone', title: 'This download has expired' })
    const body = found.localPath
      ? Bun.file(found.localPath)
      : found.stream
        ? await found.stream()
        : new Uint8Array(await found.bytes())
    return new Response(body as BodyInit, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(found.size),
        'content-disposition': `attachment; filename="${settings.environment}.tgz"`,
      },
    })
  }

  const mediaKeyOf = (rest: string): string | undefined => {
    try {
      const key = rest.split('/').map(decodeURIComponent).join('/')
      return key && !key.split('/').includes('..') && !key.startsWith('.remote/') ? key : undefined
    } catch {
      return undefined
    }
  }

  return {
    isUpload(request, url) {
      if (!settings.enabled || request.method !== 'PUT') return false
      const prefix = `${REMOTE_API_PATH}/environments/${settings.environment}/`
      return url.pathname === `${prefix}pushes` || url.pathname.startsWith(`${prefix}media/`)
    },

    async handle(request, url) {
      const { pathname } = url
      if (pathname === REMOTE_DISCOVERY_PATH) {
        if (!settings.enabled) return undefined
        return request.method === 'GET'
          ? Response.json(discovery(url.origin), { headers: { 'cache-control': 'no-store' } })
          : new Response(null, { status: 405 })
      }
      if (!pathname.startsWith(`${REMOTE_API_PATH}/`)) return undefined
      if (!settings.enabled)
        return problem(404, { code: 'not-enabled', title: 'This site is not a remote' })
      const principal = await options.authenticate(request)
      if (!principal)
        return problem(401, {
          code: 'sign-in-required',
          title: 'Sign in first',
          detail: 'Sign in with the device grant the discovery document names.',
        })
      const rest = pathname.slice(REMOTE_API_PATH.length + 1)

      if (rest === 'environments' && request.method === 'GET')
        return Response.json([
          {
            ...environment(),
            may: {
              pull: may(principal, RemotePermissions.Pull),
              pullFull: may(principal, RemotePermissions.PullFull),
              push:
                may(principal, RemotePermissions.Push) &&
                (!settings.protected || may(principal, RemotePermissions.PushProtected)),
            },
          },
        ])

      const job = /^jobs\/([0-9a-f-]{36})(?:\/(download|approve|decline))?$/.exec(rest)
      if (job) {
        const [, id, action] = job as unknown as [string, string, string | undefined]
        if (!action && request.method === 'GET') {
          const found = await jobs.get(id)
          // A job is its requester's, and an approver's to look at.
          if (
            !found ||
            (found.requestedBy !== principal.id && !may(principal, RemotePermissions.PushProtected))
          )
            return problem(404, { code: 'not-found', title: 'There is no such job' })
          return Response.json(await describe(found, url.origin))
        }
        if (action === 'download' && request.method === 'GET') return download(id, principal)
        if ((action === 'approve' || action === 'decline') && request.method === 'POST')
          return decide(request, url, principal, id, action === 'approve')
        return new Response(null, { status: 405 })
      }

      const env = /^environments\/([a-z][a-z0-9-]*)\/(.+)$/.exec(rest)
      if (!env) return problem(404, { code: 'not-found', title: 'There is nothing here' })
      const [, envId, what] = env as unknown as [string, string, string]
      if (envId !== settings.environment)
        return problem(404, {
          code: 'no-such-environment',
          title: `There is no environment "${envId}"`,
        })

      if (what === 'pulls' && request.method === 'POST') return startPull(request, url, principal)
      if (what === 'pushes' && request.method === 'PUT') return startPush(request, url, principal)
      if (what === 'pushes/check' && request.method === 'POST') {
        if (
          !may(principal, RemotePermissions.Push) ||
          (settings.protected && !may(principal, RemotePermissions.PushProtected))
        )
          return problem(403, { code: 'forbidden', title: 'You may not push to this environment' })
        return pushCheck(request)
      }
      if (what === 'media/links' && request.method === 'POST') {
        if (!may(principal, RemotePermissions.Pull))
          return problem(403, {
            code: 'forbidden',
            title: 'You may not pull from this environment',
          })
        return mediaLinks(request, url)
      }
      if (what === 'media/have' && request.method === 'POST') {
        if (!may(principal, RemotePermissions.Push))
          return problem(403, { code: 'forbidden', title: 'You may not push to this environment' })
        return mediaHave(request)
      }
      if (what.startsWith('media/')) {
        const key = mediaKeyOf(what.slice('media/'.length))
        if (!key) return problem(400, { code: 'bad-key', title: 'That is not a media key' })
        if (request.method === 'GET') {
          if (!may(principal, RemotePermissions.Pull))
            return problem(403, {
              code: 'forbidden',
              title: 'You may not pull from this environment',
            })
          return mediaGet(key)
        }
        if (request.method === 'PUT') {
          if (
            !may(principal, RemotePermissions.Push) ||
            (settings.protected && !may(principal, RemotePermissions.PushProtected))
          )
            return problem(403, {
              code: 'forbidden',
              title: 'You may not push to this environment',
            })
          return mediaPut(request, key)
        }
      }
      return new Response(null, { status: 405 })
    },
  }
}
