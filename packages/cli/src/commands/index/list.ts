import { SEARCH_INDEXES, SearchIndex } from '@crombolo/data'
import { bootstrapDatabase } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { siteConfig } from '../../support/site.ts'

export default class IndexList extends BaseCommand {
  static override summary = 'the search indexes: what each holds, and what is waiting to be indexed'
  static override spec = {
    effects: 'read_only',
    cardinality: 'bounded',
    outputFields: [
      { name: 'name', type: 'string' },
      { name: 'documents', type: 'integer' },
      { name: 'fields', type: 'integer' },
      { name: 'pending', type: 'integer' },
      { name: 'healthy', type: 'boolean', description: 'nothing waiting to be indexed' },
    ],
  } as const

  async run() {
    await this.parse(IndexList)
    const { db } = await bootstrapDatabase(await siteConfig())
    try {
      const search = new SearchIndex(db)
      const items = []
      for (const index of SEARCH_INDEXES) {
        const stats = await search.stats(index)
        items.push({
          name: index.name,
          documents: stats.documentCount,
          fields: stats.fieldCount,
          pending: stats.pending,
          healthy: stats.pending === 0,
        })
      }
      for (const index of items)
        this.say(
          `  ${index.name.padEnd(14)} ${index.documents} item(s), ${index.fields} field(s)${index.pending > 0 ? `, ${index.pending} waiting` : ''}`,
        )
      return { items }
    } finally {
      await db.close()
    }
  }
}
