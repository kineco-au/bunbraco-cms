/**
 * Which pages are protected, and by what.
 *
 * An entry protects the page it names *and everything below it*, so the render
 * path asks "is anything on this node's ancestor path protected?" — which is
 * `entryFor`, resolved against `node.path` rather than by walking parents.
 *
 * Rules are names, not keys: a member group's name or a member's username, as
 * Umbraco stores them, because that is what a signed-in member carries.
 */
import { normaliseUuid } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { DbDate } from '../dialect.ts'
import { NodeRepository } from './nodes.ts'

export const MEMBER_GROUP_RULE = 'MemberRole'
export const MEMBER_USERNAME_RULE = 'MemberUsername'

export interface PublicAccessEntry {
  key: string
  /** The protected page. */
  nodeKey: string
  loginNodeKey: string
  errorNodeKey: string
  memberGroupNames: string[]
  memberUserNames: string[]
}

export interface PublicAccessInput {
  nodeKey: string
  loginNodeKey: string
  errorNodeKey: string
  memberGroupNames: readonly string[]
  memberUserNames: readonly string[]
}

interface EntryRow {
  id: number
  key: string
  node_key: string
  login_key: string
  error_key: string
}

const SELECT = `SELECT a.id, a.key,
         n.unique_id AS node_key, l.unique_id AS login_key, e.unique_id AS error_key
    FROM public_access a
    JOIN node n ON n.id = a.node_id
    JOIN node l ON l.id = a.login_node_id
    JOIN node e ON e.id = a.error_node_id`

export class PublicAccessRepository {
  #db: Db
  #nodes: NodeRepository

  constructor(db: Db) {
    this.#db = db
    this.#nodes = new NodeRepository(db)
  }

  async #rules(id: number): Promise<{ groups: string[]; users: string[] }> {
    const rows = await this.#db.query<{ rule_type: string; rule_value: string }>(
      'SELECT rule_type, rule_value FROM public_access_rule WHERE public_access_id = ? ORDER BY rule_value',
      [id],
    )
    return {
      groups: rows
        .filter((r) => r.rule_type === MEMBER_GROUP_RULE)
        .map((r) => String(r.rule_value)),
      users: rows
        .filter((r) => r.rule_type === MEMBER_USERNAME_RULE)
        .map((r) => String(r.rule_value)),
    }
  }

  async #hydrate(row: EntryRow): Promise<PublicAccessEntry> {
    const { groups, users } = await this.#rules(Number(row.id))
    return {
      key: normaliseUuid(String(row.key)),
      nodeKey: normaliseUuid(String(row.node_key)),
      loginNodeKey: normaliseUuid(String(row.login_key)),
      errorNodeKey: normaliseUuid(String(row.error_key)),
      memberGroupNames: groups,
      memberUserNames: users,
    }
  }

  /** The entry protecting this page itself, if any. */
  async byNodeKey(nodeKey: string): Promise<PublicAccessEntry | undefined> {
    const rows = await this.#db.query<EntryRow>(`${SELECT} WHERE n.unique_id = ?`, [
      normaliseUuid(nodeKey),
    ])
    return rows[0] ? this.#hydrate(rows[0]) : undefined
  }

  /**
   * The entry that governs a page: its own, else the nearest protected
   * ancestor's. `undefined` means the page is open to everyone.
   */
  async entryFor(nodeKey: string): Promise<PublicAccessEntry | undefined> {
    const node = await this.#nodes.byKey(nodeKey)
    if (!node) return undefined
    // `path` is "-1,1050,1063": the ids from the root down. The nearest
    // protected ancestor governs, so the deepest match wins.
    const ids = node.path
      .split(',')
      .map((part) => Number(part))
      .filter((id) => Number.isFinite(id))
    if (ids.length === 0) return undefined
    const holes = ids.map(() => '?').join(', ')
    const rows = await this.#db.query<EntryRow>(
      `${SELECT} WHERE a.node_id IN (${holes}) ORDER BY n.level DESC LIMIT 1`,
      [...ids],
    )
    return rows[0] ? this.#hydrate(rows[0]) : undefined
  }

  /** Whether an ancestor above this page is protected, which the editor shows. */
  async isProtectedByAncestor(nodeKey: string): Promise<boolean> {
    const entry = await this.entryFor(nodeKey)
    return entry !== undefined && entry.nodeKey !== normaliseUuid(nodeKey)
  }

  /**
   * Creates or replaces the entry for a page. `undefined` means one of the
   * three nodes could not be found.
   */
  async save(input: PublicAccessInput): Promise<PublicAccessEntry | undefined> {
    const node = await this.#nodes.byKey(input.nodeKey)
    const login = await this.#nodes.byKey(input.loginNodeKey)
    const error = await this.#nodes.byKey(input.errorNodeKey)
    if (!node || !login || !error) return undefined
    const now = DbDate.toDb(new Date())
    await this.#db.transaction(async (tx) => {
      const existing = await tx.query<{ id: number }>(
        'SELECT id FROM public_access WHERE node_id = ?',
        [node.id],
      )
      let id = existing[0] ? Number(existing[0].id) : undefined
      if (id === undefined) {
        const key = crypto.randomUUID()
        await tx.exec(
          `INSERT INTO public_access (key, node_id, login_node_id, error_node_id, create_date, update_date)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [key, node.id, login.id, error.id, now, now],
        )
        const created = await tx.query<{ id: number }>(
          'SELECT id FROM public_access WHERE node_id = ?',
          [node.id],
        )
        id = Number(created[0]?.id)
      } else {
        await tx.exec(
          'UPDATE public_access SET login_node_id = ?, error_node_id = ?, update_date = ? WHERE id = ?',
          [login.id, error.id, now, id],
        )
        await tx.exec('DELETE FROM public_access_rule WHERE public_access_id = ?', [id])
      }
      for (const [type, names] of [
        [MEMBER_GROUP_RULE, input.memberGroupNames],
        [MEMBER_USERNAME_RULE, input.memberUserNames],
      ] as const) {
        for (const name of new Set(names.filter((value) => value.trim() !== ''))) {
          await tx.exec(
            'INSERT INTO public_access_rule (public_access_id, rule_type, rule_value, create_date) VALUES (?, ?, ?, ?)',
            [id, type, name, now],
          )
        }
      }
    })
    return this.byNodeKey(input.nodeKey)
  }

  async remove(nodeKey: string): Promise<boolean> {
    const node = await this.#nodes.byKey(nodeKey)
    if (!node) return false
    const rows = await this.#db.query<{ id: number }>(
      'SELECT id FROM public_access WHERE node_id = ?',
      [node.id],
    )
    const id = rows[0]?.id
    if (id === undefined) return false
    await this.#db.exec('DELETE FROM public_access_rule WHERE public_access_id = ?', [id])
    await this.#db.exec('DELETE FROM public_access WHERE id = ?', [id])
    return true
  }
}
