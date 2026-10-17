import { Args } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { describeUser, openPeople, userNamed } from '../../support/people.ts'
import { siteConfig } from '../../support/site.ts'

/** For someone who has lost their authenticator: their next sign-in enrols again. */
export default class UsersReset2fa extends BaseCommand {
  static override summary =
    "remove a user's second factors, so their next sign-in sets one up again"
  static override args = {
    user: Args.string({ required: true, description: 'their e-mail address or username' }),
  }
  static override audit = {
    category: 'user',
    action: 'ResetTwoFactor',
    entityType: 'User',
  } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'id', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'removed', type: 'array', items: { type: 'string' } },
      { name: 'changed', type: 'boolean' },
    ],
    errors: ['not_found'],
  } as const

  async run() {
    const { args } = await this.parse(UsersReset2fa)
    const people = await openPeople(await siteConfig())
    try {
      const user = await userNamed(people, args.user)
      this.auditKey = user.key
      const removed = await people.twoFactor.providers(user.key)
      await people.twoFactor.reset(user.key)
      this.say(
        removed.length > 0
          ? `  removed  ${removed.join(', ')} from ${describeUser(user)}`
          : `  ${describeUser(user)} has no second factor; nothing changed`,
      )
      return { id: user.key, email: user.email, removed, changed: removed.length > 0 }
    } finally {
      await people.db.close()
    }
  }
}
