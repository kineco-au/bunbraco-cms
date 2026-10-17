import { readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { appendCacheInstruction, type NodeRow } from '@crombolo/data'
import { bootstrapDatabase, mediaFileOf } from '@crombolo/server'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { dryRun } from '../../support/flags.ts'
import { childrenByName, mediaParent, openMedia, sha256 } from '../../support/media-tree.ts'
import { siteConfig } from '../../support/site.ts'

interface Outcome {
  path: string
  action: 'created' | 'folder' | 'skipped' | 'differs' | 'unsupported'
  type?: string
}

/**
 * A folder of files into the media library: a media folder for each directory,
 * an item for each file, typed by its extension as an upload is. A file already
 * there with the same bytes is skipped, so an import that stopped part-way runs
 * again from where it got to.
 */
export default class MediaImport extends BaseCommand {
  static override summary = 'import a folder of files into the media library, keeping its folders'
  static override description = [
    'Each directory becomes a media folder and each file a media item, typed by its extension as an upload is. Files no media type takes are reported and left.',
    'Run it again after a stop: a file already imported with the same bytes is skipped, and one whose bytes differ is reported and left alone.',
  ].join('\n\n')
  static override examples = ['<%= config.bin %> media import ./photos --under /Gallery --dry-run']
  static override args = {
    dir: Args.string({ required: true, description: 'the folder to import' }),
  }
  static override flags = {
    under: Flags.string({
      summary: 'the media folder to import into; the root when not given',
      helpValue: '<path|uuid>',
    }),
    'dry-run': dryRun,
  }
  static override audit = { category: 'media', action: 'Import', entityType: 'Media' } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    outputFields: [
      { name: 'created', type: 'integer' },
      { name: 'folders', type: 'integer' },
      { name: 'skipped', type: 'integer' },
      { name: 'differs', type: 'array', items: { type: 'string' } },
      { name: 'unsupported', type: 'array', items: { type: 'string' } },
      { name: 'changed', type: 'boolean' },
    ],
    errors: ['not_found', 'io'],
  } as const

  async run() {
    const { args, flags } = await this.parse(MediaImport)
    const root = resolve(args.dir)
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
      this.fail('not_found', `${args.dir} is not a folder.`)
    const config = await siteConfig()
    const { db } = await bootstrapDatabase(config)
    try {
      const tree = await openMedia(db, config)
      const parent = await mediaParent(db, flags.under)
      const folderTypes = await tree.port.folderTypes()
      const folderType = folderTypes.find((t) => t.name === 'Folder') ?? folderTypes[0]
      if (!folderType) this.fail('refused', 'This site has no media folder type to import into.')
      const typeFor = new Map<string, { key: string; name: string } | undefined>()
      const outcomes: Outcome[] = []
      const dry = flags['dry-run']

      const walk = async (dir: string, into: NodeRow | null, intoKey: string | null) => {
        const existing =
          into || !dry ? await childrenByName(tree, into) : new Map<string, NodeRow>()
        for (const name of readdirSync(dir).sort()) {
          if (name.startsWith('.')) continue
          const path = join(dir, name)
          const shown = relative(root, path)
          if (statSync(path).isDirectory()) {
            let folder = existing.get(name) ?? null
            if (!folder) {
              outcomes.push({ path: shown, action: 'folder' })
              if (!dry) {
                const key = crypto.randomUUID()
                await tree.repo.create({
                  key,
                  contentTypeKey: folderType.key,
                  componentKey: null,
                  parentKey: intoKey,
                  values: [],
                  variants: [{ culture: null, segment: null, name }],
                })
                folder = (await tree.nodes.byKey(key)) ?? null
              }
            }
            await walk(path, folder, folder?.key ?? null)
            continue
          }
          const extension = extname(name).slice(1).toLowerCase()
          if (!typeFor.has(extension)) {
            const types = await tree.port.typesForExtension(extension)
            typeFor.set(extension, types.find((t) => t.matched) ?? types[0])
          }
          const type = typeFor.get(extension)
          if (!type) {
            outcomes.push({ path: shown, action: 'unsupported' })
            continue
          }
          const bytes = await Bun.file(path).bytes()
          const there = existing.get(name)
          if (there) {
            const media = await tree.repo.byKey(there.key)
            const src = media ? mediaFileOf(media) : null
            const stored = src ? await tree.files.open(src) : undefined
            const same = stored ? sha256(await stored.bytes()) === sha256(bytes) : false
            outcomes.push({ path: shown, action: same ? 'skipped' : 'differs', type: type.name })
            continue
          }
          outcomes.push({ path: shown, action: 'created', type: type.name })
          if (dry) continue
          const upload = crypto.randomUUID()
          await tree.files.saveTemporary(upload, new File([bytes], name))
          await tree.repo.create({
            key: crypto.randomUUID(),
            contentTypeKey: type.key,
            componentKey: null,
            parentKey: intoKey,
            values: [
              {
                alias: 'umbracoFile',
                culture: null,
                segment: null,
                value: { temporaryFileId: upload },
              },
            ],
            variants: [{ culture: null, segment: null, name }],
          })
          const made = outcomes.filter((o) => o.action === 'created').length
          if (made % 25 === 0) this.progress(`  imported ${made}`)
        }
      }
      await walk(root, parent, parent?.key ?? null)

      const count = (action: Outcome['action']) => outcomes.filter((o) => o.action === action)
      const verb = dry ? 'would create' : 'created'
      for (const o of outcomes.filter((o) => o.action !== 'skipped'))
        this.say(
          `  ${(o.action === 'created' ? verb : o.action === 'folder' ? `${verb} folder` : o.action).padEnd(20)} ${o.path}${o.type ? `  (${o.type})` : ''}`,
        )
      this.say(
        `\n  ${count('created').length} file(s) and ${count('folder').length} folder(s) ${dry ? 'to create' : 'created'}, ${count('skipped').length} already here` +
          `${count('differs').length > 0 ? `, ${count('differs').length} differ` : ''}${count('unsupported').length > 0 ? `, ${count('unsupported').length} no media type takes` : ''}`,
      )
      const changed = !dry && (count('created').length > 0 || count('folder').length > 0)
      if (dry) this.changedNothing = true
      // Once for the run: the nodes refresh what shows media.
      if (changed)
        await appendCacheInstruction(db, {
          kind: 'content',
          payload: { media: true },
          by: `cli:${config.nodeId}`,
        })
      return {
        created: count('created').length,
        folders: count('folder').length,
        skipped: count('skipped').length,
        differs: count('differs').map((o) => o.path),
        unsupported: count('unsupported').map((o) => o.path),
        changed,
      }
    } finally {
      await db.close()
    }
  }
}
