/**
 * The login/back-office branding images. These live on Umbraco's
 * BackOfficeGraphicsController, which is excluded from the OpenAPI document, so
 * they cannot be routed through the contract-first router.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MANAGEMENT_API_PATH } from '@bunbraco/core'
import type { BackOfficePaths } from './paths.ts'

export const GRAPHICS_PREFIX = `${MANAGEMENT_API_PATH}/security/back-office/graphics`

/**
 * Bunbraco's own marks, as Umbraco's names them. The plain names are the ones
 * the client asks for on the header bar, which the theme paints orange, so they
 * get the cocoa mark; the `-alternative` ones sit on white surfaces and get the
 * orange one.
 *
 * Umbraco's `background` illustration used to be served here. Nothing ever
 * requested it — our login page draws a card rather than Umbraco's split
 * screen, and `login.js` has no background property — so it is gone.
 */
const GRAPHICS: Record<string, string> = {
  logo: 'branding/logo-header.svg',
  'logo-alternative': 'branding/logo-surface.svg',
  'login-logo': 'branding/logo-header.svg',
  'login-logo-alternative': 'branding/logo-surface.svg',
}

/**
 * Vendored asset paths served as bunbraco's instead.
 *
 * These three are Umbraco's own marks and artwork, which MIT does not license:
 * MIT grants copyright permission and says nothing about trademarks. Each is
 * requested by a vendored element that hard-codes its path, so the substitution
 * happens here rather than by patching the client, and the originals are no
 * longer committed under `backoffice-dist/upstream-static/`.
 *
 * `resolveStaticFile` consults this before falling back to `vendorDir`, on both
 * the hashed and the plain prefix, so there is no path left that reaches an
 * Umbraco mark.
 *
 * - `favicon.svg` — the Umbraco "U" roundel, requested by the shells
 * - `umbraco-logo.svg` — the wordmark, requested by the header popover
 * - `installer-illustration.svg` — the backdrop of `app-error.element.js`, which
 *   is a real runtime path, so this needs a replacement rather than a deletion
 */
export const BRANDED_ASSETS: Readonly<Record<string, string>> = {
  'assets/favicon.svg': 'branding/favicon.svg',
  'assets/umbraco-logo.svg': 'branding/logo-surface.svg',
  'assets/installer-illustration.svg': 'branding/backdrop.svg',
}

export function resolveGraphic(paths: BackOfficePaths, pathname: string): string | undefined {
  const prefix = `${GRAPHICS_PREFIX}/`
  if (!pathname.startsWith(prefix)) return undefined
  const graphic = GRAPHICS[pathname.slice(prefix.length)]
  if (!graphic) return undefined
  const file = join(paths.pluginDir, graphic)
  return existsSync(file) ? file : undefined
}
