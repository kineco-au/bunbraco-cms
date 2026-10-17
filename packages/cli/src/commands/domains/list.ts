import { DomainRepository, NodeRepository } from '@crombolo/data'
import { bootstrapDatabase, DOMAINS_FILE, resolvePlaceholders } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { readDeclarations } from '../../support/domains.ts'
import { siteConfig } from '../../support/site.ts'

export default class DomainsList extends BaseCommand {
  static override summary = 'the hostnames domains.toml declares, and what is bound here'
  static override spec = {
    effects: 'read_only',
    cardinality: 'bounded',
    outputFields: [
      {
        name: 'file',
        type: 'array',
        items: {
          type: 'object',
          fields: [
            { name: 'node', type: 'string' },
            { name: 'host', type: 'string' },
            { name: 'resolved', type: 'string' },
            { name: 'missing', type: 'array', items: { type: 'string' } },
            { name: 'culture', type: 'string', nullable: true },
          ],
        },
      },
      {
        name: 'bound',
        type: 'array',
        items: {
          type: 'object',
          fields: [
            { name: 'node', type: 'string' },
            { name: 'host', type: 'string' },
            { name: 'culture', type: 'string', nullable: true },
          ],
        },
      },
    ],
  } as const

  async run() {
    await this.parse(this.ctor)
    const config = await siteConfig()
    const { read, declarations } = readDeclarations(this, config)
    const { db } = await bootstrapDatabase(config)
    try {
      if (!read) this.say(`No ${DOMAINS_FILE}; nothing is deployed from a file here.`)
      const file = declarations.map((declaration) => {
        const resolved = resolvePlaceholders(declaration.host)
        // What the file says, and what it comes to here, which is the whole
        // point of a placeholder and the first thing to check when one is wrong.
        const note =
          resolved.missing.length > 0
            ? `  (${resolved.missing.join(', ')} not set here)`
            : resolved.value !== declaration.host
              ? ` → ${resolved.value}`
              : ''
        this.say(
          `  file     ${declaration.node.padEnd(24)} ${declaration.host}${note}${declaration.culture ? `  ${declaration.culture}` : ''}`,
        )
        return {
          node: declaration.node,
          host: declaration.host,
          resolved: resolved.value,
          missing: resolved.missing,
          culture: declaration.culture ?? null,
        }
      })
      // What the database actually answers on, which is the thing a person is
      // usually asking about when a hostname is not working.
      const nodes = new NodeRepository(db)
      const bound = []
      for (const row of await new DomainRepository(db).all()) {
        const node = (await nodes.byId(row.nodeId))?.text ?? String(row.nodeId)
        this.say(
          `  bound    ${node.padEnd(24)} ${row.domainName}${row.isoCode ? `  ${row.isoCode}` : ''}`,
        )
        bound.push({ node, host: row.domainName, culture: row.isoCode ?? null })
      }
      return { file, bound }
    } finally {
      await db.close()
    }
  }
}
