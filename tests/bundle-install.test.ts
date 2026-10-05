/**
 * Installing a bundle that carries its own structure — what a created package
 * is. docs/17-packages.md.
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
  mkdirSync(join(root, 'Views', 'Partials'), { recursive: true })
  mkdirSync(join(root, 'css'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      viewsDir: join(root, 'Views'),
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
  { path: 'views/brochure.tsx', text: VIEW },
  { path: 'partials/promo.tsx', text: 'export default () => <aside />\n' },
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
      'partials',
      'schema',
      'scripts',
      'styles',
      'views',
    ])
  })
})

describe('planning, before anything is written', () => {
  test('maps each section onto this site’s own directories', async () => {
    const { h, config, db, root } = await site()
    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    const target = (path: string) => plan.files.find((f) => f.path === path)?.target

    expect(target('views/brochure.tsx')).toBe(join(root, 'Views', 'brochure.tsx'))
    // Umbraco's place, and ours: partials sit under the views directory.
    expect(target('partials/promo.tsx')).toBe(join(root, 'Views', 'Partials', 'promo.tsx'))
    expect(target('styles/brochure.css')).toBe(join(root, 'css', 'brochure.css'))
    expect(target('scripts/brochure.js')).toBe(join(root, 'scripts', 'brochure.js'))
    expect(target('schema/document-types/brochure.toml')).toBe(
      join(root, 'schema', 'document-types', 'brochure.toml'),
    )
  })

  test('writes nothing: the site is untouched by a plan', async () => {
    const { h, config, db, root } = await site()
    await planSections(db, config, await bundleWith(h, SECTIONS()))
    expect(existsSync(join(root, 'Views', 'brochure.tsx'))).toBe(false)
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
    writeFileSync(join(root, 'Views', 'brochure.tsx'), 'something else\n')
    writeFileSync(join(root, 'css', 'brochure.css'), '.brochure { color: red }\n')

    const plan = await planSections(db, config, await bundleWith(h, SECTIONS()))
    const action = (path: string) => plan.files.find((f) => f.path === path)?.action
    expect(action('views/brochure.tsx')).toBe('overwrite')
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

    expect(readFileSync(join(root, 'Views', 'brochure.tsx'), 'utf8')).toBe(VIEW)
    expect(readFileSync(join(root, 'Views', 'Partials', 'promo.tsx'), 'utf8')).toContain(
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
    expect(existsSync(join(root, 'Views', 'brochure.tsx'))).toBe(true)
  })

  test('declining the files applies only the schema', async () => {
    const { h, config, db, root } = await site()
    await applySections(db, config, await bundleWith(h, SECTIONS()), { withoutFiles: true })
    expect(existsSync(join(root, 'Views', 'brochure.tsx'))).toBe(false)
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

  test('creates a directory a section needs but the site has not got', async () => {
    const { h, config, db, root } = await site()
    rmSync(join(root, 'Views', 'Partials'), { recursive: true, force: true })
    await applySections(db, config, await bundleWith(h, SECTIONS()))
    expect(existsSync(join(root, 'Views', 'Partials', 'promo.tsx'))).toBe(true)
  })
})
