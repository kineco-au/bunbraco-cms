/**
 * The whole transfer, through the real CLI, between two real databases.
 *
 * Everything else tests the functions. This spawns `bunbraco` as a pipeline
 * would: separate processes, separate SQLite files, a bundle written to disk and
 * read back, and assertions on exit codes and on what the command printed. That
 * covers the parts unit tests cannot — argument parsing, exit status, the output
 * somebody reads, and the fact that a bundle survives a trip through the file
 * system.
 *
 * Named `*.integration.ts`, so `bun test` does not collect it: it spawns a
 * process per step and takes long enough to be a nuisance locally. `bun run
 * test:integration` runs it, and CI always does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'packages/cli/bin/bunbraco.ts')

const PAGE_TOML = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
templates = ["page"]
default-template = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

const VIEW = `export default function Page({ model }) {
  return <main>{model.text('title')}</main>
}
`

/** Seeds content through the repositories, which is the one thing the CLI cannot do. */
const SEED = `
import { ContentTypeRepository, DocumentRepository, currentSchemaState } from '@bunbraco/data'
import { bootstrapDatabase, loadConfig } from '@bunbraco/server'

const [, , ...args] = Bun.argv
const config = loadConfig({}, process.cwd())
const { db } = await bootstrapDatabase(config)
const state = await currentSchemaState(db)
const docs = new DocumentRepository(db, {
  nodeState: { version: state.version, revision: state.revision },
})
const types = new ContentTypeRepository(db)
const page = await types.byAlias('page')
if (!page) throw new Error('the page type is not synced')

if (args[0] === 'tree') {
  const root = await docs.create({
    key: crypto.randomUUID(),
    contentTypeKey: page.key,
    templateKey: null,
    parentKey: null,
    values: [{ alias: 'title', culture: null, segment: null, value: 'Campaigns' }],
    variants: [{ culture: null, segment: null, name: 'Campaigns' }],
  })
  await docs.publish(root.key, null)
  const keys = [root.key]
  for (const name of ['Offer A', 'Offer B']) {
    const child = await docs.create({
      key: crypto.randomUUID(),
      contentTypeKey: page.key,
      templateKey: null,
      parentKey: root.key,
      values: [{ alias: 'title', culture: null, segment: null, value: name }],
      variants: [{ culture: null, segment: null, name }],
    })
    await docs.publish(child.key, null)
    keys.push(child.key)
  }
  console.log(keys.join(' '))
} else if (args[0] === 'edit') {
  const existing = await docs.byKey(args[1])
  if (!existing) throw new Error('no such document')
  await docs.update({
    key: args[1],
    contentTypeKey: existing.contentTypeKey,
    templateKey: existing.templateKey,
    parentKey: existing.parentKey,
    values: [{ alias: 'title', culture: null, segment: null, value: args[2] }],
    variants: existing.variants.map((v) => ({ culture: v.culture, segment: v.segment, name: v.name })),
  })
  console.log('edited')
} else if (args[0] === 'media') {
  // A media item with real bytes in this environment's store, which is what
  // --with-blobs has to carry.
  const { mediaStoreFor } = await import('@bunbraco/server')
  const media = new DocumentRepository(db, {
    kind: 'media',
    nodeState: { version: state.version, revision: state.revision },
  })
  const image = await new ContentTypeRepository(db, { kind: 'media' }).byAlias('Image')
  if (!image) throw new Error('the Image media type is not seeded')
  const key = crypto.randomUUID()
  const name = args[1] ?? 'Photo'
  const blob = key.replaceAll('-', '').slice(0, 8) + '/' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png'
  const store = await mediaStoreFor(config)
  await store.put(blob, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]))
  await media.create({
    key,
    contentTypeKey: image.key,
    templateKey: null,
    parentKey: null,
    values: [
      { alias: 'umbracoFile', culture: null, segment: null, value: { src: '/media/' + blob, crops: [], focalPoint: null } },
    ],
    variants: [{ culture: null, segment: null, name }],
  })
  console.log(JSON.stringify({ key, blob }))
} else if (args[0] === 'blob') {
  const { mediaStoreFor } = await import('@bunbraco/server')
  const store = await mediaStoreFor(config)
  const file = await store.get(args[1])
  console.log(JSON.stringify({ exists: Boolean(file), size: file ? (await file.bytes()).length : 0 }))
} else if (args[0] === 'read') {
  const doc = await docs.byKey(args[1])
  const published = await docs.byKeyPublished(args[1])
  console.log(
    JSON.stringify({
      exists: Boolean(doc),
      published: doc?.published ?? false,
      draft: doc?.values.find((v) => v.alias === 'title')?.value ?? null,
      live: published?.values.find((v) => v.alias === 'title')?.value ?? null,
    }),
  )
}
await db.close()
`

interface Run {
  code: number
  out: string
}

describe('content transfer, end to end through the CLI', () => {
  let dir: string
  let site: string
  let keys: string[] = []

  /** Runs a command in the site directory, against one of the two databases. */
  async function cli(database: 'source' | 'target', ...args: string[]): Promise<Run> {
    const proc = Bun.spawn(['bun', CLI, ...args], {
      cwd: site,
      env: {
        ...process.env,
        BUNBRACO_DB: 'sqlite',
        BUNBRACO_SQLITE_FILE: join(dir, `${database}.sqlite`),
        BUNBRACO_SCHEMA_DIR: join(site, 'schema'),
        BUNBRACO_VIEWS_DIR: join(site, 'Views'),
        BUNBRACO_MEDIA_DIR: join(dir, `${database}-media`),
        BUNBRACO_LOGS_DIR: join(dir, 'logs'),
        BUNBRACO_LOG_TO_CONSOLE: 'false',
        BUNBRACO_ADMIN_PASSWORD: 'integration-password',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code: await proc.exited, out: `${out}${err}` }
  }

  async function seed(database: 'source' | 'target', ...args: string[]): Promise<Run> {
    const proc = Bun.spawn(['bun', join(site, 'seed.ts'), ...args], {
      cwd: site,
      env: {
        ...process.env,
        BUNBRACO_DB: 'sqlite',
        BUNBRACO_SQLITE_FILE: join(dir, `${database}.sqlite`),
        BUNBRACO_SCHEMA_DIR: join(site, 'schema'),
        BUNBRACO_VIEWS_DIR: join(site, 'Views'),
        // The same store the CLI uses, or a media file seeded here is one the
        // export cannot find.
        BUNBRACO_MEDIA_DIR: join(dir, `${database}-media`),
        BUNBRACO_LOGS_DIR: join(dir, 'logs'),
        BUNBRACO_LOG_TO_CONSOLE: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code: await proc.exited, out: `${out}${err}` }
  }

  const read = async (database: 'source' | 'target', key: string) => {
    const result = await seed(database, 'read', key)
    expect(result.code, result.out).toBe(0)
    return JSON.parse(result.out.trim().split('\n').at(-1) as string) as {
      exists: boolean
      published: boolean
      draft: string | null
      live: string | null
    }
  }

  beforeAll(async () => {
    // `output/` is gitignored, so a fresh checkout has not got one — and this is
    // the only CI job that runs nothing else to create it first.
    mkdirSync(join(ROOT, 'output'), { recursive: true })
    dir = mkdtempSync(join(ROOT, 'output', 'integration-'))
    site = join(dir, 'site')
    mkdirSync(join(site, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(site, 'Views'), { recursive: true })
    writeFileSync(join(site, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(site, 'schema', 'document-types', 'page.toml'), PAGE_TOML)
    writeFileSync(join(site, 'Views', 'page.tsx'), VIEW)
    writeFileSync(join(site, 'seed.ts'), SEED)

    // Both environments get the same schema, which is what a deploy guarantees.
    for (const database of ['source', 'target'] as const) {
      const synced = await cli(database, 'schema', 'sync')
      expect(synced.code, synced.out).toBe(0)
    }
    const seeded = await seed('source', 'tree')
    expect(seeded.code, seeded.out).toBe(0)
    keys = (seeded.out.trim().split('\n').at(-1) as string).split(' ')
    expect(keys).toHaveLength(3)
  }, 120_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('exports a subtree to disk by path', async () => {
    const result = await cli(
      'source',
      'content',
      'export',
      '--root',
      '/Campaigns',
      '--out',
      bundle(),
    )
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('3 document')
    expect(existsSync(join(bundle(), 'bundle.json'))).toBe(true)
    for (const key of keys) expect(existsSync(join(bundle(), 'nodes', `${key}.json`))).toBe(true)
    // Keys and aliases only: an integer id would not survive the trip.
    const manifest = JSON.parse(readFileSync(join(bundle(), 'bundle.json'), 'utf8'))
    expect(manifest.snapshot).toBe('published')
    expect(manifest.dependencies.expected).toEqual([])
  })

  test('checks cleanly against the destination, and says nothing is outstanding', async () => {
    const result = await cli('target', 'content', 'check', bundle())
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('3 new')
    expect(result.out).toContain('would import cleanly')
  })

  test('imports as drafts, and the live site is untouched until published', async () => {
    const result = await cli('target', 'content', 'import', bundle())
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('3 created')
    for (const key of keys) {
      const state = await read('target', key)
      expect(state.exists, key).toBe(true)
      expect(state.published, key).toBe(false)
    }
    expect((await read('target', keys[0] as string)).draft).toBe('Campaigns')
  })

  test('is idempotent: a second import changes nothing', async () => {
    const result = await cli('target', 'content', 'import', bundle())
    expect(result.code, result.out).toBe(0)
    expect(result.out).toContain('0 created, 0 updated, 3 unchanged')
  })

  test('refuses when the destination has diverged, naming the conflict', async () => {
    expect(
      (await seed('target', 'edit', keys[1] as string, 'Edited at the destination')).code,
    ).toBe(0)
    const refused = await cli('target', 'content', 'import', bundle())
    expect(refused.code).toBe(1)
    // The message a person reads, not the finding code: it has to name the node
    // and the property, and offer the three ways out.
    expect(refused.out).toContain('"Offer A" is already here and differs')
    expect(refused.out).toContain('would replace title')
    expect(refused.out).toContain('take-bundle')
    expect(refused.out).toContain('Nothing was written')
    // Their edit stands.
    expect((await read('target', keys[1] as string)).draft).toBe('Edited at the destination')
  })

  test('a saved resolution settles it, and travels with the bundle', async () => {
    const saved = await cli(
      'target',
      'content',
      'check',
      bundle(),
      '--resolve-all',
      'take-bundle',
      '--save',
    )
    expect(saved.code, saved.out).toBe(0)
    expect(existsSync(join(bundle(), 'resolutions.json'))).toBe(true)

    // No flag this time: the answer is in the bundle.
    const imported = await cli('target', 'content', 'import', bundle())
    expect(imported.code, imported.out).toBe(0)
    expect((await read('target', keys[1] as string)).draft).toBe('Offer A')
  })

  test('--publish puts live what was live at the source', async () => {
    const result = await cli('target', 'content', 'import', bundle(), '--publish')
    expect(result.code, result.out).toBe(0)
    for (const key of keys) {
      const state = await read('target', key)
      expect(state.published, key).toBe(true)
      expect(state.live, key).not.toBeNull()
    }
  })

  test('lists the runs it has applied', async () => {
    const result = await cli('target', 'content', 'runs')
    expect(result.code, result.out).toBe(0)
    expect(result.out.split('\n').filter((line) => line.includes('import')).length).toBeGreaterThan(
      1,
    )
  })

  test('reverts the last run, putting the live site back', async () => {
    const runs = await cli('target', 'content', 'runs', '--limit', '1')
    const runId = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.exec(
      runs.out,
    )?.[0] as string
    expect(runId).toBeDefined()

    const reverted = await cli('target', 'content', 'revert', runId, '--resolve-all', 'discard')
    expect(reverted.code, reverted.out).toBe(0)
    expect(reverted.out).toContain('would put it back again')
    // Reverting the same run twice is refused rather than repeated.
    const again = await cli('target', 'content', 'revert', runId)
    expect(again.code).toBe(1)
    expect(again.out).toContain('is reverted, so there is nothing to put back')
    expect(again.out).toContain('Nothing was changed')
  })

  test('a bundle whose node file is missing is refused as incomplete', async () => {
    const broken = join(dir, 'broken')
    const copied = await cli('source', 'content', 'export', '--root', '/Campaigns', '--out', broken)
    expect(copied.code, copied.out).toBe(0)
    rmSync(join(broken, 'nodes', `${keys[2]}.json`))
    // Checking must refuse rather than report-and-continue: otherwise a bundle
    // that was copied half-way passes the gate and then gets imported.
    const result = await cli('target', 'content', 'check', broken)
    expect(result.code, result.out).toBe(1)
    expect(result.out).toContain('integrity does not match')
    const imported = await cli('target', 'content', 'import', broken)
    expect(imported.code, imported.out).toBe(1)
  })

  test('a path that names nothing is refused with the candidates', async () => {
    const result = await cli(
      'source',
      'content',
      'export',
      '--root',
      '/Nope',
      '--out',
      join(dir, 'x'),
    )
    expect(result.code).toBe(1)
    expect(result.out).toContain('nothing named "Nope"')
    expect(result.out).toContain('Campaigns')
  })

  test('--with-blobs carries the media bytes, and the import places them', async () => {
    const seeded = await seed('source', 'media', 'Carried')
    expect(seeded.code, seeded.out).toBe(0)
    const media = JSON.parse(seeded.out.trim().split('\n').at(-1) as string) as {
      key: string
      blob: string
    }

    const out = join(dir, 'with-blobs')
    const exported = await cli(
      'source',
      'content',
      'export',
      '--root',
      media.key,
      '--with-blobs',
      '--out',
      out,
    )
    expect(exported.code, exported.out).toBe(0)
    expect(exported.out, exported.out).toContain('1 media file(s),')
    expect(existsSync(join(out, 'blobs', media.blob)), exported.out).toBe(true)

    // The destination has the node nowhere and the file nowhere.
    const before = await seed('target', 'blob', media.blob)
    expect(JSON.parse(before.out.trim().split('\n').at(-1) as string).exists).toBe(false)

    const checked = await cli('target', 'content', 'check', out)
    expect(checked.code, checked.out).toBe(0)
    // Carried, so there is nothing for the destination to be missing.
    expect(checked.out).toContain('media file(s) carried')
    expect(checked.out).not.toContain('missing-blob')

    const imported = await cli('target', 'content', 'import', out)
    expect(imported.code, imported.out).toBe(0)
    expect(imported.out).toContain('1 media file(s) placed')

    const after = await seed('target', 'blob', media.blob)
    const placed = JSON.parse(after.out.trim().split('\n').at(-1) as string)
    expect(placed.exists).toBe(true)
    expect(placed.size).toBe(12)
  }, 60_000)

  test('without the flag the file does not travel, and the destination says so', async () => {
    const seeded = await seed('source', 'media', 'Left Behind')
    const media = JSON.parse(seeded.out.trim().split('\n').at(-1) as string) as {
      key: string
      blob: string
    }
    const out = join(dir, 'no-blobs')
    const exported = await cli('source', 'content', 'export', '--root', media.key, '--out', out)
    expect(exported.code, exported.out).toBe(0)
    expect(exported.out).toContain('pass --with-blobs')
    expect(existsSync(join(out, 'blobs'))).toBe(false)

    const checked = await cli('target', 'content', 'check', out)
    // A person has to decide: the metadata can land without the file, but
    // nobody should find that out from a broken image.
    expect(checked.out).toContain('is not in this environment')
    expect(checked.code).toBe(1)

    const allowed = await cli('target', 'content', 'check', out, '--allow-missing-blobs')
    expect(allowed.code, allowed.out).toBe(0)
  }, 60_000)

  test('publishes a branch, having refused to publish half of one', async () => {
    // Its own tree in the destination, so this says nothing about the transfer
    // tests above and they say nothing about it.
    const seeded = await seed('target', 'tree')
    expect(seeded.code, seeded.out).toBe(0)
    const [root, offerA] = (seeded.out.trim().split('\n').at(-1) as string).split(' ')

    // `tree` publishes as it goes, so take the lot down first and work up from
    // the state a draft import leaves behind.
    const down = await cli('target', 'content', 'unpublish', root as string, '--descendants')
    expect(down.code, down.out).toBe(0)
    expect(down.out).toContain('3 page(s) unpublished')
    expect((await read('target', offerA as string)).published).toBe(false)

    // A child on its own is refused: its parent is not published, and nothing
    // in this command would publish it.
    const half = await cli('target', 'content', 'publish', offerA as string)
    expect(half.code).toBe(1)
    expect(half.out).toContain('an ancestor is not published')
    expect(half.out).toContain('nothing was published')
    expect((await read('target', offerA as string)).published).toBe(false)

    // The branch together is not: the root is published first, so the children
    // are not blocked by an ancestor this very run takes live.
    const up = await cli('target', 'content', 'publish', root as string, '--descendants')
    expect(up.code, up.out).toBe(0)
    expect(up.out).toContain('3 page(s) published')
    expect((await read('target', root as string)).published).toBe(true)
    expect((await read('target', offerA as string)).published).toBe(true)
  }, 60_000)

  test('refuses a page it cannot find, and a date it cannot read', async () => {
    const missing = await cli('target', 'content', 'publish', '/Nowhere')
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('Nowhere')

    const seeded = await seed('target', 'tree')
    const [root] = (seeded.out.trim().split('\n').at(-1) as string).split(' ')
    const bad = await cli('target', 'content', 'publish', root as string, '--at', 'soon')
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('not a date')

    // A real one is recorded as a schedule rather than published now.
    const scheduled = await cli(
      'target',
      'content',
      'publish',
      root as string,
      '--at',
      '2099-01-01T09:00',
    )
    expect(scheduled.code, scheduled.out).toBe(0)
    expect(scheduled.out).toContain('scheduled')
  }, 60_000)

  test('the dictionary round trips between the two environments', async () => {
    const file = join(dir, 'dictionary.udt')
    // Nothing to export from a site with no dictionary items; prove that first.
    const empty = await cli('source', 'dictionary', 'export', '--out', file)
    expect(empty.code).toBe(1)
    expect(empty.out).toContain('no dictionary items')
  })

  function bundle(): string {
    return join(dir, 'bundle')
  }
})
