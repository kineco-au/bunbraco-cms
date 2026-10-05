/**
 * The whole upgrade, through the real CLI, as a deploy runs it.
 *
 * `tests/upgrade.test.ts` tests the functions; this tests the process. Three
 * releases of one site are laid out as a deploy lays them out — a directory per
 * release, each with its own `schema/` and `components/` — and the commands are
 * spawned against two separate SQLite databases, standing in for two
 * environments with different content. It asserts exit codes, the output an
 * operator reads, the backup file on disk, and what a real server boot of each
 * release serves over HTTP.
 *
 * That last part is the reason this suite exists: the guarantee that makes the
 * upgrade safe — the running release keeps serving its own values while the next
 * one's data work is prepared underneath it — cannot be shown by calling
 * functions in one process. It needs two releases, two node states and a
 * request.
 *
 * Named `*.integration.ts`, so `bun test` does not collect it: it spawns
 * processes and boots servers, and takes long enough to be a nuisance locally.
 * `bun run test:integration` runs it, and CI always does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'packages/cli/bin/bunbraco.ts')

const K = (n: number) => `7c3f91a2-1111-4b2c-9d3e-${String(n).padStart(12, '0')}`

/** Keys are explicit, so no sync writes them back into the fixture mid-run. */
const articleType = (properties: string) => `[document-type]
key = "${K(1)}"
alias = "article"
name = "Article"
allow-at-root = true
allow-children = ["article"]
components = ["article"]
default-component = "article"
${properties}`

const TITLE = (type = 'textstring') => `
[[property]]
key = "${K(2)}"
alias = "title"
name = "Title"
type = "${type}"
`
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

const MIGRATION = `import { defineValueMigration } from '@bunbraco/schema'

export default defineValueMigration({
  since: '1.1.0',
  from: { type: 'article', property: 'summary' },
  to: { property: 'intro' },
  convert: (summary) => \`Intro: \${String(summary)}\`,
})
`

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ESNext',
      module: 'Preserve',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      jsxImportSource: 'bunbraco',
      allowImportingTsExtensions: true,
      noEmit: true,
      types: ['bun'],
    },
  },
  null,
  2,
)}\n`

/** One view for every release: it renders both properties, so each phase shows. */
const VIEW = `export default function Article({ model }) {
  return (
    <main>
      <h1>{model.name}</h1>
      <p id="summary">{model.text('summary')}</p>
      <p id="intro">{model.text('intro')}</p>
    </main>
  )
}
`

/**
 * Release 1 has `summary`; release 2 renames it to `intro` with a value
 * migration; release 3 changes the title's editor to one nothing converts to,
 * which is the refusal case.
 */
const RELEASES = {
  1: { version: '1.0.0', revision: '1', type: articleType(TITLE() + SUMMARY), migration: false },
  2: { version: '1.1.0', revision: '2', type: articleType(TITLE() + INTRO), migration: true },
  3: {
    version: '1.2.0',
    revision: '3',
    type: articleType(TITLE('trueFalse') + INTRO),
    migration: true,
  },
} as const

type Release = keyof typeof RELEASES

/** Seeds and reads content through the repositories, which is what the CLI cannot do. */
const SEED = `
import {
  ContentTypeRepository,
  DocumentRepository,
  ComponentRepository,
  currentSchemaState,
} from '@bunbraco/data'
import { bootstrapDatabase, loadConfig } from '@bunbraco/server'

const [, , mode, ...args] = Bun.argv
const config = loadConfig({}, process.cwd())
const { db } = await bootstrapDatabase(config)

if (mode === 'state') {
  const state = await currentSchemaState(db)
  console.log(JSON.stringify({ version: state.version, revision: state.revision }))
} else if (mode === 'seed') {
  const [version, revision, ...summaries] = args
  const docs = new DocumentRepository(db, { nodeState: { version, revision }, nodeId: 'seed' })
  const type = await new ContentTypeRepository(db).byAlias('article')
  const template = await new ComponentRepository(db).byAlias('article')
  if (!type) throw new Error('the article type is not synced')
  if (!template) throw new Error('the article template is not synced')
  const keys = []
  for (const [i, summary] of summaries.entries()) {
    const name = \`Article \${i + 1}\`
    const doc = await docs.create({
      key: crypto.randomUUID(),
      contentTypeKey: type.key,
      componentKey: template.key,
      parentKey: null,
      variants: [{ culture: null, segment: null, name }],
      values: [
        { alias: 'title', culture: null, segment: null, value: name },
        { alias: 'summary', culture: null, segment: null, value: summary },
      ],
      userId: 1,
    })
    await docs.publish(doc.key, null)
    keys.push(doc.key)
  }
  console.log(keys.join(' '))
} else if (mode === 'values') {
  const [version, revision, key] = args
  const docs = new DocumentRepository(db, { nodeState: { version, revision } })
  const doc = await docs.byKey(key)
  console.log(
    JSON.stringify(Object.fromEntries((doc?.values ?? []).map((v) => [v.alias, v.value]))),
  )
}
await db.close()
`

interface Run {
  code: number
  out: string
}

/** The two environments to promote between, plus `fresh` for the first-boot case. */
type Promoted = 'dev' | 'prod'
type Environment = Promoted | 'fresh'

describe('the upgrade, end to end through the CLI', () => {
  let dir: string
  /** The content keys seeded in each environment, in creation order. */
  const keys: Record<Promoted, string[]> = { dev: [], prod: [] }
  /** What the first deploy printed, asserted below rather than where it ran. */
  const firstDeploy: Record<Promoted, Run | undefined> = { dev: undefined, prod: undefined }
  /** The backup the fix took in `prod`, used by the restore test last. */
  let prodBackup = ''

  const releaseDir = (release: Release) => join(dir, 'releases', String(release))

  function environment(database: Environment, release: Release): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      BUNBRACO_DB: 'sqlite',
      BUNBRACO_SQLITE_FILE: join(dir, `${database}.sqlite`),
      BUNBRACO_SCHEMA_DIR: join(releaseDir(release), 'schema'),
      BUNBRACO_COMPONENTS_DIR: join(releaseDir(release), 'components'),
      BUNBRACO_SCHEMA_REVISION: RELEASES[release].revision,
      BUNBRACO_MEDIA_DIR: join(dir, `${database}-media`),
      BUNBRACO_LOGS_DIR: join(dir, 'logs'),
      BUNBRACO_LOG_TO_CONSOLE: 'false',
      BUNBRACO_ADMIN_PASSWORD: 'integration-password',
    }
  }

  /**
   * Everything a process printed, and its exit code. A command that has not
   * finished in time is killed: a wrong assumption in a test here otherwise
   * hangs until the suite's own timeout, with nothing to read.
   */
  async function collect(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<Run> {
    const timer = setTimeout(() => proc.kill(), 60_000)
    try {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { code: await proc.exited, out: `${out}${err}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Runs a command from a release directory, against one of the two databases. */
  function cli(database: Environment, release: Release, ...args: string[]): Promise<Run> {
    return collect(
      Bun.spawn(['bun', CLI, ...args], {
        cwd: releaseDir(release),
        env: environment(database, release),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
  }

  function seed(database: Environment, ...args: string[]): Promise<Run> {
    return collect(
      Bun.spawn(['bun', join(dir, 'seed.ts'), ...args], {
        cwd: dir,
        env: environment(database, 2),
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
  }

  const lastLine = (run: Run) => run.out.trim().split('\n').at(-1) as string

  /** What schema version the database itself is at, which is what the cut-over moves. */
  async function stateOf(database: Environment): Promise<{ version: string; revision: string }> {
    const result = await seed(database, 'state')
    expect(result.code, result.out).toBe(0)
    return JSON.parse(lastLine(result))
  }

  /** A document's values as a node at that schema state reads them. */
  async function valuesAt(
    database: Environment,
    release: Release,
    key: string,
  ): Promise<Record<string, string | null>> {
    const { version, revision } = RELEASES[release]
    const result = await seed(database, 'values', version, revision, key)
    expect(result.code, result.out).toBe(0)
    return JSON.parse(lastLine(result))
  }

  interface Serving {
    url: string
    banner: string
    stop(): Promise<void>
  }

  /**
   * Boots a release as a deploy does — `bunbraco start`, in production, on a
   * port the OS picks — and waits for the banner to name its URL.
   */
  async function serve(database: Environment, release: Release): Promise<Serving> {
    const proc = Bun.spawn(['bun', CLI, 'start'], {
      cwd: releaseDir(release),
      env: { ...environment(database, release), NODE_ENV: 'production', PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Killed if the banner never arrives, so a release that cannot boot reports
    // what it said rather than hanging on a stream that stays open. The whole
    // banner is read, not just the line with the URL: what it says about
    // compatibility mode comes after that line.
    const timer = setTimeout(() => proc.kill(), 60_000)
    const decoder = new TextDecoder()
    let banner = ''
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      banner += decoder.decode(chunk)
      if (banner.includes('└─')) break
    }
    clearTimeout(timer)
    const url = /site\s+(http:\/\/\S+)/.exec(banner)?.[1] ?? ''
    if (!url) {
      const error = await new Response(proc.stderr).text()
      await proc.exited
      throw new Error(`release ${release} did not start:\n${banner}${error}`)
    }
    return {
      url,
      banner,
      async stop() {
        proc.kill()
        await proc.exited
      },
    }
  }

  /** The page the first published root serves, which is the site's own `/`. */
  async function homePage(database: Environment, release: Release): Promise<string> {
    const server = await serve(database, release)
    try {
      const response = await fetch(new URL('/', server.url))
      expect(response.status, `${database} at release ${release}`).toBe(200)
      return await response.text()
    } finally {
      await server.stop()
    }
  }

  function deploy(release: Release): void {
    const root = releaseDir(release)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(root, 'components'), { recursive: true })
    writeFileSync(
      join(root, 'schema', 'schema.toml'),
      `[schema]\nversion = "${RELEASES[release].version}"\n`,
    )
    writeFileSync(join(root, 'schema', 'document-types', 'article.toml'), RELEASES[release].type)
    writeFileSync(join(root, 'components', 'article.tsx'), VIEW)
    // The same tsconfig `bunbraco init` scaffolds: without `jsxImportSource` the
    // view transpiles against React and every page is a 500.
    writeFileSync(join(root, 'tsconfig.json'), TSCONFIG)
    if (RELEASES[release].migration) {
      mkdirSync(join(root, 'schema', 'migrations'), { recursive: true })
      writeFileSync(join(root, 'schema', 'migrations', '0001-summary-to-intro.ts'), MIGRATION)
    }
  }

  /**
   * The first deploy and the content, here rather than in a test: a failing
   * assertion in a test must not leave the environments half-built for the
   * tests that follow it.
   */
  beforeAll(async () => {
    mkdirSync(join(ROOT, 'output'), { recursive: true })
    dir = mkdtempSync(join(ROOT, 'output', 'integration-upgrade-'))
    writeFileSync(join(dir, 'seed.ts'), SEED)
    for (const release of [1, 2, 3] as Release[]) deploy(release)

    for (const database of ['dev', 'prod'] as Promoted[]) {
      const deployed = await cli(database, 1, 'upgrade')
      if (deployed.code !== 0) throw new Error(`release 1 would not deploy:\n${deployed.out}`)
      firstDeploy[database] = deployed
    }
    // Two environments, different content, as dev and production really differ.
    for (const [database, summaries] of [
      ['dev', ['one', 'two']],
      ['prod', ['alpha', 'beta', 'gamma']],
    ] as Array<[Promoted, string[]]>) {
      const seeded = await seed(database, 'seed', '1.0.0', '1', ...summaries)
      if (seeded.code !== 0) throw new Error(`${database} would not seed:\n${seeded.out}`)
      keys[database] = lastLine(seeded).split(' ')
    }
  }, 180_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('a database behind the framework defers the site part to the framework steps', async () => {
    // `fresh` is a database nothing has touched: this is what a first deploy sees.
    const plan = await cli('fresh', 1, 'upgrade', '--plan')
    expect(plan.code, plan.out).toBe(0)
    expect(plan.out).toContain('== CreateIdentityTables')
    expect(plan.out).toContain('CREATE TABLE')
    expect(plan.out).toContain('site schema: checked once the framework migrations have run')

    const check = await cli('fresh', 1, 'upgrade', 'check')
    expect(check.code, check.out).toBe(0)
    expect(check.out).toContain('will run at upgrade')
    expect(check.out).toContain('The site schema is checked once the framework migrations have run')
  })

  test('the first deploy installs the framework and release 1, and is idempotent', async () => {
    expect(firstDeploy.dev?.out).toContain('schema   applied 1.0.0+1')
    expect(firstDeploy.prod?.out).toContain('schema   applied 1.0.0+1')
    expect(keys.dev).toHaveLength(2)
    expect(keys.prod).toHaveLength(3)

    for (const database of ['dev', 'prod'] as Promoted[]) {
      // The framework's steps ran under the same command, and are in the ledger:
      // `upgrade` installs before it upgrades, so they are already applied by the
      // time it reports what it did.
      const ledger = await cli(database, 1, 'upgrade', 'ledger')
      expect(ledger.out).toContain('expand   CreateIdentityTables')
      expect(ledger.out).toContain('upgrade  upgrade 1.0.0+1')

      const again = await cli(database, 1, 'upgrade')
      expect(again.code, again.out).toBe(0)
      expect(again.out).toContain('Nothing to upgrade: the database is at this version.')
      expect(await stateOf(database)).toEqual({ version: '1.0.0', revision: '1' })
    }

    expect(await homePage('dev', 1)).toContain('<p id="summary">one</p>')
  })

  test('release 2 is checked against the live data, and classified data-requiring', async () => {
    const check = await cli('dev', 2, 'upgrade', 'check')
    // An automatic finding is not a reason to refuse the check: it is a reason to
    // refuse the upgrade, which is the next test.
    expect(check.code, check.out).toBe(0)
    expect(check.out).toContain('change: data-requiring')
    expect(check.out).toContain('findings: 0 blocking, 0 need a person, 1 automatic')
    expect(check.out).toContain(
      'migration 0001-summary-to-intro moves 2 value(s) from article.summary to intro',
    )
  })

  test('the upgrade refuses while the values have not moved, and writes nothing', async () => {
    const refused = await cli('dev', 2, 'upgrade')
    expect(refused.code).toBe(1)
    expect(refused.out).toContain('upgrade refused: 1 outstanding finding(s)')
    expect(refused.out).toContain('Run `bunbraco upgrade check --fix`')
    expect(await stateOf('dev')).toEqual({ version: '1.0.0', revision: '1' })
  })

  test('the fix moves the values early, and release 1 keeps serving its own', async () => {
    const fix = await cli('dev', 2, 'upgrade', 'check', '--fix')
    expect(fix.code, fix.out).toBe(0)
    expect(fix.out).toContain('applied  0001-summary-to-intro')
    expect(fix.out).toContain('deferred to the cut-over: article.summary (retire)')
    expect(fix.out).toContain('findings: 0 blocking, 0 need a person, 0 automatic')

    // The backup is the rollback plan, so it has to exist before anything else.
    const backup = /backup\s+(\S+\.bak)/.exec(fix.out)?.[1] as string
    expect(backup).toBeDefined()
    expect(existsSync(backup)).toBe(true)

    // Prepared, not current: the database is still at release 1's version.
    expect(await stateOf('dev')).toEqual({ version: '1.0.0', revision: '1' })

    // This is the guarantee the whole design turns on: the release that is
    // running has not changed, and neither has the page it serves.
    const page = await homePage('dev', 1)
    expect(page).toContain('<p id="summary">one</p>')
    expect(page).toContain('<p id="intro"></p>')

    // While release 2's state already sees the converted value.
    expect((await valuesAt('dev', 2, keys.dev[0] as string)).intro).toBe('Intro: one')
    expect((await valuesAt('dev', 1, keys.dev[0] as string)).intro).toBeUndefined()
  })

  test('the cut-over makes release 2 live, and is idempotent in turn', async () => {
    const upgraded = await cli('dev', 2, 'upgrade')
    expect(upgraded.code, upgraded.out).toBe(0)
    expect(upgraded.out).toContain('schema   applied 1.1.0+2')
    expect(await stateOf('dev')).toEqual({ version: '1.1.0', revision: '2' })

    const page = await homePage('dev', 2)
    expect(page).toContain('<p id="intro">Intro: one</p>')
    // `summary` retired at the cut-over, so the page that asks for it gets nothing.
    expect(page).toContain('<p id="summary"></p>')

    const again = await cli('dev', 2, 'upgrade')
    expect(again.code, again.out).toBe(0)
    expect(again.out).toContain('Nothing to upgrade: the database is at this version.')
  })

  test('a node left on release 1 still boots and serves, read-only', async () => {
    const server = await serve('dev', 1)
    try {
      expect(server.banner).toContain('database is ahead of schema/: reads only')
      const response = await fetch(new URL('/', server.url))
      expect(response.status).toBe(200)
      const page = await response.text()
      expect(page).toContain('<h1>Article 1</h1>')
      // It sees neither property: `intro` is newer than this node, so it is
      // pending and hidden — and `summary` is gone for every node, because
      // retirement is a flag on the property rather than a schema state a read
      // can be as-of. So a node still on the old release serves its pages
      // through the cut-over, but a property removed by the new release stops
      // rendering before that node is replaced.
      expect(page).toContain('<p id="summary"></p>')
      expect(page).toContain('<p id="intro"></p>')
    } finally {
      await server.stop()
    }
  })

  test('the ledger records the value migration and the upgrade that followed', async () => {
    const ledger = await cli('dev', 2, 'upgrade', 'ledger')
    expect(ledger.code, ledger.out).toBe(0)
    expect(ledger.out).toContain('value    0001-summary-to-intro')
    expect(ledger.out).toContain('upgrade  upgrade 1.1.0+2')
    expect(ledger.out).toContain('2 value(s)')
  })

  test('a production boot refuses while the data work is outstanding, and names the commands', async () => {
    // `prod` is still on release 1's data; deploying release 2's files there and
    // starting the server must fail loudly rather than apply half of it.
    const refused = await collect(
      Bun.spawn(['bun', CLI, 'start'], {
        cwd: releaseDir(2),
        env: { ...environment('prod', 2), NODE_ENV: 'production', PORT: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    expect(refused.out).toContain('need data work before they can apply')
    expect(refused.out).toContain('bunbraco upgrade check')
    expect(refused.code, refused.out).not.toBe(0)
    expect(await stateOf('prod')).toEqual({ version: '1.0.0', revision: '1' })
  })

  test('the same release promotes to the other environment, over its own content', async () => {
    const check = await cli('prod', 2, 'upgrade', 'check')
    expect(check.code, check.out).toBe(0)
    expect(check.out).toContain('moves 3 value(s)')

    const fix = await cli('prod', 2, 'upgrade', 'check', '--fix')
    expect(fix.code, fix.out).toBe(0)
    expect(fix.out).toContain('applied  0001-summary-to-intro')
    prodBackup = /backup\s+(\S+\.bak)/.exec(fix.out)?.[1] as string
    expect(existsSync(prodBackup)).toBe(true)

    const upgraded = await cli('prod', 2, 'upgrade')
    expect(upgraded.code, upgraded.out).toBe(0)
    expect(upgraded.out).toContain('schema   applied 1.1.0+2')
    expect(await homePage('prod', 2)).toContain('<p id="intro">Intro: alpha</p>')
  })

  test('a change nothing can convert is refused by both the check and the upgrade', async () => {
    const check = await cli('dev', 3, 'upgrade', 'check')
    expect(check.code).toBe(1)
    expect(check.out).toContain('change: breaking')
    expect(check.out).toContain('no converter exists')

    const refused = await cli('dev', 3, 'upgrade')
    expect(refused.code).toBe(1)
    expect(refused.out).toContain('upgrade refused')
    // Release 2 is still what is live, and still serves.
    expect(await stateOf('dev')).toEqual({ version: '1.1.0', revision: '2' })
    expect(await homePage('dev', 2)).toContain('<p id="intro">Intro: one</p>')
  })

  test('restoring the backup puts the database back before the upgrade', async () => {
    // Last, because it throws away everything `prod` did. A restore is the file
    // and nothing else: the write-ahead log beside it belongs to the newer state.
    const database = join(dir, 'prod.sqlite')
    for (const suffix of ['-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true })
    copyFileSync(prodBackup, database)

    expect(await stateOf('prod')).toEqual({ version: '1.0.0', revision: '1' })
    // The ledger went back with it, so the migration is pending again.
    const check = await cli('prod', 2, 'upgrade', 'check')
    expect(check.code, check.out).toBe(0)
    expect(check.out).toContain('moves 3 value(s)')
    expect(await homePage('prod', 1)).toContain('<p id="summary">alpha</p>')
  })
})
