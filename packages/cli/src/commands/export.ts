import { resolve } from 'node:path'
import { packageNameFor } from '@crombolo/transfer'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../base.ts'
import * as ops from '../operations/commands.ts'
import { counted, describeBytes, here } from '../support/describe.ts'
import { passphraseToSeal } from '../support/prompt.ts'
import { siteConfig } from '../support/site.ts'

/** The whole site as one file (story 104). */
export default class Export extends BaseCommand {
  static override summary =
    'write the whole site to one file, to move it to another machine or host'
  static override description = [
    'Schema, components, styles, scripts, dictionary, every page and media item and their files. Domains and people stay behind unless --with-members or --with-users, which are encrypted.',
    '--anonymise replaces every personal value as it writes.',
  ].join('\n\n')
  static override examples = ['<%= config.bin %> export --site --out site.tgz']
  static override flags = {
    site: Flags.boolean({
      summary: 'the whole site (required: a part of it is `content export`)',
      required: true,
    }),
    out: Flags.string({ summary: 'the file to write', helpValue: '<file.tgz>' }),
    'no-media': Flags.boolean({ summary: 'leave the media files out' }),
    drafts: Flags.boolean({ summary: 'drafts too' }),
    'with-members': Flags.boolean({ summary: 'members, encrypted' }),
    'with-users': Flags.boolean({ summary: 'back-office users, encrypted' }),
    anonymise: Flags.boolean({ summary: 'replace every personal value as it writes' }),
    name: Flags.string({ summary: "the package's npm name", helpValue: '<npm name>' }),
    'package-version': Flags.string({ summary: "the package's version", helpValue: '<version>' }),
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'out', type: 'string' },
      { name: 'package', type: 'object' },
      { name: 'counts', type: 'object' },
      { name: 'sections', type: 'object' },
      { name: 'media', type: 'object' },
      { name: 'people', type: 'object' },
      { name: 'anonymised', type: 'integer', nullable: true },
    ],
    errors: ['usage', 'auth', 'io'],
  } as const

  async run() {
    const { flags } = await this.parse(Export)
    const config = await siteConfig()
    const withPeople = flags['with-members'] || flags['with-users']
    const out = resolve(
      flags.out ??
        `${packageNameFor(`${config.siteName}-site`)}-${new Date().toISOString().slice(0, 10)}.tgz`,
    )
    const result = await ops.siteExport(config, {
      out,
      media: !flags['no-media'],
      drafts: flags.drafts,
      withMembers: flags['with-members'],
      withUsers: flags['with-users'],
      anonymise: flags.anonymise,
      passphrase:
        withPeople && !(flags.anonymise && !flags['with-members'])
          ? await passphraseToSeal()
          : undefined,
      package: { name: flags.name, version: flags['package-version'] },
    })
    this.say(`  wrote    ${here(result.out)}`)
    this.say(`  package  ${result.package.name}@${result.package.version} (private)`)
    this.say(`  content  ${counted(result.counts, 'none')}, unencrypted`)
    if (Object.keys(result.sections).length > 0) this.say(`  files    ${counted(result.sections)}`)
    if (result.media.omitted)
      this.say(
        '  media    left out (--no-media): importing it brings the media items without their files',
      )
    else
      this.say(`  media    ${result.media.carried} file(s), ${describeBytes(result.media.bytes)}`)
    for (const key of result.media.missing)
      this.warning(`  missing  ${key} is not in this environment's media store`)
    if (result.people.members + result.people.users > 0)
      this.say(
        `  people   ${result.people.members} member(s), ${result.people.users} user(s), encrypted`,
      )
    else this.say('  people   left out: pass --with-members or --with-users to bring them')
    if (result.anonymised !== undefined)
      this.say(
        `  anonymised  ${result.anonymised} email address(es) replaced; no back-office users`,
      )
    return {
      out: here(result.out),
      package: result.package,
      counts: result.counts,
      sections: result.sections,
      media: result.media,
      people: result.people,
      anonymised: result.anonymised ?? null,
    }
  }
}
