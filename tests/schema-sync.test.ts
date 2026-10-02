/**
 * Files → database: version gating, retirement and revival, key assignment,
 * deletion safety. docs/09-schema-as-code.md, "Synchronisation".
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword, passwordConfigJson } from '@bunbraco/auth'
import {
  bunbracoPlan,
  ContentTypeRepository,
  currentSchemaState,
  DataTypeRepository,
  type Db,
  DocumentRepository,
  LanguageRepository,
  migrate,
  seedContent,
  seedIdentity,
} from '@bunbraco/data'
import {
  allProperties,
  exportSchemaSet,
  generateTypes,
  hashSchemaSet,
  loadSchemaDirectory,
  type SchemaDocumentType,
  type SyncOptions,
  type SyncReport,
  syncSchema,
  writeKeysBack,
  writeSchemaFiles,
} from '@bunbraco/schema'
import { canConnect, dialectUnderTest, freshDb } from './support/db.ts'

const open: Db[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function prepared(): Promise<Db> {
  const db = await freshDb()
  open.push(db)
  await migrate(db, bunbracoPlan)
  await seedIdentity(db, {
    admin: { name: 'A', login: 'a@b.c', email: 'a@b.c', password: 'x' },
    hashPassword,
    passwordConfig: passwordConfigJson(),
  })
  await seedContent(db)
  return db
}

/** Writes a schema directory; `files` maps relative path → TOML source. */
function schemaDir(version: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunbraco-sync-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'document-types'), { recursive: true })
  mkdirSync(join(dir, 'data-types'), { recursive: true })
  writeFileSync(join(dir, 'schema.toml'), `[schema]\nversion = "${version}"\n`)
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
  return dir
}

const ARTICLE = (extra = '') => `
[document-type]
alias = "article"
name = "Article"
icon = "icon-article"
allow-at-root = true

[[tab]]
name = "Content"

[[tab.property]]
alias = "title"
name = "Title"
type = "textstring"
mandatory = true
${extra}
`

const SUMMARY = `
[[tab.property]]
alias = "summary"
name = "Summary"
type = "textarea"
`

/** The same type with keys everywhere, as a deploy to production carries. */
const KEYED = (extra = '') =>
  ARTICLE(extra)
    .replace('alias = "article"', 'key = "0b1c8e3a-1111-4a5b-9c1d-000000000001"\nalias = "article"')
    .replace('alias = "title"', 'key = "0b1c8e3a-1111-4a5b-9c1d-000000000002"\nalias = "title"')
const SUMMARY_KEYED = SUMMARY.replace(
  'alias = "summary"',
  'key = "0b1c8e3a-1111-4a5b-9c1d-000000000003"\nalias = "summary"',
)

const NODE = { nodeId: 'node-a', version: '1.0.0', revision: '1' }
const dev: SyncOptions = { mode: 'development' }
const prod: SyncOptions = { mode: 'production' }

function sync(db: Db, dir: string, node = NODE, options: SyncOptions = dev): Promise<SyncReport> {
  return syncSchema(db, loadSchemaDirectory(dir), node, options)
}

describe(`schema sync (${dialectUnderTest})`, () => {
  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`cannot connect to ${dialectUnderTest}`)
  })

  test('applies a fresh schema: types, properties, languages, and a new schema_state', async () => {
    const db = await prepared()
    const dir = schemaDir('1.0.0', {
      'document-types/article.toml': ARTICLE(SUMMARY),
      'languages.toml': `[[language]]\niso = "en-US"\nname = "English"\ndefault = true\n\n[[language]]\niso = "da-DK"\nname = "Danish"\nfallback = "en-US"\n`,
    })
    const report = await sync(db, dir)
    expect(report.action).toBe('applied')
    expect(report.created).toEqual({ types: 1, properties: 2, dataTypes: 0, languages: 1 })
    expect(report.updated.languages).toBe(1)
    // Keys were minted for the type and both properties
    expect(report.assignedKeys.map((k) => k.propertyAlias ?? '<type>').sort()).toEqual([
      '<type>',
      'summary',
      'title',
    ])

    const type = await new ContentTypeRepository(db).byAlias('article')
    expect(type?.properties.map((p) => p.alias)).toEqual(['title', 'summary'])
    expect(type?.containers.map((c) => [c.name, c.type])).toEqual([['Content', 'Tab']])
    const state = await currentSchemaState(db)
    expect(state).toMatchObject({ version: '1.0.0', revision: '1', status: 'current' })
    expect(state.id).toBe(report.state?.id as number)
    const languages = await new LanguageRepository(db).all()
    expect(languages.find((l) => l.isoCode === 'da-DK')?.fallbackIsoCode).toBe('en-US')
  })

  test('the same files a second time change nothing', async () => {
    const db = await prepared()
    const dir = schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE() })
    const first = await sync(db, dir)
    const second = await sync(db, dir)
    expect(second.action).toBe('skipped-same')
    expect((await currentSchemaState(db)).id).toBe(first.state?.id as number)
  })

  test('older files skip: the node runs in compatibility mode', async () => {
    const db = await prepared()
    await sync(db, schemaDir('2.0.0', { 'document-types/article.toml': ARTICLE() }), {
      ...NODE,
      version: '2.0.0',
    })
    const older = await sync(
      db,
      schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE(SUMMARY) }),
    )
    expect(older.action).toBe('skipped-older')
    expect(older.reason).toContain('compatibility mode')
    // Nothing from the older files landed
    const type = await new ContentTypeRepository(db).byAlias('article')
    expect(type?.properties.map((p) => p.alias)).toEqual(['title'])
  })

  test('a changed schema without a version bump applies in development and refuses in production', async () => {
    const db = await prepared()
    await sync(db, schemaDir('1.0.0', { 'document-types/article.toml': KEYED() }))
    const changed = schemaDir('1.0.0', { 'document-types/article.toml': KEYED(SUMMARY_KEYED) })

    const refused = await sync(db, changed, NODE, prod)
    expect(refused.action).toBe('refused')
    expect(refused.reason).toContain('without a version bump')

    const applied = await sync(db, changed, NODE, dev)
    expect(applied.action).toBe('applied')
    expect(applied.created.properties).toBe(1)
  })

  test('a newer revision at the same version applies in production', async () => {
    const db = await prepared()
    await sync(db, schemaDir('1.0.0', { 'document-types/article.toml': KEYED() }), NODE, prod)
    const report = await sync(
      db,
      schemaDir('1.0.0', { 'document-types/article.toml': KEYED(SUMMARY_KEYED) }),
      { ...NODE, revision: '2' },
      prod,
    )
    expect(report.action).toBe('applied')
    expect((await currentSchemaState(db)).revision).toBe('2')
  })

  test('schema problems refuse before touching the database', async () => {
    const db = await prepared()
    const before = await currentSchemaState(db)
    const report = await sync(
      db,
      schemaDir('1.0.0', {
        'document-types/article.toml': ARTICLE().replace('textstring', 'nope'),
      }),
    )
    expect(report.action).toBe('refused')
    expect(report.problems.length).toBeGreaterThan(0)
    expect((await currentSchemaState(db)).id).toBe(before.id)
  })

  test('removing a property retires it; values survive; adding it back revives the same key', async () => {
    const db = await prepared()
    await sync(db, schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE(SUMMARY) }))
    const types = new ContentTypeRepository(db)
    const typeKey = (await types.byAlias('article'))?.key as string
    const summaryKey = (await types.byAlias('article'))?.properties.find(
      (p) => p.alias === 'summary',
    )?.key as string

    const docs = new DocumentRepository(db, { nodeState: { version: '1.0.0', revision: '1' } })
    const doc = await docs.create({
      key: crypto.randomUUID(),
      contentTypeKey: typeKey,
      parentKey: null,
      templateKey: null,
      variants: [{ culture: null, segment: null, name: 'One' }],
      values: [
        { alias: 'title', culture: null, segment: null, value: 'T' },
        { alias: 'summary', culture: null, segment: null, value: 'kept' },
      ],
      userId: 1,
    })

    const removed = await sync(
      db,
      schemaDir('1.0.1', { 'document-types/article.toml': ARTICLE() }),
      {
        ...NODE,
        version: '1.0.1',
      },
    )
    expect(removed.action).toBe('applied')
    expect(removed.retired).toEqual(['article.summary'])
    expect((await types.byAlias('article'))?.properties.map((p) => p.alias)).toEqual(['title'])
    expect((await types.retiredProperties(typeKey)).map((p) => p.alias)).toEqual(['summary'])
    // The value rows are untouched
    const rows = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM property_value WHERE property_type_id = (SELECT id FROM property_type WHERE unique_id = ?)',
      [summaryKey],
    )
    expect(Number(rows[0]?.n)).toBe(1)

    const revived = await sync(
      db,
      schemaDir('1.0.2', { 'document-types/article.toml': ARTICLE(SUMMARY) }),
      { ...NODE, version: '1.0.2' },
    )
    expect(revived.action).toBe('applied')
    expect(revived.revived).toEqual(['article.summary'])
    const back = (await types.byAlias('article'))?.properties.find((p) => p.alias === 'summary')
    expect(back?.key).toBe(summaryKey)
    expect(revived.assignedKeys.find((k) => k.propertyAlias === 'summary')).toMatchObject({
      key: summaryKey,
      revived: true,
    })
    const loaded = await docs.byKey(doc.key)
    expect(loaded?.values.find((v) => v.alias === 'summary')?.value).toBe('kept')
  })

  test('deleting a type file refuses while documents of it exist, and retires it when forced', async () => {
    const db = await prepared()
    await sync(db, schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE() }))
    const typeKey = (await new ContentTypeRepository(db).byAlias('article'))?.key as string
    await new DocumentRepository(db, { nodeState: NODE }).create({
      key: crypto.randomUUID(),
      contentTypeKey: typeKey,
      parentKey: null,
      templateKey: null,
      variants: [{ culture: null, segment: null, name: 'One' }],
      values: [{ alias: 'title', culture: null, segment: null, value: 'T' }],
      userId: 1,
    })
    const empty = schemaDir('1.1.0', {})
    const refused = await sync(db, empty, { ...NODE, version: '1.1.0' })
    expect(refused.action).toBe('refused')
    expect(refused.reason).toContain('1 document(s)')
    // The transaction rolled back: no state advanced
    expect((await currentSchemaState(db)).version).toBe('1.0.0')

    const forced = await sync(
      db,
      empty,
      { ...NODE, version: '1.1.0' },
      { ...dev, forceRetireTypes: true },
    )
    expect(forced.action).toBe('applied')
    expect(forced.retiredTypes).toEqual(['article'])
    expect(await new ContentTypeRepository(db).byAlias('article')).toBeUndefined()
  })

  test('data types from files are created by alias and referenced by properties', async () => {
    const db = await prepared()
    const dir = schemaDir('1.0.0', {
      'data-types/big-text.toml': `[data-type]\nalias = "bigText"\nname = "Big text"\neditor = "Umbraco.TextArea"\n\n[data-type.config]\nmaxChars = 500\n`,
      'document-types/article.toml': ARTICLE(SUMMARY.replace('textarea', 'bigText')),
    })
    const report = await sync(db, dir)
    expect(report.action).toBe('applied')
    expect(report.created.dataTypes).toBe(1)
    const dataType = await new DataTypeRepository(db).byAlias('bigText')
    expect(dataType?.values).toEqual([{ alias: 'maxChars', value: 500 }])
    const type = await new ContentTypeRepository(db).byAlias('article')
    expect(type?.properties.find((p) => p.alias === 'summary')?.dataTypeKey).toBe(dataType?.key)
  })

  test('compositions and allowed children resolve across files in any order', async () => {
    const db = await prepared()
    const dir = schemaDir('1.0.0', {
      'document-types/article.toml': ARTICLE('').replace(
        'allow-at-root = true',
        'allow-at-root = true\ncompositions = ["seo"]\nallow-children = ["article"]',
      ),
      'document-types/seo.toml': `[document-type]\nalias = "seo"\nname = "SEO"\nicon = "icon-search"\nis-element = true\n\n[[property]]\nalias = "metaTitle"\nname = "Meta title"\ntype = "textstring"\n`,
    })
    const report = await sync(db, dir)
    expect(report.action).toBe('applied')
    const types = new ContentTypeRepository(db)
    const seo = await types.byAlias('seo')
    const article = await types.byAlias('article')
    expect(article?.compositions.map((c) => c.contentTypeKey)).toEqual([seo?.key as string])
    expect(article?.allowedContentTypes.map((c) => c.contentTypeKey)).toEqual([
      article?.key as string,
    ])
  })
})

describe(`schema sync extras (${dialectUnderTest})`, () => {
  test('a dry run reports what would happen and changes nothing', async () => {
    const db = await prepared()
    const before = await currentSchemaState(db)
    const report = await sync(
      db,
      schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE(SUMMARY) }),
      NODE,
      {
        ...dev,
        dryRun: true,
      },
    )
    expect(report.action).toBe('would-apply')
    expect(report.created.types).toBe(1)
    expect((await currentSchemaState(db)).id).toBe(before.id)
    expect(await new ContentTypeRepository(db).byAlias('article')).toBeUndefined()
  })

  test('production refuses files without keys, and accepts them once written back', async () => {
    const db = await prepared()
    const dir = schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE(SUMMARY) })
    const refused = await sync(db, dir, NODE, prod)
    expect(refused.action).toBe('refused')
    expect(refused.reason).toContain('article.title')

    const loaded = loadSchemaDirectory(dir)
    const applied = await syncSchema(db, loaded, NODE, dev)
    const written = writeKeysBack(loaded, applied.assignedKeys)
    expect(written).toEqual([join(dir, 'document-types', 'article.toml')])
    const again = loadSchemaDirectory(dir)
    expect(again.problems).toEqual([])
    expect(again.set.documentTypes[0]?.key).toBeDefined()
    expect(
      allProperties(again.set.documentTypes[0] as SchemaDocumentType).every((p) => p.key),
    ).toBe(true)
    // Same files, now keyed: production is happy, and nothing is applied twice
    const db2 = await prepared()
    expect((await syncSchema(db2, again, NODE, prod)).action).toBe('applied')
  })

  test('export round-trips what sync applied, and generate names every property', async () => {
    const db = await prepared()
    const dir = schemaDir('1.0.0', {
      'data-types/big-text.toml': `[data-type]\nalias = "bigText"\nname = "Big text"\neditor = "Umbraco.TextArea"\n\n[data-type.config]\nmaxChars = 500\n`,
      'document-types/article.toml': ARTICLE(SUMMARY.replace('textarea', 'bigText')),
      'languages.toml': `[[language]]\niso = "en-US"\nname = "English"\ndefault = true\nmandatory = true\n`,
    })
    const loaded = loadSchemaDirectory(dir)
    const applied = await syncSchema(db, loaded, NODE, dev)
    writeKeysBack(loaded, applied.assignedKeys)
    const fromFiles = loadSchemaDirectory(dir)

    const exported = await exportSchemaSet(db, '1.0.0')
    expect(hashSchemaSet(exported)).toBe(hashSchemaSet(fromFiles.set))

    const out = mkdtempSync(join(tmpdir(), 'bunbraco-export-'))
    dirs.push(out)
    writeSchemaFiles(out, exported)
    expect(readFileSync(join(out, 'document-types', 'article.toml'), 'utf8')).toBe(
      readFileSync(join(dir, 'document-types', 'article.toml'), 'utf8'),
    )
    expect(readFileSync(join(out, 'data-types', 'big-text.toml'), 'utf8')).toBe(
      readFileSync(join(dir, 'data-types', 'big-text.toml'), 'utf8'),
    )

    const types = generateTypes(fromFiles.set)
    expect(types).toContain('export interface Article {')
    expect(types).toContain('"title": string')
    expect(types).toContain('"summary"?: string')
    expect(types).toContain('"article": Article')
  })
})

describe(`schema contract steps (${dialectUnderTest})`, () => {
  test('purge deletes properties retired long enough ago, with their values, and nothing else', async () => {
    const db = await prepared()
    await sync(db, schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE(SUMMARY) }))
    const types = new ContentTypeRepository(db)
    const typeKey = (await types.byAlias('article'))?.key as string
    const docs = new DocumentRepository(db, { nodeState: { version: '1.0.0', revision: '1' } })
    await docs.create({
      key: crypto.randomUUID(),
      contentTypeKey: typeKey,
      parentKey: null,
      templateKey: null,
      variants: [{ culture: null, segment: null, name: 'One' }],
      values: [
        { alias: 'title', culture: null, segment: null, value: 'T' },
        { alias: 'summary', culture: null, segment: null, value: 'gone soon' },
      ],
      userId: 1,
    })
    await sync(db, schemaDir('1.0.1', { 'document-types/article.toml': ARTICLE() }), {
      ...NODE,
      version: '1.0.1',
    })
    expect((await types.retiredProperties(typeKey)).map((p) => p.alias)).toEqual(['summary'])

    // Not old enough: nothing happens
    expect(await types.purgeRetired(new Date(Date.now() - 86_400_000))).toEqual([])
    expect((await types.retiredProperties(typeKey)).map((p) => p.alias)).toEqual(['summary'])
    // Old enough: the property and its values go; the title stays
    expect(await types.purgeRetired(new Date(Date.now() + 1000))).toEqual([
      { type: 'article', alias: 'summary' },
    ])
    expect(await types.retiredProperties(typeKey)).toEqual([])
    const values = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM property_value')
    expect(Number(values[0]?.n)).toBe(1)
    // Re-adding the alias now creates a fresh property: revival has nothing to revive
    const back = await sync(
      db,
      schemaDir('1.0.2', { 'document-types/article.toml': ARTICLE(SUMMARY) }),
      {
        ...NODE,
        version: '1.0.2',
      },
    )
    expect(back.revived).toEqual([])
    expect(back.created.properties).toBe(1)
  })
})
