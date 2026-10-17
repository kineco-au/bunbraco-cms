import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mediaStoreFor, readRemoteMedia } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { discover, RemoteClient } from '../../remote/client.ts'
import { fetchReferencedMedia } from '../../remote/transfer.ts'
import { describeBytes } from '../../support/describe.ts'
import { keychain } from '../../support/remote.ts'
import { cwd, siteConfig } from '../../support/site.ts'

export default class MediaFetch extends BaseCommand {
  static override summary = "a lazily pulled site's media files, all of them now"
  static override description =
    'Exits 10 when a file could not be fetched; running it again fetches only what is missing.'
  static override spec = {
    effects: 'idempotent',
    cardinality: 'single',
    outputFields: [
      { name: 'fetched', type: 'integer' },
      { name: 'skipped', type: 'integer' },
      { name: 'bytes', type: 'integer' },
      { name: 'failed', type: 'array', items: { type: 'string' } },
    ],
    errors: ['not_found', 'auth', 'unavailable', 'io'],
  } as const

  async run() {
    await this.parse(MediaFetch)
    const source = readRemoteMedia(cwd())
    const listed = join(cwd(), '.crombolo', 'remote-media-blobs.json')
    if (!source || !existsSync(listed))
      this.fail(
        'not_found',
        'This site was not pulled with --lazy-media: there is nothing to fetch.',
      )
    const client = new RemoteClient(await discover(source.api), keychain())
    const blobs = JSON.parse(await Bun.file(listed).text()) as {
      key: string
      etag: string | null
    }[]
    const fetched = await fetchReferencedMedia(client, {
      environment: source.environment,
      blobs,
      store: await mediaStoreFor(await siteConfig()),
      siteDir: cwd(),
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) this.progress(`  ${done}/${total}`)
      },
    })
    this.say(
      `  media    ${fetched.fetched} fetched (${describeBytes(fetched.bytes)}), ${fetched.skipped} already here`,
    )
    if (fetched.failed.length > 0)
      this.fail(
        'io',
        `${fetched.failed.length} file(s) could not be fetched.`,
        'Run it again to fetch them.',
        fetched.failed,
      )
    return fetched
  }
}
