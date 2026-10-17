import { listAssets } from '@crombolo/server'
import { BaseCommand } from '../../base.ts'
import { here } from '../../support/describe.ts'
import { siteConfig } from '../../support/site.ts'

/** The stylesheets and scripts the backoffice also edits. */
export default class AssetsList extends BaseCommand {
  static override summary = 'the stylesheets and scripts this site has'
  static override spec = {
    effects: 'read_only',
    cardinality: 'bounded',
    // One item of `items`, as clispec reads a collection.
    outputFields: [
      { name: 'kind', type: 'string' },
      { name: 'path', type: 'string' },
    ],
  } as const

  async run() {
    await this.parse(this.ctor)
    const found = listAssets(await siteConfig())
    if (found.length === 0) this.say('No stylesheets or scripts here.')
    const items = found.map((asset) => ({ kind: asset.kind, path: here(asset.path) }))
    for (const asset of items) this.say(`  ${asset.kind.padEnd(10)} ${asset.path}`)
    return { items }
  }
}
