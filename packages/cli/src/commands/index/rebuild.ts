import { SEARCH_INDEXES, SearchIndex } from '@crombolo/data'
import { bootstrapDatabase } from '@crombolo/server'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { siteConfig } from '../../support/site.ts'

/**
 * The index lives in the database, so rebuilding it here rebuilds it for every
 * node: there is no copy per server to reach. Search keeps answering from the
 * old entries while each item is indexed again.
 */
export default class IndexRebuild extends BaseCommand {
  static override summary = 'index every item again, for every node: the index is in the database'
  static override description =
    'Search keeps answering while it runs. --queue-only queues everything and leaves the indexing to the running site.'
  static override args = {
    index: Args.string({
      description: 'one index; both when not given',
      options: SEARCH_INDEXES.map((index) => index.name),
    }),
  }
  static override flags = {
    'queue-only': Flags.boolean({ summary: 'queue everything, and let the site index it' }),
  }
  static override audit = {
    category: 'system',
    action: 'RebuildIndex',
    entityType: 'Index',
  } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'indexes', type: 'array', items: { type: 'string' } },
      { name: 'indexed', type: 'integer', description: 'items indexed here; 0 with --queue-only' },
      { name: 'queued', type: 'boolean' },
    ],
  } as const

  async run() {
    const { args, flags } = await this.parse(IndexRebuild)
    const chosen = SEARCH_INDEXES.filter((index) => !args.index || index.name === args.index)
    this.auditKey = args.index
    const { db } = await bootstrapDatabase(await siteConfig())
    try {
      const search = new SearchIndex(db)
      for (const index of chosen) await search.rebuild(index)
      const names = chosen.map((index) => index.name)
      if (flags['queue-only']) {
        this.say(`  queued   ${names.join(', ')}: the running site indexes it`)
        return { indexes: names, indexed: 0, queued: true }
      }
      let indexed = 0
      for (;;) {
        const batch = await search.indexQueued()
        if (batch === 0) break
        indexed += batch
        this.progress(`  indexed  ${indexed}`)
      }
      this.say(`  rebuilt  ${names.join(', ')}: ${indexed} item(s) indexed`)
      return { indexes: names, indexed, queued: false }
    } finally {
      await db.close()
    }
  }
}
