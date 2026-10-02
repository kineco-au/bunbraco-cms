/**
 * Media as templates see it: a published media item with its file URL, and
 * what the Media Picker and Image Cropper yield — the item with its crops,
 * each crop reachable as a URL the media route resizes and cuts.
 */
import type { PublishedProperty } from './model.ts'

export interface Crop {
  alias: string
  width: number
  height: number
  /** Fractions trimmed from each edge, as the cropper stores them; null means "around the focal point". */
  coordinates: { x1: number; y1: number; x2: number; y2: number } | null
}

export interface FocalPoint {
  left: number
  top: number
}

/** A crop URL: a named crop, or any size around the focal point. */
export type CropRequest =
  | string
  | { width?: number; height?: number; mode?: string; format?: string }

/** `url` with the query that yields `request`, given the crops and focal point in force. */
export function cropUrl(
  url: string,
  crops: readonly Crop[],
  focalPoint: FocalPoint | null,
  request: CropRequest,
): string | null {
  const params = new URLSearchParams()
  if (typeof request === 'string') {
    const crop = crops.find((c) => c.alias === request)
    if (!crop) return null
    if (crop.coordinates)
      params.set(
        'cc',
        [crop.coordinates.x1, crop.coordinates.y1, crop.coordinates.x2, crop.coordinates.y2].join(
          ',',
        ),
      )
    else if (focalPoint) params.set('rxy', `${focalPoint.left},${focalPoint.top}`)
    params.set('width', String(crop.width))
    params.set('height', String(crop.height))
  } else {
    if (focalPoint && request.width && request.height)
      params.set('rxy', `${focalPoint.left},${focalPoint.top}`)
    if (request.width) params.set('width', String(request.width))
    if (request.height) params.set('height', String(request.height))
    if (request.mode) params.set('rmode', request.mode.toLowerCase())
    if (request.format) params.set('format', request.format)
  }
  const query = params.toString()
  return query ? `${url}?${query}` : url
}

const numberOr = (value: unknown, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Crops as the cropper stores them, tolerating partial data. */
export function readCrops(value: unknown): Crop[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): Crop[] => {
    const crop = raw as Record<string, unknown>
    if (typeof crop.alias !== 'string') return []
    const c = crop.coordinates as Record<string, unknown> | null | undefined
    return [
      {
        alias: crop.alias,
        width: numberOr(crop.width, 0),
        height: numberOr(crop.height, 0),
        coordinates: c
          ? {
              x1: numberOr(c.x1, 0),
              y1: numberOr(c.y1, 0),
              x2: numberOr(c.x2, 0),
              y2: numberOr(c.y2, 0),
            }
          : null,
      },
    ]
  })
}

export function readFocalPoint(value: unknown): FocalPoint | null {
  const f = value as Record<string, unknown> | null | undefined
  if (!f) return null
  return { left: numberOr(f.left, 0.5), top: numberOr(f.top, 0.5) }
}

/** An Image Cropper value: the file, its crops and focal point. `toString()` is its URL. */
export class ImageCropperValue {
  readonly src: string
  readonly crops: Crop[]
  readonly focalPoint: FocalPoint | null

  constructor(value: { src?: unknown; crops?: unknown; focalPoint?: unknown }) {
    this.src = typeof value.src === 'string' ? value.src : ''
    this.crops = readCrops(value.crops)
    this.focalPoint = readFocalPoint(value.focalPoint)
  }

  get url(): string {
    return this.src
  }

  cropUrl(request: CropRequest): string | null {
    return this.src ? cropUrl(this.src, this.crops, this.focalPoint, request) : null
  }

  toString(): string {
    return this.src
  }
}

/** One published media item. */
export class PublishedMedia {
  readonly key: string
  readonly id: number
  readonly name: string
  readonly mediaType: { alias: string }
  readonly properties: PublishedProperty[]

  constructor(init: {
    key: string
    id: number
    name: string
    mediaTypeAlias: string
    properties: PublishedProperty[]
  }) {
    this.key = init.key
    this.id = init.id
    this.name = init.name
    this.mediaType = { alias: init.mediaTypeAlias }
    this.properties = init.properties
  }

  /** The file's URL: what `umbracoFile` holds. */
  get url(): string {
    const file = this.properties.find((p) => p.alias === 'umbracoFile')?.value
    if (typeof file === 'string') return file
    const src = (file as { src?: unknown } | null | undefined)?.src
    return typeof src === 'string' ? src : ''
  }

  /** The file as an Image Cropper value, for its crops and focal point. */
  get image(): ImageCropperValue {
    const file = this.properties.find((p) => p.alias === 'umbracoFile')?.value
    return new ImageCropperValue(
      typeof file === 'string' ? { src: file } : ((file as object | null | undefined) ?? {}),
    )
  }

  value(alias: string): unknown {
    return this.properties.find((p) => p.alias === alias)?.value ?? null
  }

  text(alias: string): string {
    const value = this.value(alias)
    return value === null || value === undefined ? '' : String(value)
  }
}

/**
 * A Media Picker entry: the media item, with the crops and focal point this
 * pick overrides (Umbraco's `MediaWithCrops`).
 */
export class MediaWithCrops {
  readonly key: string
  readonly media: PublishedMedia
  readonly crops: Crop[]
  readonly focalPoint: FocalPoint | null

  constructor(
    media: PublishedMedia,
    local: { key?: unknown; crops?: unknown; focalPoint?: unknown },
  ) {
    this.media = media
    this.key = typeof local.key === 'string' ? local.key : media.key
    const own = media.image
    const localCrops = readCrops(local.crops)
    // The pick's own crop wins; the media's crops fill in the rest.
    this.crops = [
      ...localCrops,
      ...own.crops.filter((c) => !localCrops.some((l) => l.alias === c.alias)),
    ]
    this.focalPoint = readFocalPoint(local.focalPoint) ?? own.focalPoint
  }

  get name(): string {
    return this.media.name
  }

  get url(): string {
    return this.media.url
  }

  cropUrl(request: CropRequest): string | null {
    return this.url ? cropUrl(this.url, this.crops, this.focalPoint, request) : null
  }
}
