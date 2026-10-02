/**
 * The two endpoints the backoffice probes before anything else. If either fails
 * the client hard-redirects to its error page, so they must be anonymous and
 * must not depend on the database being reachable. Plus the upload settings
 * the editor reads before it offers a file picker.
 */
import { DEFAULT_UPLOAD_SETTINGS } from '@bunbraco/core'
import type { ServerPort } from '../ports.ts'
import type { ManagementApiRouter } from '../router.ts'

export function registerServerHandlers(router: ManagementApiRouter, server: ServerPort): void {
  router.handle('GetServerStatus', () => Response.json(server.status()))
  router.handle('GetServerConfiguration', () => Response.json(server.configuration()))
  router.handle('GetServerInformation', () => Response.json(server.information()))

  router.handle('GetTemporaryFileConfiguration', () => {
    const settings = server.uploadSettings?.() ?? DEFAULT_UPLOAD_SETTINGS
    return Response.json({
      imageFileTypes: settings.imageFileTypes,
      disallowedUploadedFilesExtensions: settings.disallowedExtensions,
      allowedUploadedFileExtensions: settings.allowedExtensions,
      maxFileSize: settings.maxFileSize,
    })
  })
}
