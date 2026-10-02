/**
 * Media in an S3 bucket, through Bun's own S3 client — so this needs no
 * dependency, and works against anything that speaks S3: AWS, Cloudflare R2,
 * DigitalOcean Spaces, MinIO, Backblaze B2.
 *
 * Credentials come from the options, else from the environment Bun's client
 * already reads (`AWS_ACCESS_KEY_ID` and friends), so a machine with an instance
 * role needs none configured.
 *
 * Serving: by default the server streams the bytes, which keeps the bucket
 * private. `publicUrlPrefix` sends browsers to a CDN instead, and
 * `presignSeconds` sends them to a signed bucket URL — pick one, not both.
 */
import { contentTypeFor, isSafeMediaKey, type MediaStore, type StoredFile } from './media-store.ts'

export interface S3MediaStoreOptions {
  bucket: string
  region?: string
  /** For S3-compatible services: `https://<account>.r2.cloudflarestorage.com`. */
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  /** A folder inside the bucket, when media shares it with something else. */
  prefix?: string
  /** A CDN in front of the bucket; browsers are redirected there. */
  publicUrlPrefix?: string
  /** Redirect browsers to a presigned URL valid for this long. */
  presignSeconds?: number
  /** The ACL to write objects with; omit for a private bucket. */
  acl?: 'private' | 'public-read'
}

export function s3MediaStore(options: S3MediaStoreOptions): MediaStore {
  if (!options.bucket) throw new Error('An S3 media store needs a bucket.')
  const client = new Bun.S3Client({
    bucket: options.bucket,
    region: options.region,
    endpoint: options.endpoint,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
  })
  const prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : ''
  const publicPrefix = options.publicUrlPrefix?.replace(/\/$/, '')
  const objectKey = (key: string) => `${prefix}${key}`

  return {
    description: `s3://${options.bucket}${prefix ? `/${prefix.slice(0, -1)}` : ''}`,

    async get(key): Promise<StoredFile | undefined> {
      if (!isSafeMediaKey(key)) return undefined
      const file = client.file(objectKey(key))
      try {
        const stat = await file.stat()
        return {
          key,
          size: stat.size,
          // S3's ETag is the content hash for a single-part upload, and a
          // composite for a multipart one; either way it changes with the bytes.
          etag: stat.etag.replaceAll('"', ''),
          contentType: stat.type || contentTypeFor(key),
          bytes: async () => new Uint8Array(await file.arrayBuffer()),
        }
      } catch {
        // A missing object is a thrown NoSuchKey, not a null stat.
        return undefined
      }
    },

    async put(key, body, putOptions) {
      if (!isSafeMediaKey(key)) throw new Error(`"${key}" is not a usable media key.`)
      await client.write(objectKey(key), body, {
        type: putOptions?.contentType ?? contentTypeFor(key),
        acl: options.acl,
      })
    },

    async delete(key) {
      if (!isSafeMediaKey(key)) return
      // A delete of something absent succeeds in S3, which is what we want.
      await client.delete(objectKey(key))
    },

    async list(keyPrefix) {
      const found: string[] = []
      let continuationToken: string | undefined
      do {
        const page = await client.list({
          prefix: `${prefix}${keyPrefix}`,
          continuationToken,
          maxKeys: 1000,
        })
        for (const object of page.contents ?? [])
          if (object.key.startsWith(prefix)) found.push(object.key.slice(prefix.length))
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
      } while (continuationToken)
      return found
    },

    publicUrl:
      publicPrefix || options.presignSeconds
        ? (key) => {
            if (!isSafeMediaKey(key)) return undefined
            if (publicPrefix) return `${publicPrefix}/${key}`
            return client.presign(objectKey(key), {
              method: 'GET',
              expiresIn: options.presignSeconds,
            })
          }
        : undefined,
  }
}
