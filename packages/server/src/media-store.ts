/**
 * Where uploaded files live.
 *
 * Umbraco abstracts this as `IFileSystem` with a `MediaFileManager` on top, so a
 * site can move media to blob storage without touching anything that uses it.
 * This is the same seam, narrowed to what a media library actually needs: get,
 * put, delete, and list a prefix. Nothing above this interface knows whether the
 * bytes are on a disk, in a bucket or in a container.
 *
 * The key space is the layout the file system store has always used, so an
 * existing media folder keeps working unchanged:
 *
 *   `ab12cd34/photo.jpg`        a placed file, served at `/media/ab12cd34/photo.jpg`
 *   `.temp/<uuid>/photo.jpg`    an upload not yet placed, with `meta.json` beside it
 *   `.cache/ab/<hash>.webp`     a processed image variant
 *
 * A site picks a store in `bunbraco.config.ts` — `fileSystemMediaStore`,
 * `s3MediaStore` or `azureMediaStore` — or leaves it to the environment, which
 * is what a container deployment wants.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export interface StoredFile {
  key: string
  size: number
  /**
   * Changes whenever the contents change. Variant cache keys are built from it,
   * so a replaced original invalidates its crops without anyone tracking that.
   */
  etag: string
  contentType: string
  bytes(): Promise<Uint8Array>
  /** A path on this machine, when the store has one; lets the server stream it. */
  localPath?: string
}

export interface MediaStore {
  /** Named in the boot banner and in logs: `media/`, `s3://bucket`, … */
  readonly description: string
  get(key: string): Promise<StoredFile | undefined>
  put(key: string, body: Uint8Array | File, options?: { contentType?: string }): Promise<void>
  delete(key: string): Promise<void>
  /** Every key under a prefix, which is how temporary uploads are swept. */
  list(prefix: string): Promise<string[]>
  /**
   * A URL the browser should fetch instead of coming through this server — a CDN
   * origin, or a presigned link. Undefined means this server serves the bytes,
   * which is what the file system store always does.
   */
  publicUrl?(key: string): string | undefined
}

/** Content types by extension, for stores that do not infer one. */
const CONTENT_TYPES: Record<string, string> = {
  avif: 'image/avif',
  css: 'text/css',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
  woff2: 'font/woff2',
  zip: 'application/zip',
}

export function contentTypeFor(key: string): string {
  const extension = key.split('.').pop()?.toLowerCase() ?? ''
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * A key is `<segment>/<segment>`: no `..`, no leading dot except the two the
 * layout above reserves, and no backslashes. Checked in one place so every store
 * is safe, not only the one that touches a file system.
 */
export function isSafeMediaKey(key: string): boolean {
  if (key === '' || key.includes('\\') || key.includes('//')) return false
  const parts = key.split('/')
  return parts.every(
    (part, index) =>
      part !== '' &&
      part !== '.' &&
      part !== '..' &&
      (!part.startsWith('.') || (index === 0 && (part === '.temp' || part === '.cache'))),
  )
}

// ------------------------------------------------------------- file system

export interface FileSystemMediaStoreOptions {
  /**
   * A URL prefix that serves the media root directly — a CDN in front of the
   * same disk, or nginx. Without one the server streams every file itself.
   */
  publicUrlPrefix?: string
}

/**
 * The default: files under a directory, which is where Umbraco puts them too.
 * Deleting the last file in a folder deletes the folder, so a media root does not
 * silt up with empty directories.
 */
export function fileSystemMediaStore(
  root: string,
  options: FileSystemMediaStoreOptions = {},
): MediaStore {
  const base = resolve(root)
  const prefix = options.publicUrlPrefix?.replace(/\/$/, '')

  const pathOf = (key: string): string | undefined => {
    if (!isSafeMediaKey(key)) return undefined
    const path = resolve(base, key)
    return path === base || path.startsWith(base + sep) ? path : undefined
  }

  return {
    description: base,

    async get(key) {
      const path = pathOf(key)
      if (!path || !existsSync(path)) return undefined
      const stat = statSync(path)
      if (!stat.isFile()) return undefined
      const file = Bun.file(path)
      return {
        key,
        size: stat.size,
        // Size and mtime are what a web server would use, and they are cheap.
        etag: `${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}`,
        contentType: file.type || contentTypeFor(key),
        bytes: () => file.bytes(),
        localPath: path,
      }
    },

    async put(key, body) {
      const path = pathOf(key)
      if (!path) throw new Error(`"${key}" is not a usable media key.`)
      mkdirSync(dirname(path), { recursive: true })
      await Bun.write(path, body)
    },

    async delete(key) {
      const path = pathOf(key)
      if (!path || !existsSync(path)) return
      rmSync(path, { recursive: true, force: true })
      const folder = dirname(path)
      if (folder !== base && existsSync(folder) && readdirSync(folder).length === 0)
        rmSync(folder, { recursive: true, force: true })
    },

    async list(keyPrefix) {
      // A prefix names a folder as often as a key, so `.temp/<id>/` and
      // `.temp/<id>` mean the same thing here.
      const trimmed = keyPrefix.replace(/\/+$/, '')
      const start = trimmed === '' ? base : pathOf(trimmed)
      if (!start || !existsSync(start)) return []
      const found: string[] = []
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) walk(path)
          else
            found.push(
              path
                .slice(base.length + 1)
                .split(sep)
                .join('/'),
            )
        }
      }
      if (statSync(start).isDirectory()) walk(start)
      else found.push(trimmed)
      return found
    },

    publicUrl: prefix ? (key) => `${prefix}/${key}` : undefined,
  }
}

// -------------------------------------------------------------- from the environment

export type MediaStoreKind = 'filesystem' | 's3' | 'azure'

/**
 * The store the environment asks for. `BUNBRACO_MEDIA_STORE` picks the kind;
 * each kind reads its own variables, and an unset one falls back to the
 * credentials its SDK would find anyway (an instance role, for S3).
 *
 *   BUNBRACO_MEDIA_STORE=s3
 *   BUNBRACO_MEDIA_S3_BUCKET=my-site-media
 *   BUNBRACO_MEDIA_S3_REGION=ap-southeast-2
 *
 *   BUNBRACO_MEDIA_STORE=azure
 *   BUNBRACO_MEDIA_AZURE_ACCOUNT=mysite
 *   BUNBRACO_MEDIA_AZURE_CONTAINER=media
 *   BUNBRACO_MEDIA_AZURE_KEY=…              (or …_SAS=?sv=…)
 *
 * Anything unrecognised is the file system, so a mistyped value degrades to the
 * default rather than losing the media library.
 */
export async function mediaStoreFromEnvironment(
  mediaDir: string,
  env: Record<string, string | undefined> = Bun.env,
): Promise<MediaStore> {
  const kind = (env.BUNBRACO_MEDIA_STORE ?? 'filesystem').toLowerCase()
  if (kind === 's3') {
    const { s3MediaStore } = await import('./media-store-s3.ts')
    return s3MediaStore({
      bucket: env.BUNBRACO_MEDIA_S3_BUCKET ?? '',
      region: env.BUNBRACO_MEDIA_S3_REGION,
      endpoint: env.BUNBRACO_MEDIA_S3_ENDPOINT,
      accessKeyId: env.BUNBRACO_MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BUNBRACO_MEDIA_S3_SECRET_ACCESS_KEY,
      sessionToken: env.BUNBRACO_MEDIA_S3_SESSION_TOKEN,
      prefix: env.BUNBRACO_MEDIA_S3_PREFIX,
      publicUrlPrefix: env.BUNBRACO_MEDIA_S3_PUBLIC_URL,
      presignSeconds: env.BUNBRACO_MEDIA_S3_PRESIGN_SECONDS
        ? Number(env.BUNBRACO_MEDIA_S3_PRESIGN_SECONDS)
        : undefined,
    })
  }
  if (kind === 'azure') {
    const { azureMediaStore } = await import('./media-store-azure.ts')
    return azureMediaStore({
      account: env.BUNBRACO_MEDIA_AZURE_ACCOUNT ?? '',
      container: env.BUNBRACO_MEDIA_AZURE_CONTAINER ?? 'media',
      accountKey: env.BUNBRACO_MEDIA_AZURE_KEY,
      sasToken: env.BUNBRACO_MEDIA_AZURE_SAS,
      endpoint: env.BUNBRACO_MEDIA_AZURE_ENDPOINT,
      prefix: env.BUNBRACO_MEDIA_AZURE_PREFIX,
      publicUrlPrefix: env.BUNBRACO_MEDIA_AZURE_PUBLIC_URL,
    })
  }
  return fileSystemMediaStore(mediaDir, {
    publicUrlPrefix: env.BUNBRACO_MEDIA_PUBLIC_URL,
  })
}
