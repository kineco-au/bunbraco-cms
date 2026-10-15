/**
 * How this site's URLs are built, as Umbraco's `HideTopLevelNodeFromPath`
 * sets it. Synced from `schema/schema.toml` and changed in Settings; read by
 * the published cache. docs/rendering.md, "URLs".
 */
import type { Db } from './database.ts'

export const URL_OPTIONS_KEY = 'crombolo:urls'

export interface UrlOptions {
  /** Leave the top-level page's segment out of every path below it. Umbraco's default. */
  hideTopLevel: boolean
}

export const DEFAULT_URL_OPTIONS: UrlOptions = { hideTopLevel: true }

/** Whether two settings build the same URLs. Pure. */
export const sameUrlOptions = (a: UrlOptions, b: UrlOptions): boolean =>
  a.hideTopLevel === b.hideTopLevel

/** A stored value read leniently: anything unreadable is the default. Pure. */
export function parseUrlOptions(value: string | undefined): UrlOptions {
  if (!value) return { ...DEFAULT_URL_OPTIONS }
  try {
    const parsed = JSON.parse(value) as Partial<UrlOptions>
    return {
      hideTopLevel:
        typeof parsed.hideTopLevel === 'boolean'
          ? parsed.hideTopLevel
          : DEFAULT_URL_OPTIONS.hideTopLevel,
    }
  } catch {
    return { ...DEFAULT_URL_OPTIONS }
  }
}

export async function readUrlOptions(db: Db): Promise<UrlOptions> {
  const rows = await db.query<{ value: string }>('SELECT value FROM key_value WHERE key = ?', [
    URL_OPTIONS_KEY,
  ])
  return parseUrlOptions(rows[0]?.value)
}

/** Stores the setting; answers what it was before. */
export async function writeUrlOptions(db: Db, options: UrlOptions): Promise<UrlOptions> {
  return db.transaction(async (tx) => {
    const before = await readUrlOptions(tx)
    const value = JSON.stringify({ hideTopLevel: options.hideTopLevel })
    const now = tx.dialect.now()
    const updated = await tx.query<{ key: string }>(
      `UPDATE key_value SET value = ?, update_date = ${now} WHERE key = ? RETURNING key`,
      [value, URL_OPTIONS_KEY],
    )
    if (updated.length === 0)
      await tx.exec(`INSERT INTO key_value (key, value, update_date) VALUES (?, ?, ${now})`, [
        URL_OPTIONS_KEY,
        value,
      ])
    return before
  })
}
