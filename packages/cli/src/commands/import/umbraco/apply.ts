import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDomainsFile, writeUdtAll } from '@crombolo/server'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../../base.ts'
import { here } from '../../../support/describe.ts'
import { contentMode } from '../../../support/flags.ts'
import { PASSPHRASE_ENV, passphraseToSeal } from '../../../support/prompt.ts'
import {
  deprecated,
  loadImporter,
  planUmbraco,
  umbracoArgs,
  umbracoFlags,
} from '../../../support/umbraco.ts'
import { scaffoldFiles } from '../../../templates.ts'

export default class ImportUmbracoApply extends BaseCommand {
  static override summary = 'write a crombolo site from an Umbraco backup'
  static override description =
    'Schema, view stubs, media and a content bundle that `bun start` imports on first boot. Deprecated: story 074 replaces it.'
  static override args = umbracoArgs
  static override flags = {
    ...umbracoFlags,
    out: Flags.string({
      summary: 'the site directory to write',
      helpValue: '<dir>',
      required: true,
    }),
    postgres: Flags.boolean({ summary: 'configure Postgres' }),
    force: Flags.boolean({ summary: 'write into a directory that is not empty' }),
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'wrote', type: 'integer' },
      { name: 'out', type: 'string' },
      { name: 'report', type: 'string' },
      { name: 'sealed', type: 'boolean' },
    ],
    errors: ['not_found', 'refused', 'conflict', 'auth'],
    stability: 'deprecated',
  } as const

  async run() {
    const { args, flags } = await this.parse(ImportUmbracoApply)
    deprecated(this, this.jsonEnabled())
    const target = flags.out
    const importer = await loadImporter()
    const content = contentMode(this, flags)
    const sealing = content === 'sealed' || flags['with-members'] || flags['with-users']
    const plan = await planUmbraco(
      importer,
      args.backup,
      flags,
      content,
      sealing ? await passphraseToSeal() : undefined,
    )
    const { report } = plan
    if (!report.ready)
      this.fail(
        'refused',
        'Nothing was written: something blocks the import.',
        undefined,
        report.findings
          .filter((f) => f.class === 'blocking')
          .map((f) => `${f.title}${f.detail ? `: ${f.detail}` : ''}`),
      )
    if (
      existsSync(target) &&
      (await Array.fromAsync(new Bun.Glob('*').scan({ cwd: target, onlyFiles: false, dot: true })))
        .length > 0 &&
      !flags.force
    )
      this.fail(
        'conflict',
        `${target} is not empty.`,
        'Choose a new directory, or pass --force to write into it.',
      )

    const files = new Map<string, { text?: string; bytes?: Uint8Array; copyFrom?: string }>()
    const scaffold = scaffoldFiles({
      siteName: plan.siteName,
      postgres: flags.postgres,
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

    const reportFile = here(join(target, importer.IMPORT_DIR, 'report.md'))
    for (const line of importer.reportSummary(report)) this.say(`  ${line}`)
    this.say(`\n  wrote    ${files.size} files to ${here(target)}`)
    this.say(`  report   ${reportFile}`)
    this.say(`\nNext:\n  cd ${here(target)}\n  bun install\n  bun start`)
    this.say(
      `\n\`bun start\` imports ${importer.IMPORT_BUNDLE} on the first boot of an empty database.`,
    )
    if (sealing)
      this.say(
        `It is encrypted: \`bun start\` asks for the passphrase, or reads ${PASSPHRASE_ENV}.`,
      )
    if (content === 'omitted')
      this.say(
        'Pages and media were brought without what they hold. Run again with --include-content to bring it.',
      )
    if (plan.dictionary.length > 0)
      this.say(`Then: crombolo dictionary import ${importer.IMPORT_DIR}/dictionary.udt`)
    return { wrote: files.size, out: here(target), report: reportFile, sealed: sealing }
  }
}
