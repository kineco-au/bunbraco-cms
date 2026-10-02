/**
 * What may be uploaded, as Umbraco's defaults have it (`ContentSettings`,
 * `ContentImagingSettings`). The temporary-file configuration endpoint reports
 * these, and the upload endpoints enforce the same lists.
 */
export interface UploadSettings {
  /** Extensions treated as images: resizable, croppable, shown as thumbnails. */
  imageFileTypes: string[]
  /** Never accepted, whatever else is configured: files a server could execute. */
  disallowedExtensions: string[]
  /** When non-empty, only these are accepted. Empty means anything not disallowed. */
  allowedExtensions: string[]
  /** In bytes; null means no limit is configured. */
  maxFileSize: number | null
}

export const DEFAULT_UPLOAD_SETTINGS: Readonly<UploadSettings> = {
  imageFileTypes: ['jpeg', 'jpg', 'gif', 'bmp', 'png', 'tiff', 'tif', 'webp'],
  disallowedExtensions: [
    'ashx',
    'aspx',
    'ascx',
    'config',
    'cshtml',
    'vbhtml',
    'asmx',
    'air',
    'axd',
    'xamlx',
  ],
  allowedExtensions: [],
  maxFileSize: null,
}

/** Whether a file name's extension may be uploaded under these settings. */
export function isUploadAllowed(fileName: string, settings: UploadSettings): boolean {
  const dot = fileName.lastIndexOf('.')
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  if (settings.disallowedExtensions.includes(extension)) return false
  return settings.allowedExtensions.length === 0 || settings.allowedExtensions.includes(extension)
}
