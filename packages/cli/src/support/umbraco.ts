/**
 * `crombolo import umbraco`: a compatibility report for an Umbraco backup, and
 * then a crombolo site written from it. Neither touches a database.
 *
 * The importer is a package of its own, loaded here on demand, so a site that
 * never imports anything does not carry it or the `.bacpac` reader it needs.
 */

import { VERSION } from '@crombolo/server'
import { Args, Flags } from '@oclif/core'
import { CliError } from '../errors.ts'
import { contentFlags } from './flags.ts'
import type { Io } from './site.ts'

export const umbracoArgs = {
  backup: Args.string({ required: true, description: "a .bacpac, or Umbraco's SQLite file" }),
}

export const umbracoFlags = {
  site: Flags.string({
    summary: "the Umbraco site's files, for its views, media and plugins",
    helpValue: '<dir>',
  }),
  media: Flags.string({
    summary: 'where its media files are, if not under --site',
    helpValue: '<dir>',
  }),
  name: Flags.string({ summary: "the new site's name", helpValue: '<site name>' }),
  drafts: Flags.boolean({ summary: 'bring drafts too' }),
  staging: Flags.string({ summary: 'where to unpack a .bacpac', helpValue: '<dir>' }),
  'with-members': Flags.boolean({ summary: 'bring members, encrypted' }),
  'with-users': Flags.boolean({ summary: 'bring back-office users, encrypted' }),
  ...contentFlags,
}

export function deprecated(io: Io, json: boolean): void {
  // Not into JSON output, which a machine reads.
  if (!json)
    io.warning(
      '  deprecated  `crombolo import umbraco` is going away: an Umbraco extension will write a crombolo file that `crombolo import <file>` reads (story 074)',
    )
}

export async function loadImporter(): Promise<typeof import('@crombolo/import-umbraco')> {
  try {
    return await import('@crombolo/import-umbraco')
  } catch {
    throw new CliError('not_found', 'The importer is a separate package.', {
      hint: 'Add it, then run this again: bun add -d @crombolo/import-umbraco',
    })
  }
}

export async function planUmbraco(
  importer: typeof import('@crombolo/import-umbraco'),
  backup: string,
  flags: {
    site?: string
    media?: string
    name?: string
    drafts: boolean
    staging?: string
    'with-members': boolean
    'with-users': boolean
  },
  content: 'omitted' | 'sealed' | 'open',
  passphrase: string | undefined,
) {
  try {
    return await importer.planImport({
      source: backup,
      site: flags.site,
      media: flags.media,
      siteName: flags.name,
      drafts: flags.drafts,
      staging: flags.staging,
      coreVersion: VERSION,
      content,
      withMembers: flags['with-members'],
      withUsers: flags['with-users'],
      passphrase,
    })
  } catch (error) {
    throw new CliError('refused', error instanceof Error ? error.message : String(error))
  }
}
