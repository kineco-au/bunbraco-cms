/**
 * Media in an Azure Blob Storage container.
 *
 * Azure has no client built into Bun, and `@azure/storage-blob` is a large
 * dependency for four verbs, so this speaks the REST API directly. Two ways in:
 *
 * - **A SAS token.** Appended to every request; nothing to sign. Simplest, and
 *   what a deployment that already issues SAS tokens should use.
 * - **An account key.** Signed per request with Shared Key authorisation, which
 *   is an HMAC-SHA256 over a canonical form of the request that Azure specifies
 *   exactly — hence the deliberate ordering below, where a stray newline or a
 *   header out of order fails with 403 and no explanation.
 *
 * Serving: by default the server streams the bytes, keeping a private container
 * private. `publicUrlPrefix` redirects browsers to a CDN; a container with public
 * read access can point it at the container URL itself.
 */
import { contentTypeFor, isSafeMediaKey, type MediaStore, type StoredFile } from './media-store.ts'

export interface AzureMediaStoreOptions {
  account: string
  container: string
  /** The account key, for Shared Key authorisation. */
  accountKey?: string
  /** A SAS token instead of a key; a leading `?` is optional. */
  sasToken?: string
  /** Override for Azurite or a sovereign cloud; default is the public endpoint. */
  endpoint?: string
  /** A folder inside the container. */
  prefix?: string
  /** A CDN or public container URL; browsers are redirected there. */
  publicUrlPrefix?: string
}

const VERSION = '2021-08-06'

/**
 * Azure's `StringToSign` for Shared Key: the verb, thirteen fixed headers, then
 * the canonicalised `x-ms-*` headers and the canonicalised resource. Every field
 * is present even when empty, which is why this is a list and not a template.
 */
async function sharedKeyAuthorization(
  account: string,
  accountKey: string,
  method: string,
  url: URL,
  headers: Headers,
  contentLength: number,
): Promise<string> {
  const canonicalHeaders = [...headers.keys()]
    .filter((name) => name.startsWith('x-ms-'))
    .sort()
    .map((name) => `${name}:${(headers.get(name) ?? '').trim()}`)
    .join('\n')
  const canonicalResource = [
    `/${account}${url.pathname}`,
    ...[...url.searchParams.keys()]
      .sort()
      .map((name) => `${name.toLowerCase()}:${url.searchParams.getAll(name).sort().join(',')}`),
  ].join('\n')
  const stringToSign = [
    method,
    headers.get('content-encoding') ?? '',
    headers.get('content-language') ?? '',
    // Azure wants an empty string for a zero-length body, not "0".
    contentLength === 0 ? '' : String(contentLength),
    headers.get('content-md5') ?? '',
    headers.get('content-type') ?? '',
    '', // Date, superseded by x-ms-date
    '', // If-Modified-Since
    '', // If-Match
    '', // If-None-Match
    '', // If-Unmodified-Since
    '', // Range
    canonicalHeaders,
    canonicalResource,
  ].join('\n')

  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(accountKey), (c) => c.charCodeAt(0)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign))
  return `SharedKey ${account}:${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
}

export function azureMediaStore(options: AzureMediaStoreOptions): MediaStore {
  if (!options.account) throw new Error('An Azure media store needs an account.')
  if (!options.container) throw new Error('An Azure media store needs a container.')
  if (!options.accountKey && !options.sasToken)
    throw new Error('An Azure media store needs either an account key or a SAS token.')
  const origin = (options.endpoint ?? `https://${options.account}.blob.core.windows.net`).replace(
    /\/$/,
    '',
  )
  const prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : ''
  const sas = options.sasToken?.replace(/^\?/, '')
  const publicPrefix = options.publicUrlPrefix?.replace(/\/$/, '')

  const blobUrl = (key: string, query: Record<string, string> = {}) => {
    const url = new URL(
      `${origin}/${options.container}/${encodeURI(`${prefix}${key}`).replaceAll('#', '%23')}`,
    )
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return url
  }

  /** Adds the SAS token last, so it is never part of what Shared Key signs. */
  const send = async (
    method: string,
    url: URL,
    init: { body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('x-ms-version', VERSION)
    headers.set('x-ms-date', new Date().toUTCString())
    const length = init.body?.byteLength ?? 0
    if (options.accountKey) {
      headers.set(
        'authorization',
        await sharedKeyAuthorization(
          options.account,
          options.accountKey,
          method,
          url,
          headers,
          length,
        ),
      )
    }
    const signed = new URL(url)
    if (sas)
      for (const [name, value] of new URLSearchParams(sas)) signed.searchParams.set(name, value)
    return fetch(signed, { method, headers, body: init.body })
  }

  return {
    description: `azure://${options.account}/${options.container}${prefix ? `/${prefix.slice(0, -1)}` : ''}`,

    async get(key): Promise<StoredFile | undefined> {
      if (!isSafeMediaKey(key)) return undefined
      const url = blobUrl(key)
      const head = await send('HEAD', url)
      if (head.status === 404) return undefined
      if (!head.ok) throw new Error(`Azure HEAD ${key} failed with ${head.status}.`)
      return {
        key,
        size: Number(head.headers.get('content-length') ?? 0),
        etag: (head.headers.get('etag') ?? '').replaceAll('"', ''),
        contentType: head.headers.get('content-type') || contentTypeFor(key),
        bytes: async () => {
          const response = await send('GET', url)
          if (!response.ok) throw new Error(`Azure GET ${key} failed with ${response.status}.`)
          return new Uint8Array(await response.arrayBuffer())
        },
      }
    },

    async put(key, body, putOptions) {
      if (!isSafeMediaKey(key)) throw new Error(`"${key}" is not a usable media key.`)
      // Copied into a plain ArrayBuffer so `fetch` and the signature agree on its length.
      const bytes = new Uint8Array(body instanceof File ? await body.arrayBuffer() : body)
      const response = await send('PUT', blobUrl(key), {
        body: bytes,
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'content-type': putOptions?.contentType ?? contentTypeFor(key),
        },
      })
      if (!response.ok)
        throw new Error(`Azure PUT ${key} failed with ${response.status}: ${await response.text()}`)
    },

    async delete(key) {
      if (!isSafeMediaKey(key)) return
      const response = await send('DELETE', blobUrl(key))
      if (!response.ok && response.status !== 404)
        throw new Error(`Azure DELETE ${key} failed with ${response.status}.`)
    },

    async list(keyPrefix) {
      const found: string[] = []
      let marker: string | undefined
      do {
        const url = blobUrl('', {
          restype: 'container',
          comp: 'list',
          prefix: `${prefix}${keyPrefix}`,
        })
        // blobUrl appends the key to the container path; listing is the container itself.
        url.pathname = `/${options.container}`
        if (marker) url.searchParams.set('marker', marker)
        const response = await send('GET', url)
        if (!response.ok) throw new Error(`Azure list failed with ${response.status}.`)
        const xml = await response.text()
        for (const match of xml.matchAll(/<Name>([^<]*)<\/Name>/g)) {
          const name = decodeXmlText(match[1] ?? '')
          if (name.startsWith(prefix)) found.push(name.slice(prefix.length))
        }
        marker = /<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] || undefined
      } while (marker)
      return found
    },

    publicUrl: publicPrefix ? (key) => `${publicPrefix}/${key}` : undefined,
  }
}

const decodeXmlText = (value: string) =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
