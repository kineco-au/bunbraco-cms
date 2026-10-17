import { connect, readLedger } from '@crombolo/data'
import { BaseCommand } from '../../base.ts'
import { page, pageFlags, pagination } from '../../support/flags.ts'
import { siteConfig } from '../../support/site.ts'

export default class UpgradeLedger extends BaseCommand {
  static override summary = 'print migration_history: every migration, sync and import applied here'
  static override flags = { ...pageFlags(1000) }
  static override spec = {
    effects: 'read_only',
    cardinality: 'unbounded',
    pagination,
    fieldsArg: '--fields',
    outputFields: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'string' },
      { name: 'kind', type: 'string' },
      { name: 'appliedAt', type: 'string' },
      { name: 'durationMs', type: 'integer' },
      { name: 'appliedBy', type: 'string', nullable: true },
      { name: 'bundle', type: 'string', nullable: true },
      { name: 'note', type: 'string', nullable: true },
    ],
  } as const

  async run() {
    const { flags } = await this.parse(UpgradeLedger)
    const config = await siteConfig()
    const db = await connect({ file: config.sqliteFile })
    try {
      const rows = await readLedger(db)
      const items = rows.slice(flags.offset, flags.offset + flags.limit).map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        appliedAt: row.appliedAt,
        durationMs: row.durationMs,
        appliedBy: row.appliedBy ?? null,
        bundle: row.bundle ?? null,
        note: row.note ?? null,
      }))
      for (const row of items)
        this.say(
          `  ${row.appliedAt}  ${row.kind.padEnd(8)} ${row.bundle ? `[${row.bundle}] ` : ''}${row.name}  ${row.durationMs}ms${row.appliedBy ? `  by ${row.appliedBy}` : ''}${row.note ? `  (${row.note})` : ''}`,
        )
      if (flags.offset + items.length < rows.length)
        this.say(
          `  … ${rows.length - flags.offset - items.length} more: --offset ${flags.offset + items.length}`,
        )
      return page(items, rows.length, flags)
    } finally {
      await db.close()
    }
  }
}
