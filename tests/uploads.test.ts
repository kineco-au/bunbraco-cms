/**
 * WP-6.3: uploads. A file goes up as a temporary file, and a saved value that
 * names it places it under the media root and stores its path, served at
 * `/media/…`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, TemplateRepository } from '@bunbraco/data'
import { MediaFileStore, safeFileName } from '@bunbraco/server'
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

/** A 2×3 PNG, so dimensions can be read back. */
async function png(): Promise<Uint8Array<ArrayBuffer>> {
  const source = await Bun.file(join(import.meta.dir, 'fixtures', 'pixel.png')).bytes()
  return new Uint8Array(await new Bun.Image(source).resize(2, 3, { fit: 'fill' }).png().bytes())
}

describe('the media file store', () => {
  test('names files safely', () => {
    expect(safeFileName('My Photo (1).JPG')).toBe('my-photo-1.jpg')
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('Crème brûlée.pdf')).toBe('creme-brulee.pdf')
    expect(safeFileName('.env')).toBe('env')
  })

  test('types a file by its name, not by what the uploader claimed', async () => {
    const store = new MediaFileStore(tempDir('media-type-'))
    const id = crypto.randomUUID()
    // The multipart part's own Content-Type header, which the uploader sets. A
    // bucket-backed store keeps what it is given and serves it back, so trusting
    // this would let a .jpg be served as HTML from the site's own origin.
    await store.saveTemporary(
      id,
      new File(['<script>alert(1)</script>'], 'photo.jpg', {
        type: 'text/html',
      }),
    )
    const stored = await store.store.get(`.temp/${id}/photo.jpg`)
    expect(stored?.contentType).toBe('image/jpeg')
  })

  test('keeps a temporary file for its lifetime, then places it under the media root', async () => {
    const root = tempDir('media-store-')
    const store = new MediaFileStore(root, { lifetimeMs: 60_000 })
    const id = crypto.randomUUID()
    const saved = await store.saveTemporary(id, new File(['hello'], 'Read Me.txt'))
    expect(saved).toMatchObject({ id, fileName: 'read-me.txt', size: 5 })
    expect(await store.temporary(id)).toMatchObject({ fileName: 'read-me.txt' })
    // Past its lifetime it is gone
    expect(await store.temporary(id, new Date(Date.now() + 120_000))).toBeUndefined()

    const again = crypto.randomUUID()
    await store.saveTemporary(again, new File(['hello'], 'notes.txt'))
    const placed = await store.place(again)
    expect(placed?.src).toMatch(/^\/media\/[0-9a-f]{8}\/notes\.txt$/)
    expect(placed).toMatchObject({ bytes: 5, extension: 'txt' })
    expect(placed?.width).toBeUndefined()
    expect(await store.temporary(again)).toBeUndefined()
    const opened = await store.open(placed?.src as string)
    expect(
      new TextDecoder().decode(await (opened as { bytes(): Promise<Uint8Array> }).bytes()),
    ).toBe('hello')
    const file = opened?.localPath as string

    // Nothing outside the root, nothing hidden
    expect(store.key('/media/../package.json')).toBeUndefined()
    expect(store.key('/media/%2e%2e/package.json')).toBeUndefined()
    expect(store.key('/media/.temp/x')).toBeUndefined()
    expect(await store.open('/media/../package.json')).toBeUndefined()

    await store.remove(placed?.src as string)
    expect(existsSync(file)).toBe(false)
    expect(await store.open(placed?.src as string)).toBeUndefined()
  })

  test('reads image dimensions, and sweeps expired uploads', async () => {
    const root = tempDir('media-store-')
    const store = new MediaFileStore(root, { lifetimeMs: 1000 })
    const id = crypto.randomUUID()
    await store.saveTemporary(id, new File([await png()], 'dot.png'))
    expect(await store.place(id)).toMatchObject({ width: 2, height: 3, extension: 'png' })

    const stale = crypto.randomUUID()
    await store.saveTemporary(stale, new File(['x'], 'x.txt'))
    expect(await store.cleanupExpired(new Date())).toBe(0)
    expect(await store.cleanupExpired(new Date(Date.now() + 5000))).toBe(1)
  })
})

const TYPE_TOML = `[document-type]
alias = "download"
name = "Download"
allow-at-root = true
templates = ["download"]
default-template = "download"

[[property]]
alias = "attachment"
name = "Attachment"
type = "upload"

[[property]]
alias = "picture"
name = "Picture"
type = "imageCropper"
`

const VIEW = `export default function Download({ model }) {
  return <a href={model.text('attachment')}>{model.name}</a>
}
`

async function site() {
  const root = tempDir('uploads-site-')
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'download.toml'), TYPE_TOML)
  writeFileSync(join(root, 'Views', 'download.tsx'), VIEW)
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      viewsDir: join(root, 'Views'),
      mediaDir: join(root, 'media'),
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('download'))?.key as string
  const templateKey = (await new TemplateRepository(h.server.db).byAlias('download'))?.key as string
  return { h, typeKey, templateKey }
}

const upload = (h: Harness, id: string, file: File) => {
  const form = new FormData()
  form.set('Id', id)
  form.set('File', file)
  return h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
}

describe('temporary files and upload values', () => {
  test('a temporary file can be uploaded, read and deleted; executables are refused', async () => {
    const { h } = await site()
    const id = crypto.randomUUID()
    const response = await upload(h, id, new File(['%PDF'], 'Brochure 2026.pdf'))
    expect(response.status).toBe(201)
    expect(response.headers.get('umb-generated-resource')).toBe(id)
    const read = await h.json<{ id: string; fileName: string; availableUntil: string }>(
      `${V1}/temporary-file/${id}`,
    )
    expect(read).toMatchObject({ id, fileName: 'brochure-2026.pdf' })
    expect(new Date(read.availableUntil).getTime()).toBeGreaterThan(Date.now())
    expect((await h.del(`${V1}/temporary-file/${id}`)).status).toBe(200)
    expect((await h.call(`${V1}/temporary-file/${id}`)).status).toBe(404)

    expect((await upload(h, crypto.randomUUID(), new File(['x'], 'evil.aspx'))).status).toBe(400)
    expect((await upload(h, 'not-a-uuid', new File(['x'], 'a.txt'))).status).toBe(400)
  })

  test('saving a value that names an upload places the file, stores its path and serves it', async () => {
    const { h, typeKey, templateKey } = await site()
    const fileId = crypto.randomUUID()
    const imageId = crypto.randomUUID()
    await upload(h, fileId, new File(['%PDF-1.7'], 'Brochure.pdf'))
    await upload(h, imageId, new File([await png()], 'Hero.png'))

    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: templateKey },
      parent: null,
      values: [
        { alias: 'attachment', culture: null, segment: null, value: { temporaryFileId: fileId } },
        {
          alias: 'picture',
          culture: null,
          segment: null,
          value: {
            src: '',
            temporaryFileId: imageId,
            crops: [],
            focalPoint: { left: 0.5, top: 0.4 },
          },
        },
      ],
      variants: [{ culture: null, segment: null, name: 'Brochure' }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string

    type Doc = { values: Array<{ alias: string; value: Record<string, unknown> }> }
    const read = async () =>
      Object.fromEntries(
        (await h.json<Doc>(`${V1}/document/${key}`)).values.map((v) => [v.alias, v.value]),
      )
    const values = await read()
    expect(values.attachment).toEqual({
      src: expect.stringMatching(/^\/media\/[0-9a-f]{8}\/brochure\.pdf$/),
    })
    expect(values.picture).toEqual({
      src: expect.stringMatching(/^\/media\/[0-9a-f]{8}\/hero\.png$/),
      crops: [],
      focalPoint: { left: 0.5, top: 0.4 },
    })
    const served = await h.call(values.attachment?.src as string)
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('%PDF-1.7')
    // The temporary file is used up
    expect((await h.call(`${V1}/temporary-file/${fileId}`)).status).toBe(404)

    // Saving again without a new upload keeps the path
    await h.put(`${V1}/document/${key}`, {
      template: { id: templateKey },
      values: [
        { alias: 'attachment', culture: null, segment: null, value: values.attachment },
        { alias: 'picture', culture: null, segment: null, value: values.picture },
      ],
      variants: [{ culture: null, segment: null, name: 'Brochure' }],
    })
    expect(await read()).toEqual(values)

    // A template receives the upload as its URL
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    expect(await (await h.call('/')).text()).toContain(`href="${values.attachment?.src}"`)

    // An upload that has gone is refused, not silently dropped
    const missing = await h.put(`${V1}/document/${key}`, {
      template: { id: templateKey },
      values: [
        {
          alias: 'attachment',
          culture: null,
          segment: null,
          value: { temporaryFileId: crypto.randomUUID() },
        },
      ],
      variants: [{ culture: null, segment: null, name: 'Brochure' }],
    })
    expect(missing.status).toBe(400)
    expect((await h.call('/media/../package.json')).status).toBe(404)
  })
})
