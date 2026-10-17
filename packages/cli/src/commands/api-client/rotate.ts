import { randomBytes } from 'node:crypto'
import { hashPassword } from '@crombolo/auth'
import { UserRepository } from '@crombolo/data'
import { bootstrapDatabase } from '@crombolo/server'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { siteConfig } from '../../support/site.ts'

/** A new secret for the API client a site seeds from its environment (story 034). */
export default class ApiClientRotate extends BaseCommand {
  static override summary = 'issue a new secret for the API client, and print it once'
  static override description =
    'The old secret stops working at once. Put the new one in CROMBOLO_API_CLIENT_SECRET: a start keeps the client it finds, so it never sets the secret back.'
  static override flags = {
    client: Flags.string({
      summary: 'the client id; CROMBOLO_API_CLIENT_ID when not given',
      helpValue: '<id>',
    }),
  }
  static override audit = {
    category: 'user',
    action: 'RotateClientSecret',
    entityType: 'User',
  } as const
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'client', type: 'string' },
      { name: 'secret', type: 'string' },
    ],
    errors: ['usage', 'not_found'],
  } as const

  async run() {
    const { flags } = await this.parse(ApiClientRotate)
    const config = await siteConfig()
    const client = flags.client ?? config.apiClient?.id
    if (!client)
      this.fail('usage', 'Which API client?', 'Pass --client <id>, or set CROMBOLO_API_CLIENT_ID.')
    const { db } = await bootstrapDatabase(config)
    try {
      const users = new UserRepository(db)
      const owner = await users.clientCredentialOwner(client)
      if (!owner) this.fail('not_found', `There is no API client "${client}".`)
      this.auditKey = client
      const secret = randomBytes(32).toString('base64url')
      await users.removeClientCredential(owner.userId, client)
      await users.addClientCredential(owner.userId, client, await hashPassword(secret))
      this.say(`  rotated  ${client}; put this in CROMBOLO_API_CLIENT_SECRET:`)
      this.say(secret)
      return { client, secret }
    } finally {
      await db.close()
    }
  }
}
