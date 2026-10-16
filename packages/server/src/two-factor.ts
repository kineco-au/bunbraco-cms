/**
 * Two-factor sign-in with an authenticator app (story 032), for backoffice users
 * and members alike: setting it up, turning it on with ten recovery codes,
 * checking a code at sign-in, and turning it off. The secret is sealed with
 * `CROMBOLO_SECRET_KEY`, so two-factor sign-in cannot be turned on without the
 * key. docs/operations.md.
 *
 * Setup is stateless, as Umbraco's is: the secret goes to the browser with its
 * QR code, and comes back with the first code, which proves the app has it.
 */
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  qrCodeDataUrl,
  verifyTotp,
} from '@crombolo/auth'
import { type Db, TwoFactorRepository } from '@crombolo/data'
import { openSecret, SECRET_KEY_VARIABLE, sealSecret, usableSecretKey } from './secrets.ts'

/** Umbraco's names for the authenticator provider, which the backoffice matches by. */
export const USER_TWO_FACTOR_PROVIDER = 'UmbracoUserAppAuthenticator'
export const MEMBER_TWO_FACTOR_PROVIDER = 'UmbracoMemberAppAuthenticator'

export type TwoFactorResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { value: T }))
  | { ok: false; reason: 'unavailable' | 'invalidCode' | 'notEnabled'; message: string }

export class TwoFactorService {
  #repository: TwoFactorRepository
  #key: string | undefined
  #issuer: string

  constructor(db: Db, options: { secretKey: string | undefined; issuer: string }) {
    this.#repository = new TwoFactorRepository(db)
    this.#key = usableSecretKey(options.secretKey)
    this.#issuer = options.issuer
  }

  /** Whether two-factor sign-in can be turned on here: only with the key to seal secrets. */
  get available(): boolean {
    return this.#key !== undefined
  }

  #unavailable() {
    return {
      ok: false as const,
      reason: 'unavailable' as const,
      message: `Two-factor sign-in needs ${SECRET_KEY_VARIABLE} set on the server.`,
    }
  }

  providers(ownerKey: string): Promise<string[]> {
    return this.#repository.providers(ownerKey)
  }

  enabledAmong(ownerKeys: readonly string[]): Promise<Set<string>> {
    return this.#repository.enabledAmong(ownerKeys)
  }

  /** A new secret, its QR code and the URI in it, for an account named `account`. */
  setup(
    account: string,
  ): TwoFactorResult<{ secret: string; qrCodeSetupImageUrl: string; otpauthUri: string }> {
    if (!this.#key) return this.#unavailable()
    const secret = generateTotpSecret()
    const uri = otpauthUri({ secret, account, issuer: this.#issuer })
    return { ok: true, value: { secret, qrCodeSetupImageUrl: qrCodeDataUrl(uri), otpauthUri: uri } }
  }

  /** Turns the provider on when `code` is right for `secret`; answers with the recovery codes, shown once. */
  async enable(
    ownerKey: string,
    provider: string,
    secret: string,
    code: string,
  ): Promise<TwoFactorResult<{ recoveryCodes: string[] }>> {
    if (!this.#key) return this.#unavailable()
    const step = verifyTotp(secret, code)
    if (step === undefined)
      return {
        ok: false,
        reason: 'invalidCode',
        message: 'That code is not right. Try the next one.',
      }
    const recoveryCodes = generateRecoveryCodes()
    await this.#repository.enable(
      ownerKey,
      provider,
      sealSecret(secret, this.#key),
      step,
      recoveryCodes.map(hashRecoveryCode),
    )
    return { ok: true, value: { recoveryCodes } }
  }

  /**
   * Whether a code — from the app, or a recovery code — is this owner's, now. An
   * accepted app code's step is recorded, so it cannot be used again; a recovery
   * code is spent.
   */
  async verify(ownerKey: string, provider: string, code: string): Promise<boolean> {
    const login = await this.#repository.get(ownerKey, provider)
    if (!login || !this.#key) return false
    const digits = code.replace(/\s/g, '')
    if (/^\d{6}$/.test(digits)) {
      let secret: string
      try {
        secret = openSecret(login.sealedSecret, this.#key)
      } catch {
        return false
      }
      const step = verifyTotp(secret, digits, { lastUsedStep: login.lastUsedStep })
      return step !== undefined && (await this.#repository.useStep(ownerKey, provider, step))
    }
    return this.#repository.useRecoveryCode(ownerKey, hashRecoveryCode(code))
  }

  /** Turns a provider off for its owner, who proves it with a code. */
  async disable(ownerKey: string, provider: string, code: string): Promise<TwoFactorResult> {
    if (!(await this.#repository.get(ownerKey, provider)))
      return { ok: false, reason: 'notEnabled', message: 'Two-factor sign-in is not on.' }
    if (!(await this.verify(ownerKey, provider, code)))
      return { ok: false, reason: 'invalidCode', message: 'That code is not right.' }
    await this.#repository.disable(ownerKey, provider)
    return { ok: true }
  }

  /** Turns it off for someone else, as an administrator does for a lost phone. */
  async reset(ownerKey: string, provider?: string): Promise<void> {
    await this.#repository.disable(ownerKey, provider)
  }

  recoveryCodesLeft(ownerKey: string): Promise<number> {
    return this.#repository.recoveryCodesLeft(ownerKey)
  }
}
