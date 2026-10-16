/**
 * The OAuth 2.0 device authorization grant (RFC 8628), for the `crombolo` CLI
 * signing in to a remote (story 107): the CLI shows a short code, the person
 * approves it in a browser where they are already signed in, and the CLI
 * receives tokens for that person, with that person's permissions.
 *
 * The device code is a bearer credential and is stored hashed; the user code is
 * what a person types, short and unambiguous, and is single-use. An approved
 * authorization becomes a session of its own, so "signed-in devices" is the
 * list of those sessions and revoking one ends it.
 */
import { randomInt } from 'node:crypto'
import { type Db, DbDate } from '@crombolo/data'
import { generateToken, hashToken } from './pkce.ts'

/** The client id the CLI signs in as. */
export const REMOTE_CLIENT_ID = 'crombolo-cli'
export const DEVICE_CODE_SECONDS = 10 * 60
export const DEVICE_POLL_SECONDS = 5

/** No vowels or look-alikes, so a code never spells a word or reads two ways. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'issued'

export interface DeviceAuthorizationRow {
  id: number
  userCode: string
  clientId: string
  clientName: string | null
  scope: string
  status: DeviceStatus
  userId: number | null
  sessionId: string | null
  intervalSeconds: number
  lastPolledAt: Date | undefined
  expiresAt: Date
  decidedAt: Date | undefined
  createdAt: Date
}

export interface SignedInDevice {
  id: number
  clientName: string | null
  signedInAt: Date
  lastUsedAt: Date | undefined
}

function userCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)] as string
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`
}

/** A code as typed: case, spaces and the dash do not matter. */
export const normaliseUserCode = (code: string): string => {
  const plain = code.toUpperCase().replace(/[^A-Z]/g, '')
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain
}

function mapRow(row: Record<string, unknown>): DeviceAuthorizationRow {
  return {
    id: Number(row.id),
    userCode: String(row.user_code),
    clientId: String(row.client_id),
    clientName:
      row.client_name === null || row.client_name === undefined ? null : String(row.client_name),
    scope: String(row.scope),
    status: String(row.status) as DeviceStatus,
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    sessionId:
      row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    intervalSeconds: Number(row.interval_seconds),
    lastPolledAt: DbDate.fromDb(row.last_polled_at),
    expiresAt: DbDate.fromDb(row.expires_at) ?? new Date(0),
    decidedAt: DbDate.fromDb(row.decided_at),
    createdAt: DbDate.fromDb(row.create_date) ?? new Date(0),
  }
}

export class DeviceStore {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async create(init: {
    clientId: string
    clientName: string | null
    scope: string
  }): Promise<{ deviceCode: string; userCode: string; expiresAt: Date }> {
    const deviceCode = generateToken()
    const expiresAt = new Date(Date.now() + DEVICE_CODE_SECONDS * 1000)
    // A clash with a live code is vanishingly rare; another draw settles it.
    for (let attempt = 0; ; attempt++) {
      const code = userCode()
      try {
        await this.#db.exec(
          `INSERT INTO device_authorization
             (device_code_hash, user_code, client_id, client_name, scope, status, interval_seconds, expires_at, create_date)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            hashToken(deviceCode),
            code,
            init.clientId,
            init.clientName,
            init.scope,
            DEVICE_POLL_SECONDS,
            DbDate.toDb(expiresAt),
            DbDate.toDb(new Date()),
          ],
        )
        return { deviceCode, userCode: code, expiresAt }
      } catch (error) {
        if (attempt >= 4) throw error
      }
    }
  }

  async byDeviceCode(deviceCode: string): Promise<DeviceAuthorizationRow | undefined> {
    const rows = await this.#db.query(
      'SELECT * FROM device_authorization WHERE device_code_hash = ?',
      [hashToken(deviceCode)],
    )
    return rows[0] ? mapRow(rows[0]) : undefined
  }

  async byUserCode(code: string): Promise<DeviceAuthorizationRow | undefined> {
    const rows = await this.#db.query('SELECT * FROM device_authorization WHERE user_code = ?', [
      normaliseUserCode(code),
    ])
    return rows[0] ? mapRow(rows[0]) : undefined
  }

  async polled(id: number, intervalSeconds: number): Promise<void> {
    await this.#db.exec(
      'UPDATE device_authorization SET last_polled_at = ?, interval_seconds = ? WHERE id = ?',
      [DbDate.toDb(new Date()), intervalSeconds, id],
    )
  }

  /** Approves or denies a pending one; false when it was no longer pending. */
  async decide(id: number, userId: number, approve: boolean): Promise<boolean> {
    const rows = await this.#db.query<{ id: number }>(
      `UPDATE device_authorization SET status = ?, user_id = ?, decided_at = ?
       WHERE id = ? AND status = 'pending' RETURNING id`,
      [approve ? 'approved' : 'denied', userId, DbDate.toDb(new Date()), id],
    )
    return rows.length > 0
  }

  /** Marks an approved one as having had its tokens issued, once; false if it already had. */
  async issued(id: number, sessionId: string): Promise<boolean> {
    const rows = await this.#db.query<{ id: number }>(
      `UPDATE device_authorization SET status = 'issued', session_id = ?
       WHERE id = ? AND status = 'approved' RETURNING id`,
      [sessionId, id],
    )
    return rows.length > 0
  }

  /** The devices signed in as this user, whose sessions are still open. */
  async signedIn(userId: number): Promise<SignedInDevice[]> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT d.id, d.client_name, s.logged_in_utc, s.last_validated_utc
       FROM device_authorization d JOIN user_login_session s ON s.session_id = d.session_id
       WHERE d.user_id = ? AND d.status = 'issued' AND s.logged_out_utc IS NULL
       ORDER BY s.logged_in_utc DESC`,
      [userId],
    )
    return rows.map((row) => ({
      id: Number(row.id),
      clientName: row.client_name === null ? null : String(row.client_name),
      signedInAt: DbDate.fromDb(row.logged_in_utc) ?? new Date(0),
      lastUsedAt: DbDate.fromDb(row.last_validated_utc),
    }))
  }

  async byId(id: number): Promise<DeviceAuthorizationRow | undefined> {
    const rows = await this.#db.query('SELECT * FROM device_authorization WHERE id = ?', [id])
    return rows[0] ? mapRow(rows[0]) : undefined
  }
}
