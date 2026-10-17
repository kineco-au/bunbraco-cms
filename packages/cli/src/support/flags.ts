/** Flags more than one command takes, and what they come to. */

import {
  isResolution,
  type NodeResolutions,
  parseResolveFlags,
  RESOLUTIONS,
  type Resolution,
} from '@crombolo/transfer'
import { Flags } from '@oclif/core'
import { CliError } from '../errors.ts'
import type * as ops from '../operations/commands.ts'
import type { Io } from './site.ts'

export const backupTaken = Flags.boolean({
  summary: 'a backup was taken another way: Postgres needs this, or CROMBOLO_PG_DUMP',
})

export const dryRun = Flags.boolean({ summary: 'say what it would do, and change nothing' })

/** A repeatable value flag that takes one value each time, so it never swallows an argument. */
export const many = (summary: string, helpValue?: string) =>
  Flags.string({ summary, helpValue, multiple: true, multipleNonGreedy: true, default: [] })

/** The flags `content check` and `content import` share: resolutions, placement, files. */
export const transferFlags = {
  under: Flags.string({ summary: 'place the bundle under this page', helpValue: '<path|uuid>' }),
  resolve: many(
    'answer a finding: <key>=take-bundle|keep-local|skip, or <key>/<property>[@<culture>]=take-bundle|keep-local',
    '<answer>',
  ),
  'resolve-all': Flags.string({
    summary: 'answer every finding the same way',
    options: [...RESOLUTIONS],
  }),
  'allow-missing-blobs': Flags.boolean({
    summary: 'import media items whose files the bundle does not carry',
  }),
  publish: Flags.boolean({ summary: 'publish what it imports' }),
  'no-schema': Flags.boolean({ summary: 'decline the schema the bundle carries' }),
  'no-files': Flags.boolean({ summary: 'decline the views, styles and scripts it carries' }),
  'replace-files': Flags.boolean({
    summary: 'allow replacing files this site has; the originals are kept for a revert',
  }),
}

export interface TransferFlagValues {
  under?: string
  resolve: string[]
  'resolve-all'?: string
  'allow-missing-blobs': boolean
  publish: boolean
  'no-schema': boolean
  'no-files': boolean
  'replace-files': boolean
}

export function parseResolutions(values: readonly string[]): Record<string, NodeResolutions> {
  const parsed = parseResolveFlags([...values])
  if (parsed.problems.length > 0)
    throw new CliError('usage', 'A --resolve answer could not be read.', {
      details: parsed.problems,
    })
  return parsed.byNode
}

export function transferInput(bundle: string, flags: TransferFlagValues): ops.TransferInput {
  const all = flags['resolve-all']
  if (all !== undefined && !isResolution(all))
    throw new CliError('usage', `"${all}" is not one of ${RESOLUTIONS.join(', ')}.`)
  return {
    bundle,
    under: flags.under,
    resolutions: parseResolutions(flags.resolve),
    resolveAll: all as Resolution | undefined,
    allowMissingBlobs: flags['allow-missing-blobs'],
    publish: flags.publish,
    // What a bundle carries is applied by default — that is the point of it
    // carrying anything — so these decline a half, for someone who wants the
    // content without the structure that came with it.
    withoutSchema: flags['no-schema'],
    withoutFiles: flags['no-files'],
    replaceFiles: flags['replace-files'],
  }
}

/** Property values and media files in an export: left out, sealed, or — asked twice — open. */
export const contentFlags = {
  'include-content': Flags.boolean({
    summary: 'bring property values and media files, encrypted under a passphrase',
  }),
  'allow-content-unencrypted': Flags.boolean({
    summary: 'with --include-content: write them readable',
  }),
}

export function contentMode(
  io: Io,
  flags: {
    'include-content': boolean
    'allow-content-unencrypted': boolean
    'with-blobs'?: boolean
  },
): 'omitted' | 'sealed' | 'open' {
  const include = flags['include-content']
  const open = flags['allow-content-unencrypted']
  if (open && !include)
    throw new CliError('usage', '--allow-content-unencrypted goes with --include-content.')
  if (flags['with-blobs'] && !include)
    throw new CliError(
      'usage',
      'Media files are content: --with-blobs goes with --include-content.',
    )
  if (open)
    io.warning(
      '  warning  property values and media files are written unencrypted: anyone with the files can read any personal information in them',
    )
  return !include ? 'omitted' : open ? 'open' : 'sealed'
}

/** Offset pagination for a list: `--limit` and `--offset`, and what was left out. */
export const pageFlags = (limit: number) => ({
  limit: Flags.integer({ summary: 'how many to list', default: limit, min: 1 }),
  offset: Flags.integer({ summary: 'how many to skip first', default: 0, min: 0 }),
  fields: Flags.string({
    summary: 'only these fields of each item, comma-separated',
    helpValue: '<a,b>',
  }),
})

export const pagination = { style: 'offset', offsetArg: '--offset', limitArg: '--limit' } as const

/** One page of a list, in the envelope clispec asks for, narrowed to `--fields` when given. */
export function page<T extends object>(
  items: readonly T[],
  total: number,
  flags: { offset: number; fields?: string },
): { items: Partial<T>[]; total: number; offset: number; truncated: boolean } {
  const wanted = flags.fields
    ?.split(',')
    .map((field) => field.trim())
    .filter(Boolean)
  const narrowed = wanted
    ? items.map(
        (item) =>
          Object.fromEntries(
            Object.entries(item).filter(([key]) => wanted.includes(key)),
          ) as Partial<T>,
      )
    : [...items]
  return {
    items: narrowed,
    total,
    offset: flags.offset,
    truncated: flags.offset + items.length < total,
  }
}
