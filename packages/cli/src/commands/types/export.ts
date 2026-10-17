import { existsSync } from 'node:fs'
import { exportSchemaSet, writeSchemaFiles } from '@crombolo/schema'
import { bootstrapDatabase } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'
import { loadTypes } from '../../support/types.ts'

export default class TypesExport extends BaseCommand {
  static override summary = "write the database's definitions as schema/ files"
  static override aliases = ['schema:export']
  static override deprecateAliases = true
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    outputFields: [{ name: 'wrote', type: 'array', items: { type: 'string' } }],
  } as const

  async run() {
    await this.parse(TypesExport)
    const config = await siteConfig()
    const { db } = await bootstrapDatabase(config)
    try {
      const version = existsSync(config.schemaDir) ? loadTypes(config).set.version : '1.0.0'
      const wrote = writeSchemaFiles(config.schemaDir, await exportSchemaSet(db, version)).map(here)
      for (const file of wrote) this.say(`  wrote  ${file}`)
      return { wrote }
    } finally {
      await db.close()
    }
  }
}
