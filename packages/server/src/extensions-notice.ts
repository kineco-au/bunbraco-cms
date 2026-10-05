/**
 * The one trace App_Plugins leaves behind.
 *
 * Extensions are npm dependencies now (`docs/17-bundles.md`), and nothing
 * reads this directory any more. A site upgrading with files still in it would
 * otherwise find its extensions had quietly stopped loading, so the boot says
 * what happened. Remove at 1.0.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface NoticeLog {
  warning(message: string, properties?: Record<string, unknown>): void
}

export function warnAboutAppPlugins(siteDir: string, log: NoticeLog): void {
  const dir = join(siteDir, 'App_Plugins')
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((entry) => !entry.startsWith('.'))
  } catch {
    return
  }
  if (entries.length === 0) return
  log.warning(
    'App_Plugins is no longer read: {count} item(s) in {dir} are being ignored. {remedy}',
    {
      count: entries.length,
      dir,
      remedy:
        'Backoffice extensions are npm dependencies now — install one with `bun add`, and see docs/17-bundles.md.',
    },
  )
}
