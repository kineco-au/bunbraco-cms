/**
 * WP-6.4's exit, through the API: an image uploaded to Media, picked on a page
 * and published, renders as a resized crop the media route serves. Plus the
 * gallery form, rich text links and images, and the Image Cropper's crops.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@bunbraco/core'
import { ContentTypeRepository, TemplateRepository } from '@bunbraco/data'
import { siteMediaTypeFiles } from '@bunbraco/schema'
import { decodePng, encodePng } from '@bunbraco/server'
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

const ARTICLE = `[document-type]
alias = "article"
name = "Article"
allow-at-root = true
allow-children = ["article"]
templates = ["article"]
default-template = "article"

[[property]]
alias = "hero"
name = "Hero"
type = "imageMediaPicker"

[[property]]
alias = "gallery"
name = "Gallery"
type = "multipleMediaPicker"

[[property]]
alias = "body"
name = "Body"
type = "richtext"

[[property]]
alias = "cover"
name = "Cover"
type = "coverCropper"
`

const COVER_CROPPER = `[data-type]
alias = "coverCropper"
name = "Cover cropper"
editor = "Umbraco.ImageCropper"
editor-ui = "Umb.PropertyEditorUi.ImageCropper"

[[data-type.config.crops]]
alias = "thumb"
width = 4
height = 4
`

const VIEW = `export default function Article({ model }) {
  const hero = model.value('hero')
  return (
    <main>
      <img class="hero" src={hero?.cropUrl({ width: 4, height: 4 })} alt={hero?.name} />
      <ul>{model.media('gallery').map((m) => <li>{m.name}={m.url}</li>)}</ul>
      <div class="body">{model.html('body')}</div>
      <img class="cover" src={model.value('cover')?.cropUrl('thumb')} />
    </main>
  )
}
`

/** 16×8: red on the left half, green on the right. */
const halves = () => {
  const data = new Uint8Array(16 * 8 * 4)
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 16; x++)
      data.set(x < 8 ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * 16 + x) * 4)
  return encodePng({ width: 16, height: 8, data }) as Uint8Array<ArrayBuffer>
}

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'media-render-'))
  dirs.push(root)
  for (const dir of ['schema/document-types', 'schema/data-types', 'schema/media-types', 'Views'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  for (const [path, content] of Object.entries(siteMediaTypeFiles()))
    writeFileSync(join(root, path), content)
  writeFileSync(join(root, 'schema', 'document-types', 'article.toml'), ARTICLE)
  writeFileSync(join(root, 'schema', 'data-types', 'cover-cropper.toml'), COVER_CROPPER)
  writeFileSync(join(root, 'Views', 'article.tsx'), VIEW)
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      viewsDir: join(root, 'Views'),
      mediaDir: join(root, 'media'),
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('article'))?.key as string
  const templateKey = (await new TemplateRepository(h.server.db).byAlias('article'))?.key as string

  const upload = async (name: string) => {
    const id = crypto.randomUUID()
    const form = new FormData()
    form.set('Id', id)
    form.set('File', new File([halves()], name))
    await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
    return id
  }
  const image = async (name: string, focalPoint: { left: number; top: number } | null = null) => {
    const response = await h.post(`${V1}/media`, {
      mediaType: { id: SYSTEM_MEDIA_TYPE_KEYS.Image },
      parent: null,
      values: [
        {
          alias: 'umbracoFile',
          culture: null,
          segment: null,
          value: { src: '', temporaryFileId: await upload(`${name}.png`), crops: [], focalPoint },
        },
      ],
      variants: [{ culture: null, segment: null, name }],
    })
    const key = response.headers.get('umb-generated-resource') as string
    const media = await h.json<{ values: Array<{ alias: string; value: { src: string } }> }>(
      `${V1}/media/${key}`,
    )
    return { key, src: media.values.find((v) => v.alias === 'umbracoFile')?.value.src as string }
  }
  const page = async (name: string, values: Record<string, unknown>) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: templateKey },
      parent: null,
      values: Object.entries(values).map(([alias, value]) => ({
        alias,
        culture: null,
        segment: null,
        value,
      })),
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    const key = response.headers.get('umb-generated-resource') as string
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    return key
  }
  return { h, image, page, upload }
}

const pick = (mediaKey: string, extra: Record<string, unknown> = {}) => ({
  key: crypto.randomUUID(),
  mediaKey,
  mediaTypeAlias: 'Image',
  crops: [],
  focalPoint: null,
  ...extra,
})

describe('media on pages', () => {
  test('a picked image renders as a resized crop around its focal point, which the media route serves', async () => {
    const { h, image, page, upload } = await site()
    // The focal point is on the green half
    const hero = await image('Hero', { left: 0.9, top: 0.5 })
    const other = await image('Other')
    const about = await page('About', {})
    await page('Home', {
      hero: [pick(hero.key)],
      gallery: [pick(other.key), pick(hero.key)],
      body: {
        markup: `<p><a href="/{localLink:${about}}" type="document">About</a> <a href="/{localLink:${crypto.randomUUID()}}" type="document">Gone</a> <img src="${hero.src}" alt="hero" /></p>`,
        blocks: null,
      },
      cover: {
        src: '',
        temporaryFileId: await upload('cover.png'),
        crops: [
          { alias: 'thumb', width: 4, height: 4, coordinates: { x1: 0, y1: 0, x2: 0.5, y2: 0 } },
        ],
        focalPoint: null,
      },
    })

    // About was created first, so it is the site root; Home is a second root
    const home = await (await h.call('/home')).text()
    const heroUrl = /class="hero" src="([^"]+)"/.exec(home)?.[1]?.replaceAll('&amp;', '&') as string
    expect(heroUrl).toBe(`${hero.src}?rxy=0.9%2C0.5&width=4&height=4`)
    expect(home).toContain('alt="Hero"')
    expect(home).toContain(`<li>Other=${other.src}</li><li>Hero=${hero.src}</li>`)
    // Rich text: local links resolve, a dead one goes nowhere, images stay
    expect(home).toContain('<a href="/" type="document">About</a>')
    expect(home).toContain('<a href="#" type="document">Gone</a>')
    expect(home).toContain(`<img src="${hero.src}" alt="hero" />`)

    // The crop the page asked for: 4×4, from the green side
    const served = await h.call(heroUrl)
    expect(served.status).toBe(200)
    const pixels = decodePng(new Uint8Array(await served.arrayBuffer()))
    expect([pixels.width, pixels.height]).toEqual([4, 4])
    expect(Array.from(pixels.data.subarray(0, 3)).map((c) => Math.round(c / 16))).toEqual([
      0, 16, 0,
    ])

    // The cropper's named crop: the stored coordinates trim the right half, so it is red
    const coverUrl = /class="cover" src="([^"]+)"/
      .exec(home)?.[1]
      ?.replaceAll('&amp;', '&') as string
    expect(coverUrl).toMatch(/\?cc=0%2C0%2C0\.5%2C0&width=4&height=4$/)
    const cover = decodePng(new Uint8Array(await (await h.call(coverUrl)).arrayBuffer()))
    expect(Array.from(cover.data.subarray(0, 3)).map((c) => Math.round(c / 16))).toEqual([16, 0, 0])

    // Trashed media drops out of the page
    await h.put(`${V1}/media/${other.key}/move-to-recycle-bin`, {})
    expect(await (await h.call('/home')).text()).toContain(`<ul><li>Hero=${hero.src}</li></ul>`)
  })
})
