import { UserGroupRepository } from '@crombolo/data'
import { BaseCommand } from '../../base.ts'
import { page, pageFlags, pagination } from '../../support/flags.ts'
import { OBSERVER, openPeople } from '../../support/people.ts'
import { siteConfig } from '../../support/site.ts'

export default class UsersList extends BaseCommand {
  static override summary = 'the back-office users: who, their groups, their state and last sign-in'
  static override flags = { ...pageFlags(50) }
  static override spec = {
    effects: 'read_only',
    cardinality: 'unbounded',
    pagination,
    fieldsArg: '--fields',
    outputFields: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'userName', type: 'string' },
      { name: 'kind', type: 'string', enum: ['Default', 'Api'] },
      { name: 'state', type: 'string' },
      { name: 'groups', type: 'array', items: { type: 'string' } },
      { name: 'failedLoginAttempts', type: 'integer' },
      { name: 'lastLoginDate', type: 'string', nullable: true },
    ],
  } as const

  async run() {
    const { flags } = await this.parse(UsersList)
    const people = await openPeople(await siteConfig())
    try {
      const found = await people.users.list(OBSERVER, flags.offset, flags.limit)
      const groups = new Map(
        (await new UserGroupRepository(people.db).all()).map((g) => [g.key, g.alias]),
      )
      const items = found.items.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        userName: user.userName,
        kind: user.kind,
        state: user.state,
        groups: user.userGroupIds.map((g) => groups.get(g.id) ?? g.id),
        failedLoginAttempts: user.failedLoginAttempts,
        lastLoginDate: user.lastLoginDate ?? null,
      }))
      if (items.length === 0) this.say('No users.')
      for (const user of items)
        this.say(
          `  ${user.state.padEnd(9)} ${user.name} <${user.email || user.userName}>  ${user.groups.join(', ') || 'no groups'}` +
            `${user.lastLoginDate ? `  last in ${user.lastLoginDate}` : '  never signed in'}`,
        )
      if (flags.offset + items.length < found.total)
        this.say(
          `  … ${found.total - flags.offset - items.length} more: --offset ${flags.offset + items.length}`,
        )
      return page(items, found.total, flags)
    } finally {
      await people.db.close()
    }
  }
}
