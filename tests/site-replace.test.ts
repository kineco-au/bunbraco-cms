/**
 * Story 105: replacing a site with a whole-site file, all or nothing, and the
 * round trip with 104 — a site exported, started elsewhere, exported again,
 * comes out the same.
 *
 * Each site is exported to a file before the next one boots: on Postgres the
 * next harness resets the database, so the file is the only thing that crosses.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentImport, revertSections, siteReplaceCheck } from '@crombolo/cli'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@crombolo/core'
import {
  ContentTypeRepository,
  DictionaryRepository,
  MemberRepository,
  NodeRepository,
  ObjectTypes,
} from '@crombolo/data'
import {
  type CromboloConfig,
  exportSite,
  extractTarball,
  installBundleContent,
  mediaStoreFor,
} from '@crombolo/server'
import { loadBundle, revertRun } from '@crombolo/transfer'
import { dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const PASSPHRASE = 'a passphrase long enough to use'

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

const type = (alias: string, name: string) => `[content-type]
alias = "${alias}"
name = "${name}"
allow-at-root = true
components = ["${alias}"]
default-component = "${alias}"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

/** A site with one type, its component, a stylesheet, and the given pages. */
async function site(options: { types: string[]; css: string; pages: string[]; title?: string }) {
  const root = temp('site')
  for (const dir of ['schema/content-types', 'components', 'css', 'scripts', 'media'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  for (const alias of options.types) {
    writeFileSync(join(root, 'schema', 'content-types', `${alias}.toml`), type(alias, alias))
    writeFileSync(join(root, 'components', `${alias}.tsx`), 'export default () => <main />\n')
  }
  writeFileSync(join(root, 'css', options.css), 'body { color: red }\n')
  const h = await signedInServer({
    config: {
      siteDir: root,
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      stylesheetsDir: join(root, 'css'),
      scriptsDir: join(root, 'scripts'),
      mediaDir: join(root, 'media'),
      // A file of its own, so the commands' own connection opens the same database.
      sqliteFile: join(root, 'site.sqlite'),
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias(options.types[0] as string))
    ?.key as string
  const keys: string[] = []
  for (const name of options.pages) {
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      parent: null,
      values: [
        { alias: 'title', culture: null, segment: null, value: options.title ?? `${name} title` },
      ],
      variants: [{ culture: null, segment: null, name }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    expect((await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    keys.push(key)
  }
  return { h, root, config: h.server.config, keys }
}

async function addPhoto(h: Harness): Promise<void> {
  const upload = crypto.randomUUID()
  const form = new FormData()
  form.set('Id', upload)
  form.set('File', new File([new Uint8Array([9, 8, 7, 6])], 'photo.png'))
  expect((await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })).status).toBe(201)
  const photo = await h.post(`${V1}/media`, {
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
  expect(photo.status).toBe(201)
}

/** Exports a site and closes it, so the next one can boot on the same database. */
async function exportAndClose(
  h: Harness,
  options: Partial<Parameters<typeof exportSite>[2]> = {},
): Promise<string> {
  const out = join(temp('file'), 'site.tgz')
  await exportSite(h.server.db, h.server.config, { out, ...options })
  await h.db.close()
  open.splice(open.indexOf(h), 1)
  return out
}

const live = async (_config: CromboloConfig, db: Harness['server']['db']) =>
  (
    await db.query<{ text: string }>(
      'SELECT text FROM node WHERE node_object_type = ? AND trashed = ? ORDER BY text',
      [ObjectTypes.Document, db.dialect.boolValue(false)],
    )
  ).map((row) => String(row.text))

describe(`replacing a site (${dialectUnderTest})`, () => {
  test('without a mode, says what would go and changes nothing', async () => {
    const a = await site({ types: ['page'], css: 'site.css', pages: ['Home', 'About'] })
    const file = await exportAndClose(a.h)
    const b = await site({ types: ['article'], css: 'other.css', pages: ['Old news'] })
    const { summary } = await siteReplaceCheck(b.config, { bundle: file, replace: 'replace' })
    expect(summary.leaving).toEqual({ document: 1 })
    expect(summary.filesRemoved.map((path) => path.split('/').slice(-2).join('/')).sort()).toEqual([
      'components/article.tsx',
      'content-types/article.toml',
      'css/other.css',
    ])
    expect(await live(b.config, b.h.server.db)).toEqual(['Old news'])
  })

  test('--replace makes the site the file’s, recycling what it lacks, and reverts', async () => {
    const a = await site({ types: ['page'], css: 'site.css', pages: ['Home', 'About'] })
    await addPhoto(a.h)
    await a.h.post(`${V1}/dictionary`, {
      name: 'Greeting',
      parent: null,
      translations: [{ isoCode: 'en-US', translation: 'Hello' }],
    })
    const file = await exportAndClose(a.h)

    const b = await site({ types: ['article'], css: 'other.css', pages: ['Old news'] })
    await b.h.post(`${V1}/dictionary`, {
      name: 'Farewell',
      parent: null,
      translations: [{ isoCode: 'en-US', translation: 'Bye' }],
    })
    const result = await contentImport(b.config, {
      bundle: file,
      replace: 'replace',
      backupTaken: true,
    })
    expect(result.problems).toEqual([])
    expect(result.runId).toBeDefined()
    const db = b.h.server.db

    expect(await live(b.config, db)).toEqual(['About', 'Home'])
    const published = await db.query<{ published: unknown }>(
      'SELECT d.published FROM document d JOIN node n ON n.id = d.node_id WHERE n.trashed = ? AND n.node_object_type = ?',
      [db.dialect.boolValue(false), ObjectTypes.Document],
    )
    expect(published.map((row) => Boolean(row.published))).toEqual([true, true])
    // The page that was here is in the recycle bin, not gone.
    const trashed = await db.query<{ text: string }>(
      'SELECT text FROM node WHERE trashed = ? AND node_object_type = ?',
      [db.dialect.boolValue(true), ObjectTypes.Document],
    )
    expect(trashed.map((row) => String(row.text))).toEqual(['Old news'])

    expect(existsSync(join(b.root, 'css', 'site.css'))).toBe(true)
    expect(existsSync(join(b.root, 'css', 'other.css'))).toBe(false)
    expect(existsSync(join(b.root, 'schema', 'content-types', 'article.toml'))).toBe(false)
    expect(existsSync(join(b.root, 'components', 'page.tsx'))).toBe(true)
    expect(await new ContentTypeRepository(db).byAlias('page')).toBeDefined()
    const dictionary = (await new DictionaryRepository(db).all()).map((item) => item.name)
    expect(dictionary).toEqual(['Greeting'])
    const store = await mediaStoreFor(b.config)
    expect((await store.list('')).some((key) => key.endsWith('photo.png'))).toBe(true)

    // Reverted: the content, the files and the dictionary are what they were.
    const reverted = await revertRun(db, result.runId as string, {
      nodeId: 'test',
      resolveAll: 'discard',
    })
    expect(reverted.runId).toBeDefined()
    const sections = await revertSections(db, b.config, result.runId as string)
    expect(sections.dictionary).toBe(true)
    expect(await live(b.config, db)).toEqual(['Old news'])
    expect(existsSync(join(b.root, 'css', 'other.css'))).toBe(true)
    expect(existsSync(join(b.root, 'css', 'site.css'))).toBe(false)
    expect(existsSync(join(b.root, 'schema', 'content-types', 'article.toml'))).toBe(true)
    expect((await new DictionaryRepository(db).all()).map((item) => item.name)).toEqual([
      'Farewell',
    ])
  })

  test('--replace-all needs an administrator in the file, then deletes what it lacks', async () => {
    const a = await site({ types: ['page'], css: 'site.css', pages: ['Home'] })
    const withoutUsers = await exportAndClose(a.h)
    const b = await site({ types: ['page'], css: 'site.css', pages: ['Old news'] })
    const refused = await contentImport(b.config, {
      bundle: withoutUsers,
      replace: 'replace-all',
      backupTaken: true,
    })
    expect(refused.runId).toBeUndefined()
    expect(refused.problems.join(' ')).toContain('no back-office administrator')
    expect(await live(b.config, b.h.server.db)).toEqual(['Old news'])
    await b.h.db.close()
    open.splice(open.indexOf(b.h), 1)

    const c = await site({ types: ['page'], css: 'site.css', pages: ['Home'] })
    const withUsers = await exportAndClose(c.h, { withUsers: true, passphrase: PASSPHRASE })
    const d = await site({ types: ['page'], css: 'site.css', pages: ['Old news'] })
    const member = await d.h.post(`${V1}/member`, {
      memberType: { id: (await import('@crombolo/data')).SYSTEM_MEMBER_TYPE.key },
      email: 'old@example.test',
      username: 'old',
      password: 'correct-horse-battery',
      isApproved: true,
      groups: [],
      values: [],
      variants: [{ culture: null, segment: null, name: 'Old' }],
    })
    expect(member.status).toBe(201)
    const result = await contentImport(d.config, {
      bundle: withUsers,
      replace: 'replace-all',
      passphrase: PASSPHRASE,
      backupTaken: true,
    })
    expect(result.problems).toEqual([])
    expect(result.runId).toBeDefined()
    const db = d.h.server.db
    expect(await live(d.config, db)).toEqual(['Home'])
    const anyTrashed = await db.query(
      'SELECT id FROM node WHERE trashed = ? AND node_object_type = ?',
      [db.dialect.boolValue(true), ObjectTypes.Document],
    )
    expect(anyTrashed).toEqual([])
    expect(await new MemberRepository(db).byUsername('old')).toBeUndefined()
  })

  test('refuses what is not a whole site, and a file without its media unless told', async () => {
    const a = await site({ types: ['page'], css: 'site.css', pages: ['Home'] })
    await addPhoto(a.h)
    const noMedia = await exportAndClose(a.h, { media: false })
    const b = await site({ types: ['page'], css: 'site.css', pages: ['Old news'] })
    const refused = await contentImport(b.config, {
      bundle: noMedia,
      replace: 'replace',
      backupTaken: true,
    })
    expect(refused.problems.join(' ')).toContain('--allow-missing-media')
    const allowed = await contentImport(b.config, {
      bundle: noMedia,
      replace: 'replace',
      allowMissingBlobs: true,
      backupTaken: true,
    })
    expect(allowed.runId).toBeDefined()
  })

  test('a refusal part-way leaves the files, the schema and the media as they were', async () => {
    const a = await site({ types: ['page'], css: 'site.css', pages: ['Home'] })
    await addPhoto(a.h)
    const file = await exportAndClose(a.h)
    // The destination has the file's page in its recycle bin: the content
    // check blocks that, inside the transaction, after the prune and the
    // schema sync have run.
    const unpacked = temp('unpacked')
    await extractTarball(file, unpacked)
    const loaded = loadBundle(join(unpacked, 'content'))
    const homeKey = loaded.set?.nodes.find((n) => n.kind === 'document')?.key as string

    const b = await site({ types: ['article'], css: 'other.css', pages: [] })
    const articleKey = (await new ContentTypeRepository(b.h.server.db).byAlias('article'))
      ?.key as string
    const clash = await b.h.post(`${V1}/document`, {
      id: homeKey,
      documentType: { id: articleKey },
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Clash' }],
    })
    expect(clash.status).toBe(201)
    expect((await b.h.put(`${V1}/document/${homeKey}/move-to-recycle-bin`, {})).status).toBe(200)
    const store = await mediaStoreFor(b.config)
    const mediaBefore = await store.list('')

    const result = await installBundleContent(b.h.server.db, b.config, {
      bundle: join(unpacked),
      replace: 'replace',
      backupTaken: true,
    })
    expect(result.runId).toBeUndefined()
    expect(existsSync(join(b.root, 'css', 'other.css'))).toBe(true)
    expect(existsSync(join(b.root, 'css', 'site.css'))).toBe(false)
    expect(existsSync(join(b.root, 'schema', 'content-types', 'page.toml'))).toBe(false)
    expect(await new ContentTypeRepository(b.h.server.db).byAlias('page')).toBeUndefined()
    expect(await live(b.config, b.h.server.db)).toEqual([])
    expect((await store.list('')).sort()).toEqual(mediaBefore.sort())
  })
})

/** Everything a file says about the site, without what differs every time it is written. */
async function contents(file: string): Promise<Record<string, unknown>> {
  const dir = temp('compare')
  await extractTarball(file, dir)
  const loaded = loadBundle(join(dir, 'content'))
  expect(loaded.problems).toEqual([])
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !/(date|At|At\b|^id$|createdBy|integrity)$/i.test(key))
          .map(([key, v]) => [key, strip(v)]),
      )
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [path, disk] of loaded.files) out[path] = readFileSync(disk, 'utf8')
  for (const [key, disk] of loaded.blobs) out[`blob:${key}`] = readFileSync(disk).toString('base64')
  out.nodes = strip([...(loaded.set?.nodes ?? [])].sort((x, y) => x.key.localeCompare(y.key)))
  const manifest = loaded.set?.manifest
  out.manifest = strip({
    counts: manifest?.counts,
    carries: manifest?.carries,
    blobs: manifest?.blobs,
    scope: manifest?.scope,
    requires: manifest?.requires,
  })
  return out
}

describe(`the round trip (${dialectUnderTest})`, () => {
  test('a site exported, started elsewhere and exported again comes out the same', async () => {
    const a = await site({ types: ['page'], css: 'site.css', pages: ['Home', 'About'] })
    await addPhoto(a.h)
    await a.h.post(`${V1}/dictionary`, {
      name: 'Greeting',
      parent: null,
      translations: [{ isoCode: 'en-US', translation: 'Hello' }],
    })
    const first = await exportAndClose(a.h)

    // Started elsewhere: an empty site, as `start --from` scaffolds one, then
    // the file imported over it.
    const root = temp('elsewhere')
    for (const dir of ['schema', 'components', 'css', 'scripts', 'media'])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        stylesheetsDir: join(root, 'css'),
        scriptsDir: join(root, 'scripts'),
        mediaDir: join(root, 'media'),
        sqliteFile: join(root, 'site.sqlite'),
      },
    })
    open.push(h)
    const imported = await contentImport(h.server.config, {
      bundle: first,
      replace: 'replace',
      backupTaken: true,
    })
    expect(imported.problems).toEqual([])
    expect(imported.runId).toBeDefined()
    expect(await new NodeRepository(h.server.db).roots(ObjectTypes.Document, 0, 10)).toMatchObject({
      total: 2,
    })
    const second = await exportAndClose(h)

    expect(await contents(second)).toEqual(await contents(first))
  })
})
