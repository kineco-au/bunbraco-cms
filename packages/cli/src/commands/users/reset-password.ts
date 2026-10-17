import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { checkStatus, describeUser, OPERATOR, openPeople, userNamed } from '../../support/people.ts'
import { readStdin } from '../../support/prompt.ts'
import { siteConfig } from '../../support/site.ts'

export default class UsersResetPassword extends BaseCommand {
  static override summary = 'give a user a new password, and end their sessions'
  static override description =
    "A new one is generated and printed, unless --stdin gives it. `admin reset-password` does the same for the site's own administrator."
  static override examples = [
    '<%= config.bin %> users reset-password editor@example.com',
    'printf %s "$PASSWORD" | <%= config.bin %> users reset-password editor@example.com --stdin',
  ]
  static override args = {
    user: Args.string({ required: true, description: 'their e-mail address or username' }),
  }
  static override flags = { stdin: Flags.boolean({ summary: 'read the new password from stdin' }) }
  static override audit = { category: 'user', action: 'ResetPassword', entityType: 'User' } as const
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'id', type: 'string' },
      { name: 'email', type: 'string' },
      {
        name: 'password',
        type: 'string',
        nullable: true,
        description: 'the generated one; null when given',
      },
    ],
    errors: ['not_found', 'usage', 'refused'],
  } as const

  async run() {
    const { args, flags } = await this.parse(UsersResetPassword)
    const given = flags.stdin ? await readStdin() : undefined
    if (flags.stdin && !given) this.fail('usage', 'Nothing came on stdin to use as the password.')
    const people = await openPeople(await siteConfig())
    try {
      const user = await userNamed(people, args.user)
      this.auditKey = user.key
      let password: string | null = null
      if (given) checkStatus(await people.users.changePassword(OPERATOR, user.key, given, null))
      else {
        const result = await people.users.resetPassword(OPERATOR, user.key)
        checkStatus(result.status)
        password = result.status === 'Success' ? result.value : null
      }
      this.say(`  reset    ${describeUser(user)}; their sessions are ended`)
      if (password) this.say(password)
      return { id: user.key, email: user.email, password }
    } finally {
      await people.db.close()
    }
  }
}
