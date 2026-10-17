import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { NodeRow } from '@crombolo/data'
import { bootstrapDatabase, mediaFileOf, safeFileName } from '@crombolo/server'
import { Args, Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { here } from '../../support/describe.ts'
import { childrenByName, mediaParent, openMedia } from '../../support/media-tree.ts'
import { siteConfig } from '../../support/site.ts'

/** The media library, or a folder of it, back out as files in folders. */
export default class MediaExport extends BaseCommand {
  static override summary = 'write media files back out as a folder tree'
  static override examples = ['<%= config.bin %> media export /Gallery --out ./gallery']
  static override args = {
    folder: Args.string({
      description: 'a media folder, as a path or uuid; everything when not given',
    }),
  }
  static override flags = {
    out: Flags.string({ summary: 'the folder to write into', helpValue: '<dir>', required: true }),
  }
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    outputFields: [
      { name: 'out', type: 'string' },
      { name: 'files', type: 'integer' },
      { name: 'bytes', type: 'integer' },
      {
        name: 'missing',
        type: 'array',
        items: { type: 'string' },
        description: 'items whose file is not in the store',
      },
    ],
    errors: ['not_found'],
  } as const

  async run() {
    const { args, flags } = await this.parse(MediaExport)
    const config = await siteConfig()
    const { db } = await bootstrapDatabase(config)
    try {
      const tree = await openMedia(db, config)
      const start = await mediaParent(db, args.folder)
      const out = resolve(flags.out)
      let files = 0
      let bytes = 0
      const missing: string[] = []

      const write = async (node: NodeRow, dir: string) => {
        const media = await tree.repo.byKey(node.key)
        const src = media ? mediaFileOf(media) : null
        const name = node.text ?? node.key
        if (!src) {
          // A folder, or an item with nothing uploaded: its children follow.
          const children = await childrenByName(tree, node)
          if (children.size === 0 && media) return
          const into = join(dir, safeFileName(name))
          for (const child of children.values()) await write(child, into)
          return
        }
        const stored = await tree.files.open(src)
        if (!stored) {
          missing.push(name)
          return
        }
        const extension = extname(src)
        const fileName = safeFileName(
          extname(name).toLowerCase() === extension.toLowerCase() ? name : `${name}${extension}`,
        )
        const content = await stored.bytes()
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, fileName), content)
        files += 1
        bytes += content.length
      }

      if (start) await write(start, out)
      else for (const child of (await childrenByName(tree, null)).values()) await write(child, out)
      mkdirSync(out, { recursive: true })
      this.say(`  wrote    ${files} file(s) to ${here(out)}`)
      for (const name of missing)
        this.warning(`  missing  ${name}: its file is not in the media store`)
      return { out: here(out), files, bytes, missing }
    } finally {
      await db.close()
    }
  }
}
