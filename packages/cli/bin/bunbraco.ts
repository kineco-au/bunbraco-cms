#!/usr/bin/env bun
/**
 * The bunbraco CLI. Runs from a site directory and reads `bunbraco.config.ts`
 * there when present.
 *
 *   bunbraco start                  boot the site; resets and prints the admin password
 *   bunbraco start --keep-admin     boot without touching the admin password
 *   bunbraco start --bundle <dir>   apply a content bundle, once, then serve
 *   bunbraco init                   scaffold a site in the current directory
 *   bunbraco init --template <id>   …from a starter template, content included
 *   bunbraco status                 what this environment is, without starting it
 *   bunbraco admin reset-password   reset the administrator's password and print it
 *   bunbraco schema check           validate schema/ and report what a sync would do
 *   bunbraco schema check --static  validate the files only, no database
 *   bunbraco schema sync            apply schema/ to the database
 *   bunbraco schema export          write the database's definitions as schema/ files
 *   bunbraco schema new             scaffold a type file, and the view it points at
 *   bunbraco schema add-property    append a property to a type, and apply it
 *   bunbraco generate               TypeScript for the document types in schema/
 *   bunbraco views check            compile every view before a visitor does
 *   bunbraco assets list            the stylesheets and scripts beside them
 *
 *   bunbraco content export         write a subtree as a bundle, to move to another environment
 *   bunbraco content check          read-only: what importing a bundle here would do
 *   bunbraco content import         apply a bundle, in one transaction, and record the run
 *   bunbraco content runs           the imports applied here
 *   bunbraco content revert         put an import back, restoring what the site served
 *
 *   bunbraco domains                the hostnames this site answers on
 *   bunbraco domains set            write domains.toml and apply it
 *
 *   bunbraco import umbraco report  read-only: what importing an Umbraco backup would and would not bring
 *   bunbraco import umbraco apply   write a bunbraco site from an Umbraco backup
 *
 *   bunbraco upgrade --plan         print the DDL each pending framework migration would run
 *   bunbraco upgrade                back up, apply pending framework migrations, record them
 *   bunbraco upgrade ledger         print migration_history
 *
 *   bunbraco maintenance pause      refuse editors' saves cluster-wide; readers unaffected
 *   bunbraco maintenance resume     let editors save again
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { AuthStore, resetAdminPassword } from '@bunbraco/auth'
import { ObjectTypes } from '@bunbraco/core'
import {
  ContentTypeRepository,
  connect,
  currentSchemaState,
  DictionaryRepository,
  DocumentRepository,
  DomainRepository,
  describeRefFailure,
  type Finding,
  NodeRepository,
  readLedger,
  recordInLedger,
  resolveNodeRef,
  TransferRunRepository,
  writeReport,
} from '@bunbraco/data'
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
  type SchemaDocumentType,
  type SchemaTypeKind,
  type SyncReport,
  TYPE_KIND_FILES,
  type ValueMigration,
  validateSchemaSet,
  viewScaffold,
  writeDocumentType,
  writeSchemaFiles,
} from '@bunbraco/schema'
import {
  assertPortAvailable,
  assetDirs,
  assetScaffold,
  type BunbracoConfig,
  backupBefore,
  bootstrapDatabase,
  checkViews,
  createServer,
  DOMAINS_FILE,
  type DomainDeclaration,
  describeDatabase,
  dictionaryToUdt,
  domainsFilePath,
  importDictionaryUdt,
  listAssets,
  listViews,
  loadConfig,
  mediaStoreFor,
  partialScaffold,
  placeBlobs,
  readDomainsFile,
  resolveDomainNode,
  resolvePlaceholders,
  type ServerHandle,
  siteStatus,
  syncDomainsFile,
  syncSchemaDirectory,
  templateAliasesIn,
  undoDomainsFile,
  viewFileFor,
  withoutNode,
  writeDictionaryUdt,
  writeDomains,
  writeDomainsFile,
  writeUdtAll,
} from '@bunbraco/server'
import {
  importBundle,
  isResolution,
  isRevertResolution,
  loadBundle,
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
} from '@bunbraco/transfer'
import * as ops from '../src/operations/commands.ts'
import { findTemplate, listTemplates, scaffoldFiles } from '../src/templates.ts'

const cwd = process.cwd()
const [command = 'help', ...rest] = Bun.argv.slice(2)
const flags = new Set(rest.filter((arg) => arg.startsWith('--')))
const positional = rest.filter((arg) => !arg.startsWith('--'))

async function siteConfig(): Promise<BunbracoConfig> {
  const file = join(cwd, 'bunbraco.config.ts')
  const overrides = existsSync(file)
    ? ((await import(file)).default as Partial<BunbracoConfig>)
    : {}
  return loadConfig(overrides, cwd)
}

function banner(lines: string[]): void {
  const width = Math.max(...lines.map((line) => line.length))
  console.log(`┌─${'─'.repeat(width)}─┐`)
  for (const line of lines) console.log(`│ ${line.padEnd(width)} │`)
  console.log(`└─${'─'.repeat(width)}─┘`)
}

async function start(): Promise<void> {
  const config = await siteConfig()
  // Before the migration and the seed, so a clash with the container stack is
  // reported in a second rather than after the database work.
  await assertPortAvailable(config.port)
  const server = await createServer(config)
  // After the schema sync inside `createServer`, which is what gives the bundle
  // document types to land on, and before anything is served.
  const bundles = await importStartupBundles(server, config)
  const seededAdminPassword = server.seededAdminPassword

  const lines = ['Bunbraco is running', '']
  const listening = Bun.serve(server.serveOptions)
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
          ? '  (from BUNBRACO_ADMIN_PASSWORD)'
          : '  A fresh password is generated on every start; set',
      )
      if (!config.adminPassword)
        lines.push('  BUNBRACO_ADMIN_PASSWORD to keep one, or pass --keep-admin.')
      if (admin.sessionsEnded > 0)
        lines.push(`  Ended ${admin.sessionsEnded} session(s): the password changed.`)
    }
  }
  const views = server.health().views
  lines.push(
    `  database    ${describeDatabase(config)}`,
    `  views       ${config.viewsDir}${views.hash ? `   generation ${views.hash.slice(0, 8)}` : ''}`,
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
 * `start --bundle <dir>`, repeatable: apply a bundle before the site serves
 * anything, taking the flags `content import` takes.
 *
 * Imported once per bundle — a run still standing here means this site already
 * has that content — so a restart costs a query and a line in the banner. It
 * runs after the schema sync, which is what gives the bundle its document types,
 * and before anything is served. A refusal stops the boot: a site missing the
 * content the command line asked for is worse than a site that did not come up.
 */
async function importStartupBundles(
  server: ServerHandle,
  config: BunbracoConfig,
): Promise<string[]> {
  const dirs = flagValues('--bundle')
  if (dirs.length === 0) return []

  const lines: string[] = []
  const db = server.db
  let imported = false
  for (const dir of dirs) {
    const loaded = loadBundle(dir)
    for (const problem of loaded.problems) console.error(`  ${problem.file}: ${problem.message}`)
    if (!loaded.set || loaded.problems.length > 0) {
      console.error(`\n${dir} cannot be read. The site has not started.`)
      process.exit(1)
    }
    const set = loaded.set
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

    const prepared = await ops.transferOptions(db, config, set, transferInput(dir))
    for (const problem of prepared.problems) console.error(`  ${problem}`)
    const started = performance.now()
    const result = await importBundle(db, set, {
      ...prepared.options,
      publish: flags.has('--publish'),
      nodeId: config.nodeId,
      label: flagValue('--label'),
    })
    await writeReport(db, result.check.findings, { source: 'transfer', scope: set.manifest.id })
    if (!result.runId) {
      printTransferFindings(result.check)
      console.error(
        `\n${dir} was refused: ${result.check.outstanding.length} finding(s) outstanding. ` +
          'Nothing was written, and the site has not started.',
      )
      process.exit(1)
    }
    const c = result.check.counts
    const placed = describePlaced(
      loaded.blobs.size > 0 ? await placeBlobs(await mediaStoreFor(config), loaded.blobs) : null,
    )
    lines.push(
      `  bundle      ${set.manifest.id}: ${c.create} created, ${c.update} updated` +
        `${result.published.length > 0 ? `, ${result.published.length} published` : ''} (run ${result.runId})`,
    )
    if (placed) lines.push(`  blobs       ${placed}`)
    for (const failure of result.publishFailures)
      console.error(`  not published  ${failure.key}: ${failure.reason}`)
    await recordInLedger(db, {
      name: `content import ${set.manifest.id}`,
      kind: 'transfer',
      durationMs: Math.round(performance.now() - started),
      appliedBy: config.nodeId,
      note: `run ${result.runId} (start --bundle)`,
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
    console.error(`No template "${requested}". \`bunbraco init --template list\` prints them.`)
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
 * `bunbraco status`: what this environment resolved to, and what is wrong with
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
  line('views', `${report.site.views}   snapshots in ${report.site.viewsCache}`)
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
        ? `${pending.length} pending (\`bunbraco upgrade --plan\` lists them)`
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
    `bunbraco ${report.versions.bunbraco}${report.versions.backoffice ? `, backoffice ${report.versions.backoffice}` : ''}, bun ${report.versions.bun}`,
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
      const loaded = loadSchemaDirectory(config.schemaDir)
      const problems = [
        ...loaded.problems,
        ...validateSchemaSet(loaded.set, { templateAliases: templateAliasesIn(config.viewsDir) }),
      ]
      if (problems.length > 0) {
        console.error(`${problems.length} problem(s):`)
        printProblems(problems)
        process.exit(1)
      }
      console.log(
        `schema ${loaded.set.version}: ${loaded.set.documentTypes.length} document type(s), ${(loaded.set.mediaTypes ?? []).length} media type(s), ${loaded.set.dataTypes.length} data type(s), ${loaded.set.languages.length} language(s) — valid`,
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
      const loaded = loadSchemaDirectory(config.schemaDir)
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
          ? loadSchemaDirectory(config.schemaDir).set.version
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
  'document-type': 'document',
  'media-type': 'media',
  'member-type': 'member',
}

/**
 * `schema new <kind> <alias>`: the file a site would otherwise write from
 * memory, keys and all, and the view it points at.
 */
async function schemaNew(config: BunbracoConfig): Promise<void> {
  const kindArg = positional[1] ?? ''
  const alias = positional[2]
  const kind = TYPE_KINDS[kindArg]
  if (!kind || !alias) {
    console.error(
      `schema new needs a kind and an alias: ${Object.keys(TYPE_KINDS).join(', ')}.\n` +
        '  bunbraco schema new document-type article --at-root',
    )
    process.exit(1)
  }

  const loaded = loadSchemaDirectory(config.schemaDir)
  const existing = [
    ...loaded.set.documentTypes,
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
    // A document type with nothing in it cannot be published, so it starts with
    // the one property every page has; the other kinds get what they are given.
    tab: kind === 'document' ? (flagValue('--tab') ?? 'Content') : undefined,
  })

  const file = join(config.schemaDir, TYPE_KIND_FILES[kind].dir, fileNameFor(alias))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, writeDocumentType(type, kind))
  console.log(`  created  ${relative(cwd, file)}`)

  // A type nothing allows cannot be created anywhere, which is a confusing
  // first five minutes: the editor simply never offers it.
  if (kind === 'document' && !element && !type.allowAtRoot) {
    const parents = loaded.set.documentTypes.filter((t) => t.allowChildren.includes(alias))
    if (parents.length === 0)
      console.log(
        `  note     nothing allows a "${alias}" yet — add it to a parent's allow-children, or pass --at-root`,
      )
  }

  if (type.templates.length > 0) {
    const view = join(config.viewsDir, `${alias}.tsx`)
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
async function schemaAddProperty(config: BunbracoConfig): Promise<void> {
  const typeAlias = positional[1]
  const alias = positional[2]
  const dataType = flagValue('--type')
  if (!typeAlias || !alias || !dataType) {
    console.error(
      'schema add-property needs the type, the property alias and --type <data type>:\n' +
        '  bunbraco schema add-property article summary --type textarea --mandatory',
    )
    process.exit(1)
  }

  const loaded = loadSchemaDirectory(config.schemaDir)
  if (loaded.problems.length > 0) {
    printProblems(loaded.problems)
    process.exit(1)
  }
  const kinds: Array<[SchemaTypeKind, SchemaDocumentType[]]> = [
    ['document', loaded.set.documentTypes],
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
  const text = writeDocumentType(result.type, found.kind)
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
async function applySchema(config: BunbracoConfig): Promise<void> {
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
  for (const t of loaded.set.documentTypes) {
    if (!t.key)
      problems.push(
        `${t.alias}: no key — run \`bunbraco schema sync\` in development to assign one`,
      )
    for (const p of allProperties(t)) if (!p.key) problems.push(`${t.alias}.${p.alias}: no key`)
  }
  for (const d of loaded.set.dataTypes) if (!d.key) problems.push(`data type ${d.alias}: no key`)
  for (const m of migrations) {
    const type = loaded.set.documentTypes.find((t) => t.alias === m.from.type)
    if (!type) {
      problems.push(`migration ${m.id}: no document type "${m.from.type}"`)
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

async function schemaPurge(config: BunbracoConfig): Promise<void> {
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
  const loaded = loadSchemaDirectory(config.schemaDir)
  const problems = [...loaded.problems, ...validateSchemaSet(loaded.set)]
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

async function contentRevert(config: BunbracoConfig): Promise<void> {
  const runId = positional[1]
  if (!runId) {
    console.error('content revert needs the run id. `bunbraco content runs` lists them.')
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
    const files = ops.restoreSectionFiles(config, runId)
    for (const file of files.restored) console.log(`  restored ${relative(cwd, file)}`)
    for (const file of files.removed)
      console.log(`  removed  ${relative(cwd, file)}  (created by that run)`)

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
        `\`bunbraco content revert ${result.runId}\` would put it back again.`,
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
function transferInput(dir: string): ops.TransferInput {
  const allFlag = flagValue('--resolve-all')
  if (allFlag !== undefined && !isResolution(allFlag)) {
    console.error(`  "${allFlag}" is not one of ${RESOLUTIONS.join(', ')}`)
    process.exit(1)
  }
  return {
    dir,
    under: flagValue('--under'),
    resolutions: parseResolutions(),
    resolveAll: allFlag as Resolution | undefined,
    allowMissingBlobs: flags.has('--allow-missing-blobs'),
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

async function contentImport(config: BunbracoConfig): Promise<void> {
  const dir = positional[1]
  if (!dir) {
    console.error('content import needs the bundle directory.')
    process.exit(1)
  }
  const result = await ops.contentImport(config, {
    ...transferInput(dir),
    publish: flags.has('--publish'),
    label: flagValue('--label'),
    backupTaken: flags.has('--backup-taken'),
  })
  for (const problem of result.problems) console.error(`  ${problem}`)
  if (result.backup.path) console.log(`  backup   ${result.backup.path}`)
  describeBundle(result.bundle)

  if (!result.runId) {
    printTransferFindings(result.check)
    // Sections are applied before the content is checked, because content
    // naming a type the bundle brings cannot pass a check until that type
    // exists. So a refusal here may still have written files, and saying
    // otherwise would send somebody looking in the wrong place.
    if (result.sections) {
      console.error(
        `\nimport refused, but this bundle's structure was already applied: ` +
          `${result.sections.written.length} file(s) written${
            result.sections.schema ? `, schema ${result.sections.schema.action}` : ''
          }.`,
      )
      for (const file of result.sections.written) console.error(`    ${relative(cwd, file)}`)
      if (result.sections.replaced.length > 0)
        console.error(
          `  the originals are under ${relative(cwd, join(config.siteDir, ops.RUN_BACKUP_DIR))}`,
        )
    } else {
      console.error(
        `\nimport refused: ${result.check.outstanding.length} finding(s) outstanding. Nothing was written.`,
      )
    }
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
  console.log(`\nDone. \`bunbraco content revert ${result.runId}\` puts it back.`)
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
async function contentPublish(config: BunbracoConfig, publishing: boolean): Promise<void> {
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

async function contentRuns(config: BunbracoConfig): Promise<void> {
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

/** `--resolve <key>=take-bundle`, repeatable; the same shape as `--set`. */
function parseResolutions(): Record<string, Resolution> {
  const out: Record<string, Resolution> = {}
  for (const pair of flagValues('--resolve')) {
    const eq = pair.indexOf('=')
    if (eq < 0) {
      console.error(`  --resolve wants <key>=<choice>, not "${pair}"`)
      process.exit(1)
    }
    const choice = pair.slice(eq + 1)
    if (!isResolution(choice)) {
      console.error(`  "${choice}" is not one of ${RESOLUTIONS.join(', ')}`)
      process.exit(1)
    }
    out[pair.slice(0, eq)] = choice
  }
  return out
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
    for (const suggestion of resolutionsFor(f.code)) console.log(`             → ${suggestion}`)
    if (f.link) console.log(`             ${f.link}`)
  }
}

async function contentCheck(config: BunbracoConfig): Promise<void> {
  const dir = positional[1]
  if (!dir) {
    console.error('content check needs the bundle directory.')
    process.exit(1)
  }
  const result = await ops.contentCheck(config, transferInput(dir))
  for (const problem of result.problems) console.error(`  ${problem}`)
  describeBundle(result.bundle)
  if (result.under) console.log(`  under    ${result.under}`)
  printSections(result.sections)
  printTransferFindings(result.check)

  if (flags.has('--save')) {
    const target = join(dir, RESOLUTIONS_FILE)
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

async function contentExport(config: BunbracoConfig): Promise<void> {
  const out = flagValue('--out')
  const refs = flagValues('--root')
  if (!out || refs.length === 0) {
    console.error('content export needs --root <path|uuid> (repeatable) and --out <dir>.')
    process.exit(1)
  }
  const result = await ops.contentExport(config, {
    roots: refs,
    only: flags.has('--only'),
    drafts: flags.has('--drafts'),
    withBlobs: flags.has('--with-blobs'),
    withBlueprints: flags.has('--with-blueprints'),
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
  console.log(
    `  bundle   ${result.bundleId} (${result.snapshot}): ${
      counts.length > 0 ? counts.map(([kind, n]) => `${n} ${kind}`).join(', ') : 'nothing selected'
    }`,
  )
  if (result.expected.length > 0) {
    console.log(`  expects  ${result.expected.length} node(s) to exist at the destination:`)
    for (const e of result.expected) console.log(`    ${e.key}  ${e.name}  (${e.why})`)
  }
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

/**
 * `09-schema-as-code.md` leaves the dictionary in the database, because
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
 * `bunbraco domains`: which hostnames reach which page.
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
    `  wrote    ${relative(cwd, written.file)}${written.backup ? '  (previous kept; `bunbraco domains undo` puts it back)' : ''}`,
  )
  return applyDomains(config)
}

/** Applies the file as a boot would, and reports what it did. */
async function applyDomains(config: BunbracoConfig): Promise<void> {
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
 * `bunbraco import umbraco`: a compatibility report for an Umbraco backup, and
 * then a bunbraco site written from it.
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
  if (kind !== 'umbraco' || (sub !== 'report' && sub !== 'apply')) return help()
  if (!backup) {
    console.error(`import umbraco ${sub} needs the backup: a .bacpac, or Umbraco's SQLite file.`)
    process.exit(1)
  }
  const out = flagValue('--out')
  if (sub === 'apply' && !out) {
    console.error('import umbraco apply needs --out <dir>: the site directory to write.')
    process.exit(1)
  }

  let importer: typeof import('@bunbraco/import-umbraco')
  try {
    importer = await import('@bunbraco/import-umbraco')
  } catch {
    console.error(
      'The importer is a separate package. Add it, then run this again:\n\n  bun add -d @bunbraco/import-umbraco',
    )
    process.exit(1)
  }

  let plan: Awaited<ReturnType<typeof importer.planImport>>
  try {
    plan = await importer.planImport({
      source: backup,
      site: flagValue('--site'),
      media: flagValue('--media'),
      siteName: flagValue('--name'),
      drafts: flags.has('--drafts'),
      staging: flagValue('--staging'),
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
  if (plan.dictionary.length > 0)
    console.log(`Then: bunbraco dictionary import ${importer.IMPORT_DIR}/dictionary.udt`)
}

/**
 * `bunbraco views`: what is on disk, whether it compiles, and a new one.
 *
 * A view is loaded when a request renders it, so one that does not compile is a
 * 500 waiting for a visitor. `views check` is that failure brought forward.
 */
async function views(): Promise<void> {
  const config = await siteConfig()
  const sub = positional[0] ?? 'check'
  if (sub !== 'check' && sub !== 'list' && sub !== 'new') return help()

  const loaded = existsSync(config.schemaDir) ? loadSchemaDirectory(config.schemaDir) : undefined
  const types = loaded?.set.documentTypes ?? []

  if (sub === 'list') {
    const found = listViews(config.viewsDir)
    if (found.length === 0) console.log(`No views in ${relative(cwd, config.viewsDir) || '.'}.`)
    for (const view of found) {
      const declaredBy = types
        .filter((type) => type.templates.includes(view.alias))
        .map((type) => type.alias)
      const note =
        view.kind !== 'template'
          ? ''
          : declaredBy.length > 0
            ? `  ← ${declaredBy.join(', ')}`
            : '  (no document type declares it)'
      console.log(`  ${view.kind.padEnd(9)} ${relative(cwd, view.path)}${note}`)
    }
    return
  }

  if (sub === 'new') {
    const alias = positional[1]
    if (!alias) {
      console.error('views new needs a name: `bunbraco views new article` or `--partial header`.')
      process.exit(1)
    }
    const partial = flags.has('--partial')
    const file = viewFileFor(config.viewsDir, alias, partial)
    if (existsSync(file)) {
      console.error(`${relative(cwd, file)} already exists.`)
      process.exit(1)
    }
    const type = types.find((candidate) => candidate.templates.includes(alias))
    if (!partial && !type)
      console.log(
        `  note     no document type declares the template "${alias}" — add it to one's templates, or \`bunbraco schema new\``,
      )
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(
      file,
      partial ? partialScaffold(alias) : type ? viewScaffold(type) : partialScaffold(alias),
    )
    console.log(`  created  ${relative(cwd, file)}`)
    return
  }

  const report = await checkViews({
    viewsDir: config.viewsDir,
    siteDir: config.siteDir,
    declaredTemplates: types.flatMap((type) => type.templates),
  })
  const counts: Record<string, number> = { template: 0, partial: 0, component: 0 }
  for (const view of report.views) counts[view.kind] = (counts[view.kind] ?? 0) + 1
  console.log(
    `  checked  ${report.views.length} file(s): ${counts.template} template(s), ` +
      `${counts.partial} partial(s), ${counts.component} component(s)`,
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

/** `bunbraco assets`: the stylesheets and scripts the backoffice also edits. */
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
    console.error('assets new needs a kind and a name: `bunbraco assets new stylesheet site.css`.')
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
            `  ${row.appliedAt}  ${row.kind.padEnd(8)} ${row.name}  ${row.durationMs}ms${row.appliedBy ? `  by ${row.appliedBy}` : ''}${row.note ? `  (${row.note})` : ''}`,
          )
      } finally {
        await db.close()
      }
      return
    }
    case 'check': {
      if (!flags.has('--fix')) {
        const report = await ops.upgradeCheck(config, { set: parseSet() })
        printFindings(report)
        if (!report.siteChecked)
          console.log(
            'The site schema is checked once the framework migrations have run (`bunbraco upgrade`).',
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
        for (const step of plan.steps) {
          console.log(
            `\n== ${step.name} (${step.kind}${step.release ? `, release ${step.release}` : ''})`,
          )
          if (step.unplannable) console.log(`  unplannable: ${step.unplannable}`)
          for (const sql of step.statements) console.log(`  ${sql};`)
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
          'Run `bunbraco upgrade check --fix`, resolve what needs a person, and try again.',
        )
        process.exit(1)
      }
      if (result.action === 'nothing')
        return console.log('Nothing to upgrade: the database is at this version.')
      for (const name of result.frameworkApplied) console.log(`  applied  ${name}`)
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
  console.log(`bunbraco <command>

  start [--keep-admin]        boot the site in the current directory
        [--bundle <dir>]      apply a content bundle first, once per bundle, then serve;
                              takes the \`content import\` flags (--publish, --under, …)
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
  schema new <document-type|media-type|member-type> <alias>
                              write the type file, with keys, and the view it points at
                              [--name <name>] [--description <text>] [--icon <icon>]
                              [--at-root] [--element] [--tab <tab>] [--no-view]
  schema add-property <type> <alias> --type <data type>
                              append a property to that type and apply it
                              [--name <name>] [--mandatory] [--tab <tab>] [--dry-run]
  schema purge --older-than N delete properties retired more than N days ago, with their values
  generate                    schema/content-types.d.ts from schema/
  views check                 compile every view, and report a template with no file
  views list                  what is in Views/, and which type declares each template
  views new <alias> [--partial]
                              a view for a type that declares one, or Views/Partials/<name>.tsx
  assets list                 the stylesheets and scripts this site has
  assets new <stylesheet|script> <name>
                              write an empty one in the place the backoffice edits
  content export --root <path|uuid> --out <dir>
                              write a content bundle: the subtree, its dependencies
                              and what the destination must already have
                              [--only] [--drafts] [--with-blobs] [--with-blueprints]
  content check <dir>         what importing the bundle here would do, and what it
                              needs from a person first; writes to the Changes dashboard
                              [--under <path|uuid>] [--resolve <key>=take-bundle|keep-local|skip]
                              [--resolve-all <choice>] [--allow-missing-blobs] [--save]
  content import <dir>        re-check, back up, then apply: documents and elements
                              arrive as drafts, media is live. One transaction, so a
                              failure leaves nothing behind
                              [--publish] [--label <text>] [--backup-taken] + the check flags
                              [--no-schema] [--no-files] decline a section it carries
                              [--replace-files] allow replacing files this site has;
                              refused without it, and the originals are kept for a revert
  bundle check <dir>          the same as content check
  bundle install <dir>        the same as content import; a bundle carrying its own
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
  import umbraco report <backup> [--site <dir>] [--media <dir>] [--out <dir>] [--json]
                              read-only: what importing an Umbraco backup would bring,
                              and what it would not — packages, Razor, custom code.
                              <backup> is a .bacpac or Umbraco's SQLite file; --site is
                              the site's files, for its views, media and plugins.
                              Non-zero when something blocks the import
  import umbraco apply <backup> --out <dir> [--site <dir>] [--media <dir>]
                              write a bunbraco site: schema, view stubs, media and a
                              content bundle that \`bun start\` imports on first boot
                              [--name <site name>] [--drafts] [--postgres] [--force]
  upgrade check [--set t.p=v] what the deployed schema/ would do to this database's data
  upgrade check --fix         back up; apply the additive part and every conversion early
  upgrade [--force <reason>]  re-check, back up, apply framework steps, cut over, ledger
  upgrade --plan              the DDL pending framework migrations would run
  upgrade ledger              print migration_history
  maintenance pause [--reason <text>]
                              refuse every editor's save, on every node, until resumed;
                              readers are unaffected and no node drains
  maintenance resume          let editors save again
  maintenance status [--json] whether editing is paused, by whom and why
  (Postgres: --backup-taken or BUNBRACO_PG_DUMP before anything that writes)`)
}

try {
  await dispatch()
} catch (error) {
  if (!(error instanceof ops.CommandError)) throw error
  for (const problem of error.problems) console.error(`  ${problem}`)
  console.error(error.message)
  process.exit(1)
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
     * the Packages section builds (`docs/17-bundles.md`), and `install` reads
     * better than `import` for one — but it is the same operation on the same
     * artifact, so this is the same code path, not a second one.
     */
    case 'bundle':
      if (positional[0] === 'install') positional[0] = 'import'
      await content()
      break
    case 'dictionary':
      await dictionary()
      break
    case 'domains':
      await domains()
      break
    case 'views':
      await views()
      break
    case 'assets':
      await assets()
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
