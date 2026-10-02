/**
 * Editor-specific value shapes. Structured editors store JSON text and hand the
 * editor the parsed value, as Umbraco's value editors do; everything else is
 * stored and returned as is.
 */

export const RICH_TEXT_EDITOR_ALIAS = 'Umbraco.RichText'
export const UPLOAD_FIELD_EDITOR_ALIAS = 'Umbraco.UploadField'
export const IMAGE_CROPPER_EDITOR_ALIAS = 'Umbraco.ImageCropper'

/** Editors whose value names an uploaded file, and so may arrive with a temporary file. */
export const FILE_VALUE_EDITORS: ReadonlySet<string> = new Set([
  UPLOAD_FIELD_EDITOR_ALIAS,
  IMAGE_CROPPER_EDITOR_ALIAS,
])

/** Editors whose values are objects or arrays, stored as JSON. */
export const JSON_VALUE_EDITORS: ReadonlySet<string> = new Set([
  RICH_TEXT_EDITOR_ALIAS,
  'Umbraco.BlockList',
  'Umbraco.BlockGrid',
  'Umbraco.CheckBoxList',
  'Umbraco.ColorPicker',
  'Umbraco.DateTimeWithTimeZone',
  'Umbraco.DropDown.Flexible',
  // A `Guid[]` of the elements picked, not the `umb://…` references a content
  // picker stores.
  'Umbraco.ElementPicker',
  'Umbraco.ImageCropper',
  'Umbraco.MediaPicker3',
  'Umbraco.MultipleTextstring',
  'Umbraco.MultiUrlPicker',
  'Umbraco.Slider',
  'Umbraco.Tags',
])

export interface RichTextValue {
  markup: string
  blocks: unknown
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * A string spread into an object (`{...'abc'}` is `{0:'a',1:'b',2:'c'}`), which
 * earlier builds stored when they handed the editor JSON text instead of JSON.
 */
function unspreadString(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>)
  const indexed = entries.filter(([key]) => /^\d+$/.test(key))
  if (indexed.length === 0) return undefined
  const chars: string[] = []
  for (const [key, char] of indexed) {
    if (typeof char !== 'string' || char.length !== 1) return undefined
    chars[Number(key)] = char
  }
  if (chars.length !== indexed.length) return undefined
  return chars.join('')
}

function toRichText(value: unknown): RichTextValue {
  if (typeof value === 'string') {
    const parsed = tryParse(value)
    if (parsed && typeof parsed === 'object') return toRichText(parsed)
    return { markup: value, blocks: null }
  }
  const spread = unspreadString(value)
  if (spread !== undefined) return toRichText(spread)
  const object = (value ?? {}) as Partial<RichTextValue>
  return {
    markup: typeof object.markup === 'string' ? object.markup : '',
    blocks: object.blocks ?? null,
  }
}

/**
 * An upload is stored as its path (`/media/ab12cd34/file.pdf`), as Umbraco
 * stores it, and edited as `{ src }`.
 */
function toUpload(stored: unknown): { src: string } | null {
  if (typeof stored === 'string') {
    const parsed = tryParse(stored)
    if (parsed && typeof parsed === 'object') return toUpload(parsed)
    return stored ? { src: stored } : null
  }
  const src = (stored as { src?: unknown } | null)?.src
  return typeof src === 'string' && src ? { src } : null
}

/** A stored instant as the date pickers show it: `2026-01-02 03:04:05`, in the zone it was entered in. */
function toWallClock(stored: unknown): unknown {
  const date = new Date(String(stored))
  if (Number.isNaN(date.getTime())) return stored
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** The value an editor receives for what is stored. */
export function toEditorValue(editorAlias: string | undefined, stored: unknown): unknown {
  if (stored === null || stored === undefined || !editorAlias) return stored
  if (editorAlias === RICH_TEXT_EDITOR_ALIAS) return toRichText(stored)
  if (editorAlias === UPLOAD_FIELD_EDITOR_ALIAS) return toUpload(stored)
  if (editorAlias === 'Umbraco.TrueFalse')
    return stored === true || stored === 1 || stored === '1' || stored === 'true'
  if (editorAlias === 'Umbraco.DateTime') return toWallClock(stored)
  if (!JSON_VALUE_EDITORS.has(editorAlias) || typeof stored !== 'string') return stored
  const parsed = tryParse(stored)
  return parsed !== null && typeof parsed === 'object' ? parsed : stored
}

/** The value a template receives: rich text is its markup, an upload its URL. */
export function toPublishedValue(editorAlias: string | undefined, stored: unknown): unknown {
  const value = toEditorValue(editorAlias, stored)
  if (editorAlias === RICH_TEXT_EDITOR_ALIAS && value) return (value as RichTextValue).markup
  if (editorAlias === UPLOAD_FIELD_EDITOR_ALIAS)
    return (value as { src: string } | null)?.src ?? null
  return value
}

/** What is stored for an upload the editor sent: its path, once any temporary file is placed. */
export function toStoredUpload(value: unknown): string | null {
  return toUpload(value)?.src ?? null
}
