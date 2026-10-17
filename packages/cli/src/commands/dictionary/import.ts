import { existsSync } from 'node:fs'
import { bootstrapDatabase, importDictionaryUdt } from '@crombolo/server'
import { Args } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { siteConfig } from '../../support/site.ts'

export default class DictionaryImport extends BaseCommand {
  static override summary = 'apply a .udt file: items upsert by key'
  static override description =
    'A translation for a language this site has not got is skipped, and said so.'
  static override args = { file: Args.string({ required: true, description: 'the .udt file' }) }
  static override audit = {
    category: 'settings',
    action: 'Import',
    entityType: 'DictionaryItem',
  } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'imported', type: 'integer' },
      { name: 'skipped', type: 'array', items: { type: 'string' } },
    ],
    errors: ['not_found', 'refused'],
  } as const

  async run() {
    const { args } = await this.parse(DictionaryImport)
    if (!existsSync(args.file)) this.fail('not_found', `No file at ${args.file}.`)
    const { db } = await bootstrapDatabase(await siteConfig())
    try {
      const outcome = await importDictionaryUdt(db, await Bun.file(args.file).text(), null)
      if (!outcome.ok) this.fail('refused', `refused: ${outcome.reason}`)
      this.say(`  imported ${outcome.imported} item(s)`)
      // Umbraco's own behaviour, and worth saying out loud rather than dropping
      // translations silently: a language this site has not got is skipped.
      if (outcome.skipped.length > 0)
        this.say(
          `  skipped  translations for ${outcome.skipped.join(', ')} — no such language here`,
        )
      return { imported: outcome.imported, skipped: outcome.skipped }
    } finally {
      await db.close()
    }
  }
}
