import { writeSchemaFiles } from '@crombolo/schema'
import { BaseCommand } from '../../base.ts'
import { here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'
import { loadTypes, needSchemaDir, refuseProblems } from '../../support/types.ts'

export default class TypesRewrite extends BaseCommand {
  static override summary = 'rewrite every schema/ file canonically'
  static override description =
    'Every file in the canonical layout: a reviewable commit when the vocabulary changes.'
  static override aliases = ['schema:rewrite', 'upgrade:schema']
  static override deprecateAliases = true
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    outputFields: [{ name: 'wrote', type: 'array', items: { type: 'string' } }],
    errors: ['not_found', 'refused'],
  } as const

  async run() {
    await this.parse(TypesRewrite)
    const config = await siteConfig()
    needSchemaDir(config)
    const loaded = loadTypes(config)
    refuseProblems(loaded.problems)
    const wrote = writeSchemaFiles(config.schemaDir, loaded.set).map(here)
    for (const file of wrote) this.say(`  wrote  ${file}`)
    return { wrote }
  }
}
