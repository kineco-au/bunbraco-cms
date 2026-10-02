/**
 * Importing schema files into a running node.
 *
 * The point of the feature is that the files are the source of truth and the
 * database is a view of them, so a TOML changed by a commit, by another node
 * publishing to the shared store, or by the assistant, reaches the runtime
 * without a restart — and says first what it is about to do.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BACKOFFICE_PATH } from '@bunbraco/core'
import { ContentTypeRepository } from '@bunbraco/data'
import {
  fileSystemMediaStore,
  publishSchema,
  type SchemaStore,
  schemaStoreOver,
} from '@bunbraco/server'
import { type Harness, signedInServer, signInAsGroup } from './support/harness.ts'

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

const IMPORT = `${DEFAULT_BACKOFFICE_PATH}/bunbraco/api/schema-import`

const temp = (name: string) => {
  const dir = mkdtempSync(join(process.cwd(), 'output', `${name}-`))
  dirs.push(dir)
  return dir
}

const storeIn = (dir: string): SchemaStore => schemaStoreOver(fileSystemMediaStore(dir))

const type = (alias: string, name: string, extra = '') => `[document-type]
alias = "${alias}"
name = "${name}"
allow-at-root = true
${extra}`

/** A schema directory with one document type, and the server reading it. */
async function site(options: { store?: boolean } = {}) {
  const schemaDir = temp('schema')
  mkdirSync(join(schemaDir, 'document-types'), { recursive: true })
  writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(schemaDir, 'document-types', 'home-page.toml'), type('homePage', 'Home Page'))

  if (!options.store) {
    const h = await signedInServer({ config: { schemaDir } })
    open.push(h)
    return { h, schemaDir, store: undefined }
  }

  const remote = temp('store')
  const store = storeIn(remote)
  await publishSchema(store, schemaDir)
  const h = await signedInServer({ config: { schemaStore: store, schemaCacheDir: temp('cache') } })
  open.push(h)
  return { h, schemaDir: remote, store }
}

interface ImportResult {
  dryRun: boolean
  classification: string
  action?: string
  materialised?: number
  findings: { code: string }[]
  state: { version: string; revision: string }
}

const aliases = async (h: Harness, alias: string) =>
  await new ContentTypeRepository(h.server.db).byAlias(alias)

describe('asking what an import would do', () => {
  test('a GET reports the classification and changes nothing', async () => {
    const { h, schemaDir } = await site()
    writeFileSync(join(schemaDir, 'document-types', 'article.toml'), type('article', 'Article'))

    const asked = await h.json<ImportResult>(IMPORT)
    expect(asked.dryRun).toBe(true)
    expect(asked.classification).toBe('additive')
    // Nothing applied: the type is still absent from the database.
    expect(await aliases(h, 'article')).toBeUndefined()
  })

  test('an unchanged directory is classified as nothing to do', async () => {
    const { h } = await site()
    expect((await h.json<ImportResult>(IMPORT)).classification).toBe('none')
  })
})

describe('importing', () => {
  test('a type added to the files appears in the database, with no restart', async () => {
    const { h, schemaDir } = await site()
    expect(await aliases(h, 'article')).toBeUndefined()

    writeFileSync(join(schemaDir, 'document-types', 'article.toml'), type('article', 'Article'))
    const applied = await h.json<ImportResult>(IMPORT, { method: 'POST' })

    expect(applied.action).toBe('applied')
    expect(await aliases(h, 'article')).toBeDefined()
  })

  test('a change to an existing type is applied', async () => {
    const { h, schemaDir } = await site()
    writeFileSync(
      join(schemaDir, 'document-types', 'home-page.toml'),
      type('homePage', 'Renamed Home'),
    )
    await h.json<ImportResult>(IMPORT, { method: 'POST' })
    expect((await aliases(h, 'homePage'))?.name).toBe('Renamed Home')
  })

  test('the node does not then judge itself behind and drain', async () => {
    const { h, schemaDir } = await site()
    writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.1.0"\n')
    writeFileSync(join(schemaDir, 'document-types', 'article.toml'), type('article', 'Article'))

    const applied = await h.json<ImportResult>(IMPORT, { method: 'POST' })
    expect(applied.state.version).toBe('1.1.0')

    // `/health` reads the same nodeState the poller does; a stale one here would
    // take the node out of the load balancer straight after its own import.
    const health = await h.json<{ ok: boolean; readOnly: boolean }>('/health')
    expect(health.readOnly).toBe(false)
    expect(health.ok).toBe(true)
  })

  test('it needs a signed-in user, like every other plugin route', async () => {
    const { h } = await site()
    const anonymous = await h.server.fetch(
      new Request(`http://localhost${IMPORT}`, { method: 'POST' }),
    )
    expect(anonymous.status).toBe(401)
  })

  test('and Settings, because it applies type changes to the database', async () => {
    const { h } = await site()
    const writer = await signInAsGroup(h)
    // The dry run reads the pending schema, the POST applies it: both are the
    // authority every document-type write asks for.
    expect((await writer.call(IMPORT)).status).toBe(403)
    expect((await writer.call(IMPORT, { method: 'POST' })).status).toBe(403)
    expect((await h.call(IMPORT)).status).toBe(200)
  })
})

describe('with a shared store', () => {
  test('picks up what another node published, without a restart', async () => {
    const { h, schemaDir: remote, store } = await site({ store: true })
    expect(await aliases(h, 'article')).toBeUndefined()

    // Another node writes a new type and publishes it.
    const elsewhere = temp('other-node')
    mkdirSync(join(elsewhere, 'document-types'), { recursive: true })
    writeFileSync(join(elsewhere, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(
      join(elsewhere, 'document-types', 'home-page.toml'),
      type('homePage', 'Home Page'),
    )
    writeFileSync(join(elsewhere, 'document-types', 'article.toml'), type('article', 'Article'))
    await publishSchema(store as SchemaStore, elsewhere)
    expect(remote).toBeTruthy()

    const applied = await h.json<ImportResult>(IMPORT, { method: 'POST' })
    expect(applied.materialised).toBe(3)
    expect(applied.action).toBe('applied')
    expect(await aliases(h, 'article')).toBeDefined()
  })
})
