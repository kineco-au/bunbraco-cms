/**
 * Schema in shared storage, so a deployed site can own its own metadata.
 *
 * The store is the truth and the local directory is a cache of it, so what these
 * hold to is the mirror in both directions: what the store has is what the node
 * loads, what the node writes is what the store keeps, and a file that has gone
 * from one is gone from the other. A stale cache resurrecting a deleted document
 * type is the failure worth preventing.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository } from '@bunbraco/data'
import {
  fileSystemMediaStore,
  materialiseSchema,
  publishSchema,
  type SchemaStore,
  schemaStoreOver,
} from '@bunbraco/server'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const dirs: string[] = []
const open: Harness[] = []
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

/** A store backed by a directory, which is what the file-system media store is. */
const storeIn = (dir: string): SchemaStore => schemaStoreOver(fileSystemMediaStore(dir))

const HOME = `[document-type]
alias = "homePage"
name = "Home Page"
`
const ARTICLE = `[document-type]
alias = "article"
name = "Article"
`

describe('materialising a store', () => {
  test('copies every schema file into the directory the loader reads', async () => {
    const remote = temp('store')
    const local = temp('cache')
    mkdirSync(join(remote, 'document-types'), { recursive: true })
    writeFileSync(join(remote, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(remote, 'document-types', 'home-page.toml'), HOME)

    const keys = await materialiseSchema(storeIn(remote), local)

    expect(keys.sort()).toEqual(['document-types/home-page.toml', 'schema.toml'])
    expect(readFileSync(join(local, 'document-types', 'home-page.toml'), 'utf8')).toBe(HOME)
  })

  test('is a mirror: a type deleted from the store is deleted from a stale cache', async () => {
    const remote = temp('store')
    const local = temp('cache')
    mkdirSync(join(remote, 'document-types'), { recursive: true })
    writeFileSync(join(remote, 'document-types', 'home-page.toml'), HOME)
    writeFileSync(join(remote, 'document-types', 'article.toml'), ARTICLE)
    await materialiseSchema(storeIn(remote), local)
    expect(existsSync(join(local, 'document-types', 'article.toml'))).toBe(true)

    // Somebody removes the type; this node restarts with yesterday's cache.
    rmSync(join(remote, 'document-types', 'article.toml'))
    await materialiseSchema(storeIn(remote), local)

    expect(existsSync(join(local, 'document-types', 'article.toml'))).toBe(false)
    expect(existsSync(join(local, 'document-types', 'home-page.toml'))).toBe(true)
  })

  test('ignores anything in the bucket that is not schema', async () => {
    const remote = temp('store')
    const local = temp('cache')
    writeFileSync(join(remote, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(remote, 'notes.txt'), 'not schema')
    const keys = await materialiseSchema(storeIn(remote), local)
    expect(keys).toEqual(['schema.toml'])
    expect(existsSync(join(local, 'notes.txt'))).toBe(false)
  })

  test('an empty store leaves an empty directory rather than failing', async () => {
    const local = temp('cache')
    expect(await materialiseSchema(storeIn(temp('store')), local)).toEqual([])
    expect(existsSync(local)).toBe(true)
  })
})

describe('publishing back', () => {
  test('sends what the node wrote, so it outlives the container', async () => {
    const remote = temp('store')
    const local = temp('cache')
    mkdirSync(join(local, 'document-types'), { recursive: true })
    writeFileSync(join(local, 'document-types', 'home-page.toml'), HOME)

    const report = await publishSchema(storeIn(remote), local)

    expect(report.written).toEqual(['document-types/home-page.toml'])
    expect(readFileSync(join(remote, 'document-types', 'home-page.toml'), 'utf8')).toBe(HOME)
  })

  test('skips files that have not changed, so a rewrite of everything is cheap', async () => {
    const remote = temp('store')
    const local = temp('cache')
    mkdirSync(join(local, 'document-types'), { recursive: true })
    writeFileSync(join(local, 'document-types', 'home-page.toml'), HOME)
    const store = storeIn(remote)
    await publishSchema(store, local)

    // `rewriteAll` rewrites every file after a move; nothing should be re-sent.
    expect(await publishSchema(store, local)).toEqual({ written: [], removed: [] })

    writeFileSync(join(local, 'document-types', 'home-page.toml'), `${HOME}icon = "icon-home"\n`)
    expect((await publishSchema(store, local)).written).toEqual(['document-types/home-page.toml'])
  })

  test('removes from the store what the node deleted', async () => {
    const remote = temp('store')
    const local = temp('cache')
    mkdirSync(join(local, 'document-types'), { recursive: true })
    writeFileSync(join(local, 'document-types', 'home-page.toml'), HOME)
    writeFileSync(join(local, 'document-types', 'article.toml'), ARTICLE)
    const store = storeIn(remote)
    await publishSchema(store, local)

    rmSync(join(local, 'document-types', 'article.toml'))
    const report = await publishSchema(store, local)

    expect(report.removed).toEqual(['document-types/article.toml'])
    expect(await store.list()).toEqual(['document-types/home-page.toml'])
  })

  test('a round trip leaves both sides identical', async () => {
    const remote = temp('store')
    const local = temp('cache')
    mkdirSync(join(local, 'document-types'), { recursive: true })
    writeFileSync(join(local, 'schema.toml'), '[schema]\nversion = "2.1.0"\n')
    writeFileSync(join(local, 'document-types', 'home-page.toml'), HOME)
    writeFileSync(join(local, 'document-types', 'article.toml'), ARTICLE)
    const store = storeIn(remote)
    await publishSchema(store, local)

    const elsewhere = temp('other-node')
    await materialiseSchema(store, elsewhere)

    for (const key of [
      'schema.toml',
      'document-types/home-page.toml',
      'document-types/article.toml',
    ]) {
      expect(readFileSync(join(elsewhere, ...key.split('/')), 'utf8')).toBe(
        readFileSync(join(local, ...key.split('/')), 'utf8'),
      )
    }
  })
})

describe('a node backed by a store', () => {
  const DOCUMENT_TYPE = {
    alias: 'landingPage',
    name: 'Landing Page',
    icon: 'icon-document',
    description: null,
    allowedAsRoot: true,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collection: null,
    cleanup: {
      preventCleanup: false,
      keepAllVersionsNewerThanDays: null,
      keepLatestVersionPerDayForDays: null,
    },
    properties: [],
    containers: [],
    compositions: [],
    allowedDocumentTypes: [],
    allowedTemplates: [],
    defaultTemplate: null,
    parent: null,
  }

  test('loads its schema from the store, and publishes a change back for other nodes', async () => {
    const remote = temp('store')
    mkdirSync(join(remote, 'document-types'), { recursive: true })
    writeFileSync(join(remote, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(remote, 'document-types', 'home-page.toml'), HOME)

    const h = await signedInServer({
      config: { schemaStore: storeIn(remote), schemaCacheDir: temp('cache') },
    })
    open.push(h)

    // It booted from the store rather than from a directory in the image.
    expect(await new ContentTypeRepository(h.server.db).byAlias('homePage')).toBeDefined()

    // A store makes writes durable, so the environment is writable without asking.
    const created = await h.post(`${V1}/document-type`, DOCUMENT_TYPE)
    expect(created.status).toBe(201)

    // The new type is in the store, so the next node to boot has it.
    const store = storeIn(remote)
    expect(await store.list()).toContain('document-types/landing-page.toml')

    const elsewhere = temp('other-node')
    await materialiseSchema(store, elsewhere)
    const carried = readFileSync(join(elsewhere, 'document-types', 'landing-page.toml'), 'utf8')
    expect(carried).toContain('alias = "landingPage"')
  })

  test('without a store, a read-only environment still refuses schema writes', async () => {
    // The refusal is about a schema directory this environment does not own, so
    // there has to be one for it to be refused over.
    const schemaDir = temp('schema')
    mkdirSync(join(schemaDir, 'document-types'), { recursive: true })
    writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(schemaDir, 'document-types', 'home-page.toml'), HOME)

    const h = await signedInServer({ config: { schemaDir, schemaWritable: false } })
    open.push(h)
    const refused = await h.post(`${V1}/document-type`, DOCUMENT_TYPE)
    // The database write is refused before it happens, naming the file to change.
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('source control')
  })
})
