/**
 * Taking a page or a branch live, and back off again, without the backoffice.
 *
 * A publish can be refused per node — an unpublished ancestor, an unpublished
 * mandatory language, an empty mandatory property — so the whole selection is
 * checked before any of it is written. Half a published branch is a state
 * nobody asked for and nobody can reason about.
 */

import { ObjectTypes } from '@crombolo/core'
import {
  currentSchemaState,
  DocumentRepository,
  describeRefFailure,
  resolveNodeRef,
} from '@crombolo/data'
import { bootstrapDatabase } from '@crombolo/server'
import { Args, Flags } from '@oclif/core'
import { CliError } from '../errors.ts'
import { many } from './flags.ts'
import { type Io, siteConfig } from './site.ts'

export const publishArgs = {
  page: Args.string({ required: true, description: 'the page: a path or a uuid' }),
}

export const publishFlags = {
  descendants: Flags.boolean({ summary: 'the branch below it too' }),
  culture: many('only this culture; repeatable', '<iso>'),
  at: Flags.string({ summary: 'schedule it for this time instead', helpValue: '<time>' }),
  until: Flags.string({ summary: 'schedule the opposite for this time', helpValue: '<time>' }),
}

export const publishSpec = {
  effects: 'idempotent',
  cardinality: 'bounded',
  outputFields: [
    {
      name: 'pages',
      type: 'array',
      items: {
        type: 'object',
        fields: [
          { name: 'key', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'changed', type: 'boolean' },
        ],
      },
    },
    { name: 'scheduled', type: 'boolean' },
    { name: 'cultures', type: 'array', items: { type: 'string' } },
  ],
  errors: ['not_found', 'refused', 'usage'],
} as const

const when = (value: string | undefined, what: string): Date | null => {
  if (value === undefined) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    throw new CliError('usage', `${what} "${value}" is not a date I can read.`, {
      hint: 'Try 2026-10-01T09:00.',
    })
  return date
}

export async function publishPages(
  io: Io,
  publishing: boolean,
  ref: string,
  flags: { descendants: boolean; culture: string[]; at?: string; until?: string },
) {
  const cultures = flags.culture
  const publishTime = when(flags.at, '--at')
  const unpublishTime = when(flags.until, '--until')
  const config = await siteConfig()
  const { db } = await bootstrapDatabase(config)
  try {
    const resolved = await resolveNodeRef(db, [ObjectTypes.Document], ref)
    if (!resolved.ok) throw new CliError('not_found', describeRefFailure(ref, resolved))
    const state = await currentSchemaState(db)
    const docs = new DocumentRepository(db, {
      nodeState: { version: state.version, revision: state.revision },
      nodeId: config.nodeId,
    })
    // Parents before children, which is the order publishing has to happen in.
    const targets = [
      resolved.node,
      ...(flags.descendants
        ? await docs.nodes.descendants(resolved.node, [ObjectTypes.Document])
        : []),
    ]
    const items: { key: string; name: string; changed: boolean }[] = []

    if (publishTime || unpublishTime) {
      // A schedule is a statement about the future, so today's blockers are not
      // the question: the background job checks them when the time comes.
      for (const node of targets) {
        await docs.setSchedule(node.key, [
          { culture: cultures[0] ?? null, publishTime, unpublishTime },
        ])
        items.push({ key: node.key, name: node.text ?? node.key, changed: true })
        io.say(
          `  scheduled ${node.text ?? node.key}${publishTime ? `  from ${publishTime.toISOString()}` : ''}${unpublishTime ? `  until ${unpublishTime.toISOString()}` : ''}`,
        )
      }
      return { pages: items, scheduled: true, cultures }
    }

    if (publishing) {
      const blocked: Array<{ name: string; reasons: string[] }> = []
      // Everything in the selection counts as published for the check: the run
      // publishes parents first, so a child is not blocked by an ancestor this
      // very command is about to take live.
      const selection = new Set(targets.map((node) => node.id))
      for (const node of targets) {
        const reasons = await docs.publishBlockers(node.key, cultures, selection)
        if (reasons.length > 0) blocked.push({ name: node.text ?? node.key, reasons })
      }
      if (blocked.length > 0)
        throw new CliError(
          'refused',
          `${blocked.length} of ${targets.length} page(s) cannot be published, so nothing was published.`,
          { details: blocked.map((entry) => `${entry.name}  ${entry.reasons.join('; ')}`) },
        )
    }

    for (const node of targets) {
      const result = publishing
        ? await docs.publish(node.key, cultures.length > 0 ? cultures : null)
        : await docs.unpublish(node.key, cultures.length > 0 ? cultures : null)
      items.push({ key: node.key, name: node.text ?? node.key, changed: Boolean(result) })
      if (!result) continue
      io.say(`  ${publishing ? 'published' : 'unpublished'} ${node.text ?? node.key}`)
    }
    io.say(
      `\n${targets.length} page(s) ${publishing ? 'published' : 'unpublished'}${cultures.length > 0 ? ` in ${cultures.join(', ')}` : ''}.`,
    )
    return { pages: items, scheduled: false, cultures }
  } finally {
    await db.close()
  }
}
