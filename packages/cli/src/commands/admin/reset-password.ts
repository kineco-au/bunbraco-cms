import { AuthStore, resetAdminPassword } from '@crombolo/auth'
import { bootstrapDatabase } from '@crombolo/server'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { readStdin } from '../../support/prompt.ts'
import { siteConfig } from '../../support/site.ts'

export default class AdminResetPassword extends BaseCommand {
  static override summary = "reset the administrator's password and print it"
  static override description =
    'A new one is generated unless --stdin gives it, so it never sits in shell history.'
  static override examples = [
    '<%= config.bin %> admin reset-password',
    'printf %s "$PASSWORD" | <%= config.bin %> admin reset-password --stdin',
  ]
  static override args = {
    password: Args.string({ hidden: true, description: 'deprecated: use --stdin' }),
  }
  static override flags = {
    stdin: Flags.boolean({ summary: 'read the new password from stdin' }),
  }
  static override audit = { category: 'user', action: 'ResetPassword', entityType: 'User' } as const
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'login', type: 'string' },
      { name: 'password', type: 'string' },
    ],
    errors: ['not_found'],
  } as const

  async run() {
    const { args, flags } = await this.parse(AdminResetPassword)
    if (args.password)
      this.warning('  deprecated  a password on the command line: pipe it to --stdin instead')
    const given = flags.stdin ? await readStdin() : args.password
    const config = await siteConfig()
    // The database, not the server: resetting a password has nothing to do with
    // the schema sync, the caches or the port, and should not need them to be
    // healthy to work.
    const { db } = await bootstrapDatabase(config)
    const result = await resetAdminPassword(
      new AuthStore(db),
      config.adminLogin,
      given || undefined,
    )
    await db.close()
    if (!result) this.fail('not_found', `No account '${config.adminLogin}'.`)
    this.say(`${result.login}\n${result.password}`)
    return { login: result.login, password: result.password }
  }
}
