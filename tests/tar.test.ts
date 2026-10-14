/**
 * The npm package tarball a created bundle downloads as. Read back two ways:
 * by the test's own reader, and by the system's `tar`, so a wrong header is a
 * failure here rather than in somebody's package manager. docs/bundles.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeNpmTarball } from '../packages/server/src/tar.ts'
import { untar } from './support/tar.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const bytes = (text: string) => new TextEncoder().encode(text)

describe('an npm tarball', () => {
  test('puts every entry under package/, and reads back whole', () => {
    const packed = writeNpmTarball([
      { path: 'package.json', bytes: bytes('{"name":"a"}') },
      { path: 'bundle/bundle.json', bytes: bytes('{}') },
      { path: 'bundle/empty.txt', bytes: new Uint8Array() },
      { path: 'bundle/blobs/κλειδί', bytes: new Uint8Array(1500).fill(7) },
    ])
    const entries = untar(packed)
    expect([...entries.keys()]).toEqual([
      'package.json',
      'bundle/bundle.json',
      'bundle/empty.txt',
      'bundle/blobs/κλειδί',
    ])
    expect(new TextDecoder().decode(entries.get('package.json'))).toBe('{"name":"a"}')
    expect(entries.get('bundle/blobs/κλειδί')).toEqual(new Uint8Array(1500).fill(7))
  })

  test('the system tar unpacks it, a path longer than a header holds included', async () => {
    const long = `bundle/components/${'deep/'.repeat(20)}view.tsx`
    expect(long.length).toBeGreaterThan(100)
    const dir = mkdtempSync(join(tmpdir(), 'crombolo-tar-'))
    dirs.push(dir)
    const file = join(dir, 'a-1.0.0.tgz')
    writeFileSync(
      file,
      writeNpmTarball([
        { path: 'package.json', bytes: bytes('{"name":"a"}') },
        { path: long, bytes: bytes('export default () => null') },
      ]),
    )
    const proc = Bun.spawn(['tar', '-xzf', file, '-C', dir], { stderr: 'pipe' })
    expect([await proc.exited, await new Response(proc.stderr).text()]).toEqual([0, ''])
    expect(readFileSync(join(dir, 'package', 'package.json'), 'utf8')).toBe('{"name":"a"}')
    expect(readFileSync(join(dir, 'package', long), 'utf8')).toBe('export default () => null')
  })

  test('packs the same entries to the same bytes', () => {
    const entries = [{ path: 'package.json', bytes: bytes('{}') }]
    expect(writeNpmTarball(entries)).toEqual(writeNpmTarball(entries))
  })

  test('refuses a path that would land outside the package', () => {
    for (const path of ['/etc/passwd', '../escape', 'bundle/../../escape'])
      expect(() => writeNpmTarball([{ path, bytes: bytes('x') }]), path).toThrow(
        /not a path inside the package/,
      )
  })
})
