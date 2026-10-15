/**
 * Story 071: a bundle's people travel sealed — scrypt over a passphrase,
 * AES-256-GCM per file, the path bound in.
 */
import { describe, expect, test } from 'bun:test'
import {
  newSeal,
  openBytes,
  SEAL_MAGIC,
  SealedFileError,
  sealBytes,
  unlock,
  WrongPassphraseError,
} from '@crombolo/transfer'

// Cheap parameters: the cost is a setting, and these tests are about the format.
const CHEAP = { n: 2 ** 10, r: 8, p: 1 }

describe('sealing people', () => {
  test('a file opens with the passphrase it was sealed under, and nothing reads in the clear', () => {
    const { params, key } = newSeal('correct horse battery', CHEAP)
    const plain = Buffer.from('{"email":"ada@example.test"}')
    const sealed = sealBytes(key, 'people/members/a.json', plain)
    expect(sealed.subarray(0, 8).equals(SEAL_MAGIC)).toBe(true)
    expect(sealed.includes(Buffer.from('ada@example.test'))).toBe(false)
    const again = unlock('correct horse battery', params)
    expect(openBytes(again, 'people/members/a.json', sealed).toString()).toBe(plain.toString())
  })

  test('a wrong passphrase is named as one, not as a damaged file', () => {
    const { params } = newSeal('correct horse battery', CHEAP)
    expect(() => unlock('Correct horse battery', params)).toThrow(WrongPassphraseError)
    expect(() => unlock('', params)).toThrow(WrongPassphraseError)
  })

  test('an altered file, or one moved to another path, is refused', () => {
    const { key } = newSeal('pass', CHEAP)
    const sealed = sealBytes(key, 'people/members/a.json', Buffer.from('{}'))
    const altered = Buffer.from(sealed)
    altered[altered.length - 20] = (altered[altered.length - 20] as number) ^ 1
    expect(() => openBytes(key, 'people/members/a.json', altered)).toThrow(SealedFileError)
    expect(() => openBytes(key, 'people/members/b.json', sealed)).toThrow(SealedFileError)
    expect(() => openBytes(key, 'people/members/a.json', Buffer.from('{}'))).toThrow(
      'not a sealed file',
    )
  })

  test('the parameters keep a salt and cost, never the key', () => {
    const { params, key } = newSeal('pass', CHEAP)
    expect(params).toMatchObject({ kdf: 'scrypt', n: 1024, r: 8, p: 1 })
    expect(Buffer.from(params.salt, 'base64')).toHaveLength(16)
    expect(JSON.stringify(params)).not.toContain(key.toString('base64'))
    // Two exports of the same passphrase share nothing.
    expect(newSeal('pass', CHEAP).params.salt).not.toBe(params.salt)
  })
})
