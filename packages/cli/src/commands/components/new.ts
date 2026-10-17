import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { viewScaffold } from '@crombolo/schema'
import { componentFileFor, componentScaffold, isSafeAlias } from '@crombolo/server'
import { Args } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { declaredTypes } from '../../support/components.ts'
import { here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'

export default class ComponentsNew extends BaseCommand {
  static override summary = 'components/<alias>.tsx; the alias may carry folders'
  static override examples = ['<%= config.bin %> components new pages/article']
  static override args = {
    alias: Args.string({ required: true, description: "the component's alias" }),
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'created', type: 'string' },
      { name: 'template', type: 'boolean' },
    ],
    errors: ['usage', 'conflict'],
  } as const

  async run() {
    const { args } = await this.parse(ComponentsNew)
    const config = await siteConfig()
    if (!isSafeAlias(args.alias))
      this.fail('usage', `"${args.alias}" is not a path inside ${here(config.componentsDir)}.`)
    const file = componentFileFor(config.componentsDir, args.alias)
    if (existsSync(file)) this.fail('conflict', `${here(file)} already exists.`)
    // A content type that names this alias gets the page scaffold, which takes
    // PageProps; anything else gets the plain one. Nothing turns on the folder.
    const type = declaredTypes(config).find((candidate) =>
      candidate.components.includes(args.alias),
    )
    if (!type)
      this.say(
        `  note     no content type declares the template "${args.alias}" — add it to one's templates, or \`crombolo types new\``,
      )
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, type ? viewScaffold(type) : componentScaffold(args.alias))
    this.say(`  created  ${here(file)}`)
    return { created: here(file), template: Boolean(type) }
  }
}
