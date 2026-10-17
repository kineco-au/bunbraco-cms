import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DictionaryRepository } from '@crombolo/data'
import { bootstrapDatabase, dictionaryToUdt, writeDictionaryUdt } from '@crombolo/server'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'

/**
 * The dictionary stays in the database, because translators work in
 * production where `schema/` is read-only — so this is how a lower environment
 * gets the translations.
 */
export default class DictionaryExport extends BaseCommand {
  static override summary = "the dictionary as Umbraco's .udt, to seed another environment"
  static override flags = {
    out: Flags.string({ summary: 'the file to write', helpValue: '<file.udt>', required: true }),
    key: Flags.string({ summary: 'only this item and its children', helpValue: '<uuid>' }),
  }
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'wrote', type: 'string' },
      { name: 'items', type: 'integer' },
    ],
    errors: ['not_found'],
  } as const

  async run() {
    const { flags } = await this.parse(DictionaryExport)
    const { db } = await bootstrapDatabase(await siteConfig())
    try {
      const items = await dictionaryToUdt(new DictionaryRepository(db), flags.key)
      if (items.length === 0)
        this.fail('not_found', 'Nothing to export: this site has no dictionary items.')
      await mkdir(join(flags.out, '..'), { recursive: true })
      await writeFile(flags.out, writeDictionaryUdt(items))
      const count = (list: typeof items): number =>
        list.reduce((total, item) => total + 1 + count(item.children), 0)
      this.say(`  wrote    ${here(flags.out)}`)
      this.say(`  items    ${count(items)}`)
      return { wrote: here(flags.out), items: count(items) }
    } finally {
      await db.close()
    }
  }
}
