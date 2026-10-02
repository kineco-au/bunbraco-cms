/**
 * WP-6.4: the Media section — uploading into media items, the tree, items,
 * search and collection, sorting and moving, the recycle bin, and the lookups
 * the dropzone uses to choose a media type.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@bunbraco/core'
import { siteMediaTypeFiles } from '@bunbraco/schema'
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

const IMAGE = SYSTEM_MEDIA_TYPE_KEYS.Image
const FILE = SYSTEM_MEDIA_TYPE_KEYS.File
const FOLDER = SYSTEM_MEDIA_TYPE_KEYS.Folder

async function png(width = 4, height = 3): Promise<Uint8Array<ArrayBuffer>> {
  const source = await Bun.file(join(import.meta.dir, 'fixtures', 'pixel.png')).bytes()
  return new Uint8Array(
    await new Bun.Image(source).resize(width, height, { fit: 'fill' }).png().bytes(),
  )
}

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'media-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'media-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  for (const [path, content] of Object.entries(siteMediaTypeFiles()))
    writeFileSync(join(root, path), content)
  const mediaDir = join(root, 'media')
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), viewsDir: join(root, 'Views'), mediaDir },
  })
  open.push(h)

  const upload = async (file: File) => {
    const id = crypto.randomUUID()
    const form = new FormData()
    form.set('Id', id)
    form.set('File', file)
    const response = await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
    expect(response.status).toBe(201)
    return id
  }
  const create = async (
    type: string,
    name: string,
    parent: string | null = null,
    values: Array<{ alias: string; value: unknown }> = [],
  ) => {
    const response = await h.post(`${V1}/media`, {
      mediaType: { id: type },
      parent: parent ? { id: parent } : null,
      values: values.map((v) => ({ ...v, culture: null, segment: null })),
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  const image = async (name: string, parent: string | null = null) =>
    create(IMAGE, name, parent, [
      {
        alias: 'umbracoFile',
        value: {
          src: '',
          temporaryFileId: await upload(new File([await png()], `${name}.png`)),
          crops: [],
          focalPoint: null,
        },
      },
    ])
  const names = async (parent: string | null) =>
    (
      await h.json<{ items: Array<{ variants: Array<{ name: string }> }> }>(
        parent
          ? `${V1}/tree/media/children?parentId=${parent}&skip=0&take=50`
          : `${V1}/tree/media/root?skip=0&take=50`,
      )
    ).items.map((i) => i.variants[0]?.name)
  return { h, mediaDir, upload, create, image, names }
}

type Media = {
  id: string
  isTrashed: boolean
  mediaType: { id: string }
  values: Array<{ alias: string; value: unknown; editorAlias: string }>
  variants: Array<{ name: string }>
}
const valuesOf = (media: Media) => Object.fromEntries(media.values.map((v) => [v.alias, v.value]))

describe('media items', () => {
  test('an uploaded image becomes a media item: its file placed and served, its facts filled in', async () => {
    const { h, image } = await site()
    const key = await image('Hero')
    const media = await h.json<Media>(`${V1}/media/${key}`)
    expect(media).toMatchObject({ id: key, isTrashed: false, mediaType: { id: IMAGE } })
    const values = valuesOf(media)
    const file = values.umbracoFile as { src: string }
    expect(file.src).toMatch(/^\/media\/[0-9a-f]{8}\/hero\.png$/)
    expect(values).toMatchObject({ umbracoWidth: 4, umbracoHeight: 3, umbracoExtension: 'png' })
    expect(Number(values.umbracoBytes)).toBeGreaterThan(0)
    expect(media.values.find((v) => v.alias === 'umbracoFile')?.editorAlias).toBe(
      'Umbraco.ImageCropper',
    )

    const served = await h.call(file.src)
    expect(served.status).toBe(200)
    expect(new Uint8Array(await served.arrayBuffer()).slice(1, 4)).toEqual(
      new TextEncoder().encode('PNG'),
    )
    expect(await h.json<unknown>(`${V1}/media/urls?id=${key}`)).toEqual([
      { id: key, urlInfos: [{ culture: null, url: file.src }] },
    ])
  })

  test("replacing an item's file removes the old one", async () => {
    const { h, mediaDir, upload, image } = await site()
    const key = await image('Hero')
    const before = valuesOf(await h.json<Media>(`${V1}/media/${key}`)).umbracoFile as {
      src: string
    }
    const oldFile = join(mediaDir, before.src.slice('/media/'.length))
    const replacement = await upload(new File([await png(8, 6)], 'hero-wide.png'))
    const saved = await h.put(`${V1}/media/${key}`, {
      values: [
        {
          alias: 'umbracoFile',
          culture: null,
          segment: null,
          value: { src: before.src, temporaryFileId: replacement, crops: [], focalPoint: null },
        },
      ],
      variants: [{ culture: null, segment: null, name: 'Hero' }],
    })
    expect(saved.status).toBe(200)
    const after = valuesOf(await h.json<Media>(`${V1}/media/${key}`))
    expect((after.umbracoFile as { src: string }).src).toMatch(/hero-wide\.png$/)
    expect(after).toMatchObject({ umbracoWidth: 8, umbracoHeight: 6 })
    expect(existsSync(oldFile)).toBe(false)
  })

  test('validation: a media item without its required file is refused', async () => {
    const { h } = await site()
    const refused = await h.post(`${V1}/media/validate`, {
      mediaType: { id: IMAGE },
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Empty' }],
    })
    expect(refused.status).toBe(400)
    expect(
      (
        await h.post(`${V1}/media`, {
          mediaType: { id: IMAGE },
          parent: null,
          values: [],
          variants: [{ culture: null, segment: null, name: 'Empty' }],
        })
      ).status,
    ).toBe(400)
  })

  test('folders, the tree, items, search and the collection view', async () => {
    const { h, create, image, names } = await site()
    const photos = await create(FOLDER, 'Photos')
    const hero = await image('Hero', photos)
    await image('Banner', photos)
    await create(FOLDER, 'Documents')

    expect(await names(null)).toEqual(['Photos', 'Documents'])
    // A folder shows its children in Umbraco's media list view
    const roots = await h.json<{
      items: Array<{ id: string; mediaType: { collection: { id: string } | null } }>
    }>(`${V1}/tree/media/root?skip=0&take=10`)
    expect(roots.items.find((i) => i.id === photos)?.mediaType.collection).toEqual({
      id: '3a0156c4-3b8c-4803-bdc1-6871faa83fff',
    })
    expect(await names(photos)).toEqual(['Hero', 'Banner'])
    const items = await h.json<
      Array<{ id: string; parent: { id: string } | null; mediaType: { id: string } }>
    >(`${V1}/item/media?id=${hero}`)
    expect(items).toEqual([
      expect.objectContaining({
        id: hero,
        parent: { id: photos },
        mediaType: expect.objectContaining({ id: IMAGE }),
      }),
    ])
    expect(
      (
        await h.json<Array<{ ancestors: Array<{ id: string }> }>>(
          `${V1}/item/media/ancestors?id=${hero}`,
        )
      )[0]?.ancestors.map((a) => a.id),
    ).toEqual([photos])
    const search = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/item/media/search?query=her&skip=0&take=10`,
    )
    expect(search.items.map((i) => i.id)).toEqual([hero])

    type Collection = {
      total: number
      items: Array<{
        id: string
        variants: Array<{ name: string }>
        creator: string | null
        mediaType: { alias: string }
      }>
    }
    const collection = await h.json<Collection>(
      `${V1}/collection/media?id=${photos}&orderBy=name&orderDirection=Ascending&skip=0&take=10`,
    )
    expect(collection.items.map((i) => i.variants[0]?.name)).toEqual(['Banner', 'Hero'])
    expect(collection.items[0]).toMatchObject({
      mediaType: { alias: 'Image' },
      creator: expect.any(String),
    })
    expect(
      (
        await h.json<Collection>(
          `${V1}/collection/media?id=${photos}&filter=ban&orderBy=name&skip=0&take=10`,
        )
      ).items.map((i) => i.variants[0]?.name),
    ).toEqual(['Banner'])
    expect(
      (await h.json<Collection>(`${V1}/collection/media?orderBy=sortOrder&skip=0&take=10`)).total,
    ).toBe(2)
  })

  test('sort, move, the recycle bin, and deleting for good removes the file', async () => {
    const { h, mediaDir, create, image, names } = await site()
    const photos = await create(FOLDER, 'Photos')
    const archive = await create(FOLDER, 'Archive')
    const a = await image('Alpha', photos)
    const b = await image('Bravo', photos)
    expect(
      (
        await h.put(`${V1}/media/${photos}/sort-children`, {
          field: 'Name',
          direction: 'Descending',
        })
      ).status,
    ).toBe(200)
    expect(await names(photos)).toEqual(['Bravo', 'Alpha'])
    expect(
      (
        await h.put(`${V1}/media/sort`, {
          parent: { id: photos },
          sorting: [
            { id: a, sortOrder: 0 },
            { id: b, sortOrder: 1 },
          ],
        })
      ).status,
    ).toBe(200)
    expect(await names(photos)).toEqual(['Alpha', 'Bravo'])
    expect((await h.put(`${V1}/media/${b}/move`, { target: { id: archive } })).status).toBe(200)
    expect(await names(archive)).toEqual(['Bravo'])

    const fileOf = async (key: string) =>
      (valuesOf(await h.json<Media>(`${V1}/media/${key}`)).umbracoFile as { src: string }).src
    const alphaFile = join(mediaDir, (await fileOf(a)).slice('/media/'.length))
    expect(existsSync(alphaFile)).toBe(true)

    expect((await h.put(`${V1}/media/${a}/move-to-recycle-bin`, {})).status).toBe(200)
    const bin = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/recycle-bin/media/root?skip=0&take=10`,
    )
    expect(bin.items.map((i) => i.id)).toEqual([a])
    expect(await h.json<unknown>(`${V1}/recycle-bin/media/${a}/original-parent`)).toEqual({
      id: photos,
    })
    // Trashed media keeps its file, and restores
    expect(existsSync(alphaFile)).toBe(true)
    expect((await h.put(`${V1}/recycle-bin/media/${a}/restore`, {})).status).toBe(200)
    expect(await names(photos)).toEqual(['Alpha'])

    await h.put(`${V1}/media/${a}/move-to-recycle-bin`, {})
    expect((await h.del(`${V1}/recycle-bin/media/${a}`)).status).toBe(200)
    expect(existsSync(alphaFile)).toBe(false)
    expect((await h.call(`${V1}/media/${a}`)).status).toBe(404)

    // Emptying the bin removes the rest, files included
    const bravoFile = join(mediaDir, (await fileOf(b)).slice('/media/'.length))
    await h.put(`${V1}/media/${archive}/move-to-recycle-bin`, {})
    expect((await h.del(`${V1}/recycle-bin/media`)).status).toBe(200)
    expect(existsSync(bravoFile)).toBe(false)
    expect(
      (await h.json<{ total: number }>(`${V1}/recycle-bin/media/root?skip=0&take=10`)).total,
    ).toBe(0)
  })

  test('the dropzone lookups: which type an upload becomes, and which types are folders', async () => {
    const { h } = await site()
    type Allowed = { items: Array<{ id: string; name: string; matchedFileExtension: boolean }> }
    const forPng = await h.json<Allowed>(
      `${V1}/item/media-type/allowed?fileExtension=png&skip=0&take=20`,
    )
    expect(forPng.items.filter((t) => t.matchedFileExtension).map((t) => t.name)).toEqual(['Image'])
    const forPdf = await h.json<Allowed>(
      `${V1}/item/media-type/allowed?fileExtension=pdf&skip=0&take=20`,
    )
    expect(forPdf.items.filter((t) => t.matchedFileExtension).map((t) => t.name)).toEqual([
      'Article',
    ])
    // File takes anything, as the fallback
    expect(forPdf.items.find((t) => t.id === FILE)?.matchedFileExtension).toBe(false)
    const folders = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/item/media-type/folders?skip=0&take=10`,
    )
    expect(folders.items.map((t) => t.id)).toEqual([FOLDER])
  })
})
