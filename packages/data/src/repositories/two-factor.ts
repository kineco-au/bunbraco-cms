/**
 * The authenticators and recovery codes of users and members (story 032). The
 * secret arrives here already sealed and leaves still sealed: sealing is the
 * server's, with `CROMBOLO_SECRET_KEY`, so this layer never holds a key.
 */
import { normaliseUuid } from '@crombolo/core'
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'

export interface TwoFactorLogin {
  ownerKey: string
  providerName: string
  sealedSecret: string
  lastUsedStep: number | null
}

export class TwoFactorRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  /** The providers an owner has turned on. */
  async providers(ownerKey: string): Promise<string[]> {
    const rows = await this.#db.query<{ provider_name: string }>(
      'SELECT provider_name FROM two_factor_login WHERE owner_key = ? ORDER BY provider_name',
      [normaliseUuid(ownerKey)],
    )
    return rows.map((row) => String(row.provider_name))
  }

  /** Which of these owners have any provider on, for list views. */
  async enabledAmong(ownerKeys: readonly string[]): Promise<Set<string>> {
    if (ownerKeys.length === 0) return new Set()
    const keys = ownerKeys.map(normaliseUuid)
    const rows = await this.#db.query<{ owner_key: string }>(
      `SELECT DISTINCT owner_key FROM two_factor_login WHERE owner_key IN (${keys.map(() => '?').join(', ')})`,
      keys,
    )
    return new Set(rows.map((row) => normaliseUuid(String(row.owner_key))))
  }

  async get(ownerKey: string, providerName: string): Promise<TwoFactorLogin | undefined> {
    const rows = await this.#db.query<Record<string, unknown>>(
      'SELECT * FROM two_factor_login WHERE owner_key = ? AND provider_name = ?',
      [normaliseUuid(ownerKey), providerName],
    )
    const row = rows[0]
    if (!row) return undefined
    return {
      ownerKey: normaliseUuid(String(row.owner_key)),
      providerName: String(row.provider_name),
      sealedSecret: String(row.secret),
      lastUsedStep:
        row.last_used_step === null || row.last_used_step === undefined
          ? null
          : Number(row.last_used_step),
    }
  }

  /** Turns a provider on, with its recovery codes' hashes; replaces any earlier setup. */
  async enable(
    ownerKey: string,
    providerName: string,
    sealedSecret: string,
    acceptedStep: number,
    recoveryHashes: readonly string[],
  ): Promise<void> {
    const owner = normaliseUuid(ownerKey)
    await this.#db.transaction(async (tx) => {
      await tx.exec('DELETE FROM two_factor_login WHERE owner_key = ? AND provider_name = ?', [
        owner,
        providerName,
      ])
      await tx.exec(
        `INSERT INTO two_factor_login (owner_key, provider_name, secret, last_used_step, create_date)
         VALUES (?, ?, ?, ?, ?)`,
        [owner, providerName, sealedSecret, acceptedStep, DbDate.toDb(new Date())],
      )
      await tx.exec('DELETE FROM two_factor_recovery_code WHERE owner_key = ?', [owner])
      for (const hash of recoveryHashes)
        await tx.exec('INSERT INTO two_factor_recovery_code (owner_key, code_hash) VALUES (?, ?)', [
          owner,
          hash,
        ])
    })
  }

  /** Records a step a code was accepted for, refusing one at or before the last; true when recorded. */
  async useStep(ownerKey: string, providerName: string, step: number): Promise<boolean> {
    const rows = await this.#db.query<{ owner_key: string }>(
      `UPDATE two_factor_login SET last_used_step = ?
       WHERE owner_key = ? AND provider_name = ? AND (last_used_step IS NULL OR last_used_step < ?)
       RETURNING owner_key`,
      [step, normaliseUuid(ownerKey), providerName, step],
    )
    return rows.length > 0
  }

  /** Spends a recovery code by its hash; true when it was there and unused. */
  async useRecoveryCode(ownerKey: string, hash: string): Promise<boolean> {
    const rows = await this.#db.query<{ id: number }>(
      `UPDATE two_factor_recovery_code SET used_date = ?
       WHERE owner_key = ? AND code_hash = ? AND used_date IS NULL RETURNING id`,
      [DbDate.toDb(new Date()), normaliseUuid(ownerKey), hash],
    )
    return rows.length > 0
  }

  async recoveryCodesLeft(ownerKey: string): Promise<number> {
    const rows = await this.#db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM two_factor_recovery_code WHERE owner_key = ? AND used_date IS NULL',
      [normaliseUuid(ownerKey)],
    )
    return Number(rows[0]?.n ?? 0)
  }

  /** Turns a provider off, or every provider when none is named, with the recovery codes once none is left. */
  async disable(ownerKey: string, providerName?: string): Promise<void> {
    const owner = normaliseUuid(ownerKey)
    await this.#db.transaction(async (tx) => {
      if (providerName)
        await tx.exec('DELETE FROM two_factor_login WHERE owner_key = ? AND provider_name = ?', [
          owner,
          providerName,
        ])
      else await tx.exec('DELETE FROM two_factor_login WHERE owner_key = ?', [owner])
      const left = await tx.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM two_factor_login WHERE owner_key = ?',
        [owner],
      )
      if (Number(left[0]?.n ?? 0) === 0)
        await tx.exec('DELETE FROM two_factor_recovery_code WHERE owner_key = ?', [owner])
    })
  }
}
