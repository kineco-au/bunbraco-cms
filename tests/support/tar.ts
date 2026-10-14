/**
 * Reads an npm package tarball back, the way a package manager would: gunzip,
 * then walk the ustar headers. Independent of the writer, so a wrong size or a
 * misplaced prefix is a failure here rather than an assumption shared with it.
 */
const decoder = new TextDecoder()

const field = (block: Uint8Array, offset: number, length: number): string =>
  decoder.decode(block.subarray(offset, offset + length)).replace(/\0.*$/s, '')

/** The tarball's files by path, with npm's `package/` prefix removed. */
export function untar(gzipped: Uint8Array<ArrayBuffer>): Map<string, Uint8Array> {
  const tar = Bun.gunzipSync(gzipped)
  const found = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const size = Number.parseInt(field(header, 124, 12).trim(), 8)
    const path = prefix ? `${prefix}/${name}` : name
    if (!path.startsWith('package/')) throw new Error(`${path} is outside package/`)
    found.set(path.slice('package/'.length), tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return found
}
