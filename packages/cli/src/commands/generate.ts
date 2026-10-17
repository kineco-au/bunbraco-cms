import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateTypes, validateSchemaSet } from '@crombolo/schema'
import { formTypesFor } from '@crombolo/server'
import { BaseCommand } from '../base.ts'
import { here } from '../support/describe.ts'
import { siteConfig } from '../support/site.ts'
import { loadTypes, refuseProblems } from '../support/types.ts'

export default class Generate extends BaseCommand {
  static override summary = 'TypeScript for the content types in schema/'
  static override description = 'Writes schema/content-types.d.ts.'
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [{ name: 'wrote', type: 'string' }],
    errors: ['refused'],
  } as const

  async run() {
    await this.parse(Generate)
    const config = await siteConfig()
    const loaded = loadTypes(config)
    refuseProblems([
      ...loaded.problems,
      ...validateSchemaSet(loaded.set, { types: formTypesFor(config) }),
    ])
    const target = join(config.schemaDir, 'content-types.d.ts')
    await writeFile(target, generateTypes(loaded.set))
    this.say(`  wrote  ${here(target)}`)
    return { wrote: here(target) }
  }
}
