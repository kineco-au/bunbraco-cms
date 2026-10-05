/**
 * The zip writer behind created-package downloads (`docs/17-packages.md`).
 *
 * The reader here walks the archive the way an unzip tool does — end record,
 * then the central directory, then each local header at the offset the
 * directory claims — rather than reading back what the writer happened to
 * write. A wrong offset or size is a test failure instead of a corrupt
 * download someone finds later.
 */
import { describe, expect, test } from 'bun:test'
import { inflateRawSync } from 'node:zlib'
import { writeZip } from '../packages/server/src/zip.ts'

interface ReadEntry {
  path: string
  bytes: Uint8Array
  method: number
}

/** Reads an archive through its central directory, as the format intends. */
function readZip(archive: Uint8Array): ReadEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const decoder = new TextDecoder()

  let end = archive.length - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1
  if (end < 0) throw new Error('no end-of-central-directory record')

  const count = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  const centralOffset = view.getUint32(end + 16, true)
  expect(centralOffset + centralSize).toBe(end)

  const entries: ReadEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50)
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const path = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength))

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50)
    // The local header must agree with the directory, or tools disagree about the file.
    expect(view.getUint16(localOffset + 8, true)).toBe(method)
    expect(view.getUint32(localOffset + 14, true)).toBe(crc)
    expect(view.getUint32(localOffset + 18, true)).toBe(compressedSize)
    expect(view.getUint32(localOffset + 22, true)).toBe(uncompressedSize)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const stored = archive.subarray(dataStart, dataStart + compressedSize)
    const bytes = method === 0 ? stored : new Uint8Array(inflateRawSync(stored))
    expect(bytes.length).toBe(uncompressedSize)

    entries.push({ path, bytes, method })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const text = (value: string) => new TextEncoder().encode(value)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('writeZip', () => {
  test('round-trips several entries, directories included', () => {
    const archive = writeZip([
      { path: 'bundle.json', bytes: text('{"formatVersion":1}') },
      { path: 'schema/document-types/home.toml', bytes: text('[document-type]\nalias = "home"\n') },
      { path: 'files/Views/Home.tsx', bytes: text('export default () => <h1>Home</h1>\n') },
    ])

    const entries = readZip(archive)
    expect(entries.map((e) => e.path)).toEqual([
      'bundle.json',
      'schema/document-types/home.toml',
      'files/Views/Home.tsx',
    ])
    expect(decode(entries[1]?.bytes as Uint8Array)).toBe('[document-type]\nalias = "home"\n')
  })

  test('stores an empty entry rather than deflating it', () => {
    const entries = readZip(writeZip([{ path: 'empty.txt', bytes: new Uint8Array() }]))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.method).toBe(0)
    expect(entries[0]?.bytes).toHaveLength(0)
  })

  test('stores incompressible bytes instead of growing them', () => {
    // Deterministic pseudo-random bytes: deflate cannot shrink these.
    const noise = new Uint8Array(4096)
    let state = 1
    for (let index = 0; index < noise.length; index += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      noise[index] = (state >> 16) & 0xff
    }
    const archive = writeZip([{ path: 'noise.bin', bytes: noise }])
    const entries = readZip(archive)
    expect(entries[0]?.method).toBe(0)
    expect(entries[0]?.bytes).toEqual(noise)
  })

  test('deflates compressible bytes', () => {
    const repetitive = text('the same line over and over\n'.repeat(200))
    const archive = writeZip([{ path: 'repeat.txt', bytes: repetitive }])
    expect(archive.length).toBeLessThan(repetitive.length)
    const entries = readZip(archive)
    expect(entries[0]?.method).toBe(8)
    expect(entries[0]?.bytes).toEqual(repetitive)
  })

  test('keeps a non-ASCII path intact', () => {
    const entries = readZip(writeZip([{ path: 'files/café/menü.txt', bytes: text('ok') }]))
    expect(entries[0]?.path).toBe('files/café/menü.txt')
  })

  test('writes an empty archive that still has an end record', () => {
    expect(readZip(writeZip([]))).toEqual([])
  })

  test('is deterministic, so the same selection downloads the same bytes', () => {
    const entries = [
      { path: 'a.txt', bytes: text('one') },
      { path: 'b.txt', bytes: text('two') },
    ]
    expect(writeZip(entries)).toEqual(writeZip(entries))
  })
})
