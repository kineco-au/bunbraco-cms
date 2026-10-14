#!/usr/bin/env bun
/**
 * Starts one of this repository's sites, or a starter template, in one command.
 *
 *   bun run site                            the catalogue
 *   bun run site demo/harbourstone          on localhost
 *   bun run site demo/harbourstone --docker in the compose stack
 *   bun run site demo/harbourstone --fresh  clear its database and media, and begin again
 *   bun run site demo/harbourstone --dry-run  say what it would do, start nothing
 *
 * Ctrl-C ends it, including the container `--docker` runs it in: see
 * `runToCompletion` for why that needs a handler rather than bun's default.
 *
 * A site in `sites/` runs in place: it is a private workspace, so its `@crombolo/crombolo`
 * is a symlink to the working tree, and what it writes as it runs is gitignored.
 * A template the CLI ships (`basic`) is scaffolded first, exactly as `crombolo
 * init` would, into `.scaffolds/<slug>` — gitignored, disposable, and
 * deliberately **not** under `output/`: the compose stack mounts a named volume
 * over `/app/output`, so a site scaffolded there is invisible inside the
 * container. `.scaffolds/` is inside the bind mount and matches no workspace
 * glob, so it is visible in both places and joins no `bun install`; nothing is
 * installed into it, and resolution walks up to the repository's own
 * `node_modules`. The CLI is invoked from `packages/cli/bin` for the same reason:
 * what runs is the working tree, which is the point of a dev stack.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { findTemplate, listTemplates, type SiteTemplate, scaffoldFiles } from '@crombolo/cli'
import { connect } from '@crombolo/data'
import { portInUse } from '@crombolo/server'
import { findSite, listSites, runState, SITES_DIR, slugOf } from './sites.ts'

const ROOT = join(import.meta.dir, '..')
/**
 * Inside the bind mount, outside every workspace glob and every named volume.
 * Both are overridable so the suite can work somewhere disposable; `--docker`
 * refuses an override outside the repository, because the container only sees `/app`.
 */
const SCAFFOLDS = Bun.env.CROMBOLO_SCAFFOLDS_DIR
  ? resolve(Bun.env.CROMBOLO_SCAFFOLDS_DIR)
  : join(ROOT, '.scaffolds')
const SITES = Bun.env.CROMBOLO_SITES_DIR ? resolve(Bun.env.CROMBOLO_SITES_DIR) : SITES_DIR
const CONTAINER_ROOT = '/app'

const args = Bun.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const [requested] = args.filter((arg) => !arg.startsWith('--'))

function catalogue(): never {
  console.log('Sites:\n')
  for (const site of listSites(SITES)) console.log(`  ${site.id.padEnd(20)} ${site.description}`)
  console.log('\nTemplates:\n')
  for (const template of listTemplates())
    console.log(`  ${template.id.padEnd(20)} ${template.description}`)
  console.log('\nStart one:\n  bun run site demo/harbourstone [--docker] [--fresh]')
  process.exit(requested ? 1 : 0)
}

if (!requested) catalogue()
const site = findSite(requested, SITES)
const template = site ? undefined : findTemplate(requested)
if (!site && !template) {
  console.error(`There is no site or template "${requested}".\n`)
  catalogue()
}

const id = (site ?? template)?.id as string
const slug = slugOf(id)
const siteDir = site ? site.dir : join(SCAFFOLDS, slug)
const bundle = site ? site.bundle : template?.bundle

/** Writes the template out, exactly as `crombolo init` does. */
function scaffold(into: string, which: SiteTemplate): void {
  for (const file of scaffoldFiles({ template: which, siteName: which.name })) {
    const target = join(into, file.path)
    mkdirSync(dirname(target), { recursive: true })
    if (file.copyFrom === undefined) writeFileSync(target, file.text ?? '')
    else Bun.spawnSync(['cp', file.copyFrom, target])
  }
}

if (site) {
  if (flags.has('--fresh'))
    for (const path of runState(siteDir)) {
      // A dry run says what it would clear; the database may be someone's afternoon.
      if (!flags.has('--dry-run')) rmSync(path, { recursive: true, force: true })
      console.log(
        `  ${flags.has('--dry-run') ? 'would remove' : 'removed'}  ${relative(ROOT, path)}`,
      )
    }
  console.log(`  running  ${relative(ROOT, siteDir)} in place`)
} else if (template) {
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
}

/**
 * The database this run may touch, and no other.
 *
 * A demo must never write to a live database, and two things could make it: an
 * environment that names Postgres, or a `CROMBOLO_SQLITE_FILE` pointing outside
 * the site. So the dialect and the file are **forced** here rather than resolved
 * from the environment — `bun run site` cannot be pointed at a real database
 * even by a `.env` that names one.
 */
const sqliteFile = join(siteDir, 'crombolo.sqlite')

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
// A site in `sites/` is meant to be run again and again against its own database;
// only a scaffold, which a fresh demo expects to be empty, stops here.
if (!site && held !== undefined && held > 0 && !flags.has('--reuse')) {
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
const startArgs = bundle ? ['--bundle', bundle, '--publish'] : []
const passThrough = args.filter(
  (arg) => arg.startsWith('--') && !['--docker', '--fresh', '--reuse', '--dry-run'].includes(arg),
)

/** How long a child gets to stop on its own before Ctrl-C stops meaning please. */
const GRACE_MS = 10_000

/**
 * Runs the child to completion, and stays alive long enough to clean up after it.
 *
 * Ctrl-C reaches the two branches by quite different routes. Locally the
 * terminal is in its usual mode, so it raises SIGINT on this process group —
 * which `Bun.spawn` leaves the child in, so both get it and there is nothing to
 * forward. Under `--docker`, `docker compose run` holds the terminal in raw
 * mode and nothing local is signalled at all: the keystroke goes to the
 * container as a byte, and the container's own terminal raises the SIGINT that
 * `crombolo start` handles (see `stopOnSignal` in `packages/cli/bin`).
 *
 * Either way the job here is to wait. With no handler, bun's default took this
 * process down on the first local press and returned the prompt while
 * `docker compose run` was still stopping its container — and a `compose run`
 * container whose client has gone keeps the port it published. That is the
 * orphan that used to have to be chased with `docker:down` by hand.
 *
 * So the signal is caught in order to outlive the child's shutdown, after which
 * `cleanUp` takes away anything that survived it. A second press, or a child
 * still there after `GRACE_MS`, escalates to SIGKILL.
 */
async function runToCompletion(
  proc: Bun.Subprocess,
  cleanUp: () => void = () => {},
): Promise<number> {
  let presses = 0
  let forcing: ReturnType<typeof setTimeout> | undefined
  const onSignal = () => {
    presses += 1
    if (presses > 1) {
      proc.kill('SIGKILL')
      return
    }
    console.log('\n  stopping… (Ctrl-C again to force)')
    forcing = setTimeout(() => proc.kill('SIGKILL'), GRACE_MS)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    const code = await proc.exited
    if (forcing) clearTimeout(forcing)
    cleanUp()
    // A stop that was asked for is not a failure, so this reports success rather
    // than the 130 a shell gives a SIGINT death. It is only this process's own
    // code: `bun run site` takes the same SIGINT and reports whatever it makes
    // of it, so that is what the shell sees when the script is run that way.
    return presses > 0 ? 0 : code
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

if (flags.has('--docker')) {
  if (relative(ROOT, siteDir).startsWith('..')) {
    console.error(
      `\n${siteDir} is outside the repository, and the container only mounts it at ${CONTAINER_ROOT}.\n` +
        '  Drop CROMBOLO_SITES_DIR and CROMBOLO_SCAFFOLDS_DIR, or run without --docker.',
    )
    process.exit(1)
  }

  /**
   * A name of our own, rather than the hash `compose run` would invent. It is
   * what lets the container be removed by name on the way out, and recognised on
   * the way in: a leftover from a run that was killed outright is cleared here,
   * instead of surfacing as the port clash below for someone else to explain.
   */
  const containerName = `crombolo-site-${slug}`
  const removeContainer = () =>
    Bun.spawnSync(['docker', 'rm', '--force', containerName], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  // `--dry-run` says what it would do and touches nothing, the daemon included.
  if (!flags.has('--dry-run')) removeContainer()

  // The stack publishes one fixed port, so a clash is reported here with the way
  // out rather than as a daemon error about endpoint programming. Our own
  // leftover is already gone, so what is left is something else holding it.
  const port = Number(Bun.env.CROMBOLO_PORT ?? 8080)
  if (await portInUse(port)) {
    console.error(
      `\nPort ${port} is already in use, so the stack cannot publish it.\n` +
        '  "bun run docker:down" stops the stack, if that is what has it.\n' +
        '  Otherwise set CROMBOLO_PORT to something else.',
    )
    // A dry run reports the clash a real run would hit, without failing on it
    if (!flags.has('--dry-run')) process.exit(1)
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
    '--name',
    containerName,
    '--service-ports',
    // The dialect is forced to SQLite below, so the stack's Postgres is not
    // wanted and starting it would be pure latency.
    '--no-deps',
    '-w',
    containerSite,
    '-e',
    'CROMBOLO_DB=sqlite',
    '-e',
    `CROMBOLO_SQLITE_FILE=${containerSite}/crombolo.sqlite`,
    'cms',
    'bun',
    `${CONTAINER_ROOT}/packages/cli/bin/crombolo.ts`,
    'start',
    ...startArgs,
    ...passThrough,
  ]
  console.log(`\n  ${command.join(' ')}\n`)
  if (flags.has('--dry-run')) process.exit(0)
  const proc = Bun.spawn(command, { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] })
  process.exit(await runToCompletion(proc, removeContainer))
}

const command = [
  'bun',
  join(ROOT, 'packages/cli/bin/crombolo.ts'),
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
    CROMBOLO_DB: 'sqlite',
    CROMBOLO_SQLITE_FILE: sqliteFile,
    CROMBOLO_POSTGRES_URL: '',
    CROMBOLO_MEDIA_DIR: join(siteDir, 'media'),
    CROMBOLO_LOGS_DIR: join(siteDir, 'logs'),
  },
})
// Nothing to clean up: the server is this child, and it holds the port only for
// as long as it runs.
process.exit(await runToCompletion(proc))
