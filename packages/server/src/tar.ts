/**
 * A minimal npm package tarball writer: a gzipped ustar archive with every entry
 * under `package/`, which is the layout `npm pack` produces and `bun add
 * ./file.tgz` and `bun publish` read (`docs/bundles.md`).
 *
 * No dependency: the format is 512-byte headers and padded file bodies, and
 * `Bun.gzipSync` does the compression. Timestamps are fixed, as npm fixes them,
 * so the same selection packs to the same bytes.
 */
import { once } from 'node:events'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip, type Gzip } from 'node:zlib'

export interface TarEntry {
  /** The path inside the package, `/`-separated and never absolute. */
  path: string
  bytes: Uint8Array
}

const BLOCK = 512

/** 1985-10-26T08:15:00Z, the mtime npm writes into every packed file. */
const NPM_MTIME = 499162500

const encoder = new TextEncoder()

/** An octal field, NUL-terminated and zero-padded to its width. */
function octal(value: number, width: number): Uint8Array {
  return encoder.encode(`${value.toString(8).padStart(width - 1, '0')}\0`)
}

/**
 * Splits a path across ustar's `prefix` (155 bytes) and `name` (100 bytes) at a
 * slash, which is how a path longer than 100 bytes is written without an
 * extension header.
 */
function splitPath(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: '' }
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100)
      return { name, prefix }
  }
  throw new Error(`${path} is too long to pack`)
}

function header(path: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK)
  const put = (bytes: Uint8Array, offset: number) => block.set(bytes, offset)
  const { name, prefix } = splitPath(path)
  put(encoder.encode(name), 0)
  put(octal(0o644, 8), 100)
  put(octal(0, 8), 108)
  put(octal(0, 8), 116)
  put(octal(size, 12), 124)
  put(octal(NPM_MTIME, 12), 136)
  // The checksum is computed with its own field read as spaces.
  put(encoder.encode('        '), 148)
  put(encoder.encode('0'), 156)
  put(encoder.encode('ustar\0'), 257)
  put(encoder.encode('00'), 263)
  put(encoder.encode(prefix), 345)
  const sum = block.reduce((total, byte) => total + byte, 0)
  put(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
  return block
}

/** The entries as an npm package tarball, each under `package/`. */
export function writeNpmTarball(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = []
  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..'))
      throw new Error(`${entry.path} is not a path inside the package`)
    parts.push(header(`package/${entry.path}`, entry.bytes.length), entry.bytes)
    const pad = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK
    if (pad > 0) parts.push(new Uint8Array(pad))
  }
  // Two empty blocks end the archive.
  parts.push(new Uint8Array(BLOCK * 2))
  const tar = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    tar.set(part, offset)
    offset += part.length
  }
  return Bun.gzipSync(tar) as Uint8Array<ArrayBuffer>
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK

const checkInside = (path: string) => {
  if (path.startsWith('/') || path.split('/').includes('..'))
    throw new Error(`${path} is not a path inside the package`)
}

/**
 * An npm package tarball written as it goes (story 104), for a package too big
 * to hold in memory: entries are gzipped straight to the file, and a file's
 * bytes may arrive as a stream. The layout is `writeNpmTarball`'s.
 */
export class TarballWriter {
  #gzip: Gzip
  #done: Promise<void>

  private constructor(file: string) {
    this.#gzip = createGzip()
    const out = createWriteStream(file)
    this.#done = pipeline(this.#gzip, out)
  }

  static create(file: string): TarballWriter {
    return new TarballWriter(file)
  }

  async #write(bytes: Uint8Array): Promise<void> {
    if (!this.#gzip.write(bytes)) await once(this.#gzip, 'drain')
  }

  async add(path: string, bytes: Uint8Array): Promise<void> {
    checkInside(path)
    await this.#write(header(`package/${path}`, bytes.length))
    await this.#write(bytes)
    const pad = padding(bytes.length)
    if (pad > 0) await this.#write(new Uint8Array(pad))
  }

  /** A file whose `size` is known and whose bytes arrive in chunks; refused if they come to another size. */
  async addStream(path: string, size: number, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    checkInside(path)
    await this.#write(header(`package/${path}`, size))
    let written = 0
    for await (const chunk of chunks) {
      written += chunk.length
      if (written > size) throw new Error(`${path} is larger than its declared ${size} bytes`)
      await this.#write(chunk)
    }
    if (written !== size) throw new Error(`${path} was ${written} bytes, not ${size}`)
    const pad = padding(size)
    if (pad > 0) await this.#write(new Uint8Array(pad))
  }

  async close(): Promise<void> {
    await this.#write(new Uint8Array(BLOCK * 2))
    this.#gzip.end()
    await this.#done
  }

  /**
   * Gives up on a half-written file: the stream ends now, and its error is
   * swallowed, so nothing surfaces later after the caller has cleaned up.
   */
  async abort(): Promise<void> {
    this.#gzip.destroy()
    await this.#done.catch(() => {})
  }
}

const decoder = new TextDecoder()

const field = (block: Uint8Array, offset: number, width: number) =>
  decoder.decode(block.subarray(offset, offset + width)).replace(/\0.*$/s, '')

/**
 * Unpacks a gzipped tarball into `dir`, streaming, and answers the paths it
 * wrote. npm's `package/` folder is dropped, so `dir` holds what the package
 * holds. Only regular files are written; a path that climbs out is refused.
 */
export async function extractTarball(file: string, dir: string): Promise<string[]> {
  const written: string[] = []
  let pending = new Uint8Array(0)
  let current: { out: WriteStream; left: number; skip: number } | undefined
  let skipping = 0
  let ended = false

  const take = (n: number): Uint8Array | undefined => {
    if (pending.length < n) return undefined
    const head = pending.subarray(0, n)
    pending = pending.subarray(n)
    return head
  }

  const writeTo = async (out: WriteStream, bytes: Uint8Array) => {
    if (!out.write(bytes)) await once(out, 'drain')
  }

  const finishEntry = async (out: WriteStream) => {
    out.end()
    await once(out, 'finish')
  }

  for await (const chunk of createReadStream(file).pipe(createGunzip())) {
    const bytes = chunk as Uint8Array
    const joined = new Uint8Array(pending.length + bytes.length)
    joined.set(pending)
    joined.set(bytes, pending.length)
    pending = joined
    while (!ended) {
      if (current) {
        if (current.left > 0) {
          if (pending.length === 0) break
          const part = pending.subarray(0, Math.min(current.left, pending.length))
          pending = pending.subarray(part.length)
          current.left -= part.length
          await writeTo(current.out, part)
          continue
        }
        skipping = current.skip
        await finishEntry(current.out)
        current = undefined
      }
      if (skipping > 0) {
        const part = Math.min(skipping, pending.length)
        pending = pending.subarray(part)
        skipping -= part
        if (skipping > 0) break
      }
      const block = take(BLOCK)
      if (!block) break
      if (block.every((byte) => byte === 0)) {
        ended = true
        break
      }
      const name = field(block, 0, 100)
      const prefix = field(block, 345, 155)
      const size = Number.parseInt(field(block, 124, 12).trim() || '0', 8)
      const type = String.fromCharCode(block[156] ?? 48)
      const full = prefix ? `${prefix}/${name}` : name
      if (type !== '0' && type !== '\0') {
        skipping = size + padding(size)
        continue
      }
      const inside = full.replace(/^package\//, '')
      checkInside(inside)
      const target = join(dir, ...inside.split('/'))
      await mkdir(dirname(target), { recursive: true })
      written.push(inside)
      current = { out: createWriteStream(target), left: size, skip: padding(size) }
    }
  }
  if (current) {
    if (current.left > 0) throw new Error(`${file} ends part-way through a file`)
    await finishEntry(current.out)
  }
  return written
}
