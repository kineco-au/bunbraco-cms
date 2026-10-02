/**
 * Schema files in shared storage, so a deployed site can own its own schema.
 *
 * Without this, `schema/` is a directory in the image: a node cannot change it
 * durably — the container's disk is thrown away on redeploy — so
 * `schemaWritable` is off in production and metadata is a developer's job. With a
 * store configured, the schema lives in S3 or Azure instead, every node reads the
 * same copy, and an editor can change a document type on a deployed site and have
 * it survive and reach the other nodes.
 *
 * **The store is materialised into a local directory at boot**, and everything
 * downstream — loading, validation, hashing, sync, the writer — carries on
 * against files exactly as before. `loadSchemaDirectory` is synchronous and used
 * by the boot path, the sync, the validator and the CLI; making it async to reach
 * a network would have rippled through all of it for no gain. The local copy is a
 * cache, the store is the truth, and "the files are the schema" stays literally
 * true.
 *
 * A store is any `MediaStore`: the same four verbs over the same key space, so
 * the S3 and Azure implementations serve this with nothing duplicated.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { MediaStore } from './media-store.ts'
import { type AzureMediaStoreOptions, azureMediaStore } from './media-store-azure.ts'
import { type S3MediaStoreOptions, s3MediaStore } from './media-store-s3.ts'

export interface SchemaStore {
  /** Named in the boot banner and in logs, e.g. `s3://bucket/schema`. */
  readonly description: string
  /** Every schema file, as a path relative to the schema root. */
  list(): Promise<string[]>
  read(key: string): Promise<string | undefined>
  write(key: string, contents: string): Promise<void>
  remove(key: string): Promise<void>
}

/** Schema is TOML and nothing else; anything else in the bucket is ignored. */
const isSchemaFile = (key: string) => key.toLowerCase().endsWith('.toml')

/** Keys are always `/`-separated, whatever the host platform writes. */
const toKey = (path: string) => path.split(sep).join('/')

/** Any blob store, used for schema. */
export function schemaStoreOver(store: MediaStore): SchemaStore {
  return {
    description: store.description,
    async list() {
      return (await store.list('')).filter(isSchemaFile)
    },
    async read(key) {
      const found = await store.get(key)
      return found ? new TextDecoder().decode(await found.bytes()) : undefined
    },
    async write(key, contents) {
      await store.put(key, new TextEncoder().encode(contents), { contentType: 'text/plain' })
    },
    remove: (key) => store.delete(key),
  }
}

export interface S3SchemaStoreOptions extends S3MediaStoreOptions {}
export interface AzureSchemaStoreOptions extends AzureMediaStoreOptions {}

/** Schema in an S3 bucket, or anything that speaks S3. Defaults to a `schema/` folder. */
export const s3SchemaStore = (options: S3SchemaStoreOptions): SchemaStore =>
  schemaStoreOver(s3MediaStore({ ...options, prefix: options.prefix ?? 'schema' }))

/** Schema in an Azure Blob container. Defaults to a `schema/` folder. */
export const azureSchemaStore = (options: AzureSchemaStoreOptions): SchemaStore =>
  schemaStoreOver(azureMediaStore({ ...options, prefix: options.prefix ?? 'schema' }))

/** Every `.toml` under `dir`, as store keys. */
async function localFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const found: string[] = []
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (isSchemaFile(entry.name)) found.push(toKey(relative(dir, path)))
    }
  }
  await walk(dir)
  return found.sort()
}

/**
 * Copies the store into `dir`, which becomes the schema directory for this boot.
 *
 * A mirror, not a merge: a file the store no longer has is removed locally, so a
 * node that restarts with a stale cache cannot resurrect a deleted document type.
 */
export async function materialiseSchema(store: SchemaStore, dir: string): Promise<string[]> {
  const keys = await store.list()
  await mkdir(dir, { recursive: true })

  for (const key of keys) {
    const contents = await store.read(key)
    if (contents === undefined) continue
    const path = join(dir, ...key.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, 'utf8')
  }

  const wanted = new Set(keys)
  for (const key of await localFiles(dir)) {
    if (!wanted.has(key)) await rm(join(dir, ...key.split('/')), { force: true })
  }
  return keys
}

export interface PublishReport {
  written: string[]
  removed: string[]
}

/**
 * Sends `dir` to the store, so a schema the backoffice just changed outlives this
 * container. A mirror in the same way: a file deleted locally is deleted there.
 *
 * Unchanged files are skipped, which keeps a `rewriteAll` — every file, after a
 * move — from rewriting the whole bucket.
 */
export async function publishSchema(store: SchemaStore, dir: string): Promise<PublishReport> {
  const local = await localFiles(dir)
  const remote = new Set(await store.list())
  const report: PublishReport = { written: [], removed: [] }

  for (const key of local) {
    const contents = await readFile(join(dir, ...key.split('/')), 'utf8')
    if (remote.has(key) && (await store.read(key)) === contents) continue
    await store.write(key, contents)
    report.written.push(key)
  }

  const wanted = new Set(local)
  for (const key of remote) {
    if (wanted.has(key)) continue
    await store.remove(key)
    report.removed.push(key)
  }
  return report
}
