/**
 * Sealing what in a bundle can hold personal information (story 071):
 * property values, media files, protected-page usernames and people. The key is stretched from a passphrase
 * given at export and at install — never stored — with scrypt and a salt the
 * bundle keeps; each file is AES-256-GCM with a nonce of its own and its path
 * as additional data, so a file cannot be swapped for another's. A check value
 * tells a wrong passphrase apart from a damaged file. docs/content-transfer.md,
 * "People".
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/** What the manifest keeps to derive the key again: never the key itself. */
export interface SealParameters {
  kdf: 'scrypt'
  /** scrypt's cost, block size and parallelism. */
  n: number
  r: number
  p: number
  /** Base64. */
  salt: string
  /** A known value sealed under the key, so a wrong passphrase is named as one. */
  check: string
}

export const SEAL_MAGIC = Buffer.from('CRBSEAL1')
const CHECK_PATH = 'people/.check'
const CHECK_TEXT = 'crombolo people'

export class WrongPassphraseError extends Error {
  constructor() {
    super('The passphrase does not open this bundle’s people.')
  }
}

export class SealedFileError extends Error {}

/** The key a passphrase gives under these parameters. */
export function deriveKey(
  passphrase: string,
  params: Pick<SealParameters, 'n' | 'r' | 'p' | 'salt'>,
): Buffer {
  if (!passphrase) throw new WrongPassphraseError()
  return scryptSync(passphrase.normalize('NFC'), Buffer.from(params.salt, 'base64'), 32, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.n * params.r + 1024 * 1024,
  })
}

/** One file sealed: magic, nonce, ciphertext, tag. `nonce` is injectable for tests. */
export function sealBytes(
  key: Buffer,
  path: string,
  plain: Uint8Array,
  nonce = randomBytes(12),
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(path))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([SEAL_MAGIC, nonce, body, cipher.getAuthTag()])
}

/** One file opened; throws when it was altered, moved or is not sealed. */
export function openBytes(key: Buffer, path: string, sealed: Uint8Array): Buffer {
  const bytes = Buffer.from(sealed)
  if (bytes.length < SEAL_MAGIC.length + 12 + 16 || !bytes.subarray(0, 8).equals(SEAL_MAGIC))
    throw new SealedFileError(`${path} is not a sealed file.`)
  const nonce = bytes.subarray(8, 20)
  const tag = bytes.subarray(bytes.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(path))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(bytes.subarray(20, bytes.length - 16)), decipher.final()])
  } catch {
    throw new SealedFileError(`${path} was altered, or belongs to another file.`)
  }
}

/** The parameters a bundle keeps, and the key they give. */
export interface Seal {
  params: SealParameters
  key: Buffer
}

/** Fresh parameters and the key they give: what an export starts with. */
export function newSeal(
  passphrase: string,
  cost: Pick<SealParameters, 'n' | 'r' | 'p'> = { n: 2 ** 17, r: 8, p: 1 },
): Seal {
  const salt = randomBytes(16).toString('base64')
  const key = deriveKey(passphrase, { ...cost, salt })
  const check = sealBytes(key, CHECK_PATH, Buffer.from(CHECK_TEXT)).toString('base64')
  return { params: { kdf: 'scrypt', ...cost, salt, check }, key }
}

/** The key for a bundle's people, or a refusal naming a wrong passphrase. */
export function unlock(passphrase: string, params: SealParameters): Buffer {
  const key = deriveKey(passphrase, params)
  try {
    const opened = openBytes(key, CHECK_PATH, Buffer.from(params.check, 'base64'))
    if (opened.toString() !== CHECK_TEXT) throw new WrongPassphraseError()
  } catch {
    throw new WrongPassphraseError()
  }
  return key
}

/** A manifest's seal read without trusting it: undefined when absent or malformed. Pure. */
export function parseSealParameters(raw: unknown): SealParameters | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const seal = raw as Record<string, unknown>
  if (
    seal.kdf !== 'scrypt' ||
    typeof seal.salt !== 'string' ||
    typeof seal.check !== 'string' ||
    ![seal.n, seal.r, seal.p].every((v) => Number.isInteger(v) && (v as number) > 0)
  )
    return undefined
  return {
    kdf: 'scrypt',
    n: seal.n as number,
    r: seal.r as number,
    p: seal.p as number,
    salt: seal.salt,
    check: seal.check,
  }
}
