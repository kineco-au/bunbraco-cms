/**
 * The login page's client module.
 *
 * It is a plain `.js` asset rather than compiled TypeScript because it imports
 * bare `@umbraco-cms/backoffice/*` specifiers that only resolve in the browser,
 * through the import map the page embeds.
 */
import { join } from 'node:path'

export const LOGIN_ASSET_DIR = join(import.meta.dir, '../assets')

export function resolveLoginAsset(backOfficePath: string, pathname: string): string | undefined {
  const prefix = `${backOfficePath}/login/`
  if (!pathname.startsWith(prefix)) return undefined
  const name = pathname.slice(prefix.length)
  // Only the files we ship; no traversal, no directory listing. `device.js` and
  // `remote-approval.js` are the pages a sign-in and a push are approved on (story 107).
  return ['login.js', 'device.js', 'remote-approval.js'].includes(name)
    ? join(LOGIN_ASSET_DIR, name)
    : undefined
}
