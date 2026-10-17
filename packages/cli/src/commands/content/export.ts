import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { packageNameFor } from '@crombolo/transfer'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import * as ops from '../../operations/commands.ts'
import { counted, describeBytes, describeContentMode, here } from '../../support/describe.ts'
import { contentFlags, contentMode, many } from '../../support/flags.ts'
import { passphraseToSeal } from '../../support/prompt.ts'
import { siteConfig } from '../../support/site.ts'

export default class ContentExport extends BaseCommand {
  static override summary =
    'write a subtree as a private bundle package, to move to another environment'
  static override description = [
    'The subtree, its dependencies, and what the destination must already have.',
    'Names and the tree only, unless --include-content: values, media files (--with-blobs) and protected-page usernames, encrypted under a passphrase (asked for, or CROMBOLO_BUNDLE_PASSPHRASE). --allow-content-unencrypted writes them readable. --with-members and --with-users add people, always encrypted.',
  ].join('\n\n')
  static override examples = ['<%= config.bin %> content export --root /blog --out ./bundles/blog']
  static override flags = {
    root: many('the subtree to export; repeatable', '<path|uuid>'),
    out: Flags.string({
      summary: 'the directory to write the package to',
      helpValue: '<dir>',
      required: true,
    }),
    only: Flags.boolean({ summary: 'the roots alone, not what is below them' }),
    drafts: Flags.boolean({ summary: 'drafts, not only what is published' }),
    'with-blueprints': Flags.boolean({ summary: 'the blueprints of its types' }),
    'with-blobs': Flags.boolean({ summary: 'with --include-content: the media files' }),
    'with-members': Flags.boolean({ summary: 'members, encrypted' }),
    'with-users': Flags.boolean({ summary: 'back-office users, encrypted' }),
    name: Flags.string({ summary: "the package's npm name", helpValue: '<npm name>' }),
    'package-version': Flags.string({ summary: "the package's version", helpValue: '<version>' }),
    ...contentFlags,
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'out', type: 'string' },
      { name: 'package', type: 'object' },
      { name: 'bundleId', type: 'string' },
      { name: 'counts', type: 'object' },
      { name: 'expected', type: 'array', items: { type: 'object' } },
      { name: 'content', type: 'string', enum: ['omitted', 'sealed', 'open'] },
      { name: 'blobs', type: 'object' },
    ],
    errors: ['usage', 'not_found', 'refused', 'auth'],
  } as const

  async run() {
    const { flags } = await this.parse(ContentExport)
    if (flags.root.length === 0) this.fail('usage', 'content export needs --root <path|uuid>.')
    const content = contentMode(this, flags)
    const result = await ops.contentExport(await siteConfig(), {
      content,
      roots: flags.root,
      only: flags.only,
      drafts: flags.drafts,
      withBlobs: flags['with-blobs'],
      withMembers: flags['with-members'],
      withUsers: flags['with-users'],
      passphrase:
        content === 'sealed' || flags['with-members'] || flags['with-users']
          ? await passphraseToSeal()
          : undefined,
      withBlueprints: flags['with-blueprints'],
      // An export is a private package; without --name it is named for its directory.
      package: {
        name: flags.name ?? packageNameFor(basename(resolve(flags.out))),
        version: flags['package-version'],
      },
    })
    for (const key of result.blobs.missing)
      this.warning(`  missing  ${key} is not in this environment's media store`)
    for (const file of result.files) {
      const target = join(flags.out, file.path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, file.bytes ?? (file.text as string))
    }
    if (Object.keys(result.counts).length === 0)
      this.fail(
        'not_found',
        'Nothing was selected, so the package is empty.',
        'Check the --root values.',
      )
    this.say(`  wrote    ${here(flags.out)}`)
    this.say(`  package  ${result.package.name}@${result.package.version} (private)`)
    this.say(
      `  bundle   ${result.bundleId} (${result.snapshot}): ${counted(result.counts, 'nothing selected')}`,
    )
    if (result.expected.length > 0) {
      this.say(`  expects  ${result.expected.length} node(s) to exist at the destination:`)
      for (const e of result.expected) this.say(`    ${e.key}  ${e.name}  (${e.why})`)
    }
    describeContentMode(this, result.content, result.people)
    if (result.blobs.carried > 0)
      this.say(
        `  blobs    ${result.blobs.carried} media file(s), ${describeBytes(result.blobs.bytes)}`,
      )
    else if (result.blobs.notCarried > 0)
      this.say(
        `  blobs    ${result.blobs.notCarried} media file(s) are not carried — pass --with-blobs to include them`,
      )
    return {
      out: here(flags.out),
      package: result.package,
      bundleId: result.bundleId,
      counts: result.counts,
      expected: result.expected,
      content: result.content,
      blobs: result.blobs,
    }
  }
}
