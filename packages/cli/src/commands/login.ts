import { hostname } from 'node:os'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../base.ts'
import { signIn } from '../remote/client.ts'
import { connectRemote, keychain, openInBrowser } from '../support/remote.ts'

export default class Login extends BaseCommand {
  static override summary = 'sign in to a remote with a code you approve in its back office'
  static override description =
    'The sign-in is kept in your keychain. It waits for the approval, printing where to give it; no terminal is needed.'
  static override args = {
    remote: Args.string({ description: 'the remote; the only one, when there is one' }),
  }
  static override flags = {
    'no-browser': Flags.boolean({ summary: "don't open the approval page" }),
  }
  static override spec = {
    effects: 'non_idempotent',
    cardinality: 'single',
    outputFields: [{ name: 'remote', type: 'string' }],
    errors: ['not_found', 'auth', 'timeout', 'unavailable'],
  } as const

  async run() {
    const { args, flags } = await this.parse(Login)
    const { entry, discovery } = await connectRemote(args.remote, undefined)
    await signIn(discovery, keychain(), {
      clientName: `crombolo on ${hostname()}`,
      onCode: (code, url) => {
        this.progress(`  Approve this sign-in at ${url}`)
        this.progress(`  and check it shows   ${code}`)
        openInBrowser(url, flags['no-browser'])
      },
    })
    this.say(`  signed in to ${entry.name}`)
    return { remote: entry.name }
  }
}
