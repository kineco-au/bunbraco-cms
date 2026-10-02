/** Per-user key/value data the backoffice keeps between sessions (Umbraco's `umbracoUserData`). */
import { normaliseUuid } from '@bunbraco/core'
import type { Db } from '../database.ts'

export interface UserDataEntry {
  key: string
  group: string
  identifier: string
  value: string
}

export type UserDataResult = 'Success' | 'NotFound' | 'AlreadyExists'

const map = (row: Record<string, unknown>): UserDataEntry => ({
  key: normaliseUuid(String(row.key)),
  group: String(row.data_group),
  identifier: String(row.identifier),
  value: String(row.value),
})

export class UserDataRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async list(
    userId: number,
    filter: { groups?: readonly string[]; identifiers?: readonly string[] },
    skip: number,
    take: number,
  ): Promise<{ total: number; items: UserDataEntry[] }> {
    const where = ['user_id = ?']
    const params: unknown[] = [userId]
    if (filter.groups?.length) {
      where.push(`data_group IN (${filter.groups.map(() => '?').join(', ')})`)
      params.push(...filter.groups)
    }
    if (filter.identifiers?.length) {
      where.push(`identifier IN (${filter.identifiers.map(() => '?').join(', ')})`)
      params.push(...filter.identifiers)
    }
    const rows = await this.#db.query(
      `SELECT key, data_group, identifier, value FROM user_data WHERE ${where.join(' AND ')}
       ORDER BY data_group, identifier`,
      params,
    )
    return { total: rows.length, items: rows.slice(skip, skip + take).map(map) }
  }

  async get(userId: number, key: string): Promise<UserDataEntry | undefined> {
    const rows = await this.#db.query(
      'SELECT key, data_group, identifier, value FROM user_data WHERE user_id = ? AND key = ?',
      [userId, normaliseUuid(key)],
    )
    return rows[0] ? map(rows[0]) : undefined
  }

  async create(userId: number, entry: UserDataEntry): Promise<UserDataResult> {
    const clash = await this.#db.query(
      'SELECT 1 FROM user_data WHERE key = ? OR (user_id = ? AND data_group = ? AND identifier = ?)',
      [normaliseUuid(entry.key), userId, entry.group, entry.identifier],
    )
    if (clash.length > 0) return 'AlreadyExists'
    await this.#db.exec(
      'INSERT INTO user_data (key, user_id, data_group, identifier, value) VALUES (?, ?, ?, ?, ?)',
      [normaliseUuid(entry.key), userId, entry.group, entry.identifier, entry.value],
    )
    return 'Success'
  }

  async update(userId: number, entry: UserDataEntry): Promise<UserDataResult> {
    if (!(await this.get(userId, entry.key))) return 'NotFound'
    await this.#db.exec(
      'UPDATE user_data SET data_group = ?, identifier = ?, value = ? WHERE user_id = ? AND key = ?',
      [entry.group, entry.identifier, entry.value, userId, normaliseUuid(entry.key)],
    )
    return 'Success'
  }

  async delete(userId: number, key: string): Promise<UserDataResult> {
    if (!(await this.get(userId, key))) return 'NotFound'
    await this.#db.exec('DELETE FROM user_data WHERE user_id = ? AND key = ?', [
      userId,
      normaliseUuid(key),
    ])
    return 'Success'
  }
}
