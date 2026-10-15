/**
 * How the site's URLs are built (story 110): Umbraco's
 * `HideTopLevelNodeFromPath`, kept in `schema/schema.toml` and changed there or
 * in Settings. Either way every URL can move, so the old ones are redirected,
 * as a rename's are. docs/rendering.md, "URLs".
 */

import { existsSync } from 'node:fs'
import {
  appendCacheInstruction,
  type Db,
  readUrlOptions,
  sameUrlOptions,
  type UrlOptions,
  writeUrlOptions,
} from '@crombolo/data'
import {
  type DocumentRoute,
  PublishedCache,
  type PublishedCacheOptions,
  type PublishedContentSource,
} from '@crombolo/render'
import { createSchemaFileWriter } from './adapters/schema-files.ts'
import type { CromboloConfig } from './config.ts'
import { schemaFiles } from './ports.ts'
import type { RedirectTracker } from './redirects.ts'

export interface UrlChangeContext {
  db: Db
  config: CromboloConfig
  source: PublishedContentSource
  cacheOptions?: PublishedCacheOptions
  cache: PublishedCache
  tracker: RedirectTracker
}

/**
 * Every route the site had under `before`, read from a cache built with it,
 * then handed to the tracker against the routes it has now. The live cache is
 * dropped first, so "now" is the new setting.
 */
export async function redirectAfterUrlChange(
  ctx: UrlChangeContext,
  before: UrlOptions,
): Promise<void> {
  const old = new PublishedCache(
    { ...ctx.source, loadUrlOptions: async () => before },
    ctx.cacheOptions,
  )
  const captured: DocumentRoute[] = []
  for (const key of await old.childKeys(null)) captured.push(...(await old.routes(key, true)))
  ctx.cache.invalidate()
  await ctx.tracker.commit(captured)
}

export type UrlSettingOutcome =
  | { ok: true; options: UrlOptions }
  | { ok: false; status: number; message: string }

/** Whether Settings may change it here: not when the files are kept read-only. Pure. */
export function urlSettingEditable(
  config: Pick<CromboloConfig, 'schemaDir' | 'schemaWritable'>,
  managed: boolean,
): boolean {
  return !managed || config.schemaWritable
}

/** The change Settings makes: the database, the file, redirects, and the other nodes. */
export async function changeUrlOptions(
  ctx: UrlChangeContext,
  next: UrlOptions,
): Promise<UrlSettingOutcome> {
  if (!urlSettingEditable(ctx.config, existsSync(ctx.config.schemaDir)))
    return {
      ok: false,
      status: 409,
      message:
        'This site keeps its address settings with its files, and they cannot be changed in this environment.',
    }
  const before = await readUrlOptions(ctx.db)
  if (sameUrlOptions(before, next)) return { ok: true, options: before }
  await writeUrlOptions(ctx.db, next)
  await createSchemaFileWriter(ctx.db, schemaFiles(ctx.config)).writeUrlOptions(next)
  await redirectAfterUrlChange(ctx, before)
  await appendCacheInstruction(ctx.db, {
    kind: 'schema',
    payload: { urls: next },
    by: ctx.config.nodeId,
  })
  return { ok: true, options: next }
}
