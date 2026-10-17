/**
 * Media fetched from a remote on first request (story 108, `pull
 * --media-info-only --lazy-media`): a local site pulled without its media
 * files reads each one through from the remote it came from the first time it
 * is asked for, under the developer's own sign-in, and keeps it.
 *
 * Only the store the site serves from is wrapped. An export reads the plain
 * store, so pushing a lazily-pulled site never downloads what it never used.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic-write.ts'
import { logger } from './logging.ts'
import type { MediaStore, StoredFile } from './media-store.ts'
import { freshAccessToken, type Keychain, osKeychain } from './remote-credentials.ts'

export const REMOTE_MEDIA_FILE = join('.crombolo', 'remote-media.json')

export interface RemoteMediaSource {
  /** The remote's API base, which is also what its sign-in is kept under. */
  api: string
  environment: string
}

export function readRemoteMedia(siteDir: string): RemoteMediaSource | undefined {
  const file = join(siteDir, REMOTE_MEDIA_FILE)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RemoteMediaSource>
    return typeof parsed.api === 'string' && typeof parsed.environment === 'string'
      ? { api: parsed.api, environment: parsed.environment }
      : undefined
  } catch {
    return undefined
  }
}

export function writeRemoteMedia(siteDir: string, source: RemoteMediaSource): void {
  const file = join(siteDir, REMOTE_MEDIA_FILE)
  writeFileAtomic(file, `${JSON.stringify(source, null, 2)}\n`)
}

/** The site's store, reading through to its remote when the site was pulled lazily. */
export function withRemoteMedia(
  store: MediaStore,
  siteDir: string,
  options: { keychain?: Keychain; http?: typeof fetch } = {},
): MediaStore {
  const source = readRemoteMedia(siteDir)
  if (!source) return store
  const keychain = options.keychain ?? osKeychain()
  const http = options.http ?? fetch
  const log = logger('media')
  let warned = false

  const fetchThrough = async (key: string): Promise<StoredFile | undefined> => {
    const token = await freshAccessToken(keychain, source.api, http)
    if (!token) {
      if (!warned)
        log.warning(
          'A media file is not here yet, and fetching it needs `crombolo login` to {api}',
          {
            api: source.api,
          },
        )
      warned = true
      return undefined
    }
    const path = key.split('/').map(encodeURIComponent).join('/')
    const response = await http(`${source.api}/environments/${source.environment}/media/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined)
    if (!response?.ok) return undefined
    await store.put(key, await response.blob())
    return store.get(key)
  }

  return {
    ...store,
    description: `${store.description} (fetching from ${new URL(source.api).origin})`,
    async get(key) {
      const local = await store.get(key)
      if (local || key.startsWith('.')) return local
      return fetchThrough(key)
    },
    put: (key, body, putOptions) => store.put(key, body, putOptions),
    delete: (key) => store.delete(key),
    list: (prefix) => store.list(prefix),
    ...(store.publicUrl ? { publicUrl: (key: string) => store.publicUrl?.(key) } : {}),
  }
}
