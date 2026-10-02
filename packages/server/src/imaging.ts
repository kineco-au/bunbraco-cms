/**
 * Image processing for `/media/…?width=…` URLs, in the query vocabulary
 * Umbraco's ImageSharp URL generator writes: `width`, `height`, `rmode`
 * (crop, max, stretch, pad, boxpad, min), `rxy` (focal point), `cc` (crop
 * coordinates as fractions trimmed from each edge), `format` and `quality`.
 *
 * Bun decodes, resizes and encodes images but cannot crop or pad, so those two
 * go through raw RGBA pixels: Bun re-encodes the source as a plain PNG, which
 * is decoded here, cut, and encoded again. Results are cached on disk by source
 * and request, so each variant is computed once.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import type { MediaStore, StoredFile } from './media-store.ts'

// --------------------------------------------------------------------- PNG

export interface Pixels {
  width: number
  height: number
  /** RGBA, 8 bits per channel, rows top to bottom. */
  data: Uint8Array
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decodes an 8-bit, non-interlaced PNG of any colour type to RGBA. */
export function decodePng(bytes: Uint8Array): Pixels {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('Not a PNG.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const idat: Uint8Array[] = []
  while (offset < bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      const bitDepth = data[8]
      colorType = data[9] as number
      if (bitDepth !== 8 || data[12] !== 0)
        throw new Error('Only 8-bit, non-interlaced PNGs are decoded.')
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') transparency = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`)
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const chunk of idat) {
    joined.set(chunk, at)
    at += chunk.length
  }
  const raw = new Uint8Array(inflateSync(joined))
  const stride = width * channels
  const rows = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = rows.subarray(y * stride, (y + 1) * stride)
    const prior = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : undefined
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (out[x - channels] as number) : 0
      const up = prior ? (prior[x] as number) : 0
      const upLeft = prior && x >= channels ? (prior[x - channels] as number) : 0
      const value = line[x] as number
      out[x] =
        filter === 0
          ? value
          : filter === 1
            ? value + left
            : filter === 2
              ? value + up
              : filter === 3
                ? value + ((left + up) >> 1)
                : value + paeth(left, up, upLeft)
    }
  }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = i * channels
    const d = i * 4
    if (colorType === 6) data.set(rows.subarray(s, s + 4), d)
    else if (colorType === 2) {
      data.set(rows.subarray(s, s + 3), d)
      data[d + 3] = 255
    } else if (colorType === 0 || colorType === 4) {
      const g = rows[s] as number
      data[d] = g
      data[d + 1] = g
      data[d + 2] = g
      data[d + 3] = colorType === 4 ? (rows[s + 1] as number) : 255
    } else {
      const index = rows[s] as number
      data[d] = palette?.[index * 3] ?? 0
      data[d + 1] = palette?.[index * 3 + 1] ?? 0
      data[d + 2] = palette?.[index * 3 + 2] ?? 0
      data[d + 3] = transparency?.[index] ?? 255
    }
  }
  return { width, height, data }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Encodes RGBA pixels as a PNG (no filtering; deflate does the work). */
export function encodePng(pixels: Pixels): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, pixels.width)
  view.setUint32(4, pixels.height)
  header.set([8, 6, 0, 0, 0], 8)
  const stride = pixels.width * 4
  const raw = new Uint8Array((stride + 1) * pixels.height)
  for (let y = 0; y < pixels.height; y++)
    raw.set(pixels.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  const parts = [
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export function cropPixels(
  pixels: Pixels,
  x: number,
  y: number,
  width: number,
  height: number,
): Pixels {
  const w = Math.max(1, Math.min(width, pixels.width - x))
  const h = Math.max(1, Math.min(height, pixels.height - y))
  const data = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * pixels.width + x) * 4
    data.set(pixels.data.subarray(from, from + w * 4), row * w * 4)
  }
  return { width: w, height: h, data }
}

/** Places pixels centred on a canvas of the given size, filled with `background` (RGBA). */
export function padPixels(
  pixels: Pixels,
  width: number,
  height: number,
  background: [number, number, number, number] = [255, 255, 255, 0],
): Pixels {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(background, i * 4)
  const x0 = Math.floor((width - pixels.width) / 2)
  const y0 = Math.floor((height - pixels.height) / 2)
  for (let row = 0; row < pixels.height; row++) {
    const to = ((y0 + row) * width + x0) * 4
    data.set(pixels.data.subarray(row * pixels.width * 4, (row + 1) * pixels.width * 4), to)
  }
  return { width, height, data }
}

// ------------------------------------------------------------ the request

export type ResizeMode = 'crop' | 'max' | 'stretch' | 'pad' | 'boxpad' | 'min'
export type OutputFormat = 'jpg' | 'png' | 'webp'

export interface ImagingRequest {
  width?: number
  height?: number
  mode: ResizeMode
  /** Focal point, 0–1 from the left and top. */
  focalPoint?: { left: number; top: number }
  /** Fractions trimmed from each edge. */
  crop?: { left: number; top: number; right: number; bottom: number }
  format?: OutputFormat
  quality?: number
}

const MODES: readonly ResizeMode[] = ['crop', 'max', 'stretch', 'pad', 'boxpad', 'min']
const MAX_SIDE = 5000

/** The imaging request a query asks for, or undefined when it asks for the original. */
export function parseImagingQuery(params: URLSearchParams): ImagingRequest | undefined {
  const size = (name: string) => {
    const value = Number(params.get(name))
    return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), MAX_SIDE) : undefined
  }
  const fractions = (name: string, count: number) => {
    const parts = (params.get(name) ?? '').split(',').map(Number)
    return parts.length === count && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
      ? parts
      : undefined
  }
  const width = size('width')
  const height = size('height')
  const rxy = fractions('rxy', 2)
  const cc = fractions('cc', 4)
  const format = (params.get('format') ?? '').toLowerCase().replace('jpeg', 'jpg')
  const quality = size('quality')
  if (!width && !height && !cc && !format) return undefined
  const mode = (params.get('rmode') ?? '').toLowerCase() as ResizeMode
  return {
    width,
    height,
    mode: MODES.includes(mode) ? mode : 'crop',
    focalPoint: rxy ? { left: rxy[0] as number, top: rxy[1] as number } : undefined,
    crop: cc
      ? {
          left: cc[0] as number,
          top: cc[1] as number,
          right: cc[2] as number,
          bottom: cc[3] as number,
        }
      : undefined,
    format: ['jpg', 'png', 'webp'].includes(format) ? (format as OutputFormat) : undefined,
    quality: quality ? Math.min(quality, 100) : undefined,
  }
}

const formatOf = (source: string): OutputFormat => {
  const extension = source.split('.').pop()?.toLowerCase()
  return extension === 'png' || extension === 'gif' ? 'png' : extension === 'webp' ? 'webp' : 'jpg'
}

/** The crop window, in source pixels, that fills width×height around the focal point. */
function coverWindow(
  source: { width: number; height: number },
  width: number,
  height: number,
  focal = { left: 0.5, top: 0.5 },
) {
  const scale = Math.max(width / source.width, height / source.height)
  const w = Math.min(source.width, Math.round(width / scale))
  const h = Math.min(source.height, Math.round(height / scale))
  const x = Math.round(Math.min(Math.max(focal.left * source.width - w / 2, 0), source.width - w))
  const y = Math.round(Math.min(Math.max(focal.top * source.height - h / 2, 0), source.height - h))
  return { x, y, w, h }
}

/** Applies a request to an image's bytes; returns the new bytes and their content type. */
export async function processImage(
  bytes: Uint8Array,
  request: ImagingRequest,
  sourceName: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const format = request.format ?? formatOf(sourceName)
  let pixels: Pixels | undefined
  const decode = async () => {
    pixels ??= decodePng(await new Bun.Image(bytes).png().bytes())
    return pixels
  }

  if (request.crop) {
    const source = await decode()
    const x = Math.round(request.crop.left * source.width)
    const y = Math.round(request.crop.top * source.height)
    const right = Math.round(request.crop.right * source.width)
    const bottom = Math.round(request.crop.bottom * source.height)
    pixels = cropPixels(source, x, y, source.width - x - right, source.height - y - bottom)
  }

  const current = pixels ?? (await new Bun.Image(bytes).metadata())
  const { width, height } = request
  let resize: { width: number; height?: number; fit: 'fill' | 'inside' } | undefined

  if (width && height) {
    switch (request.mode) {
      case 'stretch':
        resize = { width, height, fit: 'fill' }
        break
      case 'max':
        resize = { width, height, fit: 'inside' }
        break
      case 'min': {
        const scale = Math.min(1, Math.max(width / current.width, height / current.height))
        resize = {
          width: Math.max(1, Math.round(current.width * scale)),
          height: Math.max(1, Math.round(current.height * scale)),
          fit: 'fill',
        }
        break
      }
      case 'pad':
      case 'boxpad': {
        const scale = Math.min(width / current.width, height / current.height)
        const fitted =
          request.mode === 'boxpad' && scale > 1
            ? { w: current.width, h: current.height }
            : {
                w: Math.max(1, Math.round(current.width * scale)),
                h: Math.max(1, Math.round(current.height * scale)),
              }
        const scaled = decodePng(
          await new Bun.Image(pixels ? encodePng(pixels) : bytes)
            .resize(fitted.w, fitted.h, { fit: 'fill' })
            .png()
            .bytes(),
        )
        pixels = padPixels(scaled, width, height)
        break
      }
      default: {
        if (!request.crop) {
          const source = await decode()
          const window = coverWindow(source, width, height, request.focalPoint)
          pixels = cropPixels(source, window.x, window.y, window.w, window.h)
        }
        resize = { width, height, fit: 'fill' }
      }
    }
  } else if (width || height) {
    const scale = width ? width / current.width : (height as number) / current.height
    resize = {
      width: Math.max(1, Math.round(current.width * scale)),
      height: Math.max(1, Math.round(current.height * scale)),
      fit: 'fill',
    }
  }

  let image = new Bun.Image(pixels ? encodePng(pixels) : bytes)
  if (resize) image = image.resize(resize.width, resize.height, { fit: resize.fit })
  const quality = request.quality
  const encoded =
    format === 'png'
      ? image.png()
      : format === 'webp'
        ? image.webp(quality ? { quality } : undefined)
        : image.jpeg(quality ? { quality } : undefined)
  return {
    bytes: await encoded.bytes(),
    contentType: format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg',
  }
}

/**
 * Serves processed variants from a cache in the media store, so each variant is
 * computed once and — wherever the store keeps its bytes — is there for every
 * node, not only the one that computed it.
 *
 * The cache key includes the source's etag, so replacing an image invalidates
 * every crop of it without anything having to track that.
 */
export class ImageProcessor {
  #store: MediaStore

  constructor(store: MediaStore) {
    this.#store = store
  }

  async variant(
    source: StoredFile,
    request: ImagingRequest,
  ): Promise<{ key: string; bytes: Uint8Array; contentType: string }> {
    const format = request.format ?? formatOf(source.key)
    const hash = new Bun.CryptoHasher('sha1')
      .update(`${source.key}|${source.etag}|${JSON.stringify(request)}`)
      .digest('hex')
    const key = `.cache/${hash.slice(0, 2)}/${hash}.${format}`
    const contentType =
      format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg'
    const cached = await this.#store.get(key)
    if (cached) return { key, bytes: await cached.bytes(), contentType }
    const result = await processImage(await source.bytes(), request, source.key)
    await this.#store.put(key, result.bytes, { contentType: result.contentType })
    return { key, bytes: result.bytes, contentType: result.contentType }
  }
}

/** The query Umbraco's URL generator would write for a resize. */
export function resizeQuery(options: {
  width?: number
  height?: number
  mode?: string
  format?: string
  focalPoint?: { left: number; top: number } | null
  crop?: { x1: number; y1: number; x2: number; y2: number } | null
}): string {
  const params = new URLSearchParams()
  if (options.crop)
    params.set('cc', [options.crop.x1, options.crop.y1, options.crop.x2, options.crop.y2].join(','))
  else if (options.focalPoint)
    params.set('rxy', [options.focalPoint.left, options.focalPoint.top].join(','))
  if (options.width) params.set('width', String(options.width))
  if (options.height) params.set('height', String(options.height))
  if (options.mode) params.set('rmode', options.mode.toLowerCase())
  if (options.format) params.set('format', options.format)
  const query = params.toString()
  return query ? `?${query}` : ''
}
