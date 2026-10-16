/**
 * Story 107: this server as a remote — discovery, its environment, pulls and
 * pushes as jobs, the permissions each needs, approval of protected pushes, and
 * media by reference. Driven with a bearer token, as the CLI drives it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEVICE_CODE_GRANT, REMOTE_CLIENT_ID } from '@crombolo/auth'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@crombolo/core'
import { DbDate, RemoteJobRepository } from '@crombolo/data'
import {
  type CromboloConfig,
  exportSite,
  extractTarball,
  REMOTE_API_PATH,
  REMOTE_DISCOVERY_PATH,
  type RemoteSettings,
} from '@crombolo/server'
import { loadBundle, openBundle } from '@crombolo/transfer'
import { dialectUnderTest } from './support/db.ts'
import { type Harness, ORIGIN, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

const PASSPHRASE = 'a passphrase long enough to use'
const SECRET_KEY = 'a-test-secret-key-that-is-long-enough-to-use'
const SECURITY = `${V1}/security/back-office`

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const temp = (name: string) => {
  const dir = mkdtempSync(join(process.cwd(), 'output', `${name}-`))
  dirs.push(dir)
  return dir
}

const PAGE = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
components = ["page"]
default-component = "page"
`

const REMOTE: RemoteSettings = {
  enabled: true,
  environment: 'production',
  protected: false,
  approvals: false,
  maxUploadBytes: 1024 ** 3,
}

/** A site with one published page and one photo, answering as a remote. */
async function remoteSite(
  remote: Partial<RemoteSettings> = {},
  extra: Partial<CromboloConfig> = {},
) {
  const root = temp('remote')
  for (const dir of ['schema/content-types', 'components', 'css', 'scripts', 'media'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE)
  writeFileSync(join(root, 'components', 'page.tsx'), 'export default () => <main />\n')
  const h = await signedInServer({
    config: {
      siteDir: root,
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      stylesheetsDir: join(root, 'css'),
      scriptsDir: join(root, 'scripts'),
      mediaDir: join(root, 'media'),
      remote: { ...REMOTE, ...remote },
      ...extra,
    },
  })
  open.push(h)
  const types = await h.json<{ items: { id: string; name: string }[] }>(
    `${V1}/tree/document-type/root?take=100`,
  )
  const created = await h.post(`${V1}/document`, {
    documentType: { id: types.items.find((t) => t.name === 'Page')?.id },
    parent: null,
    values: [],
    variants: [{ culture: null, segment: null, name: 'Home' }],
  })
  const home = created.headers.get('umb-generated-resource') as string
  await h.put(`${V1}/document/${home}/publish`, { publishSchedules: [] })
  const upload = crypto.randomUUID()
  const form = new FormData()
  form.set('Id', upload)
  form.set('File', new File([new Uint8Array([7, 7, 7])], 'photo.png'))
  await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
  await h.post(`${V1}/media`, {
    mediaType: { id: SYSTEM_MEDIA_TYPE_KEYS.Image },
    parent: null,
    values: [
      {
        alias: 'umbracoFile',
        culture: null,
        segment: null,
        value: { src: '', temporaryFileId: upload, crops: [], focalPoint: null },
      },
    ],
    variants: [{ culture: null, segment: null, name: 'Photo' }],
  })
  return { h, root, home }
}

/** A device sign-in for whoever `approver` is signed in as: the CLI's bearer token. */
async function tokenFor(approver: Harness): Promise<string> {
  const form = (fields: Record<string, string>) =>
    approver.server.fetch(
      new Request(`${ORIGIN}${SECURITY}/${fields.grant_type ? 'token' : 'device'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }),
    )
  const codes = (await (await form({ client_id: REMOTE_CLIENT_ID })).json()) as {
    device_code: string
    user_code: string
  }
  await approver.post(`${SECURITY}/device/decide`, { userCode: codes.user_code, approve: true })
  const tokens = (await (
    await form({
      grant_type: DEVICE_CODE_GRANT,
      device_code: codes.device_code,
      client_id: REMOTE_CLIENT_ID,
    })
  ).json()) as { access_token: string }
  return tokens.access_token
}

/** The remote API, as the CLI calls it. */
function client(h: Harness, token: string) {
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    return h.server.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }))
  }
  const api = (path: string, init: RequestInit = {}) => call(`${REMOTE_API_PATH}/${path}`, init)
  const json = (path: string, body: unknown) =>
    api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  /** Polls a job until it stops moving. */
  const settle = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      const job = (await (await api(`jobs/${id}`)).json()) as Record<string, unknown>
      if (job.state !== 'queued' && job.state !== 'running') return job
      await Bun.sleep(50)
    }
    throw new Error('the job never finished')
  }
  return { call, api, json, settle }
}

type Job = {
  id: string
  state: string
  stage?: string
  approvalUrl?: string
  download?: { url: string; sha256: string; size: number }
  problem?: { code: string; title: string; items?: string[] }
  runId?: string
}

describe(`discovery (${dialectUnderTest})`, () => {
  test('is not there unless the remote is enabled', async () => {
    const h = await signedInServer()
    open.push(h)
    const response = await h.server.fetch(new Request(`${ORIGIN}${REMOTE_DISCOVERY_PATH}`))
    expect(response.status).toBe(404)
    const api = await h.server.fetch(new Request(`${ORIGIN}${REMOTE_API_PATH}/environments`))
    expect(api.status).toBe(404)
  })

  test('names the versions, sign-in and environments', async () => {
    const { h } = await remoteSite({ protected: true })
    const discovery = (await (
      await h.server.fetch(new Request(`${ORIGIN}${REMOTE_DISCOVERY_PATH}`))
    ).json()) as Record<string, unknown>
    expect(discovery).toMatchObject({
      protocol: 'crombolo-remote',
      versions: ['1'],
      api: `${ORIGIN}${REMOTE_API_PATH}`,
      auth: {
        deviceAuthorization: `${ORIGIN}${SECURITY}/device`,
        token: `${ORIGIN}${SECURITY}/token`,
        clientId: REMOTE_CLIENT_ID,
      },
      capabilities: ['media-fetch', 'push-check'],
      environments: [{ id: 'production', name: 'production', protected: true }],
    })
    const anonymous = await h.server.fetch(new Request(`${ORIGIN}${REMOTE_API_PATH}/environments`))
    expect(anonymous.status).toBe(401)
    const { api } = client(h, await tokenFor(h))
    expect(await (await api('environments')).json()).toEqual([
      {
        id: 'production',
        name: 'production',
        protected: true,
        may: { pull: true, pullFull: true, push: true },
      },
    ])
  })
})

describe(`pulling (${dialectUnderTest})`, () => {
  test('exports the site sealed and anonymised, then hands it out once ready', async () => {
    const { h } = await remoteSite()
    const { api, json, call, settle } = client(h, await tokenFor(h))
    expect((await json('environments/production/pulls', {})).status).toBe(400)
    const started = await json('environments/production/pulls', { passphrase: PASSPHRASE })
    expect(started.status).toBe(202)
    const job = (await settle(((await started.json()) as Job).id)) as Job
    expect(job.state).toBe('done')
    expect(job.download?.url).toBe(`${ORIGIN}${REMOTE_API_PATH}/jobs/${job.id}/download`)

    const file = await call(new URL(job.download?.url as string).pathname)
    expect(file.status).toBe(200)
    const bytes = new Uint8Array(await file.arrayBuffer())
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.download?.sha256 as string)
    const dir = temp('pulled')
    writeFileSync(join(dir, 'site.tgz'), bytes)
    await extractTarball(join(dir, 'site.tgz'), join(dir, 'out'))
    const loaded = loadBundle(join(dir, 'out', 'content'))
    expect(loaded.problems).toEqual([])
    expect(loaded.set?.manifest).toMatchObject({ scope: 'site', content: 'sealed' })
    expect(loaded.set?.manifest.people).toBeUndefined()
    expect(openBundle(loaded, PASSPHRASE).set.nodes.length).toBeGreaterThan(0)
    // Another person's job is not theirs to see.
    const writer = await signInAsGroup(h, 'writer', 'writer@example.test')
    open.push(writer)
    expect((await api(`jobs/${crypto.randomUUID()}`)).status).toBe(404)
  })

  test('needs the pull permission, and a full copy its own', async () => {
    const { h } = await remoteSite()
    const writer = await signInAsGroup(h, 'writer', 'writer@example.test')
    open.push(writer)
    const asWriter = client(h, await tokenFor(writer))
    expect(
      (await asWriter.json('environments/production/pulls', { passphrase: PASSPHRASE })).status,
    ).toBe(403)

    // Pull granted to writers, a full copy not.
    const groups = await h.json<{ items: { id: string; alias: string }[] }>(
      `${V1}/user-group?take=100`,
    )
    const writers = groups.items.find((g) => g.alias === 'writer')?.id as string
    const group = await h.json<Record<string, unknown>>(`${V1}/user-group/${writers}`)
    const granted = await h.put(`${V1}/user-group/${writers}`, {
      ...group,
      fallbackPermissions: [...(group.fallbackPermissions as string[]), 'Crombolo.Remote.Pull'],
    })
    expect(granted.status).toBe(200)
    const again = client(h, await tokenFor(writer))
    expect(
      (await again.json('environments/production/pulls', { passphrase: PASSPHRASE })).status,
    ).toBe(202)
    const full = await again.json('environments/production/pulls', {
      passphrase: PASSPHRASE,
      full: true,
    })
    expect(full.status).toBe(403)
  })
})

/** The site's own whole-site file, sealed as the CLI seals a push. */
async function pushFile(h: Harness): Promise<{ bytes: Uint8Array; sha256: string }> {
  const out = join(temp('push'), 'site.tgz')
  await exportSite(h.server.db, h.server.config, { out, sealContent: true, passphrase: PASSPHRASE })
  const bytes = new Uint8Array(readFileSync(out))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const push = (
  api: ReturnType<typeof client>['api'],
  file: { bytes: Uint8Array; sha256: string },
  sha256 = file.sha256,
) =>
  api('environments/production/pushes', {
    method: 'PUT',
    headers: {
      'content-type': 'application/gzip',
      'crombolo-sha256': sha256,
      'crombolo-passphrase': PASSPHRASE,
    },
    body: file.bytes as BodyInit,
  })

describe(`pushing (${dialectUnderTest})`, () => {
  test('replaces the environment with the file, and refuses one that changed on the way', async () => {
    const { h, home } = await remoteSite()
    const file = await pushFile(h)
    // Changed since the file was made: the push puts it back.
    const page = await h.json<Record<string, unknown>>(`${V1}/document/${home}`)
    await h.put(`${V1}/document/${home}`, {
      ...page,
      variants: [{ culture: null, segment: null, name: 'Renamed' }],
    })
    const { api, settle } = client(h, await tokenFor(h))
    const tampered = await push(api, file, '0'.repeat(64))
    expect(tampered.status).toBe(400)
    expect(((await tampered.json()) as Job['problem'])?.code).toBe('hash-mismatch')

    const started = await push(api, file)
    expect(started.status).toBe(202)
    const job = (await settle(((await started.json()) as Job).id)) as Job
    expect(job.problem).toBeUndefined()
    expect(job.state).toBe('done')
    expect(job.runId).toBeDefined()
    const after = await h.json<{ variants: { name: string }[] }>(`${V1}/document/${home}`)
    expect(after.variants[0]?.name).toBe('Home')
  })

  test('a push can be checked first: what it would recycle and remove, nothing written', async () => {
    const { h, root } = await remoteSite()
    writeFileSync(join(root, 'css', 'old.css'), 'body {}\n')
    const { json } = client(h, await tokenFor(h))
    const checked = await json('environments/production/pushes/check', {
      nodes: [],
      files: ['schema/schema.toml', 'schema/content-types/page.toml', 'components/page.tsx'],
    })
    expect(checked.status).toBe(200)
    expect(await checked.json()).toEqual({
      environment: 'production',
      recycles: { document: 1, media: 1 },
      removesFiles: ['styles/old.css'],
      keepsPeople: true,
    })
    const pages = await h.server.db.query(
      "SELECT id FROM node WHERE text = 'Home' AND trashed = ?",
      [h.server.db.dialect.boolValue(false)],
    )
    expect(pages).toHaveLength(1)
  })

  test('a protected environment needs its own permission', async () => {
    const { h } = await remoteSite({ protected: true })
    const writer = await signInAsGroup(h, 'writer', 'writer@example.test')
    open.push(writer)
    const groups = await h.json<{ items: { id: string; alias: string }[] }>(
      `${V1}/user-group?take=100`,
    )
    const writers = groups.items.find((g) => g.alias === 'writer')?.id as string
    const group = await h.json<Record<string, unknown>>(`${V1}/user-group/${writers}`)
    await h.put(`${V1}/user-group/${writers}`, {
      ...group,
      fallbackPermissions: [...(group.fallbackPermissions as string[]), 'Crombolo.Remote.Push'],
    })
    const asWriter = client(h, await tokenFor(writer))
    const refused = await push(asWriter.api, await pushFile(h))
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as Job['problem'])?.code).toBe('forbidden-protected')
  })

  test('with approvals on, a protected push waits for someone else to approve it', async () => {
    const { h, home } = await remoteSite(
      { protected: true, approvals: true },
      { secretKey: SECRET_KEY },
    )
    const file = await pushFile(h)
    const page = await h.json<Record<string, unknown>>(`${V1}/document/${home}`)
    await h.put(`${V1}/document/${home}`, {
      ...page,
      variants: [{ culture: null, segment: null, name: 'Renamed' }],
    })
    const mine = client(h, await tokenFor(h))
    const started = await push(mine.api, file)
    const waiting = (await started.json()) as Job
    expect(waiting.state).toBe('approval-required')
    expect(waiting.approvalUrl).toBe(`${ORIGIN}/crombolo/remote-approval?job=${waiting.id}`)
    const own = await mine.api(`jobs/${waiting.id}/approve`, { method: 'POST' })
    expect(own.status).toBe(403)
    expect(((await own.json()) as Job['problem'])?.code).toBe('own-push')

    const colleague = await signInAsGroup(h, 'admin', 'colleague@example.test')
    open.push(colleague)
    // The approval page, as the colleague opens it from the link.
    expect((await colleague.call(`/crombolo/remote-approval?job=${waiting.id}`)).status).toBe(200)
    const approved = await colleague.call(`${REMOTE_API_PATH}/jobs/${waiting.id}/approve`, {
      method: 'POST',
    })
    expect(approved.status).toBe(200)
    const job = (await mine.settle(waiting.id)) as Job
    expect(job.state).toBe('done')
    const after = await h.json<{ variants: { name: string }[] }>(`${V1}/document/${home}`)
    expect(after.variants[0]?.name).toBe('Home')
    const twice = await colleague.call(`${REMOTE_API_PATH}/jobs/${waiting.id}/decline`, {
      method: 'POST',
    })
    expect(twice.status).toBe(409)
  })

  test('a declined push changes nothing', async () => {
    const { h } = await remoteSite({ protected: true, approvals: true }, { secretKey: SECRET_KEY })
    const mine = client(h, await tokenFor(h))
    const waiting = (await (await push(mine.api, await pushFile(h))).json()) as Job
    const colleague = await signInAsGroup(h, 'admin', 'colleague@example.test')
    open.push(colleague)
    const declined = await colleague.call(`${REMOTE_API_PATH}/jobs/${waiting.id}/decline`, {
      method: 'POST',
    })
    expect(((await declined.json()) as Job).state).toBe('refused')
  })
})

describe(`jobs over time (${dialectUnderTest})`, () => {
  test('a job whose server stopped is reported as stopped, and an approval expires', async () => {
    const { h } = await remoteSite({ protected: true, approvals: true }, { secretKey: SECRET_KEY })
    const db = h.server.db
    const mine = client(h, await tokenFor(h))
    const waiting = (await (await push(mine.api, await pushFile(h))).json()) as Job
    await db.exec('UPDATE remote_job SET expires_at = ? WHERE id = ?', [
      DbDate.toDb(new Date(Date.now() - 1000)),
      waiting.id,
    ])
    const colleague = await signInAsGroup(h, 'admin', 'colleague@example.test')
    open.push(colleague)
    const late = await colleague.call(`${REMOTE_API_PATH}/jobs/${waiting.id}/approve`, {
      method: 'POST',
    })
    expect(late.status).toBe(409)
    expect(((await late.json()) as Job['problem'])?.code).toBe('approval-expired')

    await new RemoteJobRepository(db).create({
      id: crypto.randomUUID(),
      kind: 'pull',
      environment: 'production',
      requestedBy: (await h.json<{ id: string }>(`${V1}/user/current`)).id,
      requestedByName: 'Administrator',
      options: {},
      state: 'running',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const [row] = await db.query<{ id: string }>(
      "SELECT id FROM remote_job WHERE state = 'running'",
    )
    await db.exec('UPDATE remote_job SET heartbeat_at = ? WHERE id = ?', [
      DbDate.toDb(new Date(Date.now() - 60 * 60 * 1000)),
      row?.id,
    ])
    const stopped = (await (await mine.api(`jobs/${row?.id}`)).json()) as Job
    expect(stopped.state).toBe('failed')
    expect(stopped.problem?.code).toBe('interrupted')
  })
})

describe(`media by reference (${dialectUnderTest})`, () => {
  test('a pull names the media files, and each is fetched on its own', async () => {
    const { h } = await remoteSite()
    const { api, json, call, settle } = client(h, await tokenFor(h))
    const started = await json('environments/production/pulls', {
      passphrase: PASSPHRASE,
      media: 'referenced',
    })
    const job = (await settle(((await started.json()) as Job).id)) as Job
    const dir = temp('pulled')
    writeFileSync(
      join(dir, 'site.tgz'),
      new Uint8Array(
        await (await call(new URL(job.download?.url as string).pathname)).arrayBuffer(),
      ),
    )
    await extractTarball(join(dir, 'site.tgz'), join(dir, 'out'))
    const manifest = loadBundle(join(dir, 'out', 'content')).set?.manifest
    expect(manifest?.media).toBe('referenced')
    const [blob] = manifest?.blobs ?? []
    expect(blob?.etag).toBeTruthy()
    expect(blob?.size).toBe(3)

    const links = (await (
      await json('environments/production/media/links', { keys: [blob?.key, 'nope/missing.png'] })
    ).json()) as {
      links: Record<string, { url: string; etag: string } | null>
    }
    expect(links.links['nope/missing.png']).toBeNull()
    const link = links.links[blob?.key as string]
    const fetched = await call(new URL(link?.url as string).pathname)
    expect([...new Uint8Array(await fetched.arrayBuffer())]).toEqual([7, 7, 7])

    const have = (await (
      await json('environments/production/media/have', {
        blobs: [{ key: blob?.key, etag: blob?.etag }, { key: 'new/file.png' }],
      })
    ).json()) as { have: string[] }
    expect(have.have).toEqual([blob?.key as string])
    const bytes = new Uint8Array([1, 2]) as Uint8Array<ArrayBuffer>
    const put = await api('environments/production/media/new/file.png', {
      method: 'PUT',
      headers: { 'crombolo-sha256': createHash('sha256').update(bytes).digest('hex') },
      body: bytes,
    })
    expect(put.status).toBe(204)
    const hidden = await api('environments/production/media/.remote/anything', { method: 'GET' })
    expect(hidden.status).toBe(400)
  })
})

describe(`the body limit (${dialectUnderTest})`, () => {
  test('an upload may be large, every other request keeps the usual limit', async () => {
    const { h } = await remoteSite({}, { maxRequestBodyBytes: 1024 })
    const serve = h.server.serveOptions.fetch as unknown as (
      request: Request,
      server: { requestIP(): null },
    ) => Promise<Response>
    const big = new Uint8Array(4096)
    const elsewhere = await serve(
      new Request(`${ORIGIN}${V1}/document`, {
        method: 'POST',
        headers: { 'content-length': String(big.length) },
        body: big,
      }),
      { requestIP: () => null },
    )
    expect(elsewhere.status).toBe(413)
    const upload = await serve(
      new Request(`${ORIGIN}${REMOTE_API_PATH}/environments/production/pushes`, {
        method: 'PUT',
        headers: { 'content-length': String(big.length) },
        body: big,
      }),
      { requestIP: () => null },
    )
    expect(upload.status).toBe(401)
  })
})
