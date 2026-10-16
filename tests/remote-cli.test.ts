/**
 * Story 108: the CLI's side of the remote protocol, end to end against the
 * CMS's own server as the remote — sign in by the device grant, pull, change,
 * push, and the guards and approvals on the way.
 *
 * The local site is always SQLite in a file of its own, so it is a different
 * database from the remote whichever dialect the remote runs on.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentImport } from '@crombolo/cli'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@crombolo/core'
import { currentSchemaState, DocumentRepository } from '@crombolo/data'
import {
  bootstrapDatabase,
  type CromboloConfig,
  type Keychain,
  loadConfig,
  mediaStoreFor,
  memoryKeychain,
  type RemoteSettings,
  readSignIn,
  withRemoteMedia,
  writeRemoteMedia,
} from '@crombolo/server'
import { discover, RemoteClient, RemoteError, signIn } from '../packages/cli/src/remote/client.ts'
import {
  addRemote,
  pickRemote,
  readRemotes,
  removeRemote,
} from '../packages/cli/src/remote/remotes-file.ts'
import {
  fetchReferencedMedia,
  pullFile,
  pushSite,
  RefusedBeforeSending,
  referencedBlobs,
} from '../packages/cli/src/remote/transfer.ts'
import { dialectUnderTest } from './support/db.ts'
import { type Harness, ORIGIN, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

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

/** A site's folders, with one page type. */
function siteFolders(root: string) {
  for (const dir of ['schema/content-types', 'components', 'css', 'scripts', 'media'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE)
  writeFileSync(join(root, 'components', 'page.tsx'), 'export default () => <main />\n')
  return {
    siteDir: root,
    schemaDir: join(root, 'schema'),
    componentsDir: join(root, 'components'),
    stylesheetsDir: join(root, 'css'),
    scriptsDir: join(root, 'scripts'),
    mediaDir: join(root, 'media'),
  }
}

/** The remote: a published Home page and a photo. */
async function remoteSite(
  remote: Partial<RemoteSettings> = {},
  extra: Partial<CromboloConfig> = {},
) {
  const h = await signedInServer({
    config: {
      ...siteFolders(temp('remote')),
      remote: {
        enabled: true,
        environment: 'production',
        protected: false,
        approvals: false,
        maxUploadBytes: 1024 ** 3,
        ...remote,
      },
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
  form.set('File', new File([new Uint8Array([4, 2])], 'photo.png'))
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
  return { h, home }
}

/** The remote's API through the server in-process, as `fetch` would reach it. */
const fetchFrom = (h: Harness) =>
  ((input: RequestInfo | URL, init?: RequestInit) =>
    h.server.fetch(new Request(input, init))) as unknown as typeof fetch

/** Signed in as whoever `approver` is, approving the code as the person would. */
async function signedInClient(
  h: Harness,
  approver: Harness = h,
  keychain: Keychain = memoryKeychain(),
) {
  const http = fetchFrom(h)
  const discovery = await discover(ORIGIN, http)
  await signIn(discovery, keychain, {
    clientName: 'crombolo in a test',
    http,
    sleep: () => Bun.sleep(5),
    onCode: async (code) => {
      await approver.post(`${SECURITY}/device/decide`, { userCode: code, approve: true })
    },
  })
  return { client: new RemoteClient(discovery, keychain, http), keychain, discovery }
}

/** A local site of its own: SQLite in a file, whatever the remote runs on. */
function localSite(): CromboloConfig {
  const root = temp('local')
  return loadConfig({
    ...siteFolders(root),
    dialect: 'sqlite',
    sqliteFile: join(root, 'site.sqlite'),
    development: true,
  })
}

/** Polls quickly, but through a real timer: a sleep that resolves at once never lets the job run. */
const noWait = { sleep: () => Bun.sleep(5) }

describe('remotes.toml', () => {
  test('keeps names and URLs, never a credential', () => {
    const dir = temp('remotes')
    addRemote(dir, { name: 'production', url: 'https://example.com', environment: 'production' })
    addRemote(dir, { name: 'staging', url: 'https://staging.example.com' })
    expect(readRemotes(dir).map((r) => r.name)).toEqual(['production', 'staging'])
    expect(pickRemote(dir, 'staging')?.url).toBe('https://staging.example.com')
    expect(pickRemote(dir, undefined)).toBeUndefined()
    expect(removeRemote(dir, 'staging')).toBe(true)
    expect(pickRemote(dir, undefined)?.environment).toBe('production')
    expect(() => addRemote(dir, { name: 'Not OK', url: 'https://x' })).toThrow('not a remote name')
  })
})

describe(`signing in (${dialectUnderTest})`, () => {
  test('a site that is not a remote is refused, and a lapsed token refreshes itself', async () => {
    const plain = await signedInServer()
    open.push(plain)
    await expect(discover(ORIGIN, fetchFrom(plain))).rejects.toThrow('not a crombolo remote')
    await plain.db.close()
    open.pop()

    const { h } = await remoteSite()
    const { client, keychain, discovery } = await signedInClient(h)
    const stored = await readSignIn(keychain, discovery.api)
    expect(stored?.refreshToken).toBeTruthy()
    // Lapsed: the next call refreshes, without a new sign-in.
    await keychain.set(
      new URL(discovery.api).origin,
      JSON.stringify({ ...stored, accessToken: 'lapsed', expiresAt: Date.now() - 1000 }),
    )
    expect((await client.environments()).map((e) => e.id)).toEqual(['production'])
    expect((await readSignIn(keychain, discovery.api))?.accessToken).not.toBe('lapsed')
  })
})

describe(`pull, change, push (${dialectUnderTest})`, () => {
  test('a pulled copy replaces a local site, and a change pushed back reaches the remote', async () => {
    const { h, home } = await remoteSite()
    const { client } = await signedInClient(h)
    const out = join(temp('pulled'), 'site.tgz')
    const pulled = await pullFile(client, { environment: 'production', out, ...noWait })
    expect(pulled.job.state).toBe('done')

    const local = localSite()
    const imported = await contentImport(local, {
      bundle: out,
      passphrase: pulled.passphrase,
      replace: 'replace',
      backupTaken: true,
    })
    expect(imported.problems).toEqual([])
    expect(imported.runId).toBeDefined()

    // A change here: Home renamed and published.
    const { db } = await bootstrapDatabase(local)
    const state = await currentSchemaState(db)
    const docs = new DocumentRepository(db, {
      nodeState: { version: state.version, revision: state.revision },
      nodeId: 'local',
    })
    const doc = await docs.byKey(home)
    expect(doc).toBeDefined()
    await docs.update({
      key: home,
      contentTypeKey: doc?.contentTypeKey as string,
      componentKey: doc?.componentKey ?? null,
      parentKey: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Home, changed locally' }],
    })
    await docs.publish(home, null)
    await db.close()

    const pushed = await pushSite(local, client, { environment: 'production', ...noWait })
    expect(pushed.check.fromRemote).toBe(true)
    expect(pushed.job.state).toBe('done')
    const after = await h.json<{ variants: { name: string }[] }>(`${V1}/document/${home}`)
    expect(after.variants[0]?.name).toBe('Home, changed locally')
  })

  test('a protected environment refuses without --force, then waits for approval', async () => {
    const { h } = await remoteSite({ protected: true, approvals: true }, { secretKey: SECRET_KEY })
    const { client } = await signedInClient(h)
    const local = localSite()
    const out = join(temp('pulled'), 'site.tgz')
    const pulled = await pullFile(client, { environment: 'production', out, ...noWait })
    await contentImport(local, {
      bundle: out,
      passphrase: pulled.passphrase,
      replace: 'replace',
      backupTaken: true,
    })

    await expect(
      pushSite(local, client, { environment: 'production', ...noWait }),
    ).rejects.toBeInstanceOf(RefusedBeforeSending)
    // With --force but no confirmation, nothing is sent either.
    await expect(
      pushSite(local, client, {
        environment: 'production',
        force: true,
        confirm: async () => false,
        ...noWait,
      }),
    ).rejects.toThrow('Nothing was sent')

    const colleague = await signInAsGroup(h, 'admin', 'colleague@example.test')
    open.push(colleague)
    let approval: string | undefined
    const result = await pushSite(local, client, {
      environment: 'production',
      force: true,
      autoApprove: true,
      onApproval: async (job) => {
        approval = job.approvalUrl
        await colleague.call(`/umbraco/remote/v1/jobs/${job.id}/approve`, { method: 'POST' })
      },
      ...noWait,
    })
    expect(approval).toContain('/remote-approval?job=')
    expect(result.job.state).toBe('done')
  })

  test('a person who may not pull is refused before anything is asked for', async () => {
    const { h } = await remoteSite()
    const writer = await signInAsGroup(h, 'writer', 'writer@example.test')
    open.push(writer)
    const { client } = await signedInClient(h, writer)
    await expect(
      pullFile(client, { environment: 'production', out: join(temp('x'), 'x.tgz'), ...noWait }),
    ).rejects.toBeInstanceOf(RefusedBeforeSending)
    await expect(
      client.post('environments/production/pulls', { passphrase: 'x'.repeat(20) }),
    ).rejects.toBeInstanceOf(RemoteError)
  })
})

describe(`media by reference (${dialectUnderTest})`, () => {
  test('media is fetched one file at a time, and a second pull fetches nothing new', async () => {
    const { h } = await remoteSite()
    const { client } = await signedInClient(h)
    const out = join(temp('pulled'), 'site.tgz')
    await pullFile(client, { environment: 'production', out, media: 'referenced', ...noWait })
    const blobs = await referencedBlobs(out)
    expect(blobs).toHaveLength(1)
    const local = localSite()
    const store = await mediaStoreFor(local)
    const first = await fetchReferencedMedia(client, {
      environment: 'production',
      blobs,
      store,
      siteDir: local.siteDir,
    })
    expect(first).toMatchObject({ fetched: 1, skipped: 0, failed: [] })
    expect([...((await (await store.get(blobs[0]?.key as string))?.bytes()) ?? [])]).toEqual([4, 2])
    const again = await fetchReferencedMedia(client, {
      environment: 'production',
      blobs,
      store,
      siteDir: local.siteDir,
    })
    expect(again).toMatchObject({ fetched: 0, skipped: 1 })
  })

  test('a push by reference uploads only the media files the remote lacks', async () => {
    const { h } = await remoteSite()
    const { client } = await signedInClient(h)
    const out = join(temp('pulled'), 'site.tgz')
    const pulled = await pullFile(client, { environment: 'production', out, ...noWait })
    const local = localSite()
    await contentImport(local, {
      bundle: out,
      passphrase: pulled.passphrase,
      replace: 'replace',
      backupTaken: true,
    })
    // The remote has lost its copy of the photo.
    const remoteStore = await mediaStoreFor(h.server.config)
    const [key] = (await remoteStore.list('')).filter((k) => !k.startsWith('.'))
    await remoteStore.delete(key as string)
    let uploads = 0
    const pushed = await pushSite(local, client, {
      environment: 'production',
      mediaInfoOnly: true,
      onMedia: () => {
        uploads++
      },
      ...noWait,
    })
    expect(pushed.job.state).toBe('done')
    expect(uploads).toBe(1)
    expect([...((await (await remoteStore.get(key as string))?.bytes()) ?? [])]).toEqual([4, 2])
  })

  test('a lazily pulled site reads a file through from the remote the first time it is asked for', async () => {
    const { h } = await remoteSite()
    const { keychain, discovery } = await signedInClient(h)
    const http = fetchFrom(h)
    const client = new RemoteClient(discovery, keychain, http)
    const out = join(temp('pulled'), 'site.tgz')
    await pullFile(client, { environment: 'production', out, media: 'referenced', ...noWait })
    const [blob] = await referencedBlobs(out)
    const local = localSite()
    writeRemoteMedia(local.siteDir, { api: discovery.api, environment: 'production' })
    const plain = await mediaStoreFor(local)
    const lazy = withRemoteMedia(plain, local.siteDir, { keychain, http })
    expect(await plain.get(blob?.key as string)).toBeUndefined()
    const fetched = await lazy.get(blob?.key as string)
    expect([...((await fetched?.bytes()) ?? [])]).toEqual([4, 2])
    expect(existsSync(join(local.mediaDir, ...String(blob?.key).split('/')))).toBe(true)
  })
})
