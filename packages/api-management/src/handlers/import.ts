/**
 * What an uploaded file turns out to be, which the client asks before it offers
 * to import: the entity type, and the alias and key inside the file so it can
 * tell a new type from an update to an existing one.
 */
import { notFound, problemDetails, problemResponse } from '@bunbraco/core'
import type { TemporaryFilePort } from '../ports.ts'
import type { ManagementApiRouter } from '../router.ts'

/** The root element names Umbraco's `.udt` exports use, to their entity types. */
const ENTITY_OF: Record<string, string> = {
  documenttype: 'document-type',
  mediatype: 'media-type',
  membertype: 'member-type',
  datatype: 'data-type',
  dictionaryitem: 'dictionary-item',
}

export function registerImportHandlers(
  router: ManagementApiRouter,
  temporaryFiles: TemporaryFilePort,
): void {
  router.handle('GetImportAnalyze', async (ctx) => {
    const id = ctx.url.searchParams.get('temporaryFileId')
    if (!id)
      return problemResponse(
        problemDetails({ title: 'A temporary file id is required', status: 400 }),
      )
    const file = await temporaryFiles.read(id)
    if (!file) return problemResponse(notFound('The file could not be found'))
    const text = new TextDecoder().decode(file.bytes)
    const root = /<\s*([A-Za-z][\w.-]*)/.exec(text.replace(/<\?[^?]*\?>/g, ''))?.[1]
    const entityType = root ? ENTITY_OF[root.toLowerCase()] : undefined
    if (!entityType)
      return problemResponse(
        problemDetails({
          title: 'The file could not be read',
          detail: 'It is not an Umbraco export.',
          status: 400,
        }),
      )
    const inside = (name: string) =>
      new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(text)?.[1]?.trim() || null
    return Response.json({ entityType, alias: inside('Alias'), key: inside('Key') })
  })
}
