import { ContentTypeRepository, recordInLedger } from '@crombolo/data'
import { backupBefore, bootstrapDatabase } from '@crombolo/server'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { backupTaken } from '../../support/flags.ts'
import { siteConfig } from '../../support/site.ts'
import { needSchemaDir } from '../../support/types.ts'

export default class TypesPurge extends BaseCommand {
  static override summary = 'delete properties retired more than N days ago, with their values'
  static override aliases = ['schema:purge']
  static override deprecateAliases = true
  static override flags = {
    'older-than': Flags.integer({
      summary: 'how long, in days, a property must have been retired',
      required: true,
      min: 0,
    }),
    'backup-taken': backupTaken,
  }
  static override audit = { category: 'schema', action: 'Purge', entityType: 'Schema' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    outputFields: [
      { name: 'purged', type: 'array', items: { type: 'string' } },
      { name: 'backup', type: 'string', nullable: true },
      { name: 'changed', type: 'boolean' },
    ],
    errors: ['not_found', 'refused'],
  } as const

  async run() {
    const { flags } = await this.parse(TypesPurge)
    const days = flags['older-than']
    const config = await siteConfig()
    needSchemaDir(config)
    const backup = await backupBefore(config, {
      reason: 'purge',
      backupTaken: flags['backup-taken'],
    })
    if (backup.path) this.progress(`  backup   ${backup.path}`)
    const { db } = await bootstrapDatabase(config)
    try {
      const before = new Date(Date.now() - days * 86_400_000)
      const started = performance.now()
      const purged = (await new ContentTypeRepository(db).purgeRetired(before)).map(
        (p) => `${p.type}.${p.alias}`,
      )
      for (const name of purged) this.say(`  purged   ${name}`)
      if (purged.length === 0) this.say(`Nothing retired more than ${days} day(s) ago.`)
      else
        await recordInLedger(db, {
          name: `purge ${purged.join(', ')}`,
          kind: 'contract',
          durationMs: Math.round(performance.now() - started),
          appliedBy: config.nodeId,
          note: `--older-than ${days}`,
        })
      return { purged, backup: backup.path ?? null, changed: purged.length > 0 }
    } finally {
      await db.close()
    }
  }
}
