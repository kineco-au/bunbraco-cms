import { Args } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import {
  checkStatus,
  describeUser,
  OBSERVER,
  OPERATOR,
  openPeople,
  userNamed,
} from '../../support/people.ts'
import { siteConfig } from '../../support/site.ts'

export default class UsersDisable extends BaseCommand {
  static override summary = 'stop a user signing in, and end their sessions'
  static override args = {
    user: Args.string({ required: true, description: 'their e-mail address or username' }),
  }
  static override audit = { category: 'user', action: 'Disable', entityType: 'User' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'id', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'changed', type: 'boolean' },
    ],
    errors: ['not_found', 'refused'],
  } as const

  async run() {
    const { args } = await this.parse(UsersDisable)
    const people = await openPeople(await siteConfig())
    try {
      const user = await userNamed(people, args.user)
      this.auditKey = user.key
      const snapshot = async () => {
        const found = await people.users.get(OBSERVER, user.key)
        return found.status === 'Success'
          ? { state: found.value.state, failed: found.value.failedLoginAttempts }
          : { state: 'unknown', failed: 0 }
      }
      const before = await snapshot()
      checkStatus(await people.users.setApproved(OPERATOR, [user.key], false))
      const after = await snapshot()
      const state = after.state
      const changed = before.state !== after.state || before.failed !== after.failed
      this.say(`  disabled  ${describeUser(user)}${changed ? '' : ' (no change)'}`)
      return { id: user.key, email: user.email, state, changed }
    } finally {
      await people.db.close()
    }
  }
}
