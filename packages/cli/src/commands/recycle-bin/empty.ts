import { ObjectTypes } from '@crombolo/core'
import {
  appendCacheInstruction,
  currentSchemaState,
  DocumentRepository,
  type NodeRow,
} from '@crombolo/data'
import { bootstrapDatabase, MediaFileStore, mediaFileOf, mediaStoreFor } from '@crombolo/server'
import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base.ts'
import { dryRun } from '../../support/flags.ts'
import { confirm } from '../../support/prompt.ts'
import { siteConfig } from '../../support/site.ts'

/** Deletes for good what is in the recycle bin: pages, media and their files. */
export default class RecycleBinEmpty extends BaseCommand {
  static override summary = 'delete what is in the recycle bin, for good'
  static override description = [
    'Pages and media both, unless --content or --media names one. --older-than keeps what was trashed recently; an item trashed before crombolo recorded when is kept by it too, and counted.',
    'Asks first, unless --yes; --dry-run lists what would go.',
  ].join('\n\n')
  static override flags = {
    content: Flags.boolean({ summary: 'only pages', exclusive: ['media'] }),
    media: Flags.boolean({ summary: 'only media, with their files', exclusive: ['content'] }),
    'older-than': Flags.integer({
      summary: 'only what was trashed more than this many days ago',
      min: 0,
    }),
    yes: Flags.boolean({ summary: "don't ask" }),
    'dry-run': dryRun,
  }
  static override audit = {
    category: 'content',
    action: 'EmptyRecycleBin',
    entityType: 'Document',
  } as const
  static override spec = {
    effects: 'idempotent',
    cardinality: 'bounded',
    confirmationBypassArg: '--yes',
    outputFields: [
      {
        name: 'items',
        type: 'array',
        items: {
          type: 'object',
          fields: [
            { name: 'key', type: 'string' },
            { name: 'name', type: 'string' },
            { name: 'kind', type: 'string', enum: ['content', 'media'] },
            { name: 'trashedAt', type: 'string', nullable: true },
          ],
        },
      },
      { name: 'kept', type: 'integer', description: 'trashed too recently, or at an unknown time' },
      { name: 'changed', type: 'boolean' },
    ],
    errors: ['confirmation_required', 'refused'],
  } as const

  async run() {
    const { flags } = await this.parse(RecycleBinEmpty)
    const config = await siteConfig()
    const { db } = await bootstrapDatabase(config)
    try {
      const kinds = (['content', 'media'] as const).filter(
        (kind) => (!flags.content && !flags.media) || flags[kind],
      )
      const files = new MediaFileStore(await mediaStoreFor(config))
      const state = await currentSchemaState(db)
      const cutoff =
        flags['older-than'] === undefined
          ? undefined
          : Date.now() - flags['older-than'] * 86_400_000
      const chosen: Array<{
        repo: DocumentRepository
        node: NodeRow
        kind: 'content' | 'media'
        trashedAt: Date | undefined
      }> = []
      let kept = 0
      for (const kind of kinds) {
        const repo = new DocumentRepository(db, {
          kind: kind === 'media' ? 'media' : 'document',
          nodeState: { version: state.version, revision: state.revision },
          nodeId: `cli:${config.nodeId}`,
        })
        const roots = await repo.trashedRoots()
        const dates = await repo.trashedDates(roots.map((node) => node.id))
        for (const node of roots) {
          const trashedAt = dates.get(node.id)
          if (cutoff !== undefined && (!trashedAt || trashedAt.getTime() > cutoff)) {
            kept += 1
            continue
          }
          chosen.push({ repo, node, kind, trashedAt })
        }
      }
      const items = chosen.map(({ node, kind, trashedAt }) => ({
        key: node.key,
        name: node.text ?? node.key,
        kind,
        trashedAt: trashedAt?.toISOString() ?? null,
      }))
      for (const item of items)
        this.say(
          `  ${flags['dry-run'] ? 'would delete' : 'deletes'}  ${item.kind.padEnd(7)} ${item.name}`,
        )
      if (kept > 0)
        this.say(`  keeps    ${kept} item(s) trashed too recently, or before the date was recorded`)
      if (items.length === 0) {
        this.say('  The recycle bin has nothing to delete.')
        this.changedNothing = true
        return { items, kept, changed: false }
      }
      if (flags['dry-run']) {
        this.changedNothing = true
        return { items, kept, changed: false }
      }
      if (!flags.yes)
        await confirm(
          `  Delete ${items.length} item(s) and everything below them, for good? [y/N]`,
          {
            bypass: '--yes',
          },
        )
      let mediaChanged = false
      for (const { repo, node, kind } of chosen) {
        // A media item's file goes with it, as emptying the bin in the back office does.
        const paths: string[] = []
        if (kind === 'media') {
          const rows = await db.query<{ unique_id: string }>(
            'SELECT unique_id FROM node WHERE (id = ? OR path LIKE ?) AND node_object_type = ?',
            [node.id, `${node.path},%`, ObjectTypes.Media],
          )
          for (const row of rows) {
            const media = await repo.byKey(String(row.unique_id))
            const file = media ? mediaFileOf(media) : null
            if (file) paths.push(file)
          }
        }
        if (await repo.delete(node.key)) for (const path of paths) await files.remove(path)
        if (kind === 'media') mediaChanged = true
      }
      // One instruction for the run, as a node's own empty-bin does.
      await appendCacheInstruction(db, {
        kind: 'content',
        payload: mediaChanged ? { media: true } : { recycleBin: true },
        by: `cli:${config.nodeId}`,
      })
      this.say(`  deleted  ${items.length} item(s)`)
      return { items, kept, changed: true }
    } finally {
      await db.close()
    }
  }
}
