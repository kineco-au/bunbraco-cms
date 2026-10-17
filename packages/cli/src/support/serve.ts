/**
 * Serving a site: the boot with its retries, the bundles a start applies, the
 * signals that stop it, and `start --from`, which makes a site out of a file.
 * `crombolo start` and `crombolo pull` both end here.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { AuthStore, resetAdminPassword } from '@crombolo/auth'
import { readSetupState, recordInLedger, TransferRunRepository, writeReport } from '@crombolo/data'
import {
  assertPortAvailable,
  type BootFailure,
  backupBefore,
  bootFailurePage,
  bootRetryDelays,
  bootstrapDatabase,
  type CromboloConfig,
  createServer,
  describeBootFailure,
  describeDatabase,
  listeningBodyLimit,
  mediaStoreFor,
  placeBlobs,
  type ServerHandle,
} from '@crombolo/server'
import { importBundle } from '@crombolo/transfer'
import { CliError } from '../errors.ts'
import * as ops from '../operations/commands.ts'
import { scaffoldFiles } from '../templates.ts'
import { banner, describePlaced, describeSync, printTransferFindings } from './describe.ts'
import { type TransferFlagValues, transferInput } from './flags.ts'
import { PASSPHRASE_ENV, passphraseForPeople, passphraseToOpen } from './prompt.ts'
import { cwd, hasSite, type Io, siteConfig } from './site.ts'

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
    process.stderr.write(`\nStopping (${signal})…\n`)
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

export interface StartOptions extends TransferFlagValues {
  keepAdmin: boolean
  bundles: string[]
  label?: string
  backupTaken: boolean
}

/** What a started site answers on, and the sign-in a development start printed. */
export interface Started {
  backoffice: string | null
  site: string | null
  role: string
  admin: { username: string; password: string } | null
  setupPending: boolean
  bundles: string[]
}

/** Boots the site and says how to reach it; it serves until a signal stops it. */
export async function serveSite(io: Io, options: StartOptions): Promise<Started> {
  const config = await siteConfig()
  // Before the migration and the seed, so a clash with the container stack is
  // reported in a second rather than after the database work.
  await assertPortAvailable(config.port).catch((error: unknown) => {
    throw new CliError('unavailable', error instanceof Error ? error.message : String(error))
  })
  const { listening, server, bundles } = await bootWithRetries(io, config, options)
  const seededAdminPassword = server.seededAdminPassword
  const backoffice =
    config.role !== 'web' ? `${listening.url}${config.backOfficePath.slice(1)}` : null
  const site = config.role !== 'api' ? String(listening.url) : null
  const started: Started = {
    backoffice,
    site,
    role: config.role,
    admin: null,
    setupPending: false,
    bundles,
  }

  const lines = ['Crombolo is running', '']
  // What this node actually answers, so a split deployment's banner does not
  // advertise an address that 404s here.
  if (backoffice) lines.push(`  backoffice  ${backoffice}`)
  if (site) lines.push(`  site        ${site}`)
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
    if ((await readSetupState(server.db)) === 'pending') {
      started.setupPending = true
      lines.push(
        '  Set up your new site at',
        `    ${backoffice}/setup`,
        config.setupCode
          ? '  with the code in CROMBOLO_SETUP_CODE.'
          : '  First set CROMBOLO_SETUP_CODE (16+ characters) and restart.',
        '',
      )
    }
  } else if (options.keepAdmin) {
    if (seededAdminPassword) {
      started.admin = { username: config.adminLogin, password: seededAdminPassword }
      lines.push(
        '  Sign in with',
        `    username  ${config.adminLogin}`,
        `    password  ${seededAdminPassword}`,
        '',
      )
    }
  } else {
    const admin = await resetAdminPassword(
      new AuthStore(server.db),
      config.adminLogin,
      config.adminPassword,
    )
    if (admin) {
      started.admin = { username: admin.login, password: admin.password }
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
  banner(io, lines)
  if (seededAdminPassword) io.say('Database created and seeded.')
  return started
}

/**
 * Listens at once, serving a page that says why the site is not up yet, and
 * retries the boot with backoff: a database that comes up after the server is
 * picked up without a restart. After the last attempt it exits, so the
 * platform's restart policy and alerts take over. docs/operations.md.
 */
async function bootWithRetries(io: Io, config: CromboloConfig, options: StartOptions) {
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
      const bundles = await importStartupBundles(io, server, config, options)
      listening.reload(server.serveOptions as never)
      return { listening, server, bundles }
    } catch (error) {
      current = undefined
      await server?.close().catch(() => {})
      failure = describeBootFailure(error, describeDatabase(config))
      const delay = delays[attempt - 1]
      io.warning(
        `crombolo: ${failure.title}. ${failure.detail}\n  To fix it: ${failure.remedy}\n  (${error instanceof Error ? error.message : String(error)})`,
      )
      if (delay === undefined || error instanceof ops.CommandError || error instanceof CliError) {
        progress = { attempt, attempts, retryInSeconds: undefined }
        listening.stop(true)
        if (error instanceof ops.CommandError || error instanceof CliError) throw error
        throw new CliError('unavailable', `Gave up after ${attempt} attempt(s): ${failure.title}.`)
      }
      progress = { attempt, attempts, retryInSeconds: Math.round(delay / 1000) }
      if (attempt === 1) io.warning(`  ${listening.url} explains this while it retries.`)
      io.warning(
        `  Trying again in ${Math.round(delay / 1000)}s (attempt ${attempt} of ${attempts}).`,
      )
      await Bun.sleep(delay)
    }
  }
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
  io: Io,
  server: ServerHandle,
  config: CromboloConfig,
  options: StartOptions,
): Promise<string[]> {
  if (options.bundles.length === 0) return []

  const lines: string[] = []
  const db = server.db
  let imported = false
  for (const target of options.bundles) {
    let resolved: ops.ResolvedBundle
    try {
      resolved = ops.readBundle(target, config.siteDir, await passphraseToOpen(target, config))
    } catch (error) {
      if (!(error instanceof ops.CommandError)) throw error
      throw new CliError('refused', `${target} cannot be read. The site has not started.`, {
        details: [error.message, ...error.problems],
      })
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
        backupTaken: options.backupTaken,
      })
      if (backup.path) io.progress(`  backup   ${backup.path}`)
    }

    const prepared = await ops.transferOptions(db, config, resolved, transferInput(target, options))
    for (const problem of prepared.problems) io.warning(`  ${problem}`)
    const started = performance.now()
    const result = await importBundle(db, set, {
      ...prepared.options,
      // The administrator this boot created stands in until the site's own arrive.
      adoptUsers: Boolean(server.seededAdminPassword),
      publish: options.publish,
      nodeId: config.nodeId,
      label: options.label,
      package: { name: resolved.package.packageName, version: resolved.package.version },
    })
    await writeReport(db, result.check.findings, { source: 'transfer', scope: set.manifest.id })
    if (!result.runId) {
      printTransferFindings(io, result.check)
      throw new CliError(
        'refused',
        `${target} was refused: ${result.check.outstanding.length} finding(s) outstanding. Nothing was written, and the site has not started.`,
      )
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
      io.warning(`  not published  ${failure.key}: ${failure.reason}`)
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

export interface FromFileOptions {
  name?: string
  postgres: boolean
  install: boolean
  allowMissingMedia: boolean
  /** A pull already holds the passphrase it sealed the file with. */
  passphrase?: string
}

/**
 * `start --from <file>` (story 105): an empty folder in, a working site out —
 * scaffolded as `init` scaffolds one, its packages installed, and the file
 * imported as a replace so nothing of the scaffold's own starting point stays.
 * The new administrator's password is printed here, once.
 */
export async function startFromFile(
  io: Io,
  from: string,
  options: FromFileOptions,
): Promise<{ runId: string; admin: { username: string; password: string } | null }> {
  const file = resolve(cwd(), from)
  if (!existsSync(file)) throw new CliError('not_found', `${from} does not exist.`)
  if (hasSite())
    throw new CliError('conflict', 'There is a site here already.', {
      hint: '`crombolo import <file> --replace` replaces it; start --from starts a new one in an empty folder.',
    })
  const dir = await ops.unpackBundle(file, cwd())
  const manifest = ops.readBundle(dir, cwd()).set.manifest
  if (manifest.scope !== 'site')
    throw new CliError('usage', `${from} is not a whole-site file.`, {
      hint: 'Write one with `crombolo export --site`.',
    })
  const sealed = manifest.people !== undefined || manifest.content === 'sealed'
  const passphrase = options.passphrase ?? (sealed ? await passphraseForPeople() : undefined)
  if (sealed && !passphrase)
    throw new CliError('auth', `${from} is sealed.`, {
      hint: `Set ${PASSPHRASE_ENV} to its passphrase.`,
    })

  for (const scaffolded of scaffoldFiles({
    siteName: options.name ?? manifest.provenance.siteName,
    postgres: options.postgres,
  })) {
    const target = join(cwd(), scaffolded.path)
    if (existsSync(target)) continue
    await mkdir(join(target, '..'), { recursive: true })
    if (scaffolded.copyFrom === undefined) await writeFile(target, scaffolded.text ?? '')
    else await Bun.write(target, Bun.file(scaffolded.copyFrom))
  }
  io.progress(`  scaffolded a site for ${manifest.provenance.siteName || 'the file'}`)
  if (options.install) {
    const install = Bun.spawnSync(['bun', 'install'], {
      cwd: cwd(),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (install.exitCode !== 0)
      throw new CliError('internal', '`bun install` failed.', {
        hint: 'Run it, then `crombolo import <file> --replace`.',
      })
  }

  const config = await siteConfig()
  const { db, seededAdminPassword } = await bootstrapDatabase(config)
  await db.close()
  const result = await ops.contentImport(config, {
    bundle: dir,
    passphrase,
    replace: 'replace',
    allowMissingBlobs: options.allowMissingMedia,
    backupTaken: true,
    label: `start --from ${basename(file)}`,
  })
  for (const problem of result.problems) io.warning(`  ${problem}`)
  if (!result.runId) {
    printTransferFindings(io, result.check)
    throw new CliError(
      'refused',
      'The file could not be imported; the scaffolded site is left as it is.',
    )
  }
  io.say(`  imported ${result.check.counts.create} item(s), run ${result.runId}`)
  const placed = describePlaced(result.blobs)
  if (placed) io.say(`  media    ${placed}`)
  if (seededAdminPassword)
    banner(io, [
      'Sign in with (shown once)',
      `  username  ${config.adminLogin}`,
      `  password  ${seededAdminPassword}`,
    ])
  return {
    runId: result.runId,
    admin: seededAdminPassword
      ? { username: config.adminLogin, password: seededAdminPassword }
      : null,
  }
}
