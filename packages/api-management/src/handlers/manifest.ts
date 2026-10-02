/**
 * Extension discovery. `/public` is anonymous and feeds the login screen;
 * `/private` requires a signed-in user and carries the rest.
 */
import type { ManifestPort } from '../ports.ts'
import type { ManagementApiRouter } from '../router.ts'

export function registerManifestHandlers(
  router: ManagementApiRouter,
  manifests: ManifestPort,
): void {
  router.handle('GetManifestManifest', () => Response.json(manifests.list('all')))
  router.handle('GetManifestManifestPublic', () => Response.json(manifests.list('public')))
  router.handle('GetManifestManifestPrivate', () => Response.json(manifests.list('private')))
}
