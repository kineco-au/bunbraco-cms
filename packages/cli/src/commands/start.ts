import { Flags } from '@oclif/core'
import { BaseCommand } from '../base.ts'
import { backupTaken, many, transferFlags } from '../support/flags.ts'
import { serveSite, startFromFile } from '../support/serve.ts'

export default class Start extends BaseCommand {
  static override summary = 'boot the site in the current directory'
  static override description = [
    "In development it resets and prints the administrator's password on every start; --keep-admin leaves it alone.",
    "--bundle applies a bundle's content first, once per bundle, taking the `content import` flags.",
    "--from, in an empty folder: scaffold a site, install it, import a whole-site file (`crombolo export --site`) and serve it; the new administrator's password is printed once.",
    'It serves until stopped. With -o json it prints one object saying where it answers.',
  ].join('\n\n')
  static override examples = [
    '<%= config.bin %> start',
    '<%= config.bin %> start --bundle ./bundles/demo --publish',
    '<%= config.bin %> start --from site-2026-10-01.tgz',
  ]
  static override flags = {
    'keep-admin': Flags.boolean({ summary: "don't touch the administrator's password" }),
    bundle: many("apply a bundle's content first; repeatable", '<pkg>'),
    from: Flags.string({
      summary: 'in an empty folder: a site from a whole-site file',
      helpValue: '<file>',
    }),
    postgres: Flags.boolean({ summary: 'with --from: configure Postgres' }),
    name: Flags.string({ summary: "with --from: the site's name", helpValue: '<site name>' }),
    'no-install': Flags.boolean({ summary: 'with --from: skip `bun install`' }),
    'allow-missing-media': Flags.boolean({
      summary: 'with --from: import media items whose files the file does not carry',
    }),
    label: Flags.string({ summary: "a label for a bundle's import run", helpValue: '<text>' }),
    'backup-taken': backupTaken,
    ...transferFlags,
  }
  static override spec = {
    effects: 'non_idempotent',
    outputKind: 'stream',
    errors: ['not_found', 'conflict', 'refused', 'unavailable', 'auth'],
  } as const

  async run() {
    const { flags } = await this.parse(Start)
    let keepAdmin = flags['keep-admin']
    if (flags.from) {
      await startFromFile(this, flags.from, {
        name: flags.name,
        postgres: flags.postgres,
        install: !flags['no-install'],
        allowMissingMedia: flags['allow-missing-media'],
      })
      // The password printed above is the one to use: this first start leaves it alone.
      keepAdmin = true
    }
    const started = await serveSite(this, {
      ...flags,
      keepAdmin,
      bundles: flags.bundle,
      backupTaken: flags['backup-taken'],
    })
    // A stream: one record when it is up, then it serves until it is stopped.
    if (this.jsonEnabled()) process.stdout.write(`${JSON.stringify(started)}\n`)
  }
}
