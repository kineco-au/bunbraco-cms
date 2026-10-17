import { appendCacheInstruction, latestCacheInstructionId, liveNodes } from '@crombolo/data'
import { bootstrapDatabase } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { siteConfig } from '../../support/site.ts'

/**
 * Each node keeps its own published cache, so this asks all of them, the way an
 * editor's save does: a cache instruction every node acts on at its next poll.
 */
export default class CacheRebuild extends BaseCommand {
  static override summary = 'rebuild the published cache on every node of the site'
  static override description =
    'Each node rebuilds at its next poll, within a few seconds. Nothing has to be reachable from here but the database.'
  static override audit = {
    category: 'system',
    action: 'RebuildCache',
    entityType: 'Cache',
  } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'instruction', type: 'integer' },
      {
        name: 'nodes',
        type: 'array',
        items: { type: 'string' },
        description: 'the nodes seen in the last minute',
      },
    ],
  } as const

  async run() {
    await this.parse(CacheRebuild)
    const config = await siteConfig()
    const { db } = await bootstrapDatabase(config)
    try {
      // Stamped as the command line, never as a node: a node skips its own.
      await appendCacheInstruction(db, {
        kind: 'content',
        payload: { all: true, reason: 'crombolo cache rebuild' },
        by: `cli:${config.nodeId}`,
      })
      const instruction = await latestCacheInstructionId(db)
      const nodes = (await liveNodes(db, { seenWithinMs: 60_000 })).map((node) => node.nodeId)
      this.say(
        nodes.length > 0
          ? `  asked    ${nodes.length} node(s) to rebuild: ${nodes.join(', ')}`
          : '  asked    every node to rebuild; none has been seen in the last minute',
      )
      return { instruction, nodes }
    } finally {
      await db.close()
    }
  }
}
