/**
 * A minimal zip writer, because a created package is a zip and nothing else
 * here needs one (`docs/17-packages.md`).
 *
 * No dependency: `node:zlib` provides `deflateRawSync` and `crc32`, which is
 * everything the format needs. Entries are written in the order given, each
 * stored if deflating does not make it smaller, and timestamps are fixed at the
 * epoch the format starts from so the same selection zips to the same bytes.
 */
import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** The path inside the archive, `/`-separated and never absolute. */
  path: string
  bytes: Uint8Array
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50

/** Deflate, or store when deflating gains nothing — as every zip writer does. */
const STORED = 0
const DEFLATED = 8

/**
 * 1980-01-01 00:00:00, the earliest the DOS field can express. A real time
 * would make the bytes depend on when the download happened, and nothing reads
 * these timestamps.
 */
const DOS_DATE = 0x0021
const DOS_TIME = 0x0000

/** Bit 11: the name is UTF-8, so a non-ASCII path survives the round trip. */
const UTF8_FLAG = 0x0800

class Writer {
  #chunks: Uint8Array[] = []
  #length = 0

  get length(): number {
    return this.#length
  }

  bytes(value: Uint8Array): void {
    this.#chunks.push(value)
    this.#length += value.length
  }

  u16(value: number): void {
    const view = new Uint8Array(2)
    new DataView(view.buffer).setUint16(0, value, true)
    this.bytes(view)
  }

  u32(value: number): void {
    const view = new Uint8Array(4)
    new DataView(view.buffer).setUint32(0, value >>> 0, true)
    this.bytes(view)
  }

  concat(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.#length)
    let offset = 0
    for (const chunk of this.#chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

interface Compressed {
  method: number
  crc: number
  deflated: Uint8Array
  size: number
}

function compress(bytes: Uint8Array): Compressed {
  const crc = crc32(bytes) >>> 0
  if (bytes.length === 0) return { method: STORED, crc, deflated: bytes, size: 0 }
  const deflated = new Uint8Array(deflateRawSync(bytes))
  return deflated.length < bytes.length
    ? { method: DEFLATED, crc, deflated, size: bytes.length }
    : { method: STORED, crc, deflated: bytes, size: bytes.length }
}

/**
 * The archive as one buffer. Package zips are a schema directory, some views
 * and a media library's worth of images — large enough to care about, small
 * enough that streaming would buy nothing but complexity.
 */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const body = new Writer()
  const central = new Writer()

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const { method, crc, deflated, size } = compress(entry.bytes)
    const offset = body.length

    body.u32(LOCAL_HEADER)
    body.u16(20)
    body.u16(UTF8_FLAG)
    body.u16(method)
    body.u16(DOS_TIME)
    body.u16(DOS_DATE)
    body.u32(crc)
    body.u32(deflated.length)
    body.u32(size)
    body.u16(name.length)
    body.u16(0)
    body.bytes(name)
    body.bytes(deflated)

    central.u32(CENTRAL_HEADER)
    central.u16(20)
    central.u16(20)
    central.u16(UTF8_FLAG)
    central.u16(method)
    central.u16(DOS_TIME)
    central.u16(DOS_DATE)
    central.u32(crc)
    central.u32(deflated.length)
    central.u32(size)
    central.u16(name.length)
    central.u16(0)
    central.u16(0)
    central.u16(0)
    central.u16(0)
    // 0o100644 in the high word: a regular file, readable, as unzip expects.
    central.u32(0o100644 << 16)
    central.u32(offset)
    central.bytes(name)
  }

  const out = new Writer()
  out.bytes(body.concat())
  const centralOffset = out.length
  out.bytes(central.concat())
  out.u32(END_OF_CENTRAL)
  out.u16(0)
  out.u16(0)
  out.u16(entries.length)
  out.u16(entries.length)
  out.u32(central.length)
  out.u32(centralOffset)
  out.u16(0)
  return out.concat()
}
