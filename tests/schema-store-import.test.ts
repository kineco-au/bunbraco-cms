/**
 * Story 106: an imported schema reaches the schema store. With a store, the
 * schema directory is only a copy, so an import that writes types there and not
 * to the store loses them at the next boot — and an import run from the CLI
 * must read the store's schema, not whatever local directory there is.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentCheck, contentImport } from '@crombolo/cli'
import { ContentTypeRepository } from '@crombolo/data'
import {
  fileSystemMediaStore,
  installBundleContent,
  loadConfig,
  type SchemaStore,
  schemaStoreOver,
  VERSION,
} from '@crombolo/server'
import {
  type BundleFile,
  type ContentSet,
  exportBundle,
  writeBundle,
  writeBundlePackage,
} from '@crombolo/transfer'
import { dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer } from './support/harness.ts'

const HOME = `[content-type]
alias = "homePage"
name = "Home Page"
allow-at-root = true
`
const BROCHURE = `[content-type]
alias = "brochure"
name = "Brochure"
allow-at-root = true
`

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

const storeIn = (dir: string): SchemaStore => schemaStoreOver(fileSystemMediaStore(dir))

/** A store holding a schema with the home page type in it. */
function storeWithHome() {
  const remote = temp('store')
  mkdirSync(join(remote, 'content-types'), { recursive: true })
  writeFileSync(join(remote, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(remote, 'content-types', 'home-page.toml'), HOME)
  return remote
}

/** A bundle package carrying the brochure type, and no content. */
async function brochurePackage(h: Harness): Promise<string> {
  const { set } = await exportBundle(h.server.db, {
    roots: [],
    asGiven: [],
    descendants: false,
    snapshot: 'published',
    blueprints: false,
    withBlobs: false,
    siteName: 'Source',
    nodeId: 'source',
  })
  const sections: BundleFile[] = [{ path: 'schema/content-types/brochure.toml', text: BROCHURE }]
  const dir = temp('brochure-kit')
  for (const file of writeBundlePackage(writeBundle(set as ContentSet, undefined, sections), {
    name: '@acme/brochure',
    version: '1.0.0',
    id: 'acme-brochure',
    label: 'Brochure',
    peerRange: `^${VERSION}`,
  })) {
    const target = join(dir, file.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.bytes ?? (file.text as string))
  }
  return dir
}

describe(`an import with a schema store (${dialectUnderTest})`, () => {
  test('publishes the types it brings, so they survive a restart', async () => {
    const remote = storeWithHome()
    const config = { schemaStore: storeIn(remote), schemaCacheDir: temp('cache') }
    const h = await signedInServer({ config })
    open.push(h)
    const result = await installBundleContent(h.server.db, h.server.config, {
      bundle: await brochurePackage(h),
      backupTaken: true,
    })
    expect(result.problems).toEqual([])
    expect(await storeIn(remote).list()).toContain('content-types/brochure.toml')
    await h.db.close()
    open.pop()

    // A restart against the same store, with a cache of its own.
    const next = await signedInServer({
      config: { ...config, schemaCacheDir: temp('cache') },
      keepDatabase: true,
    })
    open.push(next)
    const types = new ContentTypeRepository(next.server.db)
    expect(await types.byAlias('brochure')).toBeDefined()
    expect(await types.byAlias('homePage')).toBeDefined()
  })

  test('the CLI reads the store, not an empty local directory', async () => {
    const remote = storeWithHome()
    const root = temp('site')
    const sqliteFile = join(root, 'site.sqlite')
    const settings = {
      siteDir: root,
      sqliteFile,
      schemaStore: storeIn(remote),
      schemaCacheDir: temp('cache'),
    }
    // The site as it runs: booted from the store, so the home page is in its database.
    const h = await signedInServer({ config: settings })
    const bundle = await brochurePackage(h)
    await h.db.close()

    // The CLI on a machine with an empty schema directory of its own.
    const emptyLocal = temp('schema')
    const cli = () => loadConfig({ ...settings, schemaDir: emptyLocal })
    const checked = await contentCheck(cli(), { bundle })
    // Against the store the new type is additive; against nothing, the home page
    // would read as removed.
    expect(checked.sections?.schema?.classification).toBe('additive')

    const imported = await contentImport(cli(), { bundle, backupTaken: true })
    expect(imported.problems).toEqual([])
    expect((await storeIn(remote).list()).sort()).toEqual([
      'content-types/brochure.toml',
      'content-types/home-page.toml',
      'schema.toml',
    ])
  })
})
