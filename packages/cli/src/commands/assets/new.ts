import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { assetDirs, assetScaffold } from '@crombolo/server'
import { Args } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'

export default class AssetsNew extends BaseCommand {
  static override summary = 'write an empty stylesheet or script in the place the backoffice edits'
  static override examples = ['<%= config.bin %> assets new stylesheet site.css']
  static override args = {
    kind: Args.string({
      required: true,
      options: ['stylesheet', 'script'],
      description: 'which kind',
    }),
    name: Args.string({ required: true, description: 'its file name' }),
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [{ name: 'created', type: 'string' }],
    errors: ['conflict'],
  } as const

  async run() {
    const { args } = await this.parse(AssetsNew)
    const kind = args.kind as 'stylesheet' | 'script'
    const where = assetDirs(await siteConfig())[kind]
    const file = join(
      where.dir,
      args.name.endsWith(where.extension) ? args.name : `${args.name}${where.extension}`,
    )
    if (existsSync(file)) this.fail('conflict', `${here(file)} already exists.`)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, assetScaffold(kind, relative(where.dir, file)))
    this.say(`  created  ${here(file)}`)
    return { created: here(file) }
  }
}
