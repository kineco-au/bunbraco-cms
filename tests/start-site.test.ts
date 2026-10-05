/**
 * `bun run site <template>`: one command that scaffolds a starter template and
 * runs it, on localhost or in the compose stack.
 *
 * The property worth holding is the safety one. A demo must never write to a
 * live database, so the dialect and the file are forced rather than resolved
 * from the environment, and a database that already holds content stops the run
 * instead of being migrated into.
 */

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../scripts/packages.ts'

const SCRIPT = join(ROOT, 'scripts/start-site.ts')
const SANDBOX = join(ROOT, 'output', 'start-site-sites')

afterEach(() => rmSync(SANDBOX, { recursive: true, force: true }))

/** Runs the script without letting it reach the real `sites/` directory. */
function run(args: string[]) {
  const proc = Bun.spawnSync(['bun', SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, BUNBRACO_SITES_DIR: SANDBOX },
  })
  return {
    code: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  }
}

describe('choosing a template', () => {
  test('lists the catalogue when none is named', () => {
    const { code, out } = run([])
    expect(code).toBe(0)
    expect(out).toContain('demo/harbourstone')
    expect(out).toContain('basic')
  })

  test('refuses one that does not exist, and says what there is', () => {
    const { code, out } = run(['demo/nope'])
    expect(code).toBe(1)
    expect(out).toContain('demo/nope')
    expect(out).toContain('demo/harbourstone')
  })
})

describe('the database a demo is allowed to touch', () => {
  const siteDir = join(SANDBOX, 'basic')

  /** A database that looks like a site someone is using. */
  function populate(file: string) {
    mkdirSync(siteDir, { recursive: true })
    const db = new Database(file)
    db.run('CREATE TABLE node (id INTEGER PRIMARY KEY)')
    db.run('INSERT INTO node (id) VALUES (1)')
    db.close()
  }

  test('stops rather than starting against one that holds content', () => {
    populate(join(siteDir, 'bunbraco.sqlite'))
    const { code, out } = run(['basic'])
    expect(code).toBe(1)
    expect(out).toContain('already holds 1 node(s)')
    // Named, so the way forward is in the message rather than in the source.
    expect(out).toContain('--reuse')
    expect(out).toContain('--fresh')
  })

  test('says the database is empty when there is no file yet', () => {
    // Scaffolds and then tries to start, which needs a port; the point is what
    // it decided about the database before getting there.
    const { out } = run(['basic', '--dry-run'])
    expect(out).toContain('database empty')
  })

  test('forces SQLite into the site, whatever the environment says', () => {
    // The environment here names a Postgres and a file elsewhere — exactly the
    // shape that would otherwise let a demo migrate a live database.
    const proc = Bun.spawnSync(['bun', SCRIPT, 'basic', '--dry-run'], {
      cwd: ROOT,
      env: {
        ...process.env,
        BUNBRACO_SITES_DIR: SANDBOX,
        BUNBRACO_DB: 'postgres',
        BUNBRACO_POSTGRES_URL: 'postgres://nope@127.0.0.1:1/live',
        BUNBRACO_SQLITE_FILE: '/tmp/somewhere-else.sqlite',
      },
    })
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`
    expect(out).toContain(join(SANDBOX, 'basic', 'bunbraco.sqlite'))
    expect(out).not.toContain('somewhere-else')
    expect(out).not.toContain('postgres://')
  })
})

describe('where a scaffolded site lives', () => {
  const script = readFileSync(SCRIPT, 'utf8')

  test('is gitignored, so a demo is never committed', () => {
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toMatch(/^sites\/$/m)
  })

  test('is not under output/, which the stack masks with a volume', () => {
    // `cms_output:/app/output` hides the host directory inside the container, so
    // a site scaffolded there would be invisible to `--docker`.
    const compose = readFileSync(join(ROOT, 'compose.yaml'), 'utf8')
    expect(compose).toContain('cms_output:/app/output')
    expect(script).toContain("join(ROOT, 'sites')")
  })

  test('matches no workspace glob, so it joins no install', () => {
    const workspaces = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { workspaces: string[] }
    ).workspaces
    expect(workspaces).not.toContain('sites/*')
    for (const glob of workspaces) expect(glob.startsWith('sites')).toBe(false)
  })
})

describe('the compose invocation', () => {
  const script = readFileSync(SCRIPT, 'utf8')

  test('changes no service definition, so the default stack is untouched', () => {
    // `compose run -w` carries the working directory, which is why `cms` still
    // says `working_dir: /app/apps/site` and its test still passes.
    expect(readFileSync(join(ROOT, 'compose.yaml'), 'utf8')).toContain(
      'working_dir: /app/apps/site',
    )
    expect(script).toContain("'-w',")
  })

  test('skips Postgres, which a forced-SQLite run does not want', () => {
    expect(script).toContain("'--no-deps'")
  })

  test('invokes the CLI by absolute path, so the working directory may move', () => {
    // A relative `../../packages/...` breaks the moment the site is not two
    // levels down, which is the whole point of this script.
    expect(script).toContain('/packages/cli/bin/bunbraco.ts')
    expect(script).toContain('CONTAINER_ROOT')
  })

  test('refuses a site outside the repository, which the container cannot see', () => {
    const proc = Bun.spawnSync(['bun', SCRIPT, 'basic', '--docker'], {
      cwd: ROOT,
      env: { ...process.env, BUNBRACO_SITES_DIR: '/tmp/outside-the-repo' },
    })
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`
    expect(proc.exitCode).toBe(1)
    expect(out).toContain('outside the repository')
    rmSync('/tmp/outside-the-repo', { recursive: true, force: true })
  })
})

describe('what it runs', () => {
  test('uses the working tree rather than the published packages', () => {
    // No `bun install` in the site: resolution walks up to the repository's own
    // node_modules, where every @bunbraco name is a workspace symlink. A demo
    // that installed from npm would not show you your own changes.
    const script = readFileSync(SCRIPT, 'utf8')
    expect(script).not.toContain("'install'")
    expect(script).toContain("join(ROOT, 'packages/cli/bin/bunbraco.ts')")
  })

  test('imports the template’s bundle, once', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toContain("'--bundle'")
    expect(existsSync(join(ROOT, 'packages/cli/templates/demo/harbourstone/bundle'))).toBe(true)
  })
})
