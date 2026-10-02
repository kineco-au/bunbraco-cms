/**
 * Uploaded files, as Umbraco keeps them: a temporary upload first
 * (`TemporaryFile`, kept for a day), then, when a value that names it is saved, a
 * placed file served at `/media/<folder>/<name>`.
 *
 * Where the bytes actually live is the `MediaStore`'s business (see
 * media-store.ts) — a disk, an S3 bucket, an Azure container. This is the layer
 * that knows the *naming*: which key a `/media/…` URL means, and that a temporary
 * upload is `.temp/<id>/…` with its metadata beside it.
 *
 * Temporary uploads go to the store rather than to local disk, so a load-balanced
 * set can place an upload that a different node received.
 */
import { basename, extname } from 'node:path'
import {
  contentTypeFor,
  fileSystemMediaStore,
  type MediaStore,
  type StoredFile,
} from './media-store.ts'

export interface TemporaryFile {
  id: string
  fileName: string
  availableUntil: Date
  size: number
}

export interface PlacedFile {
  /** The URL path, e.g. `/media/ab12cd34/photo.jpg`. */
  src: string
  bytes: number
  /** Lowercase, without the dot. */
  extension: string
  width?: number
  height?: number
}

const TEMP = '.temp'
const DAY = 24 * 60 * 60 * 1000

/** `My Photo (1).JPG` → `my-photo-1.jpg`: safe on every file system and in a URL. */
export function safeFileName(name: string): string {
  const base = basename(name.replaceAll('\\', '/'))
  const extension = extname(base).toLowerCase()
  const stem = base
    .slice(0, base.length - extname(base).length)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${stem || 'file'}${extension.replace(/[^a-z0-9.]/g, '')}`
}

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

export interface MediaFileStoreOptions {
  lifetimeMs?: number
}

export class MediaFileStore {
  readonly store: MediaStore
  #lifetimeMs: number

  /** Takes a store, or a directory for the file system store a plain path implies. */
  constructor(store: MediaStore | string, options: MediaFileStoreOptions = {}) {
    this.store = typeof store === 'string' ? fileSystemMediaStore(store) : store
    this.#lifetimeMs = options.lifetimeMs ?? DAY
  }

  #tempKey(id: string, name: string) {
    return `${TEMP}/${id.toLowerCase()}/${name}`
  }

  async saveTemporary(id: string, file: File, now = new Date()): Promise<TemporaryFile> {
    if (!isUuid(id)) throw new Error('A temporary file id must be a uuid.')
    // A second upload under the same id replaces the first, including its name.
    await this.deleteTemporary(id)
    const fileName = safeFileName(file.name)
    // From the name, never from `file.type`: that is the multipart part's own
    // `Content-Type` header, so the uploader picks it. A bucket-backed store keeps
    // what it is given and hands it back on read, which would let `photo.jpg` be
    // served as `text/html` from this origin — past the extension checks, because
    // the name really is a .jpg. The file system store re-derives on read and was
    // never exposed; deriving here makes all three agree.
    await this.store.put(this.#tempKey(id, fileName), file, {
      contentType: contentTypeFor(fileName),
    })
    const record = {
      id: id.toLowerCase(),
      fileName,
      availableUntil: new Date(now.getTime() + this.#lifetimeMs),
      size: file.size,
    }
    await this.store.put(
      this.#tempKey(id, 'meta.json'),
      new TextEncoder().encode(JSON.stringify(record)),
      { contentType: 'application/json' },
    )
    return record
  }

  async temporary(id: string, now = new Date()): Promise<TemporaryFile | undefined> {
    if (!isUuid(id)) return undefined
    const meta = await this.store.get(this.#tempKey(id, 'meta.json'))
    if (!meta) return undefined
    let raw: TemporaryFile & { availableUntil: string }
    try {
      raw = JSON.parse(new TextDecoder().decode(await meta.bytes()))
    } catch {
      return undefined
    }
    const record = { ...raw, availableUntil: new Date(raw.availableUntil) }
    if (record.availableUntil.getTime() < now.getTime()) {
      await this.deleteTemporary(id)
      return undefined
    }
    return record
  }

  /** A temporary upload's name and contents, for uploads that are read rather than placed. */
  async readTemporary(id: string): Promise<{ fileName: string; bytes: Uint8Array } | undefined> {
    const record = await this.temporary(id)
    if (!record) return undefined
    const stored = await this.store.get(this.#tempKey(id, record.fileName))
    if (!stored) return undefined
    return { fileName: record.fileName, bytes: await stored.bytes() }
  }

  async deleteTemporary(id: string): Promise<boolean> {
    if (!isUuid(id)) return false
    const keys = await this.store.list(`${TEMP}/${id.toLowerCase()}/`)
    if (keys.length === 0) return false
    for (const key of keys) await this.store.delete(key)
    return true
  }

  /** Moves a temporary upload into the media root; undefined when it is gone or expired. */
  async place(id: string): Promise<PlacedFile | undefined> {
    const temporary = await this.temporary(id)
    if (!temporary) return undefined
    const source = await this.store.get(this.#tempKey(id, temporary.fileName))
    if (!source) return undefined
    const bytes = await source.bytes()
    let folder: string
    do folder = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
    while ((await this.store.list(`${folder}/`)).length > 0)
    const key = `${folder}/${temporary.fileName}`
    await this.store.put(key, bytes, { contentType: source.contentType })
    await this.deleteTemporary(id)
    const placed: PlacedFile = {
      src: `/media/${key}`,
      bytes: bytes.byteLength,
      extension: extname(temporary.fileName).slice(1).toLowerCase(),
    }
    try {
      const metadata = await new Bun.Image(bytes).metadata()
      placed.width = metadata.width
      placed.height = metadata.height
    } catch {
      // Not an image Bun can decode (a PDF, an SVG): no dimensions.
    }
    return placed
  }

  /** The store key a `/media/…` URL path names; undefined when it names nothing. */
  key(urlPath: string): string | undefined {
    if (!urlPath.startsWith('/media/')) return undefined
    let key: string
    try {
      key = decodeURIComponent(urlPath.slice('/media/'.length))
    } catch {
      return undefined
    }
    // A placed file is always `<folder>/<name>`; the reserved folders are not
    // reachable through a URL, whatever the store would allow.
    const parts = key.split('/')
    if (parts.length < 2 || parts.some((part) => part === '' || part.startsWith('.')))
      return undefined
    return key
  }

  /** The file a `/media/…` URL path names, or undefined. */
  async open(urlPath: string): Promise<StoredFile | undefined> {
    const key = this.key(urlPath)
    return key ? this.store.get(key) : undefined
  }

  /** Where the browser should go for a `/media/…` path, when the store serves it itself. */
  publicUrl(urlPath: string): string | undefined {
    const key = this.key(urlPath)
    return key ? this.store.publicUrl?.(key) : undefined
  }

  /** Deletes a placed file. */
  async remove(src: string): Promise<void> {
    const key = this.key(src)
    if (key) await this.store.delete(key)
  }

  /** Drops temporary uploads past their lifetime; returns how many went. */
  async cleanupExpired(now = new Date()): Promise<number> {
    const ids = new Set<string>()
    for (const key of await this.store.list(`${TEMP}/`)) {
      const id = key.split('/')[1]
      if (id) ids.add(id)
    }
    let removed = 0
    for (const id of ids) {
      if (await this.temporary(id, now)) continue
      // Reading an expired upload already drops it; this clears whatever is left,
      // such as a folder whose metadata went missing.
      await this.deleteTemporary(id)
      removed += 1
    }
    return removed
  }
}

/**
 * The media store a command should use: whatever the site configured, else the
 * environment's, else the directory on this disk. The same resolution the
 * server does at boot, for a process that is not the server.
 */
export async function mediaStoreFor(config: {
  mediaStore?: MediaStore | undefined
  mediaDir: string
}): Promise<MediaStore> {
  if (config.mediaStore) return config.mediaStore
  const { mediaStoreFromEnvironment } = await import('./media-store.ts')
  return mediaStoreFromEnvironment(config.mediaDir)
}

/**
 * Reads the media files a bundle wants to carry.
 *
 * A key the store has not got is reported rather than guessed at: the writer
 * then marks that blob as not carried, so the manifest says what is true and
 * the destination reports it missing instead of silently serving nothing.
 */
export async function readBlobs(
  store: MediaStore,
  keys: readonly string[],
): Promise<{ bytes: Map<string, Uint8Array>; missing: string[] }> {
  const bytes = new Map<string, Uint8Array>()
  const missing: string[] = []
  for (const key of keys) {
    const file = await store.get(key)
    if (!file) {
      missing.push(key)
      continue
    }
    bytes.set(key, await file.bytes())
  }
  return { bytes, missing }
}

/** Puts a bundle's media files into this environment's store, under their own keys. */
export async function placeBlobs(
  store: MediaStore,
  blobs: ReadonlyMap<string, string>,
): Promise<{ placed: number; bytes: number }> {
  let placed = 0
  let bytes = 0
  for (const [key, path] of blobs) {
    const file = Bun.file(path)
    const content = new Uint8Array(await file.arrayBuffer())
    await store.put(key, content, { contentType: contentTypeFor(key) })
    placed += 1
    bytes += content.length
  }
  return { placed, bytes }
}
