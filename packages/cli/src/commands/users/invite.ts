import { UserGroupRepository } from '@crombolo/data'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { many } from '../../support/flags.ts'
import { checkStatus, OPERATOR, openPeople } from '../../support/people.ts'
import { siteConfig } from '../../support/site.ts'

export default class UsersInvite extends BaseCommand {
  static override summary = 'create a user and print the link they set their password with'
  static override description =
    'The link is printed rather than e-mailed, so it works on a site with no e-mail delivery. It is used once, and expires as an invitation does.'
  static override examples = [
    '<%= config.bin %> users invite editor@example.com --group editor --name "Ada Lovelace"',
  ]
  static override args = {
    email: Args.string({ required: true, description: 'their e-mail address' }),
  }
  static override flags = {
    group: many('a user group, by alias; repeatable', '<alias>'),
    name: Flags.string({ summary: 'their name; the address when not given', helpValue: '<name>' }),
  }
  static override audit = { category: 'user', action: 'Invite', entityType: 'User' } as const
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'id', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'groups', type: 'array', items: { type: 'string' } },
      { name: 'link', type: 'string' },
    ],
    errors: ['usage', 'not_found', 'conflict', 'refused'],
  } as const

  async run() {
    const { args, flags } = await this.parse(UsersInvite)
    if (flags.group.length === 0)
      this.fail('usage', 'An invited user needs at least one group.', 'Pass --group <alias>.')
    const config = await siteConfig()
    const people = await openPeople(config)
    try {
      const repository = new UserGroupRepository(people.db)
      const groupKeys: string[] = []
      for (const alias of flags.group) {
        const group = await repository.byAlias(alias)
        if (!group)
          this.fail(
            'not_found',
            `There is no user group "${alias}".`,
            `It has: ${(await repository.all()).map((g) => g.alias).join(', ')}.`,
          )
        groupKeys.push(group.key)
      }
      const result = await people.users.invite(
        OPERATOR,
        {
          kind: 'Default',
          email: args.email,
          userName: args.email,
          name: flags.name ?? args.email,
          groupKeys,
        },
        null,
      )
      checkStatus(result.status)
      const id = result.status === 'Success' ? result.value : ''
      this.auditKey = id
      const captured = people.lastLink() ?? ''
      // Without an application URL the link is relative: it is the path on the site's own address.
      const link = config.applicationUrl ? captured : captured.replace(/^[^/]*/, '')
      this.say(`  invited  ${args.email} to ${flags.group.join(', ')}`)
      this.say(link)
      if (!config.applicationUrl)
        this.warning(
          '  note     the link is a path on the site: set CROMBOLO_APPLICATION_URL to print the whole address',
        )
      return { id, email: args.email, groups: flags.group, link }
    } finally {
      await people.db.close()
    }
  }
}
