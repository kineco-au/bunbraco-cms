#!/usr/bin/env bun
/**
 * The crombolo CLI. Runs from a site directory and reads `crombolo.config.ts`
 * there when present.
 *
 *   crombolo start                  boot the site; resets and prints the admin password
 *   crombolo start --keep-admin     boot without touching the admin password
 *   crombolo start --bundle <pkg>   apply a bundle's content, once, then serve
 *   crombolo start --from <file>    in an empty folder: a working site from a whole-site file
 *   crombolo init                   scaffold a site in the current directory
 *   crombolo init --template <id>   …from a starter template, content included
 *   crombolo status                 what this environment is, without starting it
 *   crombolo admin reset-password   reset the administrator's password and print it
 *   crombolo schema check           validate schema/ and report what a sync would do
 *   crombolo schema check --static  validate the files only, no database
 *   crombolo schema sync            apply schema/ to the database
 *   crombolo schema export          write the database's definitions as schema/ files
 *   crombolo schema new             scaffold a type file, and the view it points at
 *   crombolo schema add-property    append a property to a type, and apply it
 *   crombolo generate               TypeScript for the content types in schema/
 *   crombolo components check       compile every component before a visitor does
 *   crombolo assets list            the stylesheets and scripts beside them
 *
 *   crombolo export --site          write the whole site to one file, to move it to another machine or host
 *   crombolo content export         write a subtree as a private bundle package, to move to another environment
 *   crombolo content check          read-only: what installing a bundle's content here would do
 *   crombolo content import         apply a bundle's content, in one transaction, and record the run
 *   crombolo content runs           the imports applied here
 *   crombolo content revert         put an import back, restoring what the site served
 *
 *   crombolo domains                the hostnames this site answers on
 *   crombolo domains set            write domains.toml and apply it
 *
 *   crombolo import <file>          replace this site with a whole-site file; says what first
 *   crombolo remote add|list|remove the remotes this site pulls from and pushes to (remotes.toml)
 *   crombolo login|logout|whoami    sign in to a remote with a code you approve in its back office
 *   crombolo pull [<remote>]        a copy of a remote environment: started here, or replacing this site
 *   crombolo push [<remote>]        replace a remote environment with this site
 *   crombolo import umbraco report  read-only: what importing an Umbraco backup would and would not bring
 *   crombolo import umbraco apply   write a crombolo site from an Umbraco backup
 *
 *   crombolo upgrade --plan         print the DDL each pending framework migration would run
 *   crombolo upgrade                back up, apply pending framework migrations, record them
 *   crombolo upgrade ledger         print migration_history
 *   crombolo bundle purge <id>      back up, drop a bundle's tables and clear its state
 *
 *   crombolo maintenance pause      refuse editors' saves cluster-wide; readers unaffected
 *   crombolo maintenance resume     let editors save again
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { AuthStore, resetAdminPassword } from '@crombolo/auth'
import { ObjectTypes } from '@crombolo/core'
import {
  ContentTypeRepository,
  connect,
  currentSchemaState,
  DictionaryRepository,
  DocumentRepository,
  DomainRepository,
  describeRefFailure,
  type Finding,
  MigrationStepError,
  NodeRepository,
  readLedger,
  readSetupState,
  recordInLedger,
  resolveNodeRef,
  TransferRunRepository,
  UpgradeStateError,
  writeReport,
} from '@crombolo/data'
import {
  addProperty,
  allProperties,
  BUILTIN_DATA_TYPES,
  exportSchemaSet,
  fileNameFor,
  generateTypes,
  loadSchemaDirectory,
  loadValueMigrations,
  newType,
  type SchemaContentType,
  type SchemaTypeKind,
  type SyncReport,
  TYPE_KIND_FILES,
  type ValueMigration,
  validateSchemaSet,
  viewScaffold,
  writeContentType,
  writeSchemaFiles,
} from '@crombolo/schema'
import {
  assertPortAvailable,
  assetDirs,
  assetScaffold,
  type BootFailure,
  backupBefore,
  bootFailurePage,
  bootRetryDelays,
  bootstrapDatabase,
  type CromboloConfig,
  checkComponents,
  componentAliasesIn,
  componentFileFor,
  componentScaffold,
  createServer,
  DOMAINS_FILE,
  type DomainDeclaration,
  describeBootFailure,
  describeDatabase,
  dictionaryToUdt,
  domainsFilePath,
  forgetSignIn,
  formTypesFor,
  importDictionaryUdt,
  isSafeAlias,
  listAssets,
  listComponents,
  listeningBodyLimit,
  loadConfig,
  mediaStoreFor,
  osKeychain,
  placeBlobs,
  readDomainsFile,
  readRemoteMedia,
  readSignIn,
  resolveDomainNode,
  resolvePlaceholders,
  type ServerHandle,
  siteStatus,
  syncDomainsFile,
  syncSchemaDirectory,
  undoDomainsFile,
  VERSION,
  withoutNode,
  writeDictionaryUdt,
  writeDomains,
  writeDomainsFile,
  writeRemoteMedia,
  writeUdtAll,
} from '@crombolo/server'
import {
  importBundle,
  isResolution,
  isRevertResolution,
  type NodeResolutions,
  packageNameFor,
  parseResolveFlags,
  propertyHandle,
  RESOLUTIONS,
  RESOLUTIONS_FILE,
  REVERT_RESOLUTIONS,
  type Resolution,
  type RevertResolution,
  resolutionsFor,
  revertResolutionsFor,
  revertRun,
  type TransferCheck,
  writeResolutions,
} from '@crombolo/transfer'
import * as ops from '../src/operations/commands.ts'
import {
  discover,
  type Job,
  problemOf,
  RemoteClient,
  RemoteError,
  signIn,
  TimedOut,
} from '../src/remote/client.ts'
import { addRemote, pickRemote, readRemotes, removeRemote } from '../src/remote/remotes-file.ts'
import {
  fetchReferencedMedia,
  pullFile,
  pushSite,
  RefusedBeforeSending,
  referencedBlobs,
} from '../src/remote/transfer.ts'
import { findTemplate, listTemplates, scaffoldFiles } from '../src/templates.ts'

const cwd = process.cwd()
const [command = 'help', ...rest] = Bun.argv.slice(2)
const flags = new Set(rest.filter((arg) => arg.startsWith('--')))
const positional = rest.filter((arg) => !arg.startsWith('--'))

async function siteConfig(): Promise<CromboloConfig> {
  const file = join(cwd, 'crombolo.config.ts')
  const overrides = existsSync(file)
    ? ((await import(file)).default as Partial<CromboloConfig>)
    : {}
  return loadConfig(overrides, cwd)
}

function banner(lines: string[]): void {
  const width = Math.max(...lines.map((line) => line.length))
  console.log(`┌─${'─'.repeat(width)}─┐`)
  for (const line of lines) console.log(`│ ${line.padEnd(width)} │`)
  console.log(`└─${'─'.repeat(width)}─┘`)
}

/** How long a shutdown gets before it is abandoned and the process leaves anyway. */
const SHUTDOWN_MS = 10_000

/**
 * Stops the site on SIGINT and SIGTERM.
 *
 * Without a handler neither signal does anything at all in a container: `bun` is
 * PID 1 there, and the kernel drops a signal PID 1 has registered no handler
 * for. That is why Ctrl-C did nothing under `docker compose run` — the keystroke
 * reaches the container's own terminal, which raises a SIGINT nothing was
 * listening for — and why `docker stop` sat out its ten-second grace and then
 * resorted to SIGKILL. Outside a container the default would at least have
 * killed the process, so this was invisible there.
 *
 * `server.close()` is the point of it either way: the job runner, the event
 * hubs, the component watcher, the poller and the database all get to stop,
 * rather than being taken away mid-write. Connections are closed with the
 * listener because the live-update sockets are long-lived, and waiting for a
 * socket that is meant to stay open would be waiting for ever.
 *
 * A second signal, or a close that will not finish, leaves immediately.
 */
function stopOnSignal(
  listening: { stop: (closeActiveConnections?: boolean) => void },
  current: () => ServerHandle | undefined,
): void {
  let stopping = false
  const stop = (signal: string) => {
    // 130 is what a shell reports for a SIGINT death, and what this was.
    if (stopping) process.exit(130)
    stopping = true
    console.log(`\nStopping (${signal})…`)
    setTimeout(() => process.exit(130), SHUTDOWN_MS).unref()
    void (async () => {
      listening.stop(true)
      const server = current()
      if (server) await server.close()
      process.exit(0)
    })()
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop(signal))
}

/**
 * `start --from <file>` (story 105): an empty folder in, a working site out —
 * scaffolded as `init` scaffolds one, its packages installed, and the file
 * imported as a replace so nothing of the scaffold's own starting point stays.
 * The new administrator's password is printed here, once.
 */
async function startFromFile(from: string, known?: string): Promise<void> {
  const file = resolve(cwd, from)
  if (!existsSync(file)) {
    console.error(`${from} does not exist.`)
    process.exit(1)
  }
  if (existsSync(join(cwd, 'crombolo.config.ts'))) {
    console.error(
      'There is a site here already. `crombolo import <file> --replace` replaces it; start --from starts a new one in an empty folder.',
    )
    process.exit(1)
  }
  const dir = await ops.unpackBundle(file, cwd)
  const manifest = ops.readBundle(dir, cwd).set.manifest
  if (manifest.scope !== 'site') {
    console.error(`${from} is not a whole-site file: write one with \`crombolo export --site\`.`)
    process.exit(1)
  }
  // A pull already holds the passphrase it sealed the file with.
  const sealed = manifest.people !== undefined || manifest.content === 'sealed'
  const passphrase = known
    ? known
    : sealed
      ? (process.env[PASSPHRASE_ENV] ??
        (process.stdin.isTTY ? await readSecret('  Passphrase for its people: ') : undefined))
      : undefined
  if (sealed && !passphrase) {
    console.error(`${from} is sealed: set ${PASSPHRASE_ENV} to its passphrase.`)
    process.exit(1)
  }

  for (const scaffolded of scaffoldFiles({
    siteName: flagValue('--name') ?? manifest.provenance.siteName,
    postgres: flags.has('--postgres'),
  })) {
    const target = join(cwd, scaffolded.path)
    if (existsSync(target)) continue
    await mkdir(join(target, '..'), { recursive: true })
    if (scaffolded.copyFrom === undefined) await writeFile(target, scaffolded.text ?? '')
    else await Bun.write(target, Bun.file(scaffolded.copyFrom))
  }
  console.log(`  scaffolded a site for ${manifest.provenance.siteName || 'the file'}`)
  if (!flags.has('--no-install')) {
    const install = Bun.spawnSync(['bun', 'install'], { cwd, stdout: 'inherit', stderr: 'inherit' })
    if (install.exitCode !== 0) {
      console.error('`bun install` failed; run it, then `crombolo import <file> --replace`.')
      process.exit(1)
    }
  }

  const config = await siteConfig()
  const { db, seededAdminPassword } = await bootstrapDatabase(config)
  await db.close()
  const result = await ops.contentImport(config, {
    bundle: dir,
    passphrase,
    replace: 'replace',
    allowMissingBlobs: flags.has('--allow-missing-media'),
    backupTaken: true,
    label: `start --from ${basename(file)}`,
  })
  for (const problem of result.problems) console.error(`  ${problem}`)
  if (!result.runId) {
    printTransferFindings(result.check)
    console.error('\nThe file could not be imported; the scaffolded site is left as it is.')
    process.exit(1)
  }
  console.log(`  imported ${result.check.counts.create} item(s), run ${result.runId}`)
  const placed = describePlaced(result.blobs)
  if (placed) console.log(`  media    ${placed}`)
  if (seededAdminPassword)
    banner([
      'Sign in with (shown once)',
      `  username  ${config.adminLogin}`,
      `  password  ${seededAdminPassword}`,
    ])
  // The password above is the one to use: this first start leaves it alone.
  flags.add('--keep-admin')
}

async function start(): Promise<void> {
  const from = flagValue('--from')
  if (from) await startFromFile(from)
  const config = await siteConfig()
  // Before the migration and the seed, so a clash with the container stack is
  // reported in a second rather than after the database work.
  await assertPortAvailable(config.port)
  const { listening, server, bundles } = await bootWithRetries(config)
  const seededAdminPassword = server.seededAdminPassword

  const lines = ['Crombolo is running', '']
  // What this node actually answers, so a split deployment's banner does not
  // advertise an address that 404s here.
  if (config.role !== 'web')
    lines.push(`  backoffice  ${listening.url}${config.backOfficePath.slice(1)}`)
  if (config.role !== 'api') lines.push(`  site        ${listening.url}`)
  if (config.role !== 'all') lines.push(`  role        ${config.role}`)
  lines.push('')

  // A `web` node owns nothing and writes nothing at boot: resetting the password
  // here would be a write from the node whose whole point is not to make them,
  // and would end the sessions of editors signed in to the api node.
  if (config.role === 'web') {
    // Nothing to print: this node has no sign-in.
  } else if (!config.development) {
    // Production never touches an existing administrator at start: a restart an
    // attacker forced must not reset, re-enable or sign anyone out.
    if (await setupPending(server))
      lines.push(
        '  Set up your new site at',
        `    ${listening.url}${config.backOfficePath.slice(1)}/setup`,
        config.setupCode
          ? '  with the code in CROMBOLO_SETUP_CODE.'
          : '  First set CROMBOLO_SETUP_CODE (16+ characters) and restart.',
        '',
      )
  } else if (flags.has('--keep-admin')) {
    if (seededAdminPassword)
      lines.push(
        '  Sign in with',
        `    username  ${config.adminLogin}`,
        `    password  ${seededAdminPassword}`,
        '',
      )
  } else {
    const admin = await resetAdminPassword(
      new AuthStore(server.db),
      config.adminLogin,
      config.adminPassword,
    )
    if (admin) {
      lines.push(
        '  Sign in with',
        `    username  ${admin.login}`,
        `    password  ${admin.password}`,
        '',
      )
      lines.push(
        config.adminPassword
          ? '  (from CROMBOLO_ADMIN_PASSWORD)'
          : '  A fresh password is generated on every start; set',
      )
      if (!config.adminPassword)
        lines.push('  CROMBOLO_ADMIN_PASSWORD to keep one, or pass --keep-admin.')
      if (admin.sessionsEnded > 0)
        lines.push(`  Ended ${admin.sessionsEnded} session(s): the password changed.`)
    }
  }
  const components = server.health().components
  lines.push(
    `  database    ${describeDatabase(config)}`,
    `  components  ${config.componentsDir}${components.hash ? `   generation ${components.hash.slice(0, 8)}` : ''}`,
  )
  for (const line of bundles) lines.push(line)
  const report = server.schema.report
  if (report) lines.push(`  schema      ${describeSync(report)}`)
  if (server.schema.compatibilityMode)
    lines.push('  ⚠ database is ahead of schema/: reads only, writes refused with 409')
  banner(lines)
  if (seededAdminPassword) console.log('Database created and seeded.')
}

/**
 * Listens at once, serving a page that says why the site is not up yet, and
 * retries the boot with backoff: a database that comes up after the server is
 * picked up without a restart. After the last attempt it exits, so the
 * platform's restart policy and alerts take over. docs/operations.md.
 */
async function bootWithRetries(config: CromboloConfig) {
  const attempts = Math.max(1, Number(Bun.env.CROMBOLO_BOOT_ATTEMPTS ?? 10) || 10)
  const delays = bootRetryDelays(attempts)
  let failure: BootFailure | undefined
  let progress = { attempt: 1, attempts, retryInSeconds: undefined as number | undefined }
  const holding = (request: Request) => {
    if (new URL(request.url).pathname === '/health')
      return Response.json(
        { ok: false, starting: true, problem: failure?.title ?? null },
        { status: 503 },
      )
    return new Response(bootFailurePage(failure, progress), {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '10' },
    })
  }
  const listening = Bun.serve({
    port: config.port,
    maxRequestBodySize: listeningBodyLimit(config),
    fetch: holding,
    websocket: { message() {} },
  })
  let current: ServerHandle | undefined
  // Registered the moment it listens, so there is no window, retries included,
  // in which it answers requests and cannot be asked to stop.
  stopOnSignal(listening, () => current)
  for (let attempt = 1; ; attempt++) {
    let server: ServerHandle | undefined
    try {
      server = await createServer(config)
      current = server
      // After the schema sync inside `createServer`, which is what gives the
      // bundle content types to land on, and before anything is served.
      const bundles = await importStartupBundles(server, config)
      listening.reload(server.serveOptions as never)
      return { listening, server, bundles }
    } catch (error) {
      current = undefined
      await server?.close().catch(() => {})
      failure = describeBootFailure(error, describeDatabase(config))
      const delay = delays[attempt - 1]
      console.error(
        `crombolo: ${failure.title}. ${failure.detail}\n  To fix it: ${failure.remedy}\n  (${error instanceof Error ? error.message : String(error)})`,
      )
      if (delay === undefined || error instanceof ops.CommandError) {
        progress = { attempt, attempts, retryInSeconds: undefined }
        listening.stop(true)
        if (error instanceof ops.CommandError) throw error
        throw new ops.CommandError(`Gave up after ${attempt} attempt(s): ${failure.title}.`)
      }
      progress = { attempt, attempts, retryInSeconds: Math.round(delay / 1000) }
      if (attempt === 1) console.error(`  ${listening.url} explains this while it retries.`)
      console.error(
        `  Trying again in ${Math.round(delay / 1000)}s (attempt ${attempt} of ${attempts}).`,
      )
      await Bun.sleep(delay)
    }
  }
}

async function setupPending(server: ServerHandle): Promise<boolean> {
  return (await readSetupState(server.db)) === 'pending'
}

/**
 * `start --bundle <dir>`, repeatable: apply a bundle before the site serves
 * anything, taking the flags `content import` takes.
 *
 * Imported once per bundle — a run still standing here means this site already
 * has that content — so a restart costs a query and a line in the banner. It
 * runs after the schema sync, which is what gives the bundle its content types,
 * and before anything is served. A refusal stops the boot: a site missing the
 * content the command line asked for is worse than a site that did not come up.
 */
async function importStartupBundles(
  server: ServerHandle,
  config: CromboloConfig,
): Promise<string[]> {
  const targets = flagValues('--bundle')
  if (targets.length === 0) return []

  const lines: string[] = []
  const db = server.db
  let imported = false
  for (const target of targets) {
    let resolved: ops.ResolvedBundle
    try {
      resolved = ops.readBundle(target, config.siteDir, await passphraseToOpen(target, config))
    } catch (error) {
      if (!(error instanceof ops.CommandError)) throw error
      console.error(`  ${error.message}`)
      for (const problem of error.problems) console.error(`    ${problem}`)
      console.error(`\n${target} cannot be read. The site has not started.`)
      process.exit(1)
    }
    const set = resolved.set
    const standing = await new TransferRunRepository(db).appliedFor(set.manifest.id)
    if (standing) {
      lines.push(`  bundle      ${set.manifest.id} already imported (run ${standing.id})`)
      continue
    }

    // Nothing to roll back to on a database this boot created, so the backup
    // rule — which on Postgres means refusing without one — applies only to a
    // site that already had content.
    if (!server.seededAdminPassword) {
      const backup = await backupBefore(config, {
        reason: 'content-import',
        backupTaken: flags.has('--backup-taken'),
      })
      if (backup.path) console.log(`  backup   ${backup.path}`)
    }

    const prepared = await ops.transferOptions(db, config, resolved, transferInput(target))
    for (const problem of prepared.problems) console.error(`  ${problem}`)
    const started = performance.now()
    const result = await importBundle(db, set, {
      ...prepared.options,
      // The administrator this boot created stands in until the site's own arrive.
      adoptUsers: Boolean(server.seededAdminPassword),
      publish: flags.has('--publish'),
      nodeId: config.nodeId,
      label: flagValue('--label'),
      package: { name: resolved.package.packageName, version: resolved.package.version },
    })
    await writeReport(db, result.check.findings, { source: 'transfer', scope: set.manifest.id })
    if (!result.runId) {
      printTransferFindings(result.check)
      console.error(
        `\n${target} was refused: ${result.check.outstanding.length} finding(s) outstanding. ` +
          'Nothing was written, and the site has not started.',
      )
      process.exit(1)
    }
    const c = result.check.counts
    const placed = describePlaced(
      resolved.blobs.size > 0
        ? await placeBlobs(await mediaStoreFor(config), resolved.blobs, resolved.openBlob)
        : null,
    )
    lines.push(
      `  bundle      ${set.manifest.id}: ${c.create} created, ${c.update} updated` +
        `${result.published.length > 0 ? `, ${result.published.length} published` : ''} (run ${result.runId})`,
    )
    if (placed) lines.push(`  blobs       ${placed}`)
    const people = result.people.filter((p) => p.kind === 'member' || p.kind === 'user')
    if (people.length > 0)
      lines.push(
        `  people      ${people.filter((p) => p.kind === 'member').length} member(s), ${people.filter((p) => p.kind === 'user').length} user(s); their passwords are the ones they had`,
      )
    for (const finding of result.check.findings.filter((f) => f.code === 'user-adopted'))
      lines.push(`  admin       ${finding.message}`)
    for (const failure of result.publishFailures)
      console.error(`  not published  ${failure.key}: ${failure.reason}`)
    await recordInLedger(db, {
      name: `content import ${set.manifest.id}`,
      kind: 'transfer',
      durationMs: Math.round(performance.now() - started),
      appliedBy: config.nodeId,
      note: `run ${result.runId}, ${resolved.package.packageName}@${resolved.package.version} (start --bundle)`,
    })
    imported = true
  }
  // The content landed under a cache this process had already constructed.
  if (imported) server.cache.invalidate()
  return lines
}

async function init(): Promise<void> {
  const requested = flagValue('--template')
  if (requested === 'list') {
    for (const t of listTemplates()) console.log(`  ${t.id.padEnd(20)} ${t.description}`)
    console.log('\n  (no --template scaffolds the files and no content)')
    return
  }
  const template = requested ? findTemplate(requested) : undefined
  if (requested && !template) {
    console.error(`No template "${requested}". \`crombolo init --template list\` prints them.`)
    process.exit(1)
  }

  const files = scaffoldFiles({
    siteName: flagValue('--name'),
    postgres: flags.has('--postgres'),
    template,
  })

  for (const file of files) {
    const target = join(cwd, file.path)
    if (existsSync(target) && !flags.has('--force')) {
      console.log(`  exists   ${file.path}`)
      continue
    }
    await mkdir(join(target, '..'), { recursive: true })
    if (file.copyFrom === undefined) await writeFile(target, file.text ?? '')
    else await Bun.write(target, Bun.file(file.copyFrom))
    console.log(`  created  ${file.path}`)
  }

  console.log(`\nNext:\n  bun install\n  bun start`)
  if (template?.bundle)
    console.log(
      `\n\`bun start\` imports ${template.bundle} on the first boot of an empty database,\n` +
        'and says so. Nothing happens on later boots; it is one line in package.json.',
    )
}

/**
 * `crombolo status`: what this environment resolved to, and what is wrong with
 * it, without starting it.
 *
 * Read-only by construction — it opens the database rather than bootstrapping
 * it, so asking a production node how it is never migrates it.
 */
async function status(): Promise<void> {
  const config = await siteConfig()
  const report = await siteStatus(config)

  if (flags.has('--json')) {
    console.log(JSON.stringify(report, null, 2))
    if (report.problems.length > 0) process.exit(1)
    return
  }

  const line = (label: string, value: string) => console.log(`  ${label.padEnd(10)} ${value}`)
  line('site', `${report.site.name}${report.site.dir ? `   ${report.site.dir}` : ''}`)
  line('components', `${report.site.components}   snapshots in ${report.site.componentsCache}`)
  line(
    'database',
    `${report.database.description}   ${
      report.database.reachable
        ? report.database.installed
          ? 'reachable'
          : 'reachable, not installed'
        : 'unreachable'
    }`,
  )
  const files = report.schema.files ?? 'none'
  const database = report.schema.database
    ? `${report.schema.database.version}+${report.schema.database.revision}`
    : 'not installed'
  line(
    'schema',
    `files ${files}  database ${database}   ${
      !report.database.installed
        ? 'nothing applied yet'
        : report.schema.compatibilityMode
          ? 'compatibility mode'
          : report.schema.pending
            ? 'a deploy is pending'
            : 'up to date'
    }`,
  )
  const pending = report.framework.pending
  line(
    'framework',
    pending.length === 0
      ? 'no migration pending'
      : // The whole list is a wall of names on a fresh database; `upgrade --plan`
        // is where somebody goes when they want them.
        pending.length > 3
        ? `${pending.length} pending (\`crombolo upgrade --plan\` lists them)`
        : `${pending.length} pending: ${pending.join(', ')}`,
  )
  line(
    'content',
    `${report.content.documents} document(s), ${report.content.media} media, ${report.content.elements} element(s)` +
      `${report.content.lastImport ? `; last import ${report.content.lastImport}` : ''}`,
  )
  line(
    'email',
    report.email.available
      ? (report.email.description ?? 'configured')
      : report.email.provider === 'log'
        ? 'console only, nothing is sent'
        : `none — ${report.email.affects.join(', ')} unavailable`,
  )
  line(
    'findings',
    `${report.findings.blocking} blocking, ${report.findings.person} need a person, ` +
      `${report.findings.auto} automatic, ${report.findings.resolved} resolved`,
  )
  line(
    'versions',
    `crombolo ${report.versions.crombolo}${report.versions.backoffice ? `, backoffice ${report.versions.backoffice}` : ''}, bun ${report.versions.bun}`,
  )

  for (const problem of report.problems) console.error(`\n  ⚠ ${problem}`)
  if (report.problems.length > 0) process.exit(1)
}

async function admin(): Promise<void> {
  if (positional[0] !== 'reset-password') return help()
  const config = await siteConfig()
  // The database, not the server: resetting a password has nothing to do with
  // the schema sync, the caches or the port, and should not need them to be
  // healthy to work.
  const { db } = await bootstrapDatabase(config)
  const result = await resetAdminPassword(new AuthStore(db), config.adminLogin, positional[1])
  await db.close()
  if (!result) {
    console.error(`No account '${config.adminLogin}'.`)
    process.exit(1)
  }
  console.log(`${result.login}\n${result.password}`)
}

function describeSync(report: SyncReport): string {
  switch (report.action) {
    case 'applied':
    case 'would-apply': {
      const verb = report.action === 'applied' ? 'applied' : 'would apply'
      const c = report.created
      const parts = [
        `${c.types} type(s)`,
        `${c.properties} propert${c.properties === 1 ? 'y' : 'ies'}`,
        `${c.dataTypes} data type(s)`,
        `${c.languages} language(s)`,
      ]
      const extra = [
        report.retired.length > 0 ? `retired ${report.retired.join(', ')}` : '',
        report.retiredTypes.length > 0 ? `retired types ${report.retiredTypes.join(', ')}` : '',
        report.revived.length > 0 ? `revived ${report.revived.join(', ')}` : '',
        report.assignedKeys.length > 0 ? `${report.assignedKeys.length} key(s) assigned` : '',
      ].filter(Boolean)
      return `${verb} ${report.state?.version ?? ''}: created ${parts.join(', ')}${extra.length > 0 ? `; ${extra.join('; ')}` : ''}`
    }
    case 'skipped-same':
      return 'up to date'
    case 'skipped-older':
      return `compatibility mode: ${report.reason ?? ''}`
    case 'refused':
      return `refused: ${report.reason ?? `${report.problems.length} problem(s)`}`
  }
}

function printProblems(problems: SyncReport['problems']): void {
  for (const p of problems)
    console.error(`  ${p.file}${p.path ? ` (${p.path})` : ''}: ${p.message}`)
}

async function schema(): Promise<void> {
  const config = await siteConfig()
  const sub = positional[0]
  if (!existsSync(config.schemaDir) && sub !== 'export') {
    console.error(`No schema directory at ${relative(cwd, config.schemaDir) || '.'}.`)
    process.exit(1)
  }
  switch (sub) {
    case 'check': {
      const loaded = loadSchemaDirectory(config.schemaDir, { formTypes: formTypesFor(config) })
      const problems = [
        ...loaded.problems,
        ...validateSchemaSet(loaded.set, {
          componentAliases: componentAliasesIn(config.componentsDir),
          types: formTypesFor(config),
        }),
      ]
      if (problems.length > 0) {
        console.error(`${problems.length} problem(s):`)
        printProblems(problems)
        process.exit(1)
      }
      console.log(
        `schema ${loaded.set.version}: ${loaded.set.contentTypes.length} content type(s), ${(loaded.set.mediaTypes ?? []).length} media type(s), ${loaded.set.dataTypes.length} data type(s), ${loaded.set.languages.length} language(s) — valid`,
      )
      if (flags.has('--static')) {
        const issues = staticProblems(loaded, await loadValueMigrations(config.schemaDir))
        for (const issue of issues) console.error(`  ${issue}`)
        if (issues.length > 0) process.exit(1)
        return
      }
      // The same check an upgrade runs, over the site's own diff.
      positional[0] = 'check'
      await upgrade()
      return
    }
    case 'sync': {
      const { db } = await bootstrapDatabase(config)
      try {
        const report = await syncSchemaDirectory(
          db,
          config,
          { nodeId: config.nodeId, revision: config.schemaRevision },
          { forceRetireTypes: flags.has('--force-retire-types') },
        )
        if (report.problems.length > 0) printProblems(report.problems)
        console.log(describeSync(report))
        if (report.action === 'refused') process.exit(1)
      } finally {
        await db.close()
      }
      return
    }
    case 'purge':
      return schemaPurge(config)
    case 'new':
      return schemaNew(config)
    case 'add-property':
      return schemaAddProperty(config)
    case 'rewrite': {
      // Every file in the canonical layout: a reviewable commit when the vocabulary changes.
      const loaded = loadSchemaDirectory(config.schemaDir, { formTypes: formTypesFor(config) })
      if (loaded.problems.length > 0) {
        printProblems(loaded.problems)
        process.exit(1)
      }
      for (const file of writeSchemaFiles(config.schemaDir, loaded.set))
        console.log(`  wrote  ${relative(cwd, file)}`)
      return
    }
    case 'export': {
      const { db } = await bootstrapDatabase(config)
      try {
        const version = existsSync(config.schemaDir)
          ? loadSchemaDirectory(config.schemaDir, { formTypes: formTypesFor(config) }).set.version
          : '1.0.0'
        const set = await exportSchemaSet(db, version)
        for (const file of writeSchemaFiles(config.schemaDir, set))
          console.log(`  wrote  ${relative(cwd, file)}`)
      } finally {
        await db.close()
      }
      return
    }
    default:
      return help()
  }
}

const TYPE_KINDS: Record<string, SchemaTypeKind> = {
  'content-type': 'document',
  'media-type': 'media',
  'member-type': 'member',
}

/**
 * `schema new <kind> <alias>`: the file a site would otherwise write from
 * memory, keys and all, and the view it points at.
 */
async function schemaNew(config: CromboloConfig): Promise<void> {
  const kindArg = positional[1] ?? ''
  const alias = positional[2]
  const kind = TYPE_KINDS[kindArg]
  if (!kind || !alias) {
    console.error(
      `schema new needs a kind and an alias: ${Object.keys(TYPE_KINDS).join(', ')}.\n` +
        '  crombolo schema new content-type article --at-root',
    )
    process.exit(1)
  }

  const loaded = loadSchemaDirectory(config.schemaDir, { formTypes: formTypesFor(config) })
  const existing = [
    ...loaded.set.contentTypes,
    ...(loaded.set.mediaTypes ?? []),
    ...(loaded.set.memberTypes ?? []),
  ]
  if (existing.some((type) => type.alias === alias)) {
    console.error(`There is already a type with the alias "${alias}".`)
    process.exit(1)
  }

  const element = flags.has('--element')
  const type = newType({
    alias,
    kind,
    name: flagValue('--name'),
    description: flagValue('--description'),
    icon: flagValue('--icon'),
    allowAtRoot: flags.has('--at-root'),
    element,
    template: !flags.has('--no-view'),
    // A content type with nothing in it cannot be published, so it starts with
    // the one property every page has; the other kinds get what they are given.
    tab: kind === 'document' ? (flagValue('--tab') ?? 'Content') : undefined,
  })

  const file = join(config.schemaDir, TYPE_KIND_FILES[kind].dir, fileNameFor(alias))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, writeContentType(type, kind))
  console.log(`  created  ${relative(cwd, file)}`)

  // A type nothing allows cannot be created anywhere, which is a confusing
  // first five minutes: the editor simply never offers it.
  if (kind === 'document' && !element && !type.allowAtRoot) {
    const parents = loaded.set.contentTypes.filter((t) => t.allowChildren.includes(alias))
    if (parents.length === 0)
      console.log(
        `  note     nothing allows a "${alias}" yet — add it to a parent's allow-children, or pass --at-root`,
      )
  }

  if (type.components.length > 0) {
    const view = join(config.componentsDir, `${alias}.tsx`)
    if (existsSync(view)) console.log(`  exists   ${relative(cwd, view)}`)
    else {
      await mkdir(join(view, '..'), { recursive: true })
      await writeFile(view, viewScaffold(type))
      console.log(`  created  ${relative(cwd, view)}`)
    }
  }
  return applySchema(config)
}

/** `schema add-property <type> <alias> --type <data type>`: the repetitive edit. */
async function schemaAddProperty(config: CromboloConfig): Promise<void> {
  const typeAlias = positional[1]
  const alias = positional[2]
  const dataType = flagValue('--type')
  if (!typeAlias || !alias || !dataType) {
    console.error(
      'schema add-property needs the type, the property alias and --type <data type>:\n' +
        '  crombolo schema add-property article summary --type textarea --mandatory',
    )
    process.exit(1)
  }

  const loaded = loadSchemaDirectory(config.schemaDir, { formTypes: formTypesFor(config) })
  if (loaded.problems.length > 0) {
    printProblems(loaded.problems)
    process.exit(1)
  }
  const kinds: Array<[SchemaTypeKind, SchemaContentType[]]> = [
    ['document', loaded.set.contentTypes],
    ['media', loaded.set.mediaTypes ?? []],
    ['member', loaded.set.memberTypes ?? []],
  ]
  const found = kinds
    .map(([kind, types]) => ({ kind, type: types.find((t) => t.alias === typeAlias) }))
    .find((candidate) => candidate.type)
  if (!found?.type) {
    console.error(`No type "${typeAlias}" in ${relative(cwd, config.schemaDir)}.`)
    process.exit(1)
  }

  const known = new Set([
    ...BUILTIN_DATA_TYPES.map((d) => d.alias),
    ...loaded.set.dataTypes.map((d) => d.alias),
  ])
  if (!known.has(dataType)) {
    console.error(`No data type "${dataType}". Built in: ${[...known].sort().join(', ')}`)
    process.exit(1)
  }

  const result = addProperty(found.type, {
    alias,
    type: dataType,
    name: flagValue('--name'),
    description: flagValue('--description'),
    mandatory: flags.has('--mandatory'),
    tab: flagValue('--tab'),
  })
  if (!result.ok) {
    console.error(`  ${result.reason}`)
    process.exit(1)
  }

  const file = join(config.schemaDir, TYPE_KIND_FILES[found.kind].dir, fileNameFor(typeAlias))
  // The whole file is re-emitted from the model, as `schema rewrite` does, so a
  // comment in it does not survive. Said out loud rather than discovered in a
  // diff; `--dry-run` prints the file instead of writing it.
  const text = writeContentType(result.type, found.kind)
  if (flags.has('--dry-run')) {
    console.log(text)
    return
  }
  const before = existsSync(file) ? await Bun.file(file).text() : ''
  await writeFile(file, text)
  console.log(`  wrote    ${relative(cwd, file)}`)
  console.log(
    `  ${result.property.alias}  ${result.property.name} (${dataType}${result.property.mandatory ? ', mandatory' : ''}) in tab "${result.tab}"`,
  )
  if (/^\s*#/m.test(before))
    console.log('  note     the file is rewritten canonically, so its comments are not kept')
  return applySchema(config)
}

/** Applies `schema/` as a boot or a deploy step would, and reports what it did. */
async function applySchema(config: CromboloConfig): Promise<void> {
  const { db } = await bootstrapDatabase(config)
  try {
    const report = await syncSchemaDirectory(db, config, {
      nodeId: config.nodeId,
      revision: config.schemaRevision,
    })
    if (report.problems.length > 0) printProblems(report.problems)
    console.log(`  schema   ${describeSync(report)}`)
    if (report.action === 'refused') process.exit(1)
  } finally {
    await db.close()
  }
}

/** The pull-request rules: keys present, migrations well-formed, nothing the database needs. */
function staticProblems(
  loaded: ReturnType<typeof loadSchemaDirectory>,
  migrations: ValueMigration[],
): string[] {
  const problems: string[] = []
  for (const t of loaded.set.contentTypes) {
    if (!t.key)
      problems.push(
        `${t.alias}: no key — run \`crombolo schema sync\` in development to assign one`,
      )
    for (const p of allProperties(t)) if (!p.key) problems.push(`${t.alias}.${p.alias}: no key`)
  }
  for (const d of loaded.set.dataTypes) if (!d.key) problems.push(`data type ${d.alias}: no key`)
  for (const m of migrations) {
    const type = loaded.set.contentTypes.find((t) => t.alias === m.from.type)
    if (!type) {
      problems.push(`migration ${m.id}: no content type "${m.from.type}"`)
      continue
    }
    for (const target of m.to)
      if (!allProperties(type).some((p) => p.alias === target.property))
        problems.push(
          `migration ${m.id}: "${m.from.type}" has no property "${target.property}" to write to`,
        )
  }
  return problems
}

async function schemaPurge(config: CromboloConfig): Promise<void> {
  const index = rest.indexOf('--older-than')
  const days = index >= 0 ? Number(rest[index + 1]) : Number.NaN
  if (!Number.isFinite(days) || days < 0) {
    console.error(
      'schema purge needs --older-than <days>: how long a property must have been retired.',
    )
    process.exit(1)
  }
  const backup = await backupBefore(config, {
    reason: 'purge',
    backupTaken: flags.has('--backup-taken'),
  })
  if (backup.path) console.log(`  backup   ${backup.path}`)
  const { db } = await bootstrapDatabase(config)
  try {
    const before = new Date(Date.now() - days * 86_400_000)
    const started = performance.now()
    const purged = await new ContentTypeRepository(db).purgeRetired(before)
    for (const p of purged) console.log(`  purged   ${p.type}.${p.alias}`)
    if (purged.length === 0) console.log(`Nothing retired more than ${days} day(s) ago.`)
    else
      await recordInLedger(db, {
        name: `purge ${purged.map((p) => `${p.type}.${p.alias}`).join(', ')}`,
        kind: 'contract',
        durationMs: Math.round(performance.now() - started),
        appliedBy: config.nodeId,
        note: `--older-than ${days}`,
      })
  } finally {
    await db.close()
  }
}

async function generate(): Promise<void> {
  const config = await siteConfig()
  const loaded = loadSchemaDirectory(config.schemaDir, { formTypes: formTypesFor(config) })
  const problems = [
    ...loaded.problems,
    ...validateSchemaSet(loaded.set, { types: formTypesFor(config) }),
  ]
  if (problems.length > 0) {
    printProblems(problems)
    process.exit(1)
  }
  const target = join(config.schemaDir, 'content-types.d.ts')
  await writeFile(target, generateTypes(loaded.set))
  console.log(`  wrote  ${relative(cwd, target)}`)
}

/** Every value given for a repeatable flag, in the order they appeared. */
function flagValues(name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== name) continue
    const value = rest[i + 1]
    if (value !== undefined && !value.startsWith('--')) out.push(value)
  }
  return out
}

function flagValue(name: string): string | undefined {
  return flagValues(name)[0]
}

/** Where a script gives a bundle's passphrase, rather than typing it. */
const PASSPHRASE_ENV = 'CROMBOLO_BUNDLE_PASSPHRASE'
const MIN_PASSPHRASE = 12

/** A line typed without echo. */
async function readSecret(question: string): Promise<string> {
  process.stdout.write(question)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((done) => {
    let typed = ''
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          process.stdout.write('\n')
          process.exit(130)
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          done(typed)
          return
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1)
        else typed += char
      }
    }
    stdin.on('data', onData)
  })
}

/** The passphrase to open a bundle with, when it is sealed: the environment's, or asked for. */
async function passphraseToOpen(
  target: string,
  config: CromboloConfig,
): Promise<string | undefined> {
  const given = process.env[PASSPHRASE_ENV]
  if (given) return given
  let sealed = false
  try {
    sealed = ops.readBundle(target, config.siteDir).set.sealed === true
  } catch {
    // The command that follows reads it again and says what is wrong with it.
    return undefined
  }
  if (!sealed) return undefined
  if (!process.stdin.isTTY) {
    console.error(
      `${target} is encrypted. Set ${PASSPHRASE_ENV} to the passphrase it was exported with.`,
    )
    process.exit(1)
  }
  return readSecret('  Passphrase for this bundle: ')
}

/** A new passphrase to seal an export with: the environment's, or asked for twice. */
async function passphraseToSeal(): Promise<string> {
  const given = process.env[PASSPHRASE_ENV]
  if (given) {
    if (given.length < MIN_PASSPHRASE) {
      console.error(`${PASSPHRASE_ENV} is shorter than ${MIN_PASSPHRASE} characters.`)
      process.exit(1)
    }
    return given
  }
  if (!process.stdin.isTTY) {
    console.error(`An encrypted export needs a passphrase: set ${PASSPHRASE_ENV}.`)
    process.exit(1)
  }
  for (;;) {
    const first = await readSecret('  Passphrase to encrypt this bundle with: ')
    if (first.length < MIN_PASSPHRASE) {
      console.error(`  At least ${MIN_PASSPHRASE} characters, please.`)
      continue
    }
    if ((await readSecret('  Again, to confirm: ')) === first) return first
    console.error('  They did not match.')
  }
}

async function content(): Promise<void> {
  const config = await siteConfig()
  switch (positional[0]) {
    case 'export':
      return contentExport(config)
    case 'check':
      return contentCheck(config)
    case 'import':
      return contentImport(config)
    case 'runs':
      return contentRuns(config)
    case 'publish':
      return contentPublish(config, true)
    case 'unpublish':
      return contentPublish(config, false)
    case 'revert':
      return contentRevert(config)
    default:
      return help()
  }
}

async function contentRevert(config: CromboloConfig): Promise<void> {
  const runId = positional[1]
  if (!runId) {
    console.error('content revert needs the run id. `crombolo content runs` lists them.')
    process.exit(1)
  }
  const resolutions: Record<string, RevertResolution> = {}
  for (const pair of flagValues('--resolve')) {
    const eq = pair.indexOf('=')
    const choice = eq >= 0 ? pair.slice(eq + 1) : ''
    if (eq < 0 || !isRevertResolution(choice)) {
      console.error(`  --resolve wants <key>=${REVERT_RESOLUTIONS.join('|')}, not "${pair}"`)
      process.exit(1)
    }
    resolutions[pair.slice(0, eq)] = choice
  }
  const allFlag = flagValue('--resolve-all')
  if (allFlag !== undefined && !isRevertResolution(allFlag)) {
    console.error(`  "${allFlag}" is not one of ${REVERT_RESOLUTIONS.join(', ')}`)
    process.exit(1)
  }

  const backup = await backupBefore(config, {
    reason: 'content-revert',
    backupTaken: flags.has('--backup-taken'),
  })
  if (backup.path) console.log(`  backup   ${backup.path}`)

  const { db } = await bootstrapDatabase(config)
  try {
    const started = performance.now()
    const forceIndex = rest.indexOf('--force')
    const result = await revertRun(db, runId, {
      resolutions,
      resolveAll: allFlag as RevertResolution | undefined,
      force: forceIndex >= 0,
      nodeId: config.nodeId,
      backOfficePath: config.backOfficePath,
    })

    if (!result.runId) {
      for (const f of result.check.findings) {
        console.error(`  [${f.kind.padEnd(8)}] ${f.message}`)
        for (const suggestion of revertResolutionsFor(f.code))
          console.error(`             → ${suggestion}`)
      }
      console.error('\nrevert refused. Nothing was changed.')
      process.exit(1)
    }

    // The files an install replaced come back from the run's own copies, not
    // from git: these files are editable in the backoffice, so a site need not
    // be a checkout at all.
    const files = await ops.revertSections(db, config, runId)
    for (const file of files.restored) console.log(`  restored ${relative(cwd, file)}`)
    for (const file of files.removed)
      console.log(`  removed  ${relative(cwd, file)}  (created by that run)`)
    if (files.schema) console.log(`  schema   ${files.schema}`)
    if (files.dictionary) console.log('  restored the dictionary')

    for (const key of result.restored) console.log(`  restored ${key}`)
    for (const key of result.recycled) console.log(`  recycled ${key}  (created by that run)`)
    for (const entry of result.check.plan.filter((p) => p.action === 'skip'))
      console.log(`  left     ${entry.name}`)
    await recordInLedger(db, {
      name: `content revert ${runId}`,
      kind: 'revert',
      durationMs: Math.round(performance.now() - started),
      appliedBy: config.nodeId,
      note: `run ${result.runId}`,
    })
    console.log(
      `\nReverted ${runId} as run ${result.runId}. ` +
        `\`crombolo content revert ${result.runId}\` would put it back again.`,
    )
  } finally {
    await db.close()
  }
}

/**
 * Puts the media files a bundle carries into this environment's store.
 *
 * After the content, because the run is what decides whether any of this
 * happened: a refused import leaves the store alone. The keys are the ones the
 * values already name, so a picked image finds its file wherever media lives
 * here — a disk, a bucket, a container.
 */
function describePlaced(placed: { placed: number; bytes: number } | null): string | undefined {
  if (!placed) return undefined
  return `${placed.placed} media file(s) placed, ${describeBytes(placed.bytes)}`
}

/** The flags `check` and `import` share: resolutions, placement, blobs. */
function transferInput(bundle: string): ops.TransferInput {
  const allFlag = flagValue('--resolve-all')
  if (allFlag !== undefined && !isResolution(allFlag)) {
    console.error(`  "${allFlag}" is not one of ${RESOLUTIONS.join(', ')}`)
    process.exit(1)
  }
  return {
    bundle,
    under: flagValue('--under'),
    resolutions: parseResolutions(),
    resolveAll: allFlag as Resolution | undefined,
    allowMissingBlobs: flags.has('--allow-missing-blobs'),
    publish: flags.has('--publish'),
    // What a bundle carries is applied by default — that is the point of it
    // carrying anything — so these decline a half, for someone who wants the
    // content without the structure that came with it.
    withoutSchema: flags.has('--no-schema'),
    withoutFiles: flags.has('--no-files'),
    replaceFiles: flags.has('--replace-files'),
  }
}

/** What the carried sections would do, or did. */
function printSections(plan: ops.SectionPlan | undefined): void {
  if (!plan) return
  console.log(`  carries  ${plan.sections.join(', ')}`)
  const counts = new Map<string, number>()
  for (const file of plan.files) counts.set(file.action, (counts.get(file.action) ?? 0) + 1)
  const summary = [...counts].map(([action, n]) => `${n} ${action}`).join(', ')
  if (summary) console.log(`  files    ${summary}`)
  for (const file of plan.files)
    if (file.action === 'overwrite') console.log(`    overwrites ${relative(cwd, file.target)}`)
  if (plan.dictionaryItems > 0) console.log(`  dict     ${plan.dictionaryItems} file(s)`)
  if (plan.schema) {
    console.log(`  schema   ${plan.schema.classification}`)
    for (const finding of plan.schema.findings) console.log(`    ${finding}`)
  }
}

/** Bytes as somebody reads them, since a bundle of media is measured in them. */
function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function describeBundle(bundle: ops.BundleSummary): void {
  console.log(
    `  bundle   ${bundle.id} from ${bundle.from || 'elsewhere'} ` +
      `(schema ${bundle.schemaVersion}+${bundle.schemaRevision}, ` +
      `${bundle.snapshot} snapshot, ${bundle.nodes} node(s))`,
  )
  if (bundle.blobsCarried > 0)
    console.log(
      `  blobs    ${bundle.blobsCarried} media file(s) carried, ${describeBytes(bundle.blobBytes)}`,
    )
}

async function contentImport(config: CromboloConfig): Promise<void> {
  const dir = positional[1]
  if (!dir) {
    console.error(
      'content import needs a bundle: a package directory, or the name of a bundle this site depends on.',
    )
    process.exit(1)
  }
  const result = await ops.contentImport(config, {
    ...transferInput(dir),
    passphrase: await passphraseToOpen(dir, config),
    publish: flags.has('--publish'),
    label: flagValue('--label'),
    backupTaken: flags.has('--backup-taken'),
  })
  for (const problem of result.problems) console.error(`  ${problem}`)
  if (result.backup.path) console.log(`  backup   ${result.backup.path}`)
  describeBundle(result.bundle)

  if (!result.runId) {
    printTransferFindings(result.check)
    // Staged, then applied in one transaction: a refusal leaves nothing behind.
    console.error(
      `\nimport refused: ${result.check.outstanding.length || result.problems.length} finding(s) outstanding. Nothing was written.`,
    )
    process.exit(1)
  }

  const c = result.check.counts
  console.log(`  run      ${result.runId}`)
  console.log(
    `  applied  ${c.create} created, ${c.update} updated, ${c.unchanged} unchanged, ${c.skip} skipped`,
  )
  const placed = describePlaced(result.blobs)
  if (placed) console.log(`  blobs    ${placed}`)
  if (result.sections) {
    console.log(
      `  files    ${result.sections.written.length} written` +
        (result.sections.replaced.length > 0
          ? `, ${result.sections.replaced.length} replaced`
          : ''),
    )
    if (result.sections.schema) console.log(`  schema   ${result.sections.schema.action}`)
    if (result.sections.dictionary)
      console.log(`  dict     ${result.sections.dictionary.imported} imported`)
    // Named, because this is what makes reverting the install possible.
    if (result.replacedFilesKept)
      console.log(`  kept     ${relative(cwd, result.replacedFilesKept)}  (the files it replaced)`)
  }
  if (result.published > 0) console.log(`  published ${result.published} node(s)`)
  for (const failure of result.publishFailures)
    console.error(`  not published  ${failure.key}: ${failure.reason}`)
  for (const finding of result.check.findings.filter((f) => f.kind === 'auto'))
    console.log(`  [auto    ] ${finding.message}`)
  console.log(`\nDone. \`crombolo content revert ${result.runId}\` puts it back.`)
}

/**
 * `content publish` / `content unpublish`: taking a page or a branch live, and
 * back off again, without the backoffice.
 *
 * A publish can be refused per node — an unpublished ancestor, an unpublished
 * mandatory language, an empty mandatory property — so the whole selection is
 * checked before any of it is written. Half a published branch is a state
 * nobody asked for and nobody can reason about.
 */
async function contentPublish(config: CromboloConfig, publishing: boolean): Promise<void> {
  const ref = positional[1]
  const verb = publishing ? 'publish' : 'unpublish'
  if (!ref) {
    console.error(`content ${verb} needs the page: a path or a uuid.`)
    process.exit(1)
  }
  const cultures = flagValues('--culture')
  const at = flagValue('--at')
  const until = flagValue('--until')
  const when = (value: string | undefined, what: string): Date | null => {
    if (value === undefined) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      console.error(`  ${what} "${value}" is not a date I can read; try 2026-10-01T09:00`)
      process.exit(1)
    }
    return date
  }
  const publishTime = when(at, '--at')
  const unpublishTime = when(until, '--until')

  const { db } = await bootstrapDatabase(config)
  try {
    const resolved = await resolveNodeRef(db, [ObjectTypes.Document], ref)
    if (!resolved.ok) {
      console.error(`  ${describeRefFailure(ref, resolved)}`)
      process.exit(1)
    }
    const state = await currentSchemaState(db)
    const docs = new DocumentRepository(db, {
      nodeState: { version: state.version, revision: state.revision },
      nodeId: config.nodeId,
    })
    // Parents before children, which is the order publishing has to happen in.
    const targets = [
      resolved.node,
      ...(flags.has('--descendants')
        ? await docs.nodes.descendants(resolved.node, [ObjectTypes.Document])
        : []),
    ]

    if (publishTime || unpublishTime) {
      // A schedule is a statement about the future, so today's blockers are not
      // the question: the background job checks them when the time comes.
      for (const node of targets) {
        await docs.setSchedule(node.key, [
          { culture: cultures[0] ?? null, publishTime, unpublishTime },
        ])
        console.log(
          `  scheduled ${node.text ?? node.key}${publishTime ? `  from ${publishTime.toISOString()}` : ''}${unpublishTime ? `  until ${unpublishTime.toISOString()}` : ''}`,
        )
      }
      return
    }

    if (publishing) {
      const blocked: Array<{ name: string; reasons: string[] }> = []
      // Everything in the selection counts as published for the check: the run
      // publishes parents first, so a child is not blocked by an ancestor this
      // very command is about to take live.
      const selection = new Set(targets.map((node) => node.id))
      for (const node of targets) {
        const reasons = await docs.publishBlockers(node.key, cultures, selection)
        if (reasons.length > 0) blocked.push({ name: node.text ?? node.key, reasons })
      }
      if (blocked.length > 0) {
        console.error(
          `  refused  ${blocked.length} of ${targets.length} page(s) cannot be published:`,
        )
        for (const entry of blocked) console.error(`    ${entry.name}  ${entry.reasons.join('; ')}`)
        console.error('  nothing was published')
        process.exit(1)
      }
    }

    for (const node of targets) {
      const result = publishing
        ? await docs.publish(node.key, cultures.length > 0 ? cultures : null)
        : await docs.unpublish(node.key, cultures.length > 0 ? cultures : null)
      if (!result) continue
      console.log(`  ${publishing ? 'published' : 'unpublished'} ${node.text ?? node.key}`)
    }
    console.log(
      `\n${targets.length} page(s) ${publishing ? 'published' : 'unpublished'}${cultures.length > 0 ? ` in ${cultures.join(', ')}` : ''}.`,
    )
  } finally {
    await db.close()
  }
}

async function contentRuns(config: CromboloConfig): Promise<void> {
  const limitIndex = rest.indexOf('--limit')
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : 20
  const { db } = await bootstrapDatabase(config)
  try {
    const runs = await new TransferRunRepository(db).recent(
      Number.isFinite(limit) && limit > 0 ? limit : 20,
    )
    if (runs.length === 0) return console.log('No content has been imported here.')
    for (const run of runs)
      console.log(
        `  ${run.startedAt.toISOString()}  ${run.direction.padEnd(6)} ${run.status.padEnd(8)} ` +
          `${run.id}  ${run.nodeCount} node(s)  bundle ${run.bundleId}` +
          `${run.appliedBy ? `  by ${run.appliedBy}` : ''}${run.bundleLabel ? `  (${run.bundleLabel})` : ''}`,
      )
  } finally {
    await db.close()
  }
}

/** `--resolve <key>=<choice>` or `--resolve <key>/<property>[@<culture>]=<choice>`, repeatable. */
function parseResolutions(): Record<string, NodeResolutions> {
  const parsed = parseResolveFlags(flagValues('--resolve'))
  if (parsed.problems.length > 0) {
    for (const problem of parsed.problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  return parsed.byNode
}

function printTransferFindings(check: TransferCheck): void {
  const byKind = { blocking: 0, person: 0, auto: 0 }
  for (const f of check.findings) byKind[f.kind] += 1
  const c = check.counts
  console.log(
    `  plan     ${c.create} new, ${c.update} updated, ${c.unchanged} unchanged, ${c.skip} skipped`,
  )
  console.log(
    `  findings ${byKind.blocking} blocking, ${byKind.person} need a person, ${byKind.auto} automatic`,
  )
  for (const f of check.findings) {
    console.log(`  [${f.kind.padEnd(8)}] ${f.message}`)
    // The handle is the CLI's to name; the dashboard offers the same answers as choices.
    if (f.code === 'local-edit' && f.propertyAlias)
      console.log(
        `             answer it as ${f.subjectKey}/${propertyHandle(f.propertyAlias, f.culture)}`,
      )
    for (const suggestion of resolutionsFor(f.code)) console.log(`             → ${suggestion}`)
    if (f.link) console.log(`             ${f.link}`)
  }
}

async function contentCheck(config: CromboloConfig): Promise<void> {
  const dir = positional[1]
  if (!dir) {
    console.error(
      'content check needs a bundle: a package directory, or the name of a bundle this site depends on.',
    )
    process.exit(1)
  }
  const result = await ops.contentCheck(config, {
    ...transferInput(dir),
    passphrase: await passphraseToOpen(dir, config),
  })
  for (const problem of result.problems) console.error(`  ${problem}`)
  describeBundle(result.bundle)
  if (result.under) console.log(`  under    ${result.under}`)
  printSections(result.sections)
  printTransferFindings(result.check)
  // The reasons are publish's own: the check rehearsed the import to find them.
  for (const refusal of result.publishRefusals)
    console.error(`  would not publish  ${refusal.key}: ${refusal.reason}`)

  if (flags.has('--save')) {
    const target = join(result.payloadDir, RESOLUTIONS_FILE)
    await writeFile(
      target,
      writeResolutions({
        bundleId: result.bundle.id,
        under: flagValue('--under') ?? null,
        all: result.decisions.all,
        byNode: result.decisions.byNode,
      }),
    )
    console.log(`  wrote    ${relative(cwd, target)}`)
  }

  if (!result.clean) {
    console.log(
      `\n${result.check.outstanding.length} finding(s) would stop an import. Resolve them, or pass --resolve.`,
    )
    process.exit(1)
  }
  console.log('\nNothing outstanding: this bundle would import cleanly.')
}

/**
 * What an export or an import does with property values and media files:
 * left out, sealed, or — when asked twice — in the open.
 */
function contentFlags(): { content: 'omitted' | 'sealed' | 'open' } {
  const include = flags.has('--include-content')
  const open = flags.has('--allow-content-unencrypted')
  if (open && !include) {
    console.error('--allow-content-unencrypted goes with --include-content.')
    process.exit(1)
  }
  if (flags.has('--with-blobs') && !include) {
    console.error('Media files are content: --with-blobs goes with --include-content.')
    process.exit(1)
  }
  if (open)
    console.error(
      '  warning  property values and media files are written unencrypted: anyone with the files can read any personal information in them',
    )
  return { content: !include ? 'omitted' : open ? 'open' : 'sealed' }
}

function describeContentMode(
  content: 'omitted' | 'sealed' | 'open',
  people?: { members: number; users: number },
): void {
  if (content === 'omitted')
    console.log(
      '  content  not included: pages are placed and named, and no value is written. Pass --include-content to bring the values and media files',
    )
  else if (content === 'sealed') console.log('  content  encrypted: importing needs the passphrase')
  else console.log('  content  unencrypted')
  if (people && people.members + people.users > 0)
    console.log(`  people   ${people.members} member(s), ${people.users} user(s), encrypted`)
}

async function contentExport(config: CromboloConfig): Promise<void> {
  const out = flagValue('--out')
  const refs = flagValues('--root')
  if (!out || refs.length === 0) {
    console.error('content export needs --root <path|uuid> (repeatable) and --out <dir>.')
    process.exit(1)
  }
  const content = contentFlags()
  const result = await ops.contentExport(config, {
    ...content,
    roots: refs,
    only: flags.has('--only'),
    drafts: flags.has('--drafts'),
    withBlobs: flags.has('--with-blobs'),
    withMembers: flags.has('--with-members'),
    withUsers: flags.has('--with-users'),
    passphrase:
      content.content === 'sealed' || flags.has('--with-members') || flags.has('--with-users')
        ? await passphraseToSeal()
        : undefined,
    withBlueprints: flags.has('--with-blueprints'),
    // An export is a private package; without --name it is named for its directory.
    package: {
      name: flagValue('--name') ?? packageNameFor(basename(resolve(out))),
      version: flagValue('--package-version'),
    },
  })
  for (const key of result.blobs.missing)
    console.error(`  missing  ${key} is not in this environment's media store`)
  for (const file of result.files) {
    const target = join(out, file.path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, file.bytes ?? (file.text as string))
  }
  const counts = Object.entries(result.counts)
  console.log(`  wrote    ${relative(cwd, out) || '.'}`)
  console.log(`  package  ${result.package.name}@${result.package.version} (private)`)
  console.log(
    `  bundle   ${result.bundleId} (${result.snapshot}): ${
      counts.length > 0 ? counts.map(([kind, n]) => `${n} ${kind}`).join(', ') : 'nothing selected'
    }`,
  )
  if (result.expected.length > 0) {
    console.log(`  expects  ${result.expected.length} node(s) to exist at the destination:`)
    for (const e of result.expected) console.log(`    ${e.key}  ${e.name}  (${e.why})`)
  }
  describeContentMode(result.content, result.people)
  if (result.blobs.carried > 0)
    console.log(
      `  blobs    ${result.blobs.carried} media file(s), ${describeBytes(result.blobs.bytes)}`,
    )
  else if (result.blobs.notCarried > 0)
    console.log(
      `  blobs    ${result.blobs.notCarried} media file(s) are not carried — pass --with-blobs to include them`,
    )
  if (counts.length === 0) process.exit(1)
}

/** `crombolo export --site`: the whole site as one file (story 104). */
async function exportCommand(): Promise<void> {
  if (!flags.has('--site')) {
    console.error(
      'export needs --site: the whole site, as one file. For a part of it, use content export.',
    )
    process.exit(1)
  }
  const config = await siteConfig()
  const withPeople = flags.has('--with-members') || flags.has('--with-users')
  const anonymise = flags.has('--anonymise')
  const out = resolve(
    flagValue('--out') ??
      `${packageNameFor(`${config.siteName}-site`)}-${new Date().toISOString().slice(0, 10)}.tgz`,
  )
  const result = await ops.siteExport(config, {
    out,
    media: !flags.has('--no-media'),
    drafts: flags.has('--drafts'),
    withMembers: flags.has('--with-members'),
    withUsers: flags.has('--with-users'),
    anonymise,
    passphrase:
      withPeople && !(anonymise && !flags.has('--with-members'))
        ? await passphraseToSeal()
        : undefined,
    package: { name: flagValue('--name'), version: flagValue('--package-version') },
  })
  const counts = Object.entries(result.counts)
  console.log(`  wrote    ${relative(cwd, result.out) || result.out}`)
  console.log(`  package  ${result.package.name}@${result.package.version} (private)`)
  console.log(
    `  content  ${counts.length > 0 ? counts.map(([kind, n]) => `${n} ${kind}`).join(', ') : 'none'}, unencrypted`,
  )
  const sections = Object.entries(result.sections)
  if (sections.length > 0)
    console.log(`  files    ${sections.map(([section, n]) => `${n} ${section}`).join(', ')}`)
  if (result.media.omitted)
    console.log(
      '  media    left out (--no-media): importing it brings the media items without their files',
    )
  else
    console.log(`  media    ${result.media.carried} file(s), ${describeBytes(result.media.bytes)}`)
  for (const key of result.media.missing)
    console.error(`  missing  ${key} is not in this environment's media store`)
  if (result.people.members + result.people.users > 0)
    console.log(
      `  people   ${result.people.members} member(s), ${result.people.users} user(s), encrypted`,
    )
  else console.log('  people   left out: pass --with-members or --with-users to bring them')
  if (result.anonymised !== undefined)
    console.log(
      `  anonymised  ${result.anonymised} email address(es) replaced; no back-office users`,
    )
}

/**
 * `schema-as-code.md` leaves the dictionary in the database, because
 * translators work in production where `schema/` is read-only — so this is how
 * a lower environment gets the translations.
 */
async function dictionary(): Promise<void> {
  const config = await siteConfig()
  const sub = positional[0]
  if (sub !== 'export' && sub !== 'import') return help()
  const { db } = await bootstrapDatabase(config)
  try {
    if (sub === 'export') {
      const out = flagValue('--out')
      if (!out) {
        console.error('dictionary export needs --out <file.udt>.')
        process.exit(1)
      }
      const items = await dictionaryToUdt(new DictionaryRepository(db), flagValue('--key'))
      if (items.length === 0) {
        console.error('Nothing to export: this site has no dictionary items.')
        process.exit(1)
      }
      await mkdir(join(out, '..'), { recursive: true })
      await writeFile(out, writeDictionaryUdt(items))
      const count = (list: typeof items): number =>
        list.reduce((total, item) => total + 1 + count(item.children), 0)
      console.log(`  wrote    ${relative(cwd, out)}`)
      console.log(`  items    ${count(items)}`)
      return
    }

    const file = positional[1]
    if (!file) {
      console.error('dictionary import needs the .udt file.')
      process.exit(1)
    }
    if (!existsSync(file)) {
      console.error(`No file at ${file}.`)
      process.exit(1)
    }
    const outcome = await importDictionaryUdt(db, await Bun.file(file).text(), null)
    if (!outcome.ok) {
      console.error(`  refused: ${outcome.reason}`)
      process.exit(1)
    }
    console.log(`  imported ${outcome.imported} item(s)`)
    // Umbraco's own behaviour, and worth saying out loud rather than dropping
    // translations silently: a language this site has not got is skipped.
    if (outcome.skipped.length > 0)
      console.log(
        `  skipped  translations for ${outcome.skipped.join(', ')} — no such language here`,
      )
  } finally {
    await db.close()
  }
}

/**
 * `crombolo domains`: which hostnames reach which page.
 *
 * `domains.toml` is the truth and the database follows it, so `set` and `clear`
 * write the file and then apply it — one command, rather than an edit here and
 * a deploy to make it real. The file is committed; `${VAR}` in a host is read
 * from the environment when it is applied, so one file serves every
 * environment.
 */
async function domains(): Promise<void> {
  const config = await siteConfig()
  const sub = positional[0] ?? 'list'
  if (sub !== 'list' && sub !== 'apply' && sub !== 'set' && sub !== 'clear' && sub !== 'undo')
    return help()

  const file = domainsFilePath(config.siteDir)
  const read = readDomainsFile(config.siteDir)
  const declarations = read?.declarations ?? []
  for (const problem of read?.problems ?? []) console.error(`  ${file}: ${problem}`)

  if (sub === 'list') {
    const { db } = await bootstrapDatabase(config)
    try {
      if (!read) console.log(`No ${DOMAINS_FILE}; nothing is deployed from a file here.`)
      for (const declaration of declarations) {
        const resolved = resolvePlaceholders(declaration.host)
        const culture = declaration.culture ? `  ${declaration.culture}` : ''
        // What the file says, and what it comes to here, which is the whole
        // point of a placeholder and the first thing to check when one is wrong.
        const here =
          resolved.missing.length > 0
            ? `  (${resolved.missing.join(', ')} not set here)`
            : resolved.value !== declaration.host
              ? ` → ${resolved.value}`
              : ''
        console.log(
          `  file     ${declaration.node.padEnd(24)} ${declaration.host}${here}${culture}`,
        )
      }
      // What the database actually answers on, which is the thing a person is
      // usually asking about when a hostname is not working.
      const nodes = new NodeRepository(db)
      for (const row of await new DomainRepository(db).all()) {
        const node = await nodes.byId(row.nodeId)
        console.log(
          `  bound    ${(node?.text ?? String(row.nodeId)).padEnd(24)} ${row.domainName}${row.isoCode ? `  ${row.isoCode}` : ''}`,
        )
      }
    } finally {
      await db.close()
    }
    return
  }

  if (sub === 'apply') return applyDomains(config)

  if (sub === 'undo') {
    const undone = await undoDomainsFile(config.siteDir)
    if (!undone.ok) {
      console.error(`  ${undone.message}`)
      process.exit(1)
    }
    console.log(`  restored ${relative(cwd, undone.file)}`)
    return applyDomains(config)
  }

  const ref = positional[1]
  if (!ref) {
    console.error(`domains ${sub} needs the page: a path, a uuid, or / for the root page.`)
    process.exit(1)
  }

  // Stating a node's hostnames says what they are, as the backoffice's dialog
  // does: whatever that page had is replaced, so running this twice is the same
  // as running it once. Which entries belong to that page is decided by
  // resolving them, not by matching the text — `/` and `/Home` can be the same
  // page, and clearing one while the other stayed would do nothing at all.
  const { db: resolving } = await bootstrapDatabase(config)
  let kept: DomainDeclaration[] = []
  try {
    const target = await resolveDomainNode(resolving, ref)
    if (!target.ok) {
      console.error(`  ${target.message}`)
      process.exit(1)
    }
    kept = await withoutNode(resolving, declarations, target.node)
  } finally {
    await resolving.close()
  }
  const defaultCulture = flagValue('--default-culture')
  const next: DomainDeclaration[] = [...kept]
  if (sub === 'set') {
    const hosts = flagValues('--host')
    if (hosts.length === 0 && !defaultCulture) {
      console.error('domains set needs --host <host>[=<culture>], or --default-culture <iso>.')
      process.exit(1)
    }
    if (hosts.length === 0 && defaultCulture) next.push({ node: ref, host: '', defaultCulture })
    for (const [index, entry] of hosts.entries()) {
      const [host = '', culture] = entry.split('=')
      next.push({
        node: ref,
        host,
        culture,
        // The node's own fallback culture belongs to the node, so it is written
        // once rather than repeated on every hostname.
        defaultCulture: index === 0 ? defaultCulture : undefined,
      })
    }
  }

  const written = await writeDomains(config.siteDir, next)
  console.log(
    `  wrote    ${relative(cwd, written.file)}${written.backup ? '  (previous kept; `crombolo domains undo` puts it back)' : ''}`,
  )
  return applyDomains(config)
}

/** Applies the file as a boot would, and reports what it did. */
async function applyDomains(config: CromboloConfig): Promise<void> {
  const { db } = await bootstrapDatabase(config)
  try {
    const report = await syncDomainsFile(db, config.siteDir)
    for (const problem of report.problems) console.error(`  ${problem}`)
    for (const applied of report.applied)
      console.log(
        `  applied  ${applied.node.padEnd(24)} ${applied.host}${applied.culture ? `  ${applied.culture}` : ''}`,
      )
    if (report.removed > 0) console.log(`  removed  ${report.removed} binding(s)`)
    if (report.problems.length > 0) process.exit(1)
  } finally {
    await db.close()
  }
}

/**
 * `crombolo import <file>`: replace this site with a whole-site file (story
 * 105). It always says first what would be replaced, and changes nothing
 * without `--replace` or `--replace-all`.
 */
async function importFile(file: string): Promise<void> {
  const config = await siteConfig()
  const replace: ops.ReplaceMode | undefined = flags.has('--replace-all')
    ? 'replace-all'
    : flags.has('--replace')
      ? 'replace'
      : undefined
  const dir = await ops.unpackBundle(file, config.siteDir)
  let carriesPeople = false
  try {
    carriesPeople = ops.readBundle(dir, config.siteDir).set.manifest.people !== undefined
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const passphrase = carriesPeople
    ? (process.env[PASSPHRASE_ENV] ??
      (process.stdin.isTTY ? await readSecret('  Passphrase for its people: ') : undefined))
    : await passphraseToOpen(dir, config)
  const allowMissingBlobs = flags.has('--allow-missing-media')

  const { check, summary } = await ops.siteReplaceCheck(config, {
    bundle: dir,
    passphrase,
    replace: replace ?? 'replace',
    allowMissingBlobs,
  })
  describeBundle(check.bundle)
  const c = check.check.counts
  console.log(`  brings   ${c.create} new, ${c.update} changed, ${c.unchanged} unchanged`)
  const leaving = Object.entries(summary.leaving)
  const fate = replace === 'replace-all' ? 'deleted' : 'recycled'
  if (leaving.length > 0)
    console.log(
      `  ${fate.padEnd(8)} ${leaving.map(([kind, n]) => `${n} ${kind}`).join(', ')} not in the file`,
    )
  if (summary.filesRemoved.length > 0) {
    console.log(
      `  removes  ${summary.filesRemoved.length} file(s) not in the file, kept for a revert:`,
    )
    for (const path of summary.filesRemoved.slice(0, 20)) console.log(`    ${relative(cwd, path)}`)
    if (summary.filesRemoved.length > 20)
      console.log(`    … and ${summary.filesRemoved.length - 20} more`)
  }
  if (replace === 'replace-all' && summary.people.members + summary.people.users > 0)
    console.log(
      `  deletes  ${summary.people.members} member(s) and ${summary.people.users} user(s) not in the file`,
    )
  console.log("  keeps    domains, the secret key and this environment's settings")
  for (const problem of check.problems) console.error(`  ${problem}`)

  if (!replace) {
    console.error(
      '\nNothing was changed. Pass --replace to replace this site (what it loses is recycled, people kept), or --replace-all to make it exactly the file (deleted, people too).',
    )
    process.exit(1)
  }
  if (replace === 'replace-all' && !flags.has('--yes')) {
    if (!process.stdin.isTTY) {
      console.error(
        '\n--replace-all deletes what the file does not have: pass --yes to confirm it.',
      )
      process.exit(1)
    }
    const answer = prompt(
      `  This deletes for good. Type the site's name (${config.siteName}) to go on:`,
    )
    if (answer?.trim() !== config.siteName) {
      console.error('  Nothing was changed.')
      process.exit(1)
    }
  }

  const result = await ops.contentImport(config, {
    bundle: dir,
    passphrase,
    replace,
    allowMissingBlobs,
    label: `${replace} from ${basename(file)}`,
    backupTaken: flags.has('--backup-taken'),
  })
  for (const problem of result.problems) console.error(`  ${problem}`)
  if (result.backup.path) console.log(`  backup   ${result.backup.path}`)
  if (!result.runId) {
    printTransferFindings(result.check)
    console.error('\nreplace refused. Nothing was changed.')
    process.exit(1)
  }
  const counts = result.check.counts
  console.log(`  run      ${result.runId}`)
  console.log(
    `  applied  ${counts.create} created, ${counts.update} updated, ${counts.unchanged} unchanged`,
  )
  const placed = describePlaced(result.blobs)
  if (placed) console.log(`  media    ${placed}`)
  if (result.sections?.schema) console.log(`  schema   ${result.sections.schema.action}`)
  if (result.published > 0) console.log(`  published ${result.published} page(s)`)
  for (const failure of result.publishFailures)
    console.error(`  not published  ${failure.key}: ${failure.reason}`)
  console.log(
    replace === 'replace-all'
      ? `\nDone. \`crombolo content revert ${result.runId}\` puts the files and the pages it changed back; what was deleted is in the backup.`
      : `\nDone. \`crombolo content revert ${result.runId}\` puts it back.`,
  )
}

/**
 * `crombolo import umbraco`: a compatibility report for an Umbraco backup, and
 * then a crombolo site written from it.
 *
 * Neither subcommand touches a database. `report` reads the backup and prints
 * what will and will not come across; `apply` writes a site directory — schema
 * files, view stubs, a content bundle — whose `start` script does the import
 * through `start --bundle`, the path every other bundle takes.
 *
 * The importer is a package of its own, loaded here on demand, so a site that
 * never imports anything does not carry it or the `.bacpac` reader it needs.
 */
async function importSite(): Promise<void> {
  const VALUE_FLAGS = new Set(['--out', '--site', '--media', '--name', '--staging'])
  const args: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (VALUE_FLAGS.has(arg)) i++
    else if (!arg.startsWith('--')) args.push(arg)
  }
  const [kind, sub, backup] = args
  if (kind && kind !== 'umbraco') return importFile(kind)
  if (kind !== 'umbraco' || (sub !== 'report' && sub !== 'apply')) return help()
  // Not into --json output, which a machine reads.
  if (!flags.has('--json'))
    console.error(
      '  deprecated  `crombolo import umbraco` is going away: an Umbraco extension will write a crombolo file that `crombolo import <file>` reads (story 074)',
    )
  if (!backup) {
    console.error(`import umbraco ${sub} needs the backup: a .bacpac, or Umbraco's SQLite file.`)
    process.exit(1)
  }
  const out = flagValue('--out')
  if (sub === 'apply' && !out) {
    console.error('import umbraco apply needs --out <dir>: the site directory to write.')
    process.exit(1)
  }

  let importer: typeof import('@crombolo/import-umbraco')
  try {
    importer = await import('@crombolo/import-umbraco')
  } catch {
    console.error(
      'The importer is a separate package. Add it, then run this again:\n\n  bun add -d @crombolo/import-umbraco',
    )
    process.exit(1)
  }

  const { content } = sub === 'apply' ? contentFlags() : { content: 'omitted' as const }
  const withMembers = flags.has('--with-members')
  const withUsers = flags.has('--with-users')
  const sealing = content === 'sealed' || withMembers || withUsers
  // A report writes no bundle, so what it would seal with is never kept.
  const passphrase = !sealing
    ? undefined
    : sub === 'apply'
      ? await passphraseToSeal()
      : crypto.randomUUID()
  let plan: Awaited<ReturnType<typeof importer.planImport>>
  try {
    plan = await importer.planImport({
      source: backup,
      site: flagValue('--site'),
      media: flagValue('--media'),
      siteName: flagValue('--name'),
      drafts: flags.has('--drafts'),
      staging: flagValue('--staging'),
      coreVersion: VERSION,
      content: sub === 'apply' ? content : flags.has('--include-content') ? 'open' : 'omitted',
      withMembers,
      withUsers,
      passphrase,
    })
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
  const { report } = plan

  if (sub === 'report') {
    if (flags.has('--json')) console.log(importer.reportJson(report).trimEnd())
    else for (const line of importer.reportSummary(report)) console.log(`  ${line}`)
    if (out) {
      await mkdir(out, { recursive: true })
      await writeFile(join(out, 'report.md'), importer.reportMarkdown(report))
      await writeFile(join(out, 'report.json'), importer.reportJson(report))
      if (!flags.has('--json')) console.log(`\n  wrote    ${relative(cwd, join(out, 'report.md'))}`)
    }
    if (!report.ready) process.exit(1)
    return
  }

  const target = out as string
  if (!report.ready) {
    for (const finding of report.findings.filter((f) => f.class === 'blocking'))
      console.error(
        `  blocked  ${finding.title}${finding.detail ? `\n           ${finding.detail}` : ''}`,
      )
    console.error('\nNothing was written.')
    process.exit(1)
  }
  if (
    existsSync(target) &&
    (await Array.fromAsync(new Bun.Glob('*').scan({ cwd: target, onlyFiles: false, dot: true })))
      .length > 0 &&
    !flags.has('--force')
  ) {
    console.error(
      `${target} is not empty. Choose a new directory, or pass --force to write into it.`,
    )
    process.exit(1)
  }

  const files = new Map<string, { text?: string; bytes?: Uint8Array; copyFrom?: string }>()
  const scaffold = scaffoldFiles({
    siteName: plan.siteName,
    postgres: flags.has('--postgres'),
    bundle: {
      path: importer.IMPORT_BUNDLE,
      // A media item whose file was not in the backup is reported, not refused.
      flags: plan.missingMedia > 0 ? ['--allow-missing-blobs'] : [],
    },
  })
  for (const file of scaffold) files.set(file.path, file)
  // The importer's files win: the source site's media types replace the defaults.
  for (const file of plan.files) files.set(file.path, file)
  if (plan.dictionary.length > 0)
    files.set(`${importer.IMPORT_DIR}/dictionary.udt`, { text: writeUdtAll(plan.dictionary) })
  if (plan.domains.length > 0)
    files.set(`${importer.IMPORT_DIR}/domains.toml`, { text: writeDomainsFile(plan.domains) })

  for (const [path, file] of files) {
    const destination = join(target, path)
    await mkdir(join(destination, '..'), { recursive: true })
    if (file.copyFrom !== undefined) await Bun.write(destination, Bun.file(file.copyFrom))
    else await Bun.write(destination, file.bytes ?? file.text ?? '')
  }

  for (const line of importer.reportSummary(report)) console.log(`  ${line}`)
  console.log(`\n  wrote    ${files.size} files to ${relative(cwd, target) || '.'}`)
  console.log(`  report   ${relative(cwd, join(target, importer.IMPORT_DIR, 'report.md'))}`)
  console.log(`\nNext:\n  cd ${relative(cwd, target) || '.'}\n  bun install\n  bun start`)
  console.log(
    `\n\`bun start\` imports ${importer.IMPORT_BUNDLE} on the first boot of an empty database.`,
  )
  if (sealing)
    console.log(
      `It is encrypted: \`bun start\` asks for the passphrase, or reads ${PASSPHRASE_ENV}.`,
    )
  if (content === 'omitted')
    console.log(
      'Pages and media were brought without what they hold. Run again with --include-content to bring it.',
    )
  if (plan.dictionary.length > 0)
    console.log(`Then: crombolo dictionary import ${importer.IMPORT_DIR}/dictionary.udt`)
}

/**
 * `crombolo views`: what is on disk, whether it compiles, and a new one.
 *
 * A view is loaded when a request renders it, so one that does not compile is a
 * 500 waiting for a visitor. `components check` is that failure brought forward.
 */
async function components(): Promise<void> {
  const config = await siteConfig()
  const sub = positional[0] ?? 'check'
  if (sub !== 'check' && sub !== 'list' && sub !== 'new') return help()

  const loaded = existsSync(config.schemaDir)
    ? loadSchemaDirectory(config.schemaDir, { formTypes: formTypesFor(config) })
    : undefined
  const types = loaded?.set.contentTypes ?? []

  if (sub === 'list') {
    const found = listComponents(config.componentsDir)
    if (found.length === 0) console.log(`Nothing in ${relative(cwd, config.componentsDir) || '.'}.`)
    for (const component of found) {
      // A component is a template because a content type names it, not
      // because of where it sits — so the label is read off the schema.
      const declaredBy = types
        .filter((type) => type.components.includes(component.alias))
        .map((type) => type.alias)
      const kind = declaredBy.length > 0 ? 'template' : 'component'
      const note = declaredBy.length > 0 ? `  ← ${declaredBy.join(', ')}` : ''
      console.log(`  ${kind.padEnd(9)} ${relative(cwd, component.path)}${note}`)
    }
    return
  }

  if (sub === 'new') {
    const alias = positional[1]
    if (!alias) {
      console.error('components new needs a name: `crombolo components new pages/article`.')
      process.exit(1)
    }
    if (!isSafeAlias(alias)) {
      console.error(`"${alias}" is not a path inside ${relative(cwd, config.componentsDir)}.`)
      process.exit(1)
    }
    const file = componentFileFor(config.componentsDir, alias)
    if (existsSync(file)) {
      console.error(`${relative(cwd, file)} already exists.`)
      process.exit(1)
    }
    // A content type that names this alias gets the page scaffold, which takes
    // PageProps; anything else gets the plain one. Nothing turns on the folder.
    const type = types.find((candidate) => candidate.components.includes(alias))
    if (!type)
      console.log(
        `  note     no content type declares the template "${alias}" — add it to one's templates, or \`crombolo schema new\``,
      )
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, type ? viewScaffold(type) : componentScaffold(alias))
    console.log(`  created  ${relative(cwd, file)}`)
    return
  }

  const report = await checkComponents({
    componentsDir: config.componentsDir,
    siteDir: config.siteDir,
    declaredComponents: types.flatMap((type) => type.components),
  })
  const templates = report.declared.length
  console.log(
    `  checked  ${report.components.length} file(s): ${templates} template(s), ` +
      `${report.components.length - templates} component(s)`,
  )
  for (const problem of report.problems)
    console.error(`  [error]  ${problem.file}: ${problem.message}`)
  if (report.types.note) console.log(`  types    ${report.types.note}`)
  else {
    console.log(`  types    tsc --noEmit over ${relative(cwd, config.siteDir) || '.'}`)
    for (const problem of report.types.problems) console.error(`  [types]  ${problem}`)
  }
  if (report.problems.length > 0 || report.types.problems.length > 0) process.exit(1)
}

/** `crombolo assets`: the stylesheets and scripts the backoffice also edits. */
async function assets(): Promise<void> {
  const config = await siteConfig()
  const sub = positional[0] ?? 'list'
  if (sub !== 'list' && sub !== 'new') return help()

  if (sub === 'list') {
    const found = listAssets(config)
    if (found.length === 0) console.log('No stylesheets or scripts here.')
    for (const asset of found)
      console.log(`  ${asset.kind.padEnd(10)} ${relative(cwd, asset.path)}`)
    return
  }

  const kind = positional[1]
  const name = positional[2]
  if ((kind !== 'stylesheet' && kind !== 'script') || !name) {
    console.error('assets new needs a kind and a name: `crombolo assets new stylesheet site.css`.')
    process.exit(1)
  }
  const where = assetDirs(config)[kind]
  const file = join(where.dir, name.endsWith(where.extension) ? name : `${name}${where.extension}`)
  if (existsSync(file)) {
    console.error(`${relative(cwd, file)} already exists.`)
    process.exit(1)
  }
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, assetScaffold(kind, relative(where.dir, file)))
  console.log(`  created  ${relative(cwd, file)}`)
}

function parseSet(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--set') continue
    const pair = rest[i + 1] ?? ''
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const raw = pair.slice(eq + 1)
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {}
    out[pair.slice(0, eq)] = value
  }
  return out
}

function printFindings(report: { classification: string; findings: Finding[] }): void {
  const byKind = { blocking: 0, person: 0, auto: 0 }
  for (const f of report.findings) byKind[f.kind] += 1
  console.log(
    `change: ${report.classification}; findings: ${byKind.blocking} blocking, ${byKind.person} need a person, ${byKind.auto} automatic`,
  )
  for (const f of report.findings) {
    const where = f.link ? `  ${f.link}` : ''
    console.log(`  [${f.kind.padEnd(8)}] ${f.message}${where}`)
  }
}

async function upgrade(): Promise<void> {
  const config = await siteConfig()
  switch (positional[0]) {
    case 'ledger': {
      const db = await connect({ file: config.sqliteFile })
      try {
        for (const row of await readLedger(db))
          console.log(
            `  ${row.appliedAt}  ${row.kind.padEnd(8)} ${row.bundle ? `[${row.bundle}] ` : ''}${row.name}  ${row.durationMs}ms${row.appliedBy ? `  by ${row.appliedBy}` : ''}${row.note ? `  (${row.note})` : ''}`,
          )
      } finally {
        await db.close()
      }
      return
    }
    case 'check': {
      if (!flags.has('--fix')) {
        const report = await ops.upgradeCheck(config, { set: parseSet() })
        for (const bundle of report.bundles)
          if (bundle.pending.length > 0)
            console.log(
              `  bundle   ${bundle.id}: ${bundle.pending.map((step) => `${step.name} (${step.kind})`).join(', ')}`,
            )
        printFindings(report)
        if (!report.siteChecked)
          console.log(
            'The site schema is checked once the framework migrations have run (`crombolo upgrade`).',
          )
        if (report.blocking) process.exit(1)
        return
      }
      const fix = await ops.upgradeFix(config, {
        set: parseSet(),
        backupTaken: flags.has('--backup-taken'),
      })
      if (fix.backup.path) console.log(`  backup   ${fix.backup.path}`)
      console.log(
        `  sync     ${fix.sync.action}${fix.sync.deferred.length > 0 ? ` (deferred to the cut-over: ${fix.sync.deferred.join(', ')})` : ''}`,
      )
      for (const name of fix.applied) console.log(`  applied  ${name}`)
      if (fix.skipped > 0)
        console.log(`  skipped  ${fix.skipped} value(s) a converter refused; see the findings`)
      printFindings(fix)
      return
    }
    case 'schema': {
      positional[0] = 'rewrite'
      return schema()
    }
    case undefined: {
      if (flags.has('--plan')) {
        const plan = await ops.upgradePlan(config)
        if (plan.steps.length === 0) console.log('No framework migration is pending.')
        const printStep = (step: ops.PlannedStepResult, indent = '') => {
          console.log(
            `\n${indent}== ${step.name} (${step.kind}${step.release ? `, release ${step.release}` : ''})`,
          )
          if (step.unplannable) console.log(`${indent}  unplannable: ${step.unplannable}`)
          for (const sql of step.statements) console.log(`${indent}  ${sql};`)
        }
        for (const step of plan.steps) printStep(step)
        // After core's, in the order `bundles` lists them, because that is the order they run.
        for (const bundle of plan.bundles) {
          console.log(
            `\nbundle ${bundle.id} (${bundle.name}): ${bundle.steps.length === 0 ? 'nothing pending' : `${bundle.steps.length} step(s)`}`,
          )
          for (const step of bundle.steps) printStep(step, '  ')
        }
        console.log(
          plan.site.checked
            ? `\nsite schema: ${plan.site.action} (${plan.site.classification})`
            : '\nsite schema: checked once the framework migrations have run',
        )
        return
      }
      const forceIndex = rest.indexOf('--force')
      const result = await ops.upgradeRun(config, {
        force: forceIndex >= 0 ? rest[forceIndex + 1] : undefined,
        set: parseSet(),
        backupTaken: flags.has('--backup-taken'),
      })
      if (result.backup.path) console.log(`  backup   ${result.backup.path}`)
      if (result.action === 'refused') {
        console.error(`upgrade refused: ${result.reasons.length} outstanding finding(s)`)
        for (const f of result.reasons)
          console.error(`  [${f.kind.padEnd(8)}] ${f.message}${f.link ? `  ${f.link}` : ''}`)
        console.error(
          'Run `crombolo upgrade check --fix`, resolve what needs a person, and try again.',
        )
        process.exit(1)
      }
      if (result.action === 'nothing')
        return console.log('Nothing to upgrade: the database is at this version.')
      for (const name of result.frameworkApplied) console.log(`  applied  ${name}`)
      for (const bundle of result.bundlesApplied)
        for (const name of bundle.applied) console.log(`  applied  [${bundle.id}] ${name}`)
      console.log(
        `  schema   ${result.schema?.action} ${result.schema?.version ?? ''}+${result.schema?.revision ?? ''}`,
      )
      return
    }
    default:
      return help()
  }
}

/**
 * `bundle purge <id>`: drops a bundle's tables and forgets its state. Taking a
 * bundle out of `bundles` leaves them in place, so re-adding it resumes; this is
 * the deliberate act that does not.
 */
async function bundlePurge(): Promise<void> {
  const config = await siteConfig()
  const id = positional[1]
  if (!id) {
    console.error('bundle purge needs the bundle id.')
    process.exit(1)
  }
  const plan = await ops.bundlePurgePlan(config, id)
  if (plan.tables.length === 0) console.log(`  The bundle "${id}" has no tables in this database.`)
  else {
    console.log(`  This drops ${plan.tables.length} table(s), and every row in them:`)
    for (const table of plan.tables) console.log(`    ${table}`)
  }
  if (!flags.has('--yes')) {
    const answer = prompt(`  Purge the bundle "${id}"? Type its id to confirm:`)
    if (answer?.trim() !== id) {
      console.log('  Nothing was dropped.')
      process.exit(1)
    }
  }
  const result = await ops.bundlePurge(config, id, { backupTaken: flags.has('--backup-taken') })
  if (result.backup.path) console.log(`  backup   ${result.backup.path}`)
  for (const table of result.dropped) console.log(`  dropped  ${table}`)
  console.log(`  The bundle "${id}"'s state is cleared; adding it again starts its tables afresh.`)
}

/**
 * `maintenance`: the cluster-wide pause on editing that a restore or a swap
 * needs. It is a database flag, so it reaches every node on its next write.
 */
async function maintenance(): Promise<void> {
  const config = await siteConfig()
  switch (positional[0]) {
    case 'pause': {
      const paused = await ops.pauseEditing(config, { reason: flagValue('--reason') })
      console.log(`Editing paused${paused.reason ? `: ${paused.reason}` : ''}.`)
      return
    }
    case 'resume':
      await ops.resumeEditing(config)
      console.log('Editing resumed.')
      return
    case 'status': {
      const paused = await ops.editingPaused(config)
      if (flags.has('--json')) {
        console.log(JSON.stringify({ paused: paused ?? null }, null, 2))
        return
      }
      console.log(
        paused
          ? `Editing paused since ${paused.at}${paused.by ? ` by ${paused.by}` : ''}${paused.reason ? `: ${paused.reason}` : ''}.`
          : 'Editing is not paused.',
      )
      return
    }
    default:
      return help()
  }
}

function help(): void {
  console.log(`crombolo <command>

  start [--keep-admin]        boot the site in the current directory
        [--bundle <pkg>]      apply a bundle's content first, once per bundle, then serve;
                              takes the \`content import\` flags (--publish, --under, …)
        [--from <file>]       in an empty folder: scaffold a site, install it, import a
                              whole-site file (crombolo export --site) and serve it; the
                              new administrator's password is printed once
                              [--postgres] [--name <site name>] [--no-install]
  init [--force] [--name <site name>] [--postgres] [--template <id>]
                              scaffold a site here; --template list prints the
                              starter templates, which bring schema, views and content
  status [--json]             what this environment resolved to, and what is wrong with
                              it; non-zero when something would stop the site working
  admin reset-password [pw]   reset the administrator's password
  schema check [--static]     validate schema/ and report what a sync would do
  schema sync [--force-retire-types]
                              apply schema/ to the database
  schema export               write the database's definitions as schema/ files
  schema rewrite              rewrite every schema/ file canonically
  schema new <content-type|media-type|member-type> <alias>
                              write the type file, with keys, and the view it points at
                              [--name <name>] [--description <text>] [--icon <icon>]
                              [--at-root] [--element] [--tab <tab>] [--no-view]
  schema add-property <type> <alias> --type <data type>
                              append a property to that type and apply it
                              [--name <name>] [--mandatory] [--tab <tab>] [--dry-run]
  schema purge --older-than N delete properties retired more than N days ago, with their values
  generate                    schema/content-types.d.ts from schema/
  components check            compile every component, and report one a type declares with no file
  components list             what is in components/, and which type declares each
  components new <alias>      components/<alias>.tsx; the alias may carry folders
  assets list                 the stylesheets and scripts this site has
  assets new <stylesheet|script> <name>
                              write an empty one in the place the backoffice edits
  export --site [--out <file.tgz>]
                              the whole site in one file: schema, components, styles,
                              scripts, dictionary, every page and media item and their
                              files. Domains and people stay behind
                              [--no-media] [--drafts] [--with-members] [--with-users]
                              [--anonymise] replaces every personal value as it writes
  content export --root <path|uuid> --out <dir>
                              write a private bundle package: the subtree, its
                              dependencies and what the destination must already have
                              [--only] [--drafts] [--with-blueprints]
                              [--name <npm name>] [--package-version <version>]
                              Names and the tree only, unless [--include-content]:
                              values, media files [--with-blobs] and protected-page
                              usernames, encrypted under a passphrase (prompted, or
                              CROMBOLO_BUNDLE_PASSPHRASE); [--allow-content-unencrypted]
                              writes them readable. [--with-members] [--with-users]
                              add people, always encrypted
  A bundle is an npm package. <pkg> is its directory, or the name of one this
  site depends on.
  content check <pkg>         what installing its content here would do, and what it
                              needs from a person first; writes to the Changes dashboard
                              [--under <path|uuid>] [--resolve <key>=take-bundle|keep-local|skip]
                              [--resolve <key>/<property>[@<culture>]=take-bundle|keep-local]
                              [--resolve-all <choice>] [--allow-missing-blobs] [--save]
                              [--publish: also say which pages the import would not publish]
                              An encrypted bundle asks for its passphrase, or reads
                              CROMBOLO_BUNDLE_PASSPHRASE
  content import <pkg>        re-check, back up, then apply: documents and elements
                              arrive as drafts, media is live. One transaction, so a
                              failure leaves nothing behind
                              [--publish] [--label <text>] [--backup-taken] + the check flags
                              [--no-schema] [--no-files] decline a section it carries
                              [--replace-files] allow replacing files this site has;
                              refused without it, and the originals are kept for a revert
  bundle check <pkg>          the same as content check
  bundle install <pkg>        the same as content import; a bundle carrying its own
                              schema and views installs into a site that has neither
  content runs [--limit N]    the imports applied here, newest first
  content publish <path|uuid> take it live; --descendants for the branch below it,
                              --culture <iso> per culture, --at/--until to schedule
  content unpublish <path|uuid>
                              take it down; the same flags
  content revert <run-id>     put an import back: values and published state restored,
                              nodes it created unpublished and recycled. Itself a run,
                              so it can be reverted in turn
                              [--resolve <key>=discard|skip] [--resolve-all <choice>]
                              [--force] [--backup-taken]
  dictionary export --out <file.udt> [--key <uuid>]
                              the dictionary as Umbraco's .udt, to seed another environment
  dictionary import <file.udt>
                              apply one: items upsert by key, and a translation for a
                              language this site has not got is skipped
  domains                     the hostnames domains.toml declares and what is bound here
  domains set <path|uuid|/> --host <host>[=<culture>] [--host ...] [--default-culture <iso>]
                              write domains.toml and apply it; the page's hostnames are
                              replaced, and \${VAR} in a host is read from the environment
  domains clear <path|uuid|/> unbind that page, in the file and in the database
  domains apply               apply domains.toml here, as a boot does
  domains undo                put back the file the last write replaced, and apply it
  remote add <name> <url> [--env <id>]
                              a remote this site pulls from and pushes to, kept in
                              remotes.toml (URLs only; sign-ins are in your keychain)
  remote list | remove <name>
  login [<remote>]            sign in with a code you approve in the remote's back office
  logout [<remote>] | whoami [<remote>]
  pull [<remote>] [--env <id>] [--full] [--yes]
                              a copy of the environment, sealed and anonymised unless
                              --full: started here in an empty folder, or replacing this
                              site (what it loses is recycled; --yes skips the question)
                              [--no-media] [--media-info-only] fetches media files one at a
                              time, only what changed since the last pull; [--lazy-media]
                              fetches each the first time it is asked for
  push [<remote>] [--env <id>] [--force] [--auto-approve] [--media-info-only]
                              replace the environment with this site; shows what it would
                              replace first. A protected one needs --force and its name
                              typed back (--auto-approve skips that); the remote may also
                              hold it for someone else's approval
                              exit 0 done, 1 refused or failed, 2 refused before sending,
                              3 gave up waiting
  media fetch                 a lazily pulled site's media files, all of them now
  import <file> [--replace | --replace-all]
                              replace this site with a whole-site file. Says first what
                              would be replaced, and changes nothing without a mode:
                              --replace recycles content and media the file lacks and
                              keeps this site's people; --replace-all deletes them, and
                              people the file lacks (typed confirmation, or --yes).
                              Domains, the secret key and settings always stay.
                              Undone with \`content revert <run>\`
                              [--allow-missing-media] [--backup-taken]
  import umbraco report <backup> [--site <dir>] [--media <dir>] [--out <dir>] [--json]
                              read-only: what importing an Umbraco backup would bring,
                              and what it would not — packages, Razor, custom code.
                              <backup> is a .bacpac or Umbraco's SQLite file; --site is
                              the site's files, for its views, media and plugins.
                              Non-zero when something blocks the import
  import umbraco apply <backup> --out <dir> [--site <dir>] [--media <dir>]
                              write a crombolo site: schema, view stubs, media and a
                              content bundle that \`bun start\` imports on first boot
                              [--name <site name>] [--drafts] [--postgres] [--force]
                              [--include-content] [--allow-content-unencrypted]
                              [--with-members] [--with-users], as content export
  upgrade check [--set t.p=v] what the deployed schema/ would do to this database's data
  upgrade check --fix         back up; apply the additive part and every conversion early
  upgrade [--force <reason>]  re-check, back up, apply framework steps, cut over, ledger
  upgrade --plan              the DDL pending framework migrations would run
  upgrade ledger              print migration_history
  bundle purge <id> [--yes]   back up, then drop a bundle's tables and clear its state;
                              refused while crombolo.config.ts still wires it
  maintenance pause [--reason <text>]
                              refuse every editor's save, on every node, until resumed;
                              readers are unaffected and no node drains
  maintenance resume          let editors save again
  maintenance status [--json] whether editing is paused, by whom and why
  (Postgres: --backup-taken or CROMBOLO_PG_DUMP before anything that writes)`)
}

try {
  // Before dispatching, which rewrites `bundle install` as `content import`.
  const audited = commandAudit()
  await dispatch()
  if (audited) await ops.recordCommand(await siteConfig(), audited)
} catch (error) {
  // These already say what happened and what to do; a stack trace would bury it.
  if (error instanceof MigrationStepError || error instanceof UpgradeStateError) {
    console.error(error.message)
    process.exit(1)
  }
  if (!(error instanceof ops.CommandError)) throw error
  for (const problem of error.problems) console.error(`  ${problem}`)
  console.error(error.message)
  process.exit(1)
}

// A declaration, not a const: the top-level dispatch above runs before this line.
function capital(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`
}

/** The audit log entry for a command that changes the environment; undefined for one that only reads. */
function commandAudit(): ops.CommandAudit | undefined {
  if (flags.has('--dry-run') || flags.has('--plan') || flags.has('--help')) return undefined
  const sub = positional[0]
  const typed = `crombolo ${command}${sub ? ` ${sub}` : ''}`
  const entry = (
    category: ops.CommandAudit['category'],
    action: string,
    entityType?: string,
    entityKey?: string,
  ): ops.CommandAudit => ({ category, action, command: typed, entityType, entityKey })
  switch (command) {
    case 'admin':
      return sub === 'reset-password' ? entry('user', 'ResetPassword', 'User') : undefined
    case 'schema':
      if (sub === 'sync') return entry('schema', 'Sync', 'Schema')
      return sub === 'purge' ? entry('schema', 'Purge', 'Schema') : undefined
    case 'content':
    case 'bundle':
      if (sub === 'purge') return entry('system', 'Purge', 'Bundle', positional[1])
      if (sub === 'import' || sub === 'install') return entry('content', 'Import', 'Bundle')
      return sub === 'publish' || sub === 'unpublish' || sub === 'revert'
        ? entry('content', capital(sub), 'Document', positional[1])
        : undefined
    case 'dictionary':
      return sub === 'import' ? entry('settings', 'Import', 'DictionaryItem') : undefined
    case 'domains':
      return sub && sub !== 'list'
        ? entry('settings', `${capital(sub)}Domains`, 'Domain')
        : undefined
    case 'upgrade':
      if (sub === undefined) return entry('system', 'Upgrade')
      return sub === 'check' && flags.has('--fix') ? entry('system', 'UpgradeFix') : undefined
    case 'maintenance':
      if (sub === 'pause') return entry('system', 'PauseEditing')
      return sub === 'resume' ? entry('system', 'ResumeEditing') : undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------- remotes (story 108)

const keychain = () => osKeychain()

/** Exit codes a pull or push states: 1 the remote refused or failed, 2 refused before sending, 3 gave up waiting. */
function remoteExit(error: unknown): never {
  if (error instanceof RefusedBeforeSending) {
    console.error(`  ${error.message}`)
    process.exit(2)
  }
  if (error instanceof TimedOut) {
    console.error(`  ${error.message} The job carries on at the remote.`)
    process.exit(3)
  }
  if (error instanceof RemoteError) {
    console.error(`  ${error.message}`)
    for (const item of error.problem.items ?? []) console.error(`    ${item}`)
    process.exit(error.problem.code === 'sign-in-required' ? 2 : 1)
  }
  console.error(`  ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

function openInBrowser(url: string): void {
  if (flags.has('--no-browser')) return
  const opener =
    process.platform === 'darwin'
      ? ['open']
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '']
        : ['xdg-open']
  try {
    Bun.spawn([...opener, url], { stdout: 'ignore', stderr: 'ignore' })
  } catch {
    // Printed above; opening it is a convenience.
  }
}

/** The remote a command names, signed in or not, with the environment it goes to. */
async function connectRemote(name: string | undefined) {
  const entry = pickRemote(cwd, name)
  if (!entry) {
    const known = readRemotes(cwd)
    console.error(
      known.length === 0
        ? '  No remotes yet: `crombolo remote add <name> <url>`.'
        : `  Which remote? ${known.map((r) => r.name).join(', ')}`,
    )
    process.exit(2)
  }
  const discovery = await discover(entry.url).catch(remoteExit)
  const client = new RemoteClient(discovery, keychain())
  const environment =
    flagValue('--env') ??
    entry.environment ??
    (discovery.environments.length === 1 ? discovery.environments[0]?.id : undefined)
  return { entry, discovery, client, environment }
}

async function remoteCommand(): Promise<void> {
  const [sub, name, url] = positional
  if (sub === 'add') {
    if (!name || !url) {
      console.error("remote add needs a name and the site's URL.")
      process.exit(2)
    }
    const discovery = await discover(url).catch(remoteExit)
    addRemote(cwd, { name, url: new URL(url).origin, environment: flagValue('--env') })
    console.log(`  added    ${name}  ${discovery.name} (${new URL(url).origin})`)
    for (const env of discovery.environments)
      console.log(`  env      ${env.id}${env.protected ? '  protected' : ''}`)
    console.log(`\n\`crombolo login ${name}\` signs in.`)
    return
  }
  if (sub === 'remove') {
    if (!name || !removeRemote(cwd, name)) {
      console.error(`  There is no remote "${name ?? ''}".`)
      process.exit(2)
    }
    console.log(`  removed  ${name}`)
    return
  }
  const remotes = readRemotes(cwd)
  if (remotes.length === 0) console.log('  No remotes yet: `crombolo remote add <name> <url>`.')
  for (const remote of remotes) {
    const signed = (await readSignIn(keychain(), remote.url).catch(() => undefined)) !== undefined
    console.log(
      `  ${remote.name.padEnd(12)} ${remote.url}${remote.environment ? `  env ${remote.environment}` : ''}${signed ? '' : '  (not signed in)'}`,
    )
  }
}

async function loginCommand(): Promise<void> {
  const { entry, discovery } = await connectRemote(positional[0])
  await signIn(discovery, keychain(), {
    clientName: `crombolo on ${hostname()}`,
    onCode: (code, url) => {
      console.log(`  Approve this sign-in at ${url}`)
      console.log(`  and check it shows   ${code}`)
      openInBrowser(url)
    },
  }).catch(remoteExit)
  console.log(`  signed in to ${entry.name}`)
}

async function logoutCommand(): Promise<void> {
  const { entry, discovery } = await connectRemote(positional[0])
  const signedIn = await readSignIn(keychain(), discovery.api)
  // Ended at the remote too, best effort: the device leaves "Signed-in devices".
  if (signedIn)
    await fetch(signedIn.tokenUrl.replace(/\/token$/, '/revoke'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: signedIn.accessToken }).toString(),
    }).catch(() => undefined)
  await forgetSignIn(keychain(), discovery.api)
  console.log(`  signed out of ${entry.name}`)
}

async function whoamiCommand(): Promise<void> {
  const { entry, client, discovery } = await connectRemote(positional[0])
  const response = await client
    .call(`${new URL(discovery.api).origin}/umbraco/management/api/v1/user/current`)
    .catch(remoteExit)
  if (!response.ok) remoteExit(await problemOf(response))
  const me = (await response.json()) as { name: string; email: string }
  console.log(`  ${me.name} <${me.email}> on ${entry.name}`)
  for (const env of await client.environments().catch(remoteExit)) {
    const may = [env.may.pull && 'pull', env.may.pullFull && 'full pull', env.may.push && 'push']
      .filter(Boolean)
      .join(', ')
    console.log(`  ${env.id.padEnd(12)} ${may || 'nothing'}${env.protected ? '  (protected)' : ''}`)
  }
}

const describeJob = (job: Job) =>
  `  ${job.kind.padEnd(5)} ${job.state}${job.stage ? `, ${job.stage}` : ''}${job.progress != null ? ` (${job.progress}%)` : ''}`

async function pullCommand(): Promise<void> {
  const { client, environment, discovery } = await connectRemote(positional[0])
  if (!environment) {
    console.error(
      `  Which environment? ${discovery.environments.map((e) => e.id).join(', ')} (--env)`,
    )
    process.exit(2)
  }
  const media = flags.has('--no-media')
    ? ('omitted' as const)
    : flags.has('--media-info-only') || flags.has('--lazy-media')
      ? ('referenced' as const)
      : ('included' as const)
  const incoming = join(cwd, '.crombolo', 'transfer', 'incoming')
  await mkdir(incoming, { recursive: true })
  const out = join(incoming, `pull-${environment}-${Date.now().toString(36)}.tgz`)
  const pulled = await pullFile(client, {
    environment,
    out,
    full: flags.has('--full'),
    media,
    onProgress: (job) => console.log(describeJob(job)),
  }).catch(remoteExit)
  console.log(
    `  pulled   ${describeBytes(pulled.size)}${flags.has('--full') ? '' : ', anonymised'}`,
  )
  if (media !== 'included') flags.add('--allow-missing-media')

  const existing = existsSync(join(cwd, 'crombolo.config.ts'))
  if (!existing) {
    await startFromFile(out, pulled.passphrase)
  } else {
    const config = await siteConfig()
    const { summary } = await ops.siteReplaceCheck(config, {
      bundle: out,
      passphrase: pulled.passphrase,
      replace: 'replace',
      allowMissingBlobs: media !== 'included',
    })
    const leaving = Object.entries(summary.leaving)
    if (leaving.length > 0)
      console.log(
        `  recycled ${leaving.map(([kind, n]) => `${n} ${kind}`).join(', ')} here, not in ${environment}`,
      )
    if (summary.filesRemoved.length > 0)
      console.log(`  removes  ${summary.filesRemoved.length} file(s) here, kept for a revert`)
    if (!flags.has('--yes')) {
      if (!process.stdin.isTTY) {
        console.error(`\nThis replaces this site with ${environment}: pass --yes to go on.`)
        process.exit(2)
      }
      const answer = prompt(`  Replace this site with ${environment}? [y/N]`)
      if (!/^y(es)?$/i.test(answer?.trim() ?? '')) {
        console.error('  Nothing was changed.')
        process.exit(2)
      }
    }
    const result = await ops.contentImport(config, {
      bundle: out,
      passphrase: pulled.passphrase,
      replace: 'replace',
      allowMissingBlobs: media !== 'included',
      label: `pull from ${environment}`,
      backupTaken: flags.has('--backup-taken'),
    })
    for (const problem of result.problems) console.error(`  ${problem}`)
    if (!result.runId) {
      printTransferFindings(result.check)
      console.error('\npull refused. Nothing was changed.')
      process.exit(1)
    }
    console.log(
      `  replaced, run ${result.runId}: \`crombolo content revert ${result.runId}\` puts it back`,
    )
  }

  if (media === 'referenced') {
    const config = await siteConfig()
    const blobs = await referencedBlobs(out)
    if (flags.has('--lazy-media')) {
      writeRemoteMedia(cwd, { api: discovery.api, environment })
      await writeFile(
        join(cwd, '.crombolo', 'remote-media-blobs.json'),
        `${JSON.stringify(
          blobs.map((b) => ({ key: b.key, etag: b.etag })),
          null,
          2,
        )}\n`,
      )
      console.log(
        `  media    ${blobs.length} file(s) fetched from ${environment} as they are first asked for`,
      )
    } else {
      const fetched = await fetchReferencedMedia(client, {
        environment,
        blobs,
        store: await mediaStoreFor(config),
        siteDir: cwd,
      }).catch(remoteExit)
      console.log(
        `  media    ${fetched.fetched} fetched (${describeBytes(fetched.bytes)}), ${fetched.skipped} already here`,
      )
      for (const key of fetched.failed)
        console.error(`  missing  ${key}: run the pull again to fetch it`)
    }
  }
  if (!existing) await start()
}

async function pushCommand(): Promise<void> {
  const { client, environment, discovery } = await connectRemote(positional[0])
  if (!environment) {
    console.error(
      `  Which environment? ${discovery.environments.map((e) => e.id).join(', ')} (--env)`,
    )
    process.exit(2)
  }
  const config = await siteConfig()
  const result = await pushSite(config, client, {
    environment,
    force: flags.has('--force'),
    autoApprove: flags.has('--auto-approve'),
    mediaInfoOnly: flags.has('--media-info-only'),
    onCheck: (check) => {
      const counts = Object.entries(check.sending.counts)
      console.log(
        `  sending  ${counts.map(([kind, n]) => `${n} ${kind}`).join(', ') || 'no content'}, ${check.sending.files} file(s)`,
      )
      if (check.fromRemote) {
        const recycles = Object.entries(check.recycles)
        if (recycles.length > 0)
          console.log(
            `  recycles ${recycles.map(([kind, n]) => `${n} ${kind}`).join(', ')} on ${environment}`,
          )
        if (check.removesFiles.length > 0)
          console.log(`  removes  ${check.removesFiles.join(', ')} on ${environment}`)
      }
    },
    confirm: async () => {
      if (!process.stdin.isTTY) return false
      const answer = prompt(`  This replaces ${environment}. Type its name to go on:`)
      return answer?.trim() === environment
    },
    onProgress: (job) => console.log(describeJob(job)),
    onApproval: (job) => {
      console.log(`  waiting  for someone else to approve it: ${job.approvalUrl}`)
      if (job.approvalUrl) openInBrowser(job.approvalUrl)
    },
  }).catch(remoteExit)
  const { job } = result
  if (job.state === 'done') {
    console.log(`\n  pushed   ${environment} replaced, run ${job.runId ?? '—'}`)
    return
  }
  console.error(`\n  ${job.problem?.title ?? `the push ended ${job.state}`}`)
  for (const item of job.problem?.items ?? []) console.error(`    ${item}`)
  process.exit(1)
}

async function mediaCommand(): Promise<void> {
  if (positional[0] !== 'fetch') return help()
  const source = readRemoteMedia(cwd)
  const listed = join(cwd, '.crombolo', 'remote-media-blobs.json')
  if (!source || !existsSync(listed)) {
    console.error('  This site was not pulled with --lazy-media: there is nothing to fetch.')
    process.exit(2)
  }
  const discovery = await discover(source.api).catch(remoteExit)
  const client = new RemoteClient(discovery, keychain())
  const config = await siteConfig()
  const blobs = JSON.parse(await Bun.file(listed).text()) as { key: string; etag: string | null }[]
  const fetched = await fetchReferencedMedia(client, {
    environment: source.environment,
    blobs,
    store: await mediaStoreFor(config),
    siteDir: cwd,
    onProgress: (done, total) => {
      if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`)
    },
  }).catch(remoteExit)
  console.log(
    `  media    ${fetched.fetched} fetched (${describeBytes(fetched.bytes)}), ${fetched.skipped} already here`,
  )
  for (const key of fetched.failed) console.error(`  missing  ${key}`)
  if (fetched.failed.length > 0) process.exit(1)
}

async function dispatch(): Promise<void> {
  switch (command) {
    case 'start':
      await start()
      break
    case 'init':
      await init()
      break
    case 'status':
      await status()
      break
    case 'admin':
      await admin()
      break
    case 'schema':
      await schema()
      break
    case 'generate':
      await generate()
      break
    case 'content':
      await content()
      break
    /**
     * The artifact's own name. A bundle that carries its own structure is what
     * the Packages section builds (`docs/bundles.md`), and `install` reads
     * better than `import` for one — but it is the same operation on the same
     * artifact, so this is the same code path, not a second one.
     */
    case 'bundle':
      if (positional[0] === 'purge') {
        await bundlePurge()
        break
      }
      if (positional[0] === 'install') positional[0] = 'import'
      await content()
      break
    case 'dictionary':
      await dictionary()
      break
    case 'domains':
      await domains()
      break
    case 'components':
      await components()
      break
    case 'assets':
      await assets()
      break
    case 'export':
      await exportCommand()
      break
    case 'remote':
      await remoteCommand()
      break
    case 'login':
      await loginCommand()
      break
    case 'logout':
      await logoutCommand()
      break
    case 'whoami':
      await whoamiCommand()
      break
    case 'pull':
      await pullCommand()
      break
    case 'push':
      await pushCommand()
      break
    case 'media':
      await mediaCommand()
      break
    case 'import':
      await importSite()
      break
    case 'upgrade':
      await upgrade()
      break
    case 'maintenance':
      await maintenance()
      break
    default:
      help()
  }
}
