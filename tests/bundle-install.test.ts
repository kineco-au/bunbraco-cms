/**
 * Installing a bundle that carries its own structure — what a created package
 * is. docs/bundles.md.
 *
 * The cases that matter are where getting it wrong is quiet: a section landing
 * in the wrong directory, a file overwritten without warning, and the schema
 * check having to answer *before* anything is written.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applySections,
  type CarriedSections,
  carriedSections,
  carriesSections,
  contentExport,
  planSections,
  promoteBackups,
  RUN_BACKUP_DIR,
  replacementsNeedingPermission,
  restoreSectionFiles,
  stageBackups,
} from '@crombolo/cli'
import { ContentTypeRepository, DictionaryRepository, TransferRunRepository } from '@crombolo/data'
import {
  CommandError,
  installBundleContent,
  readBundle,
  syncSchemaDirectory,
  VERSION,
} from '@crombolo/server'
import {
  type BundleFile,
  type BundlePackageInfo,
  type ContentSet,
  exportBundle,
  loadBundle,
  writeBundle,
  writeBundlePackage,
} from '@crombolo/transfer'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const PAGE_TOML = `[content-type]
alias = "brochure"
name = "Brochure"
allow-at-root = true

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

const VIEW = `export default function Brochure({ model }) {
  return <main>{model.text('title')}</main>
}
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

/** A site with its own schema, views, css and scripts directories. */
async function site(dependencies: Record<string, string> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bundle-install-'))
  dirs.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'a-site', dependencies }))
  mkdirSync(join(root, 'schema'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  mkdirSync(join(root, 'css'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  const h = await signedInServer({
    config: {
      siteDir: root,
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      stylesheetsDir: join(root, 'css'),
      scriptsDir: join(root, 'scripts'),
    },
  })
  open.push(h)
  return { h, root, config: h.server.config, db: h.server.db }
}

/** A bundle carrying the given sections, written then read back as one would arrive. */
async function bundleWith(h: Harness, sections: BundleFile[]): Promise<CarriedSections> {
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
  const dir = mkdtempSync(join(process.cwd(), 'output', 'bundle-'))
  dirs.push(dir)
  for (const file of writeBundle(set as ContentSet, undefined, sections)) {
    const target = join(dir, file.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.bytes ?? (file.text as string))
  }
  const loaded = loadBundle(dir)
  expect(loaded.problems).toEqual([])
  return carriedSections(loaded)
}

const SECTIONS = (): BundleFile[] => [
  { path: 'schema/content-types/brochure.toml', text: PAGE_TOML },
  { path: 'components/brochure.tsx', text: VIEW },
  // A nested one: there is one section and one root, so a bundle can carry a
  // component in the folder its author put it in.
  { path: 'components/shared/promo.tsx', text: 'export default () => <aside />\n' },
  { path: 'styles/brochure.css', text: '.brochure { color: red }\n' },
  { path: 'scripts/brochure.js', text: 'console.log("brochure")\n' },
]

describe('what a bundle carries', () => {
  test('a content-only bundle carries no sections', async () => {
    const { h } = await site()
    const carried = await bundleWith(h, [])
    expect(carriesSections(carried)).toBe(false)
  })

  test('a bundle with sections reports each one', async () => {
    const { h } = await site()
    const carried = await bundleWith(h, SECTIONS())
    expect(carriesSections(carried)).toBe(true)
    expect(Object.keys(carried.carries).sort()).toEqual([
      'components',
      'schema',
      'scripts',
      'styles',
    ])
  })
})

describe('planning, before anything is written', () => {
  test('maps each section onto this site’s own directories', async () => {
    const { h, config, db, root } = await site()
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    const target = (path: string) => plan.files.find((f) => f.path === path)?.target

    expect(target('components/brochure.tsx')).toBe(join(root, 'components', 'brochure.tsx'))
    expect(target('components/shared/promo.tsx')).toBe(
      join(root, 'components', 'shared', 'promo.tsx'),
    )
    expect(target('styles/brochure.css')).toBe(join(root, 'css', 'brochure.css'))
    expect(target('scripts/brochure.js')).toBe(join(root, 'scripts', 'brochure.js'))
    expect(target('schema/content-types/brochure.toml')).toBe(
      join(root, 'schema', 'content-types', 'brochure.toml'),
    )
  })

  test('writes nothing: the site is untouched by a plan', async () => {
    const { h, config, db, root } = await site()
    await planSections(db, config, await bundleWith(h, SECTIONS()))
    expect(existsSync(join(root, 'components', 'brochure.tsx'))).toBe(false)
    expect(existsSync(join(root, 'schema', 'content-types', 'brochure.toml'))).toBe(false)
    // And the type it describes has not been created either.
    expect(await new ContentTypeRepository(db).byAlias('brochure')).toBeUndefined()
  })

  test('says what the schema would do, from an overlay rather than the site', async () => {
    const { h, config, db } = await site()
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    // A new type is additive: nothing existing has to change for it to apply.
    expect(plan.schema?.classification).toBe('additive')
  })

  test('tells create from overwrite from unchanged', async () => {
    const { h, config, db, root } = await site()
    writeFileSync(join(root, 'components', 'brochure.tsx'), 'something else\n')
    writeFileSync(join(root, 'css', 'brochure.css'), '.brochure { color: red }\n')

    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    const action = (path: string) => plan.files.find((f) => f.path === path)?.action
    expect(action('components/brochure.tsx')).toBe('overwrite')
    expect(action('styles/brochure.css')).toBe('unchanged')
    expect(action('scripts/brochure.js')).toBe('create')
  })

  test('declining a half leaves it out of the plan', async () => {
    const { h, config, db } = await site()
    const carried = await bundleWith(h, SECTIONS())

    const noSchema = await planSections(db, config, carried, { withoutSchema: true })
    expect(noSchema.files.some((f) => f.path.startsWith('schema/'))).toBe(false)
    expect(noSchema.schema).toBeUndefined()

    const noFiles = await planSections(db, config, carried, { withoutFiles: true })
    expect(noFiles.files.every((f) => f.path.startsWith('schema/'))).toBe(true)
  })
})

describe('applying', () => {
  test('places every section and syncs the schema it wrote', async () => {
    const { h, config, db, root } = await site()
    const result = await applySections(db, config, await bundleWith(h, SECTIONS()))

    expect(readFileSync(join(root, 'components', 'brochure.tsx'), 'utf8')).toBe(VIEW)
    expect(readFileSync(join(root, 'components', 'shared', 'promo.tsx'), 'utf8')).toContain(
      '<aside />',
    )
    expect(readFileSync(join(root, 'css', 'brochure.css'), 'utf8')).toContain('.brochure')
    expect(readFileSync(join(root, 'scripts', 'brochure.js'), 'utf8')).toContain('brochure')
    // Not byte-identical to what the bundle carried: the sync writes the keys it
    // assigned back into the file, which is how a type stays matchable by key
    // across environments rather than by alias alone.
    const written = readFileSync(join(root, 'schema', 'content-types', 'brochure.toml'), 'utf8')
    expect(written).toContain('alias = "brochure"')
    expect(written).toContain('key = ')
    expect(result.written).toHaveLength(5)

    // The file is the truth and the database follows it: the sync is what makes
    // the type exist, so an install cannot leave a database the files do not describe.
    expect(result.schema?.action).toBe('applied')
    const type = await new ContentTypeRepository(db).byAlias('brochure')
    expect(type?.name).toBe('Brochure')
  })

  /**
   * Converges rather than accumulates. A second apply rewrites the schema file
   * without the keys the first sync wrote back, so the sync runs again and
   * re-assigns them from the database — the type is matched by alias when the
   * file carries no key, so it is updated, never duplicated. The end state is
   * what matters, and it is identical.
   */
  test('applying the same bundle twice converges on one type', async () => {
    const { h, config, db } = await site()
    const carried = await bundleWith(h, SECTIONS())
    await applySections(db, config, carried)
    const first = await new ContentTypeRepository(db).byAlias('brochure')

    await applySections(db, config, carried)
    const second = await new ContentTypeRepository(db).byAlias('brochure')
    expect(second?.key).toBe(first?.key as string)

    const all = await db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM content_type WHERE alias = 'brochure'",
    )
    expect(Number(all[0]?.n)).toBe(1)
    // And the views and styles are byte-identical, since nothing rewrites those.
    const plan = await planSections(db, config, carried)
    expect(
      plan.files
        .filter((f) => !f.path.startsWith('schema/'))
        .every((f) => f.action === 'unchanged'),
    ).toBe(true)
  })

  test('declining the schema leaves the site’s structure alone', async () => {
    const { h, config, db, root } = await site()
    await applySections(db, config, await bundleWith(h, SECTIONS()), { withoutSchema: true })
    expect(existsSync(join(root, 'schema', 'content-types', 'brochure.toml'))).toBe(false)
    expect(await new ContentTypeRepository(db).byAlias('brochure')).toBeUndefined()
    // The views still arrived.
    expect(existsSync(join(root, 'components', 'brochure.tsx'))).toBe(true)
  })

  test('declining the files applies only the schema', async () => {
    const { h, config, db, root } = await site()
    await applySections(db, config, await bundleWith(h, SECTIONS()), { withoutFiles: true })
    expect(existsSync(join(root, 'components', 'brochure.tsx'))).toBe(false)
    expect(await new ContentTypeRepository(db).byAlias('brochure')).toBeDefined()
  })

  test('imports the dictionary items it carries', async () => {
    const { h, config, db } = await site()
    const udt = `<?xml version="1.0" encoding="utf-8"?>
<DictionaryItems>
  <DictionaryItem Key="3f2a8b1c-1111-4222-8333-44445555aaaa" Name="Greeting">
    <Value LanguageCultureAlias="en-US"><![CDATA[Hello]]></Value>
  </DictionaryItem>
</DictionaryItems>
`
    const result = await applySections(
      db,
      config,
      await bundleWith(h, [{ path: 'dictionary.udt', text: udt }]),
    )
    expect(result.dictionary?.imported).toBe(1)
    const item = await new DictionaryRepository(db).get('3f2a8b1c-1111-4222-8333-44445555aaaa')
    expect(item?.name).toBe('Greeting')
  })

  /**
   * The files a bundle carries are all editable in the backoffice — a
   * stylesheet, a template, a content type — and a site need not be a git
   * checkout, so an overwrite can be unrecoverable. The originals are kept.
   */
  test('keeps what it replaced, under the backup directory', async () => {
    const { h, config, db, root } = await site()
    const target = join(root, 'css', 'brochure.css')
    writeFileSync(target, '.brochure { color: blue } /* an editor wrote this */\n')

    const staging = stageBackups(config)
    const result = await applySections(db, config, await bundleWith(h, SECTIONS()), {
      backupDir: staging,
      replaceFiles: true,
    })

    expect(result.replaced).toContain(target)
    const kept = join(staging, 'replaced', 'styles/brochure.css')
    expect(readFileSync(kept, 'utf8')).toContain('an editor wrote this')
    // And the site now has the bundle's version.
    expect(readFileSync(target, 'utf8')).toContain('color: red')
  })

  test('keeps nothing when nothing was replaced', async () => {
    const { h, config, db } = await site()
    const staging = stageBackups(config)
    const result = await applySections(db, config, await bundleWith(h, SECTIONS()), {
      backupDir: staging,
    })
    expect(result.replaced).toEqual([])
    expect(existsSync(join(staging, 'replaced'))).toBe(false)
  })

  test('creates a directory a section needs but the site has not got', async () => {
    const { h, config, db, root } = await site()
    rmSync(join(root, 'components', 'shared', 'promo.tsx'), { force: true })
    await applySections(db, config, await bundleWith(h, SECTIONS()))
    expect(existsSync(join(root, 'components', 'shared', 'promo.tsx'))).toBe(true)
  })
})

/**
 * Undoing an install, without assuming the site is a git checkout: the content
 * comes back through the ledger, and the files come back from the copies the
 * install kept. `docs/bundles.md`.
 */
/**
 * The rule that stops an install destroying an editor's work. Its own function
 * precisely so it can be held to this.
 */
describe('permission to replace a file', () => {
  test('a file that would be replaced needs permission, named', async () => {
    const { h, config, db, root } = await site()
    writeFileSync(join(root, 'css', 'brochure.css'), '.brochure { color: blue }\n')
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))

    const blocked = replacementsNeedingPermission(plan)
    expect(blocked.map((f) => f.path)).toEqual(['styles/brochure.css'])
  })

  test('nothing needs permission on a site that has none of the files', async () => {
    const { h, config, db } = await site()
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    expect(replacementsNeedingPermission(plan)).toEqual([])
  })

  /** An identical file is not a replacement: applying it changes nothing. */
  test('an unchanged file needs no permission', async () => {
    const { h, config, db, root } = await site()
    writeFileSync(join(root, 'css', 'brochure.css'), '.brochure { color: red }\n')
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    expect(replacementsNeedingPermission(plan)).toEqual([])
  })

  test('granting it clears every one', async () => {
    const { h, config, db, root } = await site()
    writeFileSync(join(root, 'css', 'brochure.css'), '.brochure { color: blue }\n')
    writeFileSync(join(root, 'components', 'brochure.tsx'), 'different\n')
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))

    expect(replacementsNeedingPermission(plan)).toHaveLength(2)
    expect(replacementsNeedingPermission(plan, { replaceFiles: true })).toEqual([])
  })

  /** Schema is as editable from the backoffice as a stylesheet is. */
  test('a schema file the backoffice changed is protected too', async () => {
    const { h, config, db, root } = await site()
    mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
    writeFileSync(
      join(root, 'schema', 'content-types', 'brochure.toml'),
      '[content-type]\nalias = "brochure"\nname = "Edited here"\n',
    )
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    expect(replacementsNeedingPermission(plan).map((f) => f.path)).toContain(
      'schema/content-types/brochure.toml',
    )
  })
})

describe('reverting the files an install wrote', () => {
  const RUN = 'a1b2c3d4-0000-4000-8000-000000000001'

  test('puts a replaced file back and removes one it created', async () => {
    const { h, config, db, root } = await site()
    const replacedTarget = join(root, 'css', 'brochure.css')
    writeFileSync(replacedTarget, '.brochure { color: blue }\n')

    const staging = stageBackups(config)
    await applySections(db, config, await bundleWith(h, SECTIONS()), {
      backupDir: staging,
      replaceFiles: true,
    })
    const createdTarget = join(root, 'components', 'brochure.tsx')
    expect(existsSync(createdTarget)).toBe(true)

    const kept = promoteBackups(config, staging, RUN)
    expect(kept).toBeDefined()

    const restored = restoreSectionFiles(config, RUN)
    expect(readFileSync(replacedTarget, 'utf8')).toBe('.brochure { color: blue }\n')
    expect(restored.restored).toContain(replacedTarget)
    // A file the install created goes away again; nothing else put it there.
    expect(existsSync(createdTarget)).toBe(false)
    expect(restored.removed).toContain(createdTarget)
  })

  test('a run that replaced nothing restores nothing, and does not throw', async () => {
    const { config } = await site()
    expect(restoreSectionFiles(config, 'no-such-run')).toEqual({ restored: [], removed: [] })
  })

  /**
   * A staging directory is only promoted once the content has imported. One
   * that holds no record is an apply that wrote nothing, and is cleaned up —
   * but a directory that does hold one is never discarded, because it has the
   * only copy of what was replaced.
   */
  test('an empty staging directory is cleaned up rather than promoted', async () => {
    const { config } = await site()
    const staging = stageBackups(config)
    expect(promoteBackups(config, staging, RUN)).toBeUndefined()
    expect(existsSync(staging)).toBe(false)
  })

  test('the backups sit beside the components cache, not inside it', async () => {
    // `.crombolo/components` is rebuilt from components/ and cleared at boot;
    // these have to outlive a restart to be worth taking.
    expect(RUN_BACKUP_DIR).toBe(join('.crombolo', 'transfer'))
    expect(RUN_BACKUP_DIR.startsWith(join('.crombolo', 'components'))).toBe(false)
  })
})

const KIT: BundlePackageInfo = {
  name: '@acme/kit',
  version: '1.4.0',
  id: 'acme-kit',
  label: 'Kit',
  peerRange: `^${VERSION}`,
}

/** A bundle package carrying these sections, written where `dir` says. */
async function packageAt(
  h: Harness,
  dir: string,
  sections: BundleFile[],
  info: BundlePackageInfo = KIT,
): Promise<string> {
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
  for (const file of writeBundlePackage(
    writeBundle(set as ContentSet, undefined, sections),
    info,
  )) {
    const target = join(dir, file.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.bytes ?? (file.text as string))
  }
  return dir
}

const outputDir = (prefix: string) => {
  const dir = mkdtempSync(join(process.cwd(), 'output', prefix))
  dirs.push(dir)
  return dir
}

const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof CommandError) return [error.message, ...error.problems].join('\n')
    throw error
  }
  throw new Error('it was not refused')
}

describe('a bundle is found as a package', () => {
  test('a package directory installs in place, and the site does not come to depend on it', async () => {
    const { h, root, config, db } = await site()
    const dir = await packageAt(h, outputDir('kit-'), SECTIONS())
    const before = readFileSync(join(root, 'package.json'), 'utf8')
    const result = await installBundleContent(db, config, { bundle: dir, backupTaken: true })
    expect(result.problems).toEqual([])
    expect(result.runId).toBeDefined()
    expect(existsSync(join(root, 'components', 'brochure.tsx'))).toBe(true)
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
    expect(result.bundle.package).toEqual({ name: '@acme/kit', version: '1.4.0' })
  })

  test('the run records the package and version that brought the content', async () => {
    const { h, config, db } = await site()
    const dir = await packageAt(h, outputDir('kit-'), [])
    const result = await installBundleContent(db, config, { bundle: dir, backupTaken: true })
    const run = await new TransferRunRepository(db).byId(result.runId as string)
    expect([run?.packageName, run?.packageVersion]).toEqual(['@acme/kit', '1.4.0'])
    expect((await new TransferRunRepository(db).appliedForPackage('@acme/kit'))?.id).toBe(
      result.runId as string,
    )
  })

  test('a dependency installs by its package name', async () => {
    const { h, root, config, db } = await site({ '@acme/kit': '^1.4.0' })
    await packageAt(h, join(root, 'node_modules', '@acme', 'kit'), SECTIONS())
    const result = await installBundleContent(db, config, {
      bundle: '@acme/kit',
      backupTaken: true,
    })
    expect(result.runId).toBeDefined()
    expect(existsSync(join(root, 'components', 'brochure.tsx'))).toBe(true)
  })

  test('a name the site does not depend on is refused, naming how to add it', async () => {
    const { config } = await site()
    expect(refusal(() => readBundle('@acme/kit', config.siteDir))).toContain('bun add @acme/kit')
  })

  test('a bare payload with no package around it is refused', async () => {
    const { h } = await site()
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
    const dir = outputDir('bare-')
    for (const file of writeBundle(set as ContentSet))
      writeFileSync(join(dir, file.path), file.text as string)
    expect(refusal(() => readBundle(dir, dir))).toContain('Every bundle is an npm package')
  })

  test('a package written for another core is refused, naming both', async () => {
    const { h } = await site()
    const dir = await packageAt(h, outputDir('kit-'), [], { ...KIT, peerRange: '^0.1.0' })
    const message = refusal(() => readBundle(dir, dir))
    expect(message).toContain('^0.1.0')
    expect(message).toContain(VERSION)
  })

  test('a package that carries no content has nothing to install', async () => {
    const dir = outputDir('no-content-')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/screens',
        version: '1.0.0',
        peerDependencies: { '@crombolo/crombolo': `^${VERSION}` },
        crombolo: { id: 'acme-screens', extensions: [{ type: 'dashboard' }] },
      }),
    )
    expect(refusal(() => readBundle(dir, dir))).toContain('carries no content')
  })
})

describe('an environment’s export', () => {
  /**
   * `content export` opens its own connection, so the source site is a file on
   * SQLite (an in-memory database is a different one per connection) and is the
   * same database on Postgres. The destination is booted afterwards, which on
   * Postgres resets the schema: the export is already on disk by then.
   */
  test('is a private package that installs on another site, and round trips', async () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'export-source-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
    mkdirSync(join(root, 'components'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'content-types', 'brochure.toml'), PAGE_TOML)
    const source = await signedInServer({
      config: {
        siteDir: root,
        sqliteFile: join(root, 'source.sqlite'),
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
      },
    })
    const type = await new ContentTypeRepository(source.server.db).byAlias('brochure')
    const created = await source.post(`${V1}/document`, {
      documentType: { id: type?.key },
      template: null,
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Autumn' }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    const exported = await contentExport(source.server.config, {
      roots: [key],
      drafts: true,
      package: { name: 'autumn-campaign' },
    })
    await source.db.close()

    expect(exported.package).toEqual({ name: 'autumn-campaign', version: '1.0.0' })
    const out = outputDir('export-')
    for (const file of exported.files) {
      const target = join(out, file.path)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, file.bytes ?? (file.text as string))
    }
    const json = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
    expect(json.private).toBe(true)
    expect(json.keywords).toBeUndefined()
    expect(json.crombolo.content).toBe('bundle')
    expect(existsSync(join(out, 'bundle', 'bundle.json'))).toBe(true)

    const destination = await site()
    // The destination has the type already, as a deploy would have given it.
    mkdirSync(join(destination.root, 'schema', 'content-types'), { recursive: true })
    writeFileSync(join(destination.root, 'schema', 'content-types', 'brochure.toml'), PAGE_TOML)
    await syncSchemaDirectory(destination.db, destination.config, {
      nodeId: destination.config.nodeId,
      revision: destination.config.schemaRevision,
    })
    const installed = await installBundleContent(destination.db, destination.config, {
      bundle: out,
      withoutFiles: true,
      backupTaken: true,
    })
    expect(installed.problems).toEqual([])
    expect(installed.runId).toBeDefined()
    expect(installed.bundle.package).toEqual({ name: 'autumn-campaign', version: '1.0.0' })
    const read = await destination.h.json<{ variants: { name: string }[] }>(`${V1}/document/${key}`)
    expect(read.variants[0]?.name).toBe('Autumn')
  })
})
