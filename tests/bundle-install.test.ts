/**
 * Installing a bundle that carries its own structure — what a created package
 * is. docs/17-bundles.md.
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
  planSections,
  promoteBackups,
  RUN_BACKUP_DIR,
  replacementsNeedingPermission,
  restoreSectionFiles,
  stageBackups,
} from '@bunbraco/cli'
import { ContentTypeRepository, DictionaryRepository } from '@bunbraco/data'
import {
  type BundleFile,
  type ContentSet,
  exportBundle,
  loadBundle,
  writeBundle,
} from '@bunbraco/transfer'
import { type Harness, signedInServer } from './support/harness.ts'

const PAGE_TOML = `[document-type]
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
async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bundle-install-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  mkdirSync(join(root, 'css'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  const h = await signedInServer({
    config: {
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
  { path: 'schema/document-types/brochure.toml', text: PAGE_TOML },
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
    expect(target('schema/document-types/brochure.toml')).toBe(
      join(root, 'schema', 'document-types', 'brochure.toml'),
    )
  })

  test('writes nothing: the site is untouched by a plan', async () => {
    const { h, config, db, root } = await site()
    await planSections(db, config, await bundleWith(h, SECTIONS()))
    expect(existsSync(join(root, 'components', 'brochure.tsx'))).toBe(false)
    expect(existsSync(join(root, 'schema', 'document-types', 'brochure.toml'))).toBe(false)
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
    const written = readFileSync(join(root, 'schema', 'document-types', 'brochure.toml'), 'utf8')
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
    expect(existsSync(join(root, 'schema', 'document-types', 'brochure.toml'))).toBe(false)
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
   * stylesheet, a template, a document type — and a site need not be a git
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
 * install kept. `docs/17-bundles.md`.
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
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    writeFileSync(
      join(root, 'schema', 'document-types', 'brochure.toml'),
      '[document-type]\nalias = "brochure"\nname = "Edited here"\n',
    )
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    expect(replacementsNeedingPermission(plan).map((f) => f.path)).toContain(
      'schema/document-types/brochure.toml',
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
    // `.bunbraco/components` is rebuilt from components/ and cleared at boot;
    // these have to outlive a restart to be worth taking.
    expect(RUN_BACKUP_DIR).toBe(join('.bunbraco', 'transfer'))
    expect(RUN_BACKUP_DIR.startsWith(join('.bunbraco', 'components'))).toBe(false)
  })
})
