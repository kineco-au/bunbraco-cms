/**
 * The save-time step for uploaded files: a value naming a temporary upload has
 * the file placed under the media root and stores its path instead. When the
 * file is `umbracoFile`, the width, height, size and extension properties are
 * filled in, as Umbraco's `AutoFillImageProperties` does for media types.
 */
import {
  type DocumentValue,
  FILE_VALUE_EDITORS,
  IMAGE_CROPPER_EDITOR_ALIAS,
  toStoredUpload,
} from '@bunbraco/core'
import type { ValueIntake } from '@bunbraco/data'
import type { MediaFileStore, PlacedFile } from './media-files.ts'

const AUTO_FILL = {
  file: 'umbracoFile',
  width: 'umbracoWidth',
  height: 'umbracoHeight',
  bytes: 'umbracoBytes',
  extension: 'umbracoExtension',
} as const

export class TemporaryFileMissingError extends Error {}

const temporaryIdOf = (value: unknown): string | undefined => {
  const id = (value as { temporaryFileId?: unknown } | null)?.temporaryFileId
  return typeof id === 'string' && id ? id : undefined
}

export function createFileIntake(store: MediaFileStore): ValueIntake {
  return async (values, propertyTypes) => {
    const editorOf = new Map(propertyTypes.map((p) => [p.alias, p.editorAlias]))
    const result: DocumentValue[] = [...values]
    const fills: DocumentValue[] = []

    for (const [index, value] of result.entries()) {
      const editor = editorOf.get(value.alias)
      if (!editor || !FILE_VALUE_EDITORS.has(editor)) continue
      const temporaryId = temporaryIdOf(value.value)
      let placed: PlacedFile | undefined
      if (temporaryId) {
        placed = await store.place(temporaryId)
        if (!placed)
          throw new TemporaryFileMissingError(
            `The upload for '${value.alias}' has expired or does not exist; upload it again.`,
          )
      }
      let stored: unknown
      if (editor === IMAGE_CROPPER_EDITOR_ALIAS) {
        const incoming = (value.value ?? {}) as Record<string, unknown>
        const src = placed?.src ?? (typeof incoming.src === 'string' ? incoming.src : '')
        stored = src
          ? {
              src,
              crops: Array.isArray(incoming.crops) ? incoming.crops : [],
              focalPoint: incoming.focalPoint ?? null,
            }
          : null
      } else {
        stored = placed?.src ?? toStoredUpload(value.value)
      }
      result[index] = { ...value, value: stored }

      if (placed && value.alias === AUTO_FILL.file) {
        const fill = (alias: string, fact: unknown) => {
          if (editorOf.has(alias) && fact !== undefined)
            fills.push({ alias, culture: value.culture, segment: value.segment, value: fact })
        }
        fill(AUTO_FILL.width, placed.width)
        fill(AUTO_FILL.height, placed.height)
        fill(AUTO_FILL.bytes, placed.bytes)
        fill(AUTO_FILL.extension, placed.extension)
      }
    }

    // A filled-in fact replaces whatever the editor sent for it.
    const filled = new Set(fills.map((f) => `${f.alias}|${f.culture ?? ''}|${f.segment ?? ''}`))
    return [
      ...result.filter((v) => !filled.has(`${v.alias}|${v.culture ?? ''}|${v.segment ?? ''}`)),
      ...fills,
    ]
  }
}
