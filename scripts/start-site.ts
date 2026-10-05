#!/usr/bin/env bun
/**
 * Starts a starter template as a running site, in one command.
 *
 *   bun run site                            the catalogue
 *   bun run site demo/harbourstone          on localhost
 *   bun run site demo/harbourstone --docker in the compose stack
 *   bun run site demo/harbourstone --fresh  scrap the site and scaffold it again
 *   bun run site demo/harbourstone --dry-run  say what it would do, start nothing
 *
 * The site is scaffolded into `sites/<slug>` — gitignored, disposable, and
 * deliberately **not** under `output/`: the compose stack mounts a named volume
 * over `/app/output`, so a site scaffolded there is invisible inside the
 * container. `sites/` is inside the bind mount and matches no workspace glob, so
 * it is visible in both places and joins no `bun install`.
 *
 * Nothing is installed into the site. Its `package.json` pins published versions
 * for anyone who copies it, but resolution walks up to the repository's own
 * `node_modules`, where every `@bunbraco/*` name is a workspace symlink — so what
 * runs is the working tree, which is the point of a dev stack. The CLI is invoked
 * from `packages/cli/bin` for the same reason.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { findTemplate, listTemplates, type SiteTemplate, scaffoldFiles } from '@bunbraco/cli'
import { connect } from '@bunbraco/data'
import { portInUse } from '@bunbraco/server'

const ROOT = join(import.meta.dir, '..')
/**
 * Inside the bind mount, outside every workspace glob and every named volume.
 * Overridable so the suite can scaffold somewhere disposable; `--docker` refuses
 * an override outside the repository, because the container only sees `/app`.
 */
const SITES = Bun.env.BUNBRACO_SITES_DIR ? resolve(Bun.env.BUNBRACO_SITES_DIR) : join(ROOT, 'sites')
const CONTAINER_ROOT = '/app'

const args = Bun.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const [requested] = args.filter((arg) => !arg.startsWith('--'))

const slugOf = (id: string) => id.replaceAll('/', '-')

function catalogue(): never {
  console.log('Templates:\n')
  for (const template of listTemplates())
    console.log(`  ${template.id.padEnd(20)} ${template.description}`)
  console.log('\nStart one:\n  bun run site demo/harbourstone [--docker] [--fresh]')
  process.exit(requested ? 1 : 0)
}

if (!requested) catalogue()
const template = findTemplate(requested)
if (!template) {
  console.error(`There is no template "${requested}".\n`)
  catalogue()
}

const slug = slugOf(template.id)
const siteDir = join(SITES, slug)

/** Writes the template out, exactly as `bunbraco init` does. */
function scaffold(into: string, which: SiteTemplate): void {
  for (const file of scaffoldFiles({ template: which, siteName: which.name })) {
    const target = join(into, file.path)
    mkdirSync(dirname(target), { recursive: true })
    if (file.copyFrom === undefined) writeFileSync(target, file.text ?? '')
    else Bun.spawnSync(['cp', file.copyFrom, target])
  }
}

if (flags.has('--fresh') && existsSync(siteDir)) {
  rmSync(siteDir, { recursive: true, force: true })
  console.log(`  removed  ${relative(ROOT, siteDir)}`)
}
if (!existsSync(siteDir)) {
  mkdirSync(siteDir, { recursive: true })
  scaffold(siteDir, template)
  console.log(`  created  ${relative(ROOT, siteDir)} from ${template.id}`)
} else {
  console.log(`  reusing  ${relative(ROOT, siteDir)} (--fresh to scaffold it again)`)
}

/**
 * The database this run may touch, and no other.
 *
 * A demo must never write to a live database, and two things could make it: an
 * environment that names Postgres, or a `BUNBRACO_SQLITE_FILE` pointing outside
 * the site. So the dialect and the file are **forced** here rather than resolved
 * from the environment — `bun run site` cannot be pointed at a real database
 * even by a `.env` that names one.
 */
const sqliteFile = join(siteDir, 'bunbraco.sqlite')

/** What the file already holds. A fresh demo expects nothing. */
async function existingContent(file: string): Promise<number | undefined> {
  if (!existsSync(file)) return undefined
  const db = await connect({ dialect: 'sqlite', file })
  try {
    const rows = await db.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'node'",
    )
    if (Number(rows[0]?.total ?? 0) === 0) return 0
    const nodes = await db.query<{ total: number }>('SELECT COUNT(*) AS total FROM node')
    return Number(nodes[0]?.total ?? 0)
  } finally {
    await db.close()
  }
}

const held = await existingContent(sqliteFile)
if (held !== undefined && held > 0 && !flags.has('--reuse')) {
  console.error(
    `\n${relative(ROOT, sqliteFile)} already holds ${held} node(s).\n` +
      'Pass --reuse to start against it anyway, or --fresh to scrap the site and begin again.',
  )
  process.exit(1)
}
console.log(
  held === undefined
    ? '  database empty (no file yet), so the bundle will import on first boot'
    : `  database ${held === 0 ? 'empty' : `holds ${held} node(s), reused`}`,
)

/** `--bundle` is idempotent: the CLI imports once per bundle and says so. */
const startArgs = template.bundle ? ['--bundle', template.bundle, '--publish'] : []
const passThrough = args.filter(
  (arg) => arg.startsWith('--') && !['--docker', '--fresh', '--reuse', '--dry-run'].includes(arg),
)

if (flags.has('--docker')) {
  // The stack publishes one fixed port, so a clash is reported here with the way
  // out rather than as a daemon error about endpoint programming. A `compose run`
  // container orphaned by an abrupt exit is the usual culprit, and `docker:down`
  // removes it.
  if (relative(ROOT, siteDir).startsWith('..')) {
    console.error(
      `\n${siteDir} is outside the repository, and the container only mounts it at ${CONTAINER_ROOT}.\n` +
        '  Drop BUNBRACO_SITES_DIR, or run without --docker.',
    )
    process.exit(1)
  }
  const port = Number(Bun.env.BUNBRACO_PORT ?? 8080)
  if (await portInUse(port)) {
    console.error(
      `\nPort ${port} is already in use, so the stack cannot publish it.\n` +
        '  "bun run docker:down" stops the stack and removes any orphaned run container.\n' +
        '  Otherwise set BUNBRACO_PORT to something else.',
    )
    process.exit(1)
  }

  // `compose run -w` rather than a change to the `cms` service: the stack's
  // default remains `apps/site`, and no mount in it is pinned to this path. No
  // `--watch` either — the site sits in the bind mount with no tmpfs over its
  // views cache, so a watcher would reload on the server's own writes.
  const containerSite = `${CONTAINER_ROOT}/${relative(ROOT, siteDir).split('\\').join('/')}`
  const command = [
    'docker',
    'compose',
    'run',
    '--rm',
    '--service-ports',
    // The dialect is forced to SQLite below, so the stack's Postgres is not
    // wanted and starting it would be pure latency.
    '--no-deps',
    '-w',
    containerSite,
    '-e',
    'BUNBRACO_DB=sqlite',
    '-e',
    `BUNBRACO_SQLITE_FILE=${containerSite}/bunbraco.sqlite`,
    'cms',
    'bun',
    `${CONTAINER_ROOT}/packages/cli/bin/bunbraco.ts`,
    'start',
    ...startArgs,
    ...passThrough,
  ]
  console.log(`\n  ${command.join(' ')}\n`)
  if (flags.has('--dry-run')) process.exit(0)
  const proc = Bun.spawn(command, { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] })
  process.exit(await proc.exited)
}

const command = [
  'bun',
  join(ROOT, 'packages/cli/bin/bunbraco.ts'),
  'start',
  ...startArgs,
  ...passThrough,
]
console.log(`\n  ${command.join(' ')}\n`)
console.log(`  database    ${sqliteFile}`)
if (flags.has('--dry-run')) process.exit(0)
const proc = Bun.spawn(command, {
  cwd: siteDir,
  stdio: ['inherit', 'inherit', 'inherit'],
  env: {
    ...process.env,
    // Forced, not defaulted: see above.
    BUNBRACO_DB: 'sqlite',
    BUNBRACO_SQLITE_FILE: sqliteFile,
    BUNBRACO_POSTGRES_URL: '',
    BUNBRACO_MEDIA_DIR: join(siteDir, 'media'),
    BUNBRACO_LOGS_DIR: join(siteDir, 'logs'),
  },
})
process.exit(await proc.exited)
