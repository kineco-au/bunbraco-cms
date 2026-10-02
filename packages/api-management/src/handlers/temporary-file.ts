/**
 * Temporary files: what an upload editor or the media dropzone posts before the
 * value that uses it is saved.
 */
import { notFound, problemDetails, problemResponse } from '@bunbraco/core'
import type { TemporaryFilePort } from '../ports.ts'
import type { ManagementApiRouter } from '../router.ts'
import { created } from './content-type.ts'

const toResponse = (file: { id: string; fileName: string; availableUntil: Date }) => ({
  id: file.id,
  fileName: file.fileName,
  availableUntil: file.availableUntil.toISOString(),
})

export function registerTemporaryFileHandlers(
  router: ManagementApiRouter,
  port: TemporaryFilePort,
): void {
  router.handle('PostTemporaryFile', async (ctx) => {
    let form: FormData
    try {
      form = await ctx.request.formData()
    } catch {
      return problemResponse(
        problemDetails({ title: 'The upload must be multipart/form-data', status: 400 }),
      )
    }
    const file = form.get('File')
    const id = String(form.get('Id') ?? '') || crypto.randomUUID()
    if (!(file instanceof File))
      return problemResponse(problemDetails({ title: 'No file was uploaded', status: 400 }))
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      return problemResponse(problemDetails({ title: 'The id must be a uuid', status: 400 }))
    const result = await port.save(id, file)
    if (!result.ok)
      return problemResponse(
        problemDetails({
          title: 'File upload failed',
          detail: result.reason,
          status: 400,
          operationStatus: 'FileExtensionNotAllowed',
        }),
      )
    return created(
      `${ctx.url.origin}/umbraco/management/api/v1/temporary-file/${result.file.id}`,
      result.file.id,
    )
  })

  router.handle('GetTemporaryFileById', async ({ params }) => {
    const file = await port.get(params.id as string)
    if (!file) return problemResponse(notFound('The temporary file could not be found'))
    return Response.json(toResponse(file))
  })

  router.handle('DeleteTemporaryFileById', async ({ params }) => {
    const removed = await port.remove(params.id as string)
    if (!removed) return problemResponse(notFound('The temporary file could not be found'))
    return new Response(null, { status: 200 })
  })
}
