/**
 * The 5c exit scenarios (docs/07-roadmap.md): a rename with a value migration
 * promoting through two databases with different content; a release adding a
 * required property and breaking three values — check, refuse, fix early,
 * resolve in the live editor, upgrade, cut over — with an old instance serving
 * reads throughout and going 503 after the cut-over.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashPassword, passwordConfigJson } from '@bunbraco/auth'
import {
  bunbracoPlan,
  ContentTypeRepository,
  connect,
  currentSchemaState,
  type Db,
  DocumentRepository,
  latestPreparedState,
  migrate,
  type NodeSchemaState,
  readLedger,
  readReport,
  seedContent,
  seedIdentity,
} from '@bunbraco/data'
import {
  loadSchemaDirectory,
  loadValueMigrations,
  registerConverter,
  runCheck,
  runFix,
  runUpgrade,
  type ValueMigration,
} from '@bunbraco/schema'
import { canConnect, dialectUnderTest, freshDb } from './support/db.ts'
import { BACKOFFICE, type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Db[] = []
const servers: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (servers.length > 0)
    await servers
      .pop()
      ?.db.close()
      .catch(() => {})
  while (open.length > 0)
    await open
      .pop()
      ?.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function seeded(db: Db): Promise<Db> {
  await migrate(db, bunbracoPlan)
  await seedIdentity(db, {
    admin: { name: 'A', login: 'a@b.c', email: 'a@b.c', password: 'x' },
    hashPassword,
    passwordConfig: passwordConfigJson(),
  })
  await seedContent(db)
  return db
}

async function prepared(): Promise<Db> {
  const db = await freshDb()
  open.push(db)
  return seeded(db)
}

/** A second, independent database: SQLite in memory, whatever the dialect under test. */
async function another(): Promise<Db> {
  const db = await connect({ dialect: 'sqlite', file: ':memory:' })
  open.push(db)
  return seeded(db)
}

function schemaDir(version: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(process.cwd(), 'output', 'upgrade-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'document-types'), { recursive: true })
  mkdirSync(join(dir, 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'schema.toml'), `[schema]\nversion = "${version}"\n`)
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
  return dir
}

const K = (n: number) => `0b1c8e3a-3333-4a5b-9c1d-${String(n).padStart(12, '0')}`

const ARTICLE = (properties: string) => `[document-type]
key = "${K(1)}"
alias = "article"
name = "Article"
allow-at-root = true
templates = ["article"]
default-template = "article"

[[property]]
key = "${K(2)}"
alias = "title"
name = "Title"
type = "textstring"
${properties}`

const SUMMARY = `
[[property]]
key = "${K(3)}"
alias = "summary"
name = "Summary"
type = "textarea"
`
const INTRO = `
[[property]]
key = "${K(4)}"
alias = "intro"
name = "Intro"
type = "textarea"
`
const TEASER = (type: string) => `
[[property]]
key = "${K(5)}"
alias = "teaser"
name = "Teaser"
type = "${type}"
`
const REQUIRED_SUMMARY = `
[[property]]
key = "${K(3)}"
alias = "summary"
name = "Summary"
type = "textarea"
mandatory = true
`

const MIGRATION = `import { defineValueMigration } from '@bunbraco/schema'

export default defineValueMigration({
  since: '1.1.0',
  from: { type: 'article', property: 'summary' },
  to: { property: 'intro' },
  convert: (summary) => \`Intro: \${String(summary)}\`,
})
`

const S1: NodeSchemaState = { version: '1.0.0', revision: '1' }
const S2: NodeSchemaState = { version: '1.1.0', revision: '2' }
const node = (state: NodeSchemaState, nodeId = 'cli') => ({ nodeId, ...state })
const templates = new Set(['article'])

async function createPages(db: Db, values: Array<Record<string, string>>): Promise<string[]> {
  const typeKey = (await new ContentTypeRepository(db).byAlias('article'))?.key as string
  const repo = new DocumentRepository(db, { nodeState: S1, nodeId: 'node-a' })
  const keys: string[] = []
  for (const [i, v] of values.entries()) {
    const doc = await repo.create({
      key: crypto.randomUUID(),
      contentTypeKey: typeKey,
      parentKey: null,
      templateKey: null,
      variants: [{ culture: null, segment: null, name: `Page ${i + 1}` }],
      values: Object.entries(v).map(([alias, value]) => ({
        alias,
        culture: null,
        segment: null,
        value,
      })),
      userId: 1,
    })
    await repo.publish(doc.key, null)
    keys.push(doc.key)
  }
  return keys
}

const valuesOf = async (db: Db, key: string, state: NodeSchemaState) =>
  Object.fromEntries(
    ((await new DocumentRepository(db, { nodeState: state }).byKey(key))?.values ?? []).map((v) => [
      v.alias,
      v.value,
    ]),
  )

describe(`upgrade: check, fix, cut over (${dialectUnderTest})`, () => {
  beforeAll(async () => {
    if (!(await canConnect())) throw new Error(`cannot connect to ${dialectUnderTest}`)
  })

  test('a rename with a value migration promotes through two databases with different content', async () => {
    const v1 = schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE(SUMMARY) })
    const v2 = schemaDir('1.1.0', {
      'document-types/article.toml': ARTICLE(INTRO),
      'migrations/0001-summary-to-intro.ts': MIGRATION,
    })
    const migrations = await loadValueMigrations(v2)
    expect(migrations.map((m) => m.id)).toEqual(['0001-summary-to-intro'])
    const options = { mode: 'production' as const, templateAliases: templates, migrations }

    const databases: Array<{ db: Db; keys: string[]; summaries: string[] }> = []
    for (const [db, summaries] of [
      [await prepared(), ['one', 'two']],
      [await another(), ['alpha', 'beta', 'gamma']],
    ] as Array<[Db, string[]]>) {
      // The v1 deployment carries no migration; the file belongs to v2's schema/.
      const v1Options = { ...options, migrations: [] }
      expect(
        (await runFix(db, loadSchemaDirectory(v1), node(S1), { ...v1Options, by: 'cli' })).sync
          .action,
      ).toBe('applied')
      expect(
        (
          await runUpgrade(db, loadSchemaDirectory(v1), node(S1), {
            ...v1Options,
            by: 'cli',
            policy: 'strict',
          })
        ).action,
      ).toBe('upgraded')
      const keys = await createPages(
        db,
        summaries.map((s, i) => ({ title: `T${i}`, summary: s })),
      )
      databases.push({ db, keys, summaries })
    }

    for (const { db, keys, summaries } of databases) {
      // The check names the migration and what it moves
      const check = await runCheck(db, loadSchemaDirectory(v2), node(S2), options)
      expect(check.classification).toBe('data-requiring')
      expect(check.findings.map((f) => f.code)).toEqual(['value-migration'])
      expect(check.findings[0]?.message).toContain(`moves ${summaries.length} value(s)`)
      // …and the upgrade refuses until it has run
      const refused = await runUpgrade(db, loadSchemaDirectory(v2), node(S2), {
        ...options,
        by: 'cli',
        policy: 'strict',
      })
      expect(refused.action).toBe('refused')

      // The fix moves every value under a prepared state; the old node still sees summaries
      const fix = await runFix(db, loadSchemaDirectory(v2), node(S2), { ...options, by: 'cli' })
      expect(fix.applied).toEqual(['0001-summary-to-intro'])
      expect(fix.sync.deferred).toContain('article.summary (retire)')
      expect(fix.check.outstanding).toEqual([])
      expect((await currentSchemaState(db)).version).toBe('1.0.0')
      for (const [i, key] of keys.entries()) {
        expect(await valuesOf(db, key, S1)).toEqual({ title: `T${i}`, summary: summaries[i] })
        expect(await valuesOf(db, key, S2)).toEqual({
          title: `T${i}`,
          summary: summaries[i],
          intro: `Intro: ${summaries[i]}`,
        })
      }

      // An old node edits a summary after the fix: the check notices, the fix re-converts
      const oldNode = new DocumentRepository(db, { nodeState: S1, nodeId: 'node-a' })
      const first = keys[0] as string
      await oldNode.update({
        key: first,
        contentTypeKey: (await new ContentTypeRepository(db).byAlias('article'))?.key as string,
        parentKey: null,
        templateKey: null,
        variants: [{ culture: null, segment: null, name: 'Page 1' }],
        values: [
          { alias: 'title', culture: null, segment: null, value: 'T0' },
          { alias: 'summary', culture: null, segment: null, value: 'edited late' },
        ],
      })
      const stale = await runCheck(db, loadSchemaDirectory(v2), node(S2), options)
      expect(stale.findings.map((f) => f.code)).toEqual(['unconverted-value'])
      expect(
        (
          await runUpgrade(db, loadSchemaDirectory(v2), node(S2), {
            ...options,
            by: 'cli',
            policy: 'strict',
          })
        ).action,
      ).toBe('refused')
      const again = await runFix(db, loadSchemaDirectory(v2), node(S2), { ...options, by: 'cli' })
      expect(again.sync.action).toBe('skipped-same')
      expect(again.applied).toEqual(['0001-summary-to-intro'])
      expect(again.check.outstanding).toEqual([])
      expect((await valuesOf(db, first, S2)).intro).toBe('Intro: edited late')

      // The upgrade cuts over: summary retires, intro is live, the ledger has it all
      const upgraded = await runUpgrade(db, loadSchemaDirectory(v2), node(S2), {
        ...options,
        by: 'cli',
        policy: 'strict',
      })
      expect(upgraded.action).toBe('upgraded')
      expect(upgraded.sync?.retired).toEqual(['article.summary'])
      expect((await currentSchemaState(db)).version).toBe('1.1.0')
      expect(await latestPreparedState(db)).toBeUndefined()
      expect(
        (await new ContentTypeRepository(db).byAlias('article'))?.properties.map((p) => p.alias),
      ).toEqual(['title', 'intro'])
      expect(await valuesOf(db, first, S2)).toEqual({ title: 'T0', intro: 'Intro: edited late' })
      const ledger = await readLedger(db)
      expect(ledger.filter((r) => r.kind === 'value').map((r) => r.name)).toEqual([
        '0001-summary-to-intro',
      ])
      expect(ledger.at(-1)?.kind).toBe('upgrade')

      // Re-running the same deploy does nothing rather than refusing. The
      // retired source values survive, and once the cut-over has made the
      // prepared state current there is no prepared state left to compare them
      // against — which used to report every one of them as edited since.
      const rerun = await runCheck(db, loadSchemaDirectory(v2), node(S2), options)
      expect(rerun.findings.map((f) => f.code)).toEqual([])
      expect(
        (
          await runUpgrade(db, loadSchemaDirectory(v2), node(S2), {
            ...options,
            by: 'cli',
            policy: 'strict',
          })
        ).action,
      ).toBe('nothing')

      // and the old node is now behind
      await expect(oldNode.publish(first, null)).rejects.toThrow(/writes are refused/)
    }
  })

  test('a required property without a default and three breaking values: check, refuse, fix early, resolve, upgrade', async () => {
    // A test converter: the framework's TextBox→RichText copy, except it refuses "bad"
    registerConverter({
      from: 'Umbraco.TextBox',
      to: 'Umbraco.RichText',
      convert: (value) => {
        if (String(value).includes('bad')) throw new Error('contains markup we cannot carry over')
        return `<p>${String(value)}</p>`
      },
    })
    const db = await prepared()
    const v1 = schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE(TEASER('textstring')) })
    const v2 = schemaDir('1.1.0', {
      'document-types/article.toml': ARTICLE(`${TEASER('richtext')}${REQUIRED_SUMMARY}`),
    })
    const options = {
      mode: 'production' as const,
      templateAliases: templates,
      migrations: [] as ValueMigration[],
    }
    await runUpgrade(db, loadSchemaDirectory(v1), node(S1), {
      ...options,
      by: 'cli',
      policy: 'strict',
    })
    const keys = await createPages(db, [
      { title: 'A', teaser: 'fine' },
      { title: 'B', teaser: 'bad one' },
      { title: 'C', teaser: 'also fine' },
      { title: 'D', teaser: 'bad two' },
      { title: 'E', teaser: 'bad three' },
    ])

    // 1. check: the property needs a person on every page; three values break; two convert
    const check = await runCheck(db, loadSchemaDirectory(v2), node(S2), options)
    expect(check.classification).toBe('breaking')
    const codes = (report: { findings: Array<{ code: string }> }) => {
      const counts: Record<string, number> = {}
      for (const f of report.findings) counts[f.code] = (counts[f.code] ?? 0) + 1
      return counts
    }
    expect(codes(check)).toEqual({ 'mandatory-missing': 5, 'value-conversion': 4 })
    expect(
      check.findings.filter((f) => f.code === 'value-conversion' && f.kind === 'person'),
    ).toHaveLength(3)
    expect(
      check.findings.filter((f) => f.code === 'value-conversion' && f.kind === 'auto')[0]?.message,
    ).toContain('2 value(s)')
    for (const f of check.findings.filter((f) => f.subjectType === 'document'))
      expect(f.link).toBe(`${BACKOFFICE}/section/content/workspace/document/edit/${f.subjectKey}`)

    // 2. upgrade refuses
    const refused = await runUpgrade(db, loadSchemaDirectory(v2), node(S2), {
      ...options,
      by: 'cli',
      policy: 'strict',
    })
    expect(refused.action).toBe('refused')
    expect(refused.reasons.length).toBe(9)

    // 3. fix: summary exists, pending; the two good teasers are converted ahead; the editor change waits
    const fix = await runFix(db, loadSchemaDirectory(v2), node(S2), { ...options, by: 'cli' })
    expect(fix.sync.action).toBe('applied')
    expect(fix.sync.deferred).toEqual(['article.teaser'])
    expect(fix.applied).toEqual(['convert:article.teaser:Umbraco.TextBox->Umbraco.RichText'])
    expect(fix.skipped).toBe(3)
    expect(codes(fix.check)).toEqual({ 'mandatory-missing': 5, 'value-conversion': 3 })
    const onOld = await new ContentTypeRepository(db, { nodeState: S1 }).byAlias('article')
    expect(onOld?.properties.find((p) => p.alias === 'summary')?.pending).toEqual({
      version: '1.1.0',
      revision: '2',
    })
    // …the old node still sees the plain-text teaser, and publishes without a summary
    const oldNode = new DocumentRepository(db, { nodeState: S1, nodeId: 'node-a' })
    expect((await valuesOf(db, keys[0] as string, S1)).teaser).toBe('fine')
    expect((await oldNode.publish(keys[0] as string, null))?.key).toBe(keys[0])
    const dashboard = await readReport(db)
    expect(dashboard).toHaveLength(8)

    // 4. people resolve the rest in the live backoffice: fill in summaries, fix the bad teasers
    const typeKey = onOld?.key as string
    for (const [i, key] of keys.entries()) {
      const teaser = ['fine', 'now good', 'also fine', 'now good too', 'and this'][i] as string
      await oldNode.update({
        key,
        contentTypeKey: typeKey,
        parentKey: null,
        templateKey: null,
        variants: [{ culture: null, segment: null, name: `Page ${i + 1}` }],
        values: [
          { alias: 'title', culture: null, segment: null, value: String.fromCharCode(65 + i) },
          { alias: 'teaser', culture: null, segment: null, value: teaser },
          { alias: 'summary', culture: null, segment: null, value: `summary ${i}` },
        ],
      })
    }
    const afterEdits = await runCheck(db, loadSchemaDirectory(v2), node(S2), options)
    expect(codes(afterEdits)).toEqual({ 'unconverted-value': 3 })
    const second = await runFix(db, loadSchemaDirectory(v2), node(S2), { ...options, by: 'cli' })
    expect(second.sync.action).toBe('skipped-same')
    expect(second.applied).toEqual(['convert:article.teaser:Umbraco.TextBox->Umbraco.RichText'])
    expect(second.check.outstanding).toEqual([])
    expect((await readReport(db)).filter((f) => f.status === 'open')).toEqual([])
    expect(
      (await readReport(db, { includeResolved: true })).filter((f) => f.status === 'resolved'),
    ).toHaveLength(9)

    // 5. upgrade: cut over; the editor change and the mandatory rule are live
    const upgraded = await runUpgrade(db, loadSchemaDirectory(v2), node(S2), {
      ...options,
      by: 'cli',
      policy: 'strict',
    })
    expect(upgraded.action).toBe('upgraded')
    expect((await currentSchemaState(db)).version).toBe('1.1.0')
    const live = await new ContentTypeRepository(db, { nodeState: S2 }).byAlias('article')
    expect(live?.properties.find((p) => p.alias === 'summary')?.pending).toBeNull()
    const newNode = new DocumentRepository(db, { nodeState: S2, nodeId: 'node-b' })
    expect(await valuesOf(db, keys[1] as string, S2)).toEqual({
      title: 'B',
      // A converted value reaches the rich text editor in its own shape
      teaser: { markup: '<p>now good</p>', blocks: null },
      summary: 'summary 1',
    })
    const blank = await newNode.create({
      key: crypto.randomUUID(),
      contentTypeKey: typeKey,
      parentKey: null,
      templateKey: null,
      variants: [{ culture: null, segment: null, name: 'Blank' }],
      values: [{ alias: 'title', culture: null, segment: null, value: 'F' }],
      userId: 1,
    })
    await expect(newNode.publish(blank.key, null)).rejects.toThrow(/'Summary'/)
    expect((await readLedger(db)).map((r) => r.kind).slice(-2)).toEqual(['value', 'upgrade'])
  })

  test('the upgrade policy: pending-allowed proceeds over what needs a person; --force records why', async () => {
    const db = await prepared()
    const v1 = schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE('') })
    const v2 = schemaDir('1.1.0', { 'document-types/article.toml': ARTICLE(REQUIRED_SUMMARY) })
    const options = { mode: 'development' as const, templateAliases: templates }
    await runUpgrade(db, loadSchemaDirectory(v1), node(S1), {
      ...options,
      by: 'dev',
      policy: 'pending-allowed',
    })
    await createPages(db, [{ title: 'A' }])

    const strict = await runUpgrade(db, loadSchemaDirectory(v2), node(S2), {
      ...options,
      by: 'ops',
      policy: 'strict',
    })
    expect(strict.action).toBe('refused')
    expect(strict.reasons.map((f) => f.code)).toEqual(['mandatory-missing'])

    const forced = await runUpgrade(db, loadSchemaDirectory(v2), node(S2), {
      ...options,
      by: 'ops',
      policy: 'strict',
      force: 'editors fill it in on Monday',
    })
    expect(forced.action).toBe('upgraded')
    expect((await readLedger(db)).at(-1)?.note).toBe('forced: editors fill it in on Monday')
    // The finding stays open on the dashboard until the page is fixed
    expect((await readReport(db)).map((f) => f.code)).toEqual(['mandatory-unfilled'])

    // --set fills a value everywhere it is missing instead
    const db2 = await prepared()
    await runUpgrade(db2, loadSchemaDirectory(v1), node(S1), {
      ...options,
      by: 'dev',
      policy: 'pending-allowed',
    })
    const [key] = await createPages(db2, [{ title: 'A' }])
    const withSet = { ...options, set: { 'article.summary': 'tbc' } }
    expect(
      (await runCheck(db2, loadSchemaDirectory(v2), node(S2), withSet)).findings.map((f) => f.code),
    ).toEqual(['mandatory-default'])
    const fixed = await runFix(db2, loadSchemaDirectory(v2), node(S2), { ...withSet, by: 'dev' })
    expect(fixed.applied).toEqual(['set:article.summary'])
    expect(fixed.check.outstanding).toEqual([])
    expect((await valuesOf(db2, key as string, S2)).summary).toBe('tbc')
  })
})

describe('an old instance through an upgrade (sqlite)', () => {
  test.skipIf(dialectUnderTest !== 'sqlite')(
    'serves reads throughout, then reports 503 and refuses writes after the cut-over',
    async () => {
      const root = mkdtempSync(join(process.cwd(), 'output', 'upgrade-site-'))
      dirs.push(root)
      mkdirSync(join(root, 'Views'), { recursive: true })
      writeFileSync(
        join(root, 'Views', 'article.tsx'),
        `export default function Article({ model }) { return <h1>{model.text('title')}</h1> }\n`,
      )
      const v1 = schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE('') })
      const v2 = schemaDir('1.1.0', { 'document-types/article.toml': ARTICLE(SUMMARY) })
      const sqliteFile = join(root, 'site.sqlite')
      const a = await signedInServer({
        config: {
          schemaDir: v1,
          viewsDir: join(root, 'Views'),
          sqliteFile,
          schemaRevision: '1',
          nodeId: 'node-a',
          development: false,
          schemaWritable: false,
        },
      })
      servers.push(a)
      const typeKey = (await new ContentTypeRepository(a.server.db).byAlias('article'))
        ?.key as string
      const created = await a.post(`${V1}/document`, {
        documentType: { id: typeKey },
        template: null,
        parent: null,
        values: [{ alias: 'title', culture: null, segment: null, value: 'Hello' }],
        variants: [{ culture: null, segment: null, name: 'Hello' }],
      })
      const key = created.headers.get('umb-generated-resource') as string
      expect((await a.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
        200,
      )
      expect((await a.call('/health')).status).toBe(200)

      // The operator upgrades from the new artifact, against the same database
      const cli = await connect({ dialect: 'sqlite', file: sqliteFile })
      open.push(cli)
      const result = await runUpgrade(cli, loadSchemaDirectory(v2), node(S2, 'cli'), {
        mode: 'production',
        templateAliases: templates,
        by: 'cli',
        policy: 'strict',
      })
      expect(result.action).toBe('upgraded')

      // Node A: reads fine, notices on its next poll, refuses writes, drains
      expect((await a.call(`${V1}/document/${key}`)).status).toBe(200)
      await a.server.poll()
      expect(a.server.health()).toMatchObject({ ok: false, readOnly: true, version: '1.0.0' })
      expect((await a.call('/health')).status).toBe(503)
      expect((await a.call(`${V1}/document/${key}`)).status).toBe(200)
      const write = await a.put(`${V1}/document/${key}`, {
        template: null,
        values: [{ alias: 'title', culture: null, segment: null, value: 'Changed' }],
        variants: [{ culture: null, segment: null, name: 'Hello' }],
      })
      expect(write.status).toBe(409)

      // The backup the CLI would take sits beside the database
      const { backupBefore, loadConfig } = await import('@bunbraco/server')
      const backup = await backupBefore(loadConfig({ sqliteFile, dialect: 'sqlite' }), {
        reason: 'upgrade',
      })
      expect(existsSync(backup.path as string)).toBe(true)
      expect(readdirSync(root).some((f) => f.endsWith('.upgrade.bak'))).toBe(true)
    },
  )
})

describe(`upgrade from a database behind the framework (${dialectUnderTest})`, () => {
  test('check reports the framework steps and defers the site part; upgrade applies them first', async () => {
    const db = await freshDb()
    open.push(db)
    const v1 = schemaDir('1.0.0', { 'document-types/article.toml': ARTICLE('') })
    const options = { mode: 'production' as const, templateAliases: templates }
    const check = await runCheck(db, loadSchemaDirectory(v1), node(S1), options)
    expect(check.siteChecked).toBe(false)
    expect(check.frameworkPending).toEqual(bunbracoPlan.migrations.map((m) => m.name))
    expect(check.findings.every((f) => f.code === 'framework-migration')).toBe(true)
    expect(check.outstanding).toEqual([])

    // Seeding is the server's job; the upgrade tool only needs the framework's tables and built-ins.
    await migrate(db, bunbracoPlan)
    await seedContent(db)
    const upgraded = await runUpgrade(db, loadSchemaDirectory(v1), node(S1), {
      ...options,
      by: 'cli',
      policy: 'strict',
    })
    expect(upgraded.action).toBe('upgraded')
    expect(upgraded.check.siteChecked).toBe(true)
    expect((await currentSchemaState(db)).version).toBe('1.0.0')
  })
})
