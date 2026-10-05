/**
 * WP-6.4: resized and cropped media, in the query vocabulary Umbraco's URL
 * generator writes (`width`, `height`, `rmode`, `rxy`, `cc`, `format`).
 * Images are built from known colours so crops can be checked pixel by pixel.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@bunbraco/core'
import {
  decodePng,
  encodePng,
  type ImagingRequest,
  type Pixels,
  parseImagingQuery,
  processImage,
} from '@bunbraco/server'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

type RGBA = [number, number, number, number]
const RED: RGBA = [255, 0, 0, 255]
const GREEN: RGBA = [0, 255, 0, 255]
const BLUE: RGBA = [0, 0, 255, 255]
const WHITE: RGBA = [255, 255, 255, 255]

/** A width×height image whose colour at each pixel is `colour(x, y)`. */
function image(width: number, height: number, colour: (x: number, y: number) => RGBA): Pixels {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(colour(x, y), (y * width + x) * 4)
  return { width, height, data }
}

const quadrants = image(8, 8, (x, y) => (y < 4 ? (x < 4 ? RED : GREEN) : x < 4 ? BLUE : WHITE))
const halves = image(16, 8, (x) => (x < 8 ? RED : GREEN))

const pixel = (pixels: Pixels, x: number, y: number) =>
  Array.from(pixels.data.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4))

const run = async (source: Pixels, request: Partial<ImagingRequest>) => {
  const out = await processImage(
    encodePng(source),
    { mode: 'crop', format: 'png', ...request },
    'x.png',
  )
  return decodePng(out.bytes)
}

describe('the PNG codec', () => {
  test('round-trips pixels, and Bun reads what it writes', async () => {
    const bytes = encodePng(quadrants)
    expect(decodePng(bytes)).toEqual(quadrants)
    expect(await new Bun.Image(bytes).metadata()).toMatchObject({
      width: 8,
      height: 8,
      format: 'png',
    })
  })

  test("decodes Bun's own PNG output, filters included", async () => {
    const reencoded = decodePng(await new Bun.Image(encodePng(quadrants)).png().bytes())
    expect(pixel(reencoded, 0, 0)).toEqual(RED)
    expect(pixel(reencoded, 7, 0)).toEqual(GREEN)
    expect(pixel(reencoded, 0, 7)).toEqual(BLUE)
    expect(pixel(reencoded, 7, 7)).toEqual(WHITE)
  })
})

describe('imaging requests', () => {
  test("parse Umbraco's query vocabulary; no size, crop or format means the original", () => {
    const parse = (q: string) => parseImagingQuery(new URLSearchParams(q))
    expect(parse('')).toBeUndefined()
    expect(parse('v=123')).toBeUndefined()
    expect(parse('width=200&height=100&rmode=max&format=jpeg')).toEqual({
      width: 200,
      height: 100,
      mode: 'max',
      focalPoint: undefined,
      crop: undefined,
      format: 'jpg',
      quality: undefined,
    })
    expect(parse('width=10&rxy=0.2,0.8')?.focalPoint).toEqual({ left: 0.2, top: 0.8 })
    expect(parse('cc=0.1,0.2,0.3,0.4')?.crop).toEqual({
      left: 0.1,
      top: 0.2,
      right: 0.3,
      bottom: 0.4,
    })
    expect(parse('width=99999')?.width).toBe(5000)
    expect(parse('width=10&rmode=explode')?.mode).toBe('crop')
    expect(parse('cc=2,0,0,0')).toBeUndefined()
  })

  test('crop coordinates cut the source before resizing', async () => {
    // Trim the left half and the bottom half: the green quadrant is left
    const cut = await run(quadrants, { crop: { left: 0.5, top: 0, right: 0, bottom: 0.5 } })
    expect([cut.width, cut.height]).toEqual([4, 4])
    expect(pixel(cut, 0, 0)).toEqual(GREEN)
    expect(pixel(cut, 3, 3)).toEqual(GREEN)
  })

  test('crop mode fills the box around the focal point', async () => {
    const left = await run(halves, { width: 4, height: 4, focalPoint: { left: 0.1, top: 0.5 } })
    const right = await run(halves, { width: 4, height: 4, focalPoint: { left: 0.9, top: 0.5 } })
    expect([left.width, left.height]).toEqual([4, 4])
    expect(pixel(left, 2, 2)).toEqual(RED)
    expect(pixel(right, 2, 2)).toEqual(GREEN)
  })

  test('max fits inside; stretch fills; pad centres on a transparent canvas; one side keeps the ratio', async () => {
    const max = await run(halves, { width: 8, height: 8, mode: 'max' })
    expect([max.width, max.height]).toEqual([8, 4])
    const stretch = await run(halves, { width: 8, height: 8, mode: 'stretch' })
    expect([stretch.width, stretch.height]).toEqual([8, 8])
    const pad = await run(halves, { width: 8, height: 8, mode: 'pad' })
    expect([pad.width, pad.height]).toEqual([8, 8])
    expect(pixel(pad, 4, 0)[3]).toBe(0)
    // Resampling blends by a unit or two
    expect(pixel(pad, 1, 4).every((c, i) => Math.abs(c - (RED[i] as number)) <= 4)).toBe(true)
    const byWidth = await run(halves, { width: 4 })
    expect([byWidth.width, byWidth.height]).toEqual([4, 2])
    const byHeight = await run(halves, { height: 4 })
    expect([byHeight.width, byHeight.height]).toEqual([8, 4])
  })

  test('the output format follows the request, else the source', async () => {
    const webp = await processImage(
      encodePng(halves),
      { mode: 'max', width: 4, format: 'webp' },
      'x.png',
    )
    expect(webp.contentType).toBe('image/webp')
    expect((await new Bun.Image(webp.bytes).metadata()).format).toBe('webp')
    const asSource = await processImage(encodePng(halves), { mode: 'max', width: 4 }, 'photo.jpg')
    expect(asSource.contentType).toBe('image/jpeg')
  })
})

describe('the media route and resize URLs', () => {
  test('serves a variant from the cache, and the backoffice asks for thumbnails by URL', async () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'imaging-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema'), { recursive: true })
    mkdirSync(join(root, 'components'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    const mediaDir = join(root, 'media')
    const h = await signedInServer({
      config: {
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        mediaDir,
      },
    })
    open.push(h)
    const id = crypto.randomUUID()
    const form = new FormData()
    form.set('Id', id)
    form.set('File', new File([encodePng(halves) as Uint8Array<ArrayBuffer>], 'halves.png'))
    await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
    const created = await h.post(`${V1}/media`, {
      mediaType: { id: SYSTEM_MEDIA_TYPE_KEYS.Image },
      parent: null,
      values: [
        {
          alias: 'umbracoFile',
          culture: null,
          segment: null,
          value: { src: '', temporaryFileId: id, crops: [], focalPoint: null },
        },
      ],
      variants: [{ culture: null, segment: null, name: 'Halves' }],
    })
    const key = created.headers.get('umb-generated-resource') as string

    const urls = await h.json<Array<{ id: string; urlInfos: Array<{ url: string }> }>>(
      `${V1}/imaging/resize/urls?id=${key}&width=4&height=4&mode=Crop`,
    )
    const url = urls[0]?.urlInfos[0]?.url as string
    expect(url).toMatch(/^\/media\/[0-9a-f]{8}\/halves\.png\?width=4&height=4&rmode=crop$/)

    const first = await h.call(url)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    // Uploaded bytes served from this origin: never sniffed, and an image is not
    // sandboxed — that is reserved for the types that can carry script, so
    // opening a PDF from the library still works.
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    expect(first.headers.get('content-security-policy')).toBeNull()
    const resized = decodePng(new Uint8Array(await first.arrayBuffer()))
    expect([resized.width, resized.height]).toEqual([4, 4])
    const cached = readdirSync(join(mediaDir, '.cache'), { recursive: true })
    expect(cached.filter((f) => String(f).endsWith('.png'))).toHaveLength(1)
    // The same request is served from the cache
    expect((await h.call(url)).status).toBe(200)
    expect(
      readdirSync(join(mediaDir, '.cache'), { recursive: true }).filter((f) =>
        String(f).endsWith('.png'),
      ),
    ).toHaveLength(1)
    // No query: the original
    const original = decodePng(
      new Uint8Array(await (await h.call(url.split('?')[0] as string)).arrayBuffer()),
    )
    expect([original.width, original.height]).toEqual([16, 8])
    // The cache is not reachable as media
    expect((await h.call('/media/.cache/x.png')).status).toBe(404)
  })

  test('an SVG is sandboxed, because the library may hold one and it can script', async () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'imaging-svg-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema'), { recursive: true })
    mkdirSync(join(root, 'components'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    const mediaDir = join(root, 'media')
    mkdirSync(join(mediaDir, 'abcd1234'), { recursive: true })
    writeFileSync(
      join(mediaDir, 'abcd1234', 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    )
    const h = await signedInServer({
      config: {
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        mediaDir,
      },
    })
    open.push(h)

    const served = await h.call('/media/abcd1234/logo.svg')
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/svg+xml')
    // Opened as a page it gets an opaque origin and no script; as an `<img src>`
    // it renders as before, so a site using an SVG logo is unaffected.
    expect(served.headers.get('content-security-policy')).toBe('sandbox')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
