import { TransferRunRepository } from '@crombolo/data'
import { bootstrapDatabase } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { page, pageFlags, pagination } from '../../support/flags.ts'
import { siteConfig } from '../../support/site.ts'

export default class ContentRuns extends BaseCommand {
  static override summary = 'the imports applied here, newest first'
  static override flags = { ...pageFlags(20) }
  static override spec = {
    effects: 'read_only',
    cardinality: 'unbounded',
    pagination,
    fieldsArg: '--fields',
    outputFields: [
      { name: 'id', type: 'string' },
      { name: 'startedAt', type: 'string' },
      { name: 'direction', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'nodeCount', type: 'integer' },
      { name: 'bundleId', type: 'string' },
      { name: 'bundleLabel', type: 'string', nullable: true },
      { name: 'appliedBy', type: 'string', nullable: true },
    ],
  } as const

  async run() {
    const { flags } = await this.parse(ContentRuns)
    const { db } = await bootstrapDatabase(await siteConfig())
    try {
      const repository = new TransferRunRepository(db)
      const [runs, total] = await Promise.all([
        repository.recent(flags.limit, flags.offset),
        repository.count(),
      ])
      if (runs.length === 0) this.say('No content has been imported here.')
      const items = runs.map((run) => ({
        id: run.id,
        startedAt: run.startedAt.toISOString(),
        direction: run.direction,
        status: run.status,
        nodeCount: run.nodeCount,
        bundleId: run.bundleId,
        bundleLabel: run.bundleLabel ?? null,
        appliedBy: run.appliedBy ?? null,
      }))
      for (const run of items)
        this.say(
          `  ${run.startedAt}  ${run.direction.padEnd(6)} ${run.status.padEnd(8)} ` +
            `${run.id}  ${run.nodeCount} node(s)  bundle ${run.bundleId}` +
            `${run.appliedBy ? `  by ${run.appliedBy}` : ''}${run.bundleLabel ? `  (${run.bundleLabel})` : ''}`,
        )
      if (flags.offset + runs.length < total)
        this.say(
          `  … ${total - flags.offset - runs.length} more: --offset ${flags.offset + runs.length}`,
        )
      return page(items, total, flags)
    } finally {
      await db.close()
    }
  }
}
