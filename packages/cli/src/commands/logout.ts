import { forgetSignIn, readSignIn } from '@crombolo/server'
import { Args } from '@oclif/core'
import { BaseCommand } from '../base.ts'
import { connectRemote, keychain } from '../support/remote.ts'

export default class Logout extends BaseCommand {
  static override summary = 'sign out of a remote, here and at the remote'
  static override args = {
    remote: Args.string({ description: 'the remote; the only one, when there is one' }),
  }
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'remote', type: 'string' },
      { name: 'changed', type: 'boolean' },
    ],
    errors: ['not_found', 'unavailable'],
  } as const

  async run() {
    const { args } = await this.parse(Logout)
    const { entry, discovery } = await connectRemote(args.remote, undefined)
    const signedIn = await readSignIn(keychain(), discovery.api)
    // Ended at the remote too, best effort: the device leaves "Signed-in devices".
    if (signedIn)
      await fetch(signedIn.tokenUrl.replace(/\/token$/, '/revoke'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: signedIn.accessToken }).toString(),
      }).catch(() => undefined)
    await forgetSignIn(keychain(), discovery.api)
    this.say(`  signed out of ${entry.name}`)
    return { remote: entry.name, changed: signedIn !== undefined }
  }
}
