/**
 * A minimal npm package tarball writer: a gzipped ustar archive with every entry
 * under `package/`, which is the layout `npm pack` produces and `bun add
 * ./file.tgz` and `bun publish` read (`docs/bundles.md`).
 *
 * No dependency: the format is 512-byte headers and padded file bodies, and
 * `Bun.gzipSync` does the compression. Timestamps are fixed, as npm fixes them,
 * so the same selection packs to the same bytes.
 */

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
