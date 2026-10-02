/**
 * The media storage seam: where uploaded bytes live is one interface, so a site
 * can put them on a disk, in an S3 bucket or in an Azure container without
 * anything above it changing.
 *
 * The proof is a store written here, in the test, backed by a Map: if the whole
 * media library — uploads, placement, serving, image variants, deletion — works
 * against a store that has no file system at all, then S3 and Azure are a matter
 * of talking to the service, not of fitting in.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@bunbraco/core'
import {
  contentTypeFor,
  fileSystemMediaStore,
  ImageProcessor,
  isSafeMediaKey,
  MediaFileStore,
  type MediaStore,
  mediaStoreFromEnvironment,
  type StoredFile,
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

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(process.cwd(), 'output', prefix))
  dirs.push(dir)
  return dir
}

/**
 * A store with no file system behind it, which is the shape S3 and Azure have:
 * keys in, bytes out, no paths and no directories.
 */
function memoryMediaStore(options: { publicUrlPrefix?: string } = {}): MediaStore & {
  keys(): string[]
  writes: number
} {
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string; version: number }>()
  let version = 0
  const store = {
    description: 'memory://test',
    writes: 0,
    keys: () => [...blobs.keys()].sort(),
    async get(key: string): Promise<StoredFile | undefined> {
      const blob = blobs.get(key)
      if (!blob) return undefined
      return {
        key,
        size: blob.bytes.byteLength,
        etag: String(blob.version),
        contentType: blob.contentType,
        bytes: async () => blob.bytes,
      }
    },
    async put(key: string, body: Uint8Array | File, putOptions?: { contentType?: string }) {
      const bytes =
        body instanceof File ? new Uint8Array(await body.arrayBuffer()) : new Uint8Array(body)
      blobs.set(key, {
        bytes,
        contentType: putOptions?.contentType ?? contentTypeFor(key),
        version: ++version,
      })
      store.writes += 1
    },
    async delete(key: string) {
      blobs.delete(key)
    },
    async list(prefix: string) {
      const trimmed = prefix.replace(/\/+$/, '')
      return [...blobs.keys()].filter((key) => key === trimmed || key.startsWith(`${trimmed}/`))
    },
    publicUrl: options.publicUrlPrefix
      ? (key: string) => `${options.publicUrlPrefix}/${key}`
      : undefined,
  }
  return store
}

const ARTICLE = `[document-type]
alias = "article"
name = "Article"
allow-at-root = true
templates = ["article"]
default-template = "article"
`

const VIEW = `export default function Article({ model }) {
  return <main>{model.name}</main>
}
`

/** A site whose media lives in the store given. */
async function site(store: MediaStore) {
  const root = tempDir('media-store-site-')
  for (const dir of ['schema/document-types', 'schema/media-types', 'Views'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'article.toml'), ARTICLE)
  writeFileSync(join(root, 'Views', 'article.tsx'), VIEW)
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      viewsDir: join(root, 'Views'),
      mediaDir: join(root, 'media'),
      mediaStore: store,
    },
  })
  open.push(h)

  const upload = async (name: string, bytes: Uint8Array) => {
    const id = crypto.randomUUID()
    const form = new FormData()
    form.set('Id', id)
    form.set('File', new File([bytes as Uint8Array<ArrayBuffer>], name))
    const response = await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
    if (response.status !== 201)
      throw new Error(`upload ${response.status}: ${await response.text()}`)
    return id
  }
  /** `name` is the media item's name; the file keeps its extension, as an upload does. */
  const image = async (name: string, bytes: Uint8Array) => {
    const response = await h.post(`${V1}/media`, {
      mediaType: { id: SYSTEM_MEDIA_TYPE_KEYS.Image },
      parent: null,
      values: [
        {
          alias: 'umbracoFile',
          culture: null,
          segment: null,
          value: {
            src: '',
            temporaryFileId: await upload(`${name.toLowerCase()}.png`, bytes),
            crops: [],
            focalPoint: null,
          },
        },
      ],
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`media ${response.status}: ${await response.text()}`)
    const key = response.headers.get('umb-generated-resource') as string
    const media = await h.json<{ values: Array<{ alias: string; value: { src: string } }> }>(
      `${V1}/media/${key}`,
    )
    return { key, src: media.values.find((v) => v.alias === 'umbracoFile')?.value.src as string }
  }
  return { h, upload, image }
}

/** A 4×4 PNG, big enough to crop. */
async function png(): Promise<Uint8Array<ArrayBuffer>> {
  const source = await Bun.file(join(import.meta.dir, 'fixtures', 'pixel.png')).bytes()
  return new Uint8Array(await new Bun.Image(source).resize(4, 4, { fit: 'fill' }).png().bytes())
}

describe('media keys', () => {
  test('accept a placed file, and refuse anything that could climb out', () => {
    expect(isSafeMediaKey('ab12cd34/photo.jpg')).toBe(true)
    expect(isSafeMediaKey('.temp/abc/photo.jpg')).toBe(true)
    expect(isSafeMediaKey('.cache/ab/hash.webp')).toBe(true)
    for (const bad of [
      '',
      '..',
      '../package.json',
      'a/../../b',
      'a//b',
      'a\\b',
      '.secret/x',
      'a/.hidden',
      'a/',
    ])
      expect([bad, isSafeMediaKey(bad)]).toEqual([bad, false])
  })

  test('are guessed a content type from the extension', () => {
    expect(contentTypeFor('a/b.png')).toBe('image/png')
    expect(contentTypeFor('a/b.PDF')).toBe('application/pdf')
    expect(contentTypeFor('a/b.unknown')).toBe('application/octet-stream')
  })
})

describe('a store the file system knows nothing about', () => {
  test('carries the whole media library: upload, place, serve, crop and delete', async () => {
    const store = memoryMediaStore()
    const { h, image } = await site(store)
    const original = await png()
    const placed = await image('Photo', original)

    // Placed where a file system store would have put it, but in the Map.
    expect(placed.src).toMatch(/^\/media\/[0-9a-f]{8}\/photo\.png$/)
    const key = placed.src.slice('/media/'.length)
    expect(store.keys()).toEqual([key])

    const served = await h.call(placed.src)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(original)

    // A crop is computed once and kept in the store, so the second request
    // costs no processing.
    const crop = await h.call(`${placed.src}?width=2&height=2&rmode=crop`)
    expect(crop.status).toBe(200)
    expect(store.keys().some((k) => k.startsWith('.cache/'))).toBe(true)
    const writesAfterFirst = store.writes
    const again = await h.call(`${placed.src}?width=2&height=2&rmode=crop`)
    expect(again.status).toBe(200)
    expect(store.writes).toBe(writesAfterFirst)

    // Deleting the media item deletes its bytes.
    expect((await h.del(`${V1}/media/${placed.key}`)).status).toBe(200)
    expect(store.keys().includes(key)).toBe(false)
    expect((await h.call(placed.src)).status).toBe(404)
  })

  test('a store that serves its own bytes gets the browser redirected to it', async () => {
    const store = memoryMediaStore({ publicUrlPrefix: 'https://cdn.example.test/media' })
    const { h, image } = await site(store)
    const placed = await image('Photo', await png())
    const key = placed.src.slice('/media/'.length)

    const served = await h.call(placed.src, { redirect: 'manual' })
    expect(served.status).toBe(302)
    expect(served.headers.get('location')).toBe(`https://cdn.example.test/media/${key}`)

    // A variant is in the store too, so it is served from there as well.
    const crop = await h.call(`${placed.src}?width=2&height=2&rmode=crop`, { redirect: 'manual' })
    expect(crop.status).toBe(302)
    expect(crop.headers.get('location')).toMatch(
      /^https:\/\/cdn\.example\.test\/media\/\.cache\/[0-9a-f]{2}\/[0-9a-f]+\.(png|jpg|webp)$/,
    )
  })

  test('a replaced original invalidates the crops of the one before it', async () => {
    const store = memoryMediaStore()
    const files = new MediaFileStore(store)
    const images = new ImageProcessor(store)
    await store.put('ab12cd34/photo.png', await png(), { contentType: 'image/png' })

    const first = (await files.open('/media/ab12cd34/photo.png')) as StoredFile
    const before = await images.variant(first, { width: 2, height: 2, mode: 'crop' })

    // Same key, different bytes: the etag moves, so the variant key moves with it.
    await store.put(
      'ab12cd34/photo.png',
      new Uint8Array(await new Bun.Image(await png()).resize(8, 8, { fit: 'fill' }).png().bytes()),
      { contentType: 'image/png' },
    )
    const second = (await files.open('/media/ab12cd34/photo.png')) as StoredFile
    const after = await images.variant(second, { width: 2, height: 2, mode: 'crop' })
    expect(after.key).not.toBe(before.key)
  })

  test('temporary uploads live in the store, so any node can place one', async () => {
    const store = memoryMediaStore()
    // Two stores over one backing store are two nodes behind a load balancer.
    const received = new MediaFileStore(store, { lifetimeMs: 60_000 })
    const placing = new MediaFileStore(store, { lifetimeMs: 60_000 })

    const id = crypto.randomUUID()
    await received.saveTemporary(id, new File(['hello'], 'notes.txt'))
    expect(await placing.temporary(id)).toMatchObject({ fileName: 'notes.txt', size: 5 })
    const placed = await placing.place(id)
    expect(placed?.src).toMatch(/^\/media\/[0-9a-f]{8}\/notes\.txt$/)
    expect(await received.temporary(id)).toBeUndefined()
    // Nothing of the upload is left behind.
    expect(store.keys().some((k) => k.startsWith('.temp/'))).toBe(false)
  })
})

describe('the file system store', () => {
  test('keeps bytes under its root, and refuses a key that leaves it', async () => {
    const root = tempDir('media-fs-')
    const store = fileSystemMediaStore(root)
    expect(store.description).toBe(root)

    await store.put('ab12cd34/photo.txt', new TextEncoder().encode('hello'))
    const stored = await store.get('ab12cd34/photo.txt')
    expect(stored?.size).toBe(5)
    expect(stored?.localPath).toBe(join(root, 'ab12cd34', 'photo.txt'))
    expect(new TextDecoder().decode(await (stored as StoredFile).bytes())).toBe('hello')

    expect(await store.get('../package.json')).toBeUndefined()
    await expect(store.put('../escaped.txt', new Uint8Array())).rejects.toThrow('media key')

    expect(await store.list('ab12cd34')).toEqual(['ab12cd34/photo.txt'])
    expect(await store.list('')).toEqual(['ab12cd34/photo.txt'])

    // Deleting the last file in a folder takes the folder with it.
    await store.delete('ab12cd34/photo.txt')
    expect(await store.get('ab12cd34/photo.txt')).toBeUndefined()
    expect(existsSync(join(root, 'ab12cd34'))).toBe(false)
    // Deleting what is not there is not an error.
    await store.delete('ab12cd34/photo.txt')
  })

  test('serves its own bytes only when told a URL prefix', async () => {
    const root = tempDir('media-fs-')
    expect(fileSystemMediaStore(root).publicUrl).toBeUndefined()
    const cdn = fileSystemMediaStore(root, { publicUrlPrefix: 'https://cdn.example.test/' })
    expect(cdn.publicUrl?.('ab/c.png')).toBe('https://cdn.example.test/ab/c.png')
  })

  test('a prefix that is a path on this host redirects there, not to an absolute URL', async () => {
    const store = memoryMediaStore({ publicUrlPrefix: '/static/media' })
    const { h, image } = await site(store)
    const placed = await image('Photo', await png())
    const key = placed.src.slice('/media/'.length)

    const served = await h.call(placed.src, { redirect: 'manual' })
    expect(served.status).toBe(302)
    expect(served.headers.get('location')).toBe(`/static/media/${key}`)
  })
})

describe('choosing a store from the environment', () => {
  test('defaults to the file system, and a mistyped kind degrades to it', async () => {
    const root = tempDir('media-env-')
    expect((await mediaStoreFromEnvironment(root, {})).description).toBe(root)
    expect(
      (await mediaStoreFromEnvironment(root, { BUNBRACO_MEDIA_STORE: 'nonsense' })).description,
    ).toBe(root)
  })

  test('builds an S3 store from the variables, prefix and all', async () => {
    const store = await mediaStoreFromEnvironment(tempDir('media-env-'), {
      BUNBRACO_MEDIA_STORE: 's3',
      BUNBRACO_MEDIA_S3_BUCKET: 'site-media',
      BUNBRACO_MEDIA_S3_REGION: 'ap-southeast-2',
      BUNBRACO_MEDIA_S3_ACCESS_KEY_ID: 'key',
      BUNBRACO_MEDIA_S3_SECRET_ACCESS_KEY: 'secret',
      BUNBRACO_MEDIA_S3_PREFIX: 'uploads',
      BUNBRACO_MEDIA_S3_PUBLIC_URL: 'https://cdn.example.test',
    })
    expect(store.description).toBe('s3://site-media/uploads')
    // The prefix is inside the bucket, so it is not part of the key a caller uses.
    expect(store.publicUrl?.('ab12cd34/photo.png')).toBe(
      'https://cdn.example.test/ab12cd34/photo.png',
    )
    expect(store.publicUrl?.('../escaped')).toBeUndefined()
  })

  test('builds an Azure store, and refuses one with no way to authenticate', async () => {
    const store = await mediaStoreFromEnvironment(tempDir('media-env-'), {
      BUNBRACO_MEDIA_STORE: 'azure',
      BUNBRACO_MEDIA_AZURE_ACCOUNT: 'mysite',
      BUNBRACO_MEDIA_AZURE_CONTAINER: 'media',
      BUNBRACO_MEDIA_AZURE_KEY: btoa('a-secret-key'),
      BUNBRACO_MEDIA_AZURE_PUBLIC_URL: 'https://mysite.blob.core.windows.net/media',
    })
    expect(store.description).toBe('azure://mysite/media')
    expect(store.publicUrl?.('ab12cd34/photo.png')).toBe(
      'https://mysite.blob.core.windows.net/media/ab12cd34/photo.png',
    )

    await expect(
      mediaStoreFromEnvironment(tempDir('media-env-'), {
        BUNBRACO_MEDIA_STORE: 'azure',
        BUNBRACO_MEDIA_AZURE_ACCOUNT: 'mysite',
      }),
    ).rejects.toThrow('account key or a SAS token')
  })
})
