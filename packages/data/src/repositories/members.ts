/**
 * Members: content nodes with a sign-in facet.
 *
 * A member is stored exactly as a document is — `node` + `content` +
 * `content_version` + values — so member types, properties and versioning are
 * machinery that already exists. What makes it a member is the `member` row
 * beside it: e-mail, username, password hash, approval and lockout. Group
 * membership is `member_group_member`, and the rules that protect a page name a
 * group by its **name**, so `roles` reads names rather than keys.
 *
 * Passwords arrive already hashed. Hashing belongs to `@bunbraco/auth`, and
 * `data` depends on nothing but types.
 */
import { normaliseUuid, ObjectTypes } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'
import {
  DocumentRepository,
  type DocumentRepositoryOptions,
  type SaveDocumentInput,
} from './documents.ts'
import { NodeRepository } from './nodes.ts'

/** The sign-in facet beside a member's content. */
export interface MemberIdentity {
  email: string
  username: string
  isApproved: boolean
  isLockedOut: boolean
  failedPasswordAttempts: number
  lastLoginDate: Date | undefined
  lastLockoutDate: Date | undefined
  lastPasswordChangeDate: Date | undefined
  emailConfirmedDate: Date | undefined
  /** Rotated whenever a credential changes; a session carrying a stale one is over. */
  securityStamp: string | null
}

export interface MemberRecord extends MemberIdentity {
  key: string
  name: string
  /** Member group names, which is the currency public-access rules deal in. */
  roles: string[]
  contentTypeKey: string
  contentTypeAlias: string
  contentTypeIcon: string | null
}

export interface MemberCredentials extends MemberRecord {
  passwordHash: string | null
  passwordConfig: string | null
}

/** What a create or an update writes to the facet; omitted fields are left alone. */
export interface MemberIdentityInput {
  email: string
  username: string
  isApproved: boolean
  isLockedOut: boolean
  passwordHash?: string | null
  passwordConfig?: string | null
  /** Group **keys**; the membership table stores node ids. */
  groupKeys?: readonly string[]
}

export interface MemberFilter {
  memberTypeKey?: string | null
  memberGroupName?: string | null
  isApproved?: boolean
  isLockedOut?: boolean
  /** Matched against e-mail, username and name. */
  filter?: string
  orderBy?: string
  orderDirection?: 'Ascending' | 'Descending'
  skip: number
  take: number
}

/** Umbraco's `MemberFilterRepository` order columns; anything else is username. */
const ORDER_COLUMNS: Record<string, string> = {
  email: 'm.email',
  name: 'n.text',
  username: 'm.login_name',
  isapproved: 'm.is_approved',
  islockedout: 'm.is_locked_out',
  lastlogindate: 'm.last_login_date',
}

interface MemberRow {
  unique_id: string
  text: string | null
  email: string
  login_name: string
  password: string | null
  password_config: string | null
  security_stamp_token: string | null
  email_confirmed_date: unknown
  failed_password_attempts: number
  is_locked_out: unknown
  is_approved: unknown
  last_login_date: unknown
  last_lockout_date: unknown
  last_password_change_date: unknown
  type_key: string
  type_alias: string
  type_icon: string | null
}

const SELECT = `SELECT n.unique_id, n.text, m.*,
         tn.unique_id AS type_key, ct.alias AS type_alias, ct.icon AS type_icon
    FROM member m
    JOIN node n ON n.id = m.node_id
    JOIN content c ON c.node_id = m.node_id
    JOIN content_type ct ON ct.node_id = c.content_type_id
    JOIN node tn ON tn.id = ct.node_id`

export class MemberRepository {
  #db: Db
  #nodes: NodeRepository
  readonly content: DocumentRepository

  constructor(db: Db, options: DocumentRepositoryOptions = {}) {
    this.#db = db
    this.#nodes = new NodeRepository(db)
    this.content = new DocumentRepository(db, { ...options, kind: 'member' })
  }

  async #rolesOf(nodeId: number): Promise<string[]> {
    const rows = await this.#db.query<{ text: string | null }>(
      `SELECT g.text FROM member_group_member mg JOIN node g ON g.id = mg.member_group_id
        WHERE mg.member_id = ? ORDER BY g.text`,
      [nodeId],
    )
    return rows.map((row) => String(row.text ?? '')).filter(Boolean)
  }

  async #groupKeysOf(nodeId: number): Promise<string[]> {
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT g.unique_id FROM member_group_member mg JOIN node g ON g.id = mg.member_group_id
        WHERE mg.member_id = ? ORDER BY g.text`,
      [nodeId],
    )
    return rows.map((row) => normaliseUuid(String(row.unique_id)))
  }

  async #hydrate(row: MemberRow): Promise<MemberCredentials> {
    const node = await this.#nodes.byKey(normaliseUuid(String(row.unique_id)))
    return {
      key: normaliseUuid(String(row.unique_id)),
      name: row.text ?? '',
      email: row.email,
      username: row.login_name,
      passwordHash: row.password,
      passwordConfig: row.password_config,
      securityStamp: row.security_stamp_token,
      isApproved: fromDbBool(row.is_approved),
      isLockedOut: fromDbBool(row.is_locked_out),
      failedPasswordAttempts: Number(row.failed_password_attempts ?? 0),
      lastLoginDate: DbDate.fromDb(row.last_login_date),
      lastLockoutDate: DbDate.fromDb(row.last_lockout_date),
      lastPasswordChangeDate: DbDate.fromDb(row.last_password_change_date),
      emailConfirmedDate: DbDate.fromDb(row.email_confirmed_date),
      roles: node ? await this.#rolesOf(node.id) : [],
      contentTypeKey: normaliseUuid(String(row.type_key)),
      contentTypeAlias: String(row.type_alias),
      contentTypeIcon: row.type_icon,
    }
  }

  async #one(where: string, parameters: unknown[]): Promise<MemberCredentials | undefined> {
    const rows = await this.#db.query<MemberRow>(`${SELECT} WHERE ${where}`, parameters)
    return rows[0] ? this.#hydrate(rows[0]) : undefined
  }

  byKey(key: string): Promise<MemberCredentials | undefined> {
    return this.#one('n.unique_id = ?', [normaliseUuid(key)])
  }

  byUsername(username: string): Promise<MemberCredentials | undefined> {
    return this.#one('m.login_name = ?', [username])
  }

  byEmail(email: string): Promise<MemberCredentials | undefined> {
    return this.#one('m.email = ?', [email])
  }

  /** The group keys a member belongs to, for the editor's Groups picker. */
  async groupKeys(key: string): Promise<string[]> {
    const node = await this.#nodes.byKey(key)
    return node ? this.#groupKeysOf(node.id) : []
  }

  /** Whether a username or an e-mail is taken by anyone other than `exceptKey`. */
  async taken(field: 'username' | 'email', value: string, exceptKey?: string): Promise<boolean> {
    const column = field === 'username' ? 'm.login_name' : 'm.email'
    const rows = await this.#db.query<{ unique_id: string }>(
      `SELECT n.unique_id FROM member m JOIN node n ON n.id = m.node_id WHERE ${column} = ?`,
      [value],
    )
    return rows.some(
      (row) => !exceptKey || normaliseUuid(String(row.unique_id)) !== normaliseUuid(exceptKey),
    )
  }

  async #writeGroups(nodeId: number, groupKeys: readonly string[]): Promise<void> {
    await this.#db.exec('DELETE FROM member_group_member WHERE member_id = ?', [nodeId])
    for (const key of groupKeys) {
      const group = await this.#nodes.byKey(key)
      if (!group || group.objectType !== ObjectTypes.MemberGroup) continue
      await this.#db.exec(
        'INSERT INTO member_group_member (member_id, member_group_id) VALUES (?, ?)',
        [nodeId, group.id],
      )
    }
  }

  async create(
    content: SaveDocumentInput,
    identity: MemberIdentityInput,
  ): Promise<MemberCredentials> {
    // Members never nest: the parent is always the tree root.
    const created = await this.content.create({ ...content, parentKey: null, templateKey: null })
    const node = await this.#nodes.byKey(created.key)
    if (!node) throw new Error(`the member node ${created.key} vanished while being created`)
    const now = new Date()
    await this.#db.exec(
      `INSERT INTO member (node_id, email, login_name, password, password_config,
                           security_stamp_token, failed_password_attempts, is_locked_out,
                           is_approved, last_password_change_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.id,
        identity.email,
        identity.username,
        identity.passwordHash ?? null,
        identity.passwordConfig ?? null,
        crypto.randomUUID(),
        0,
        this.#db.dialect.boolValue(identity.isLockedOut),
        this.#db.dialect.boolValue(identity.isApproved),
        identity.passwordHash ? DbDate.toDb(now) : null,
      ],
    )
    await this.#writeGroups(node.id, identity.groupKeys ?? [])
    const member = await this.byKey(created.key)
    if (!member) throw new Error(`the member ${created.key} could not be read back`)
    return member
  }

  /**
   * Saves content and facet together. A new password rotates the security
   * stamp, which ends every session the member had.
   */
  async update(
    key: string,
    content: SaveDocumentInput,
    identity: MemberIdentityInput,
  ): Promise<MemberCredentials | undefined> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== ObjectTypes.Member) return undefined
    const updated = await this.content.update({ ...content, key, templateKey: null })
    if (!updated) return undefined
    const now = new Date()
    const sets = ['email = ?', 'login_name = ?', 'is_approved = ?', 'is_locked_out = ?']
    const values: unknown[] = [
      identity.email,
      identity.username,
      this.#db.dialect.boolValue(identity.isApproved),
      this.#db.dialect.boolValue(identity.isLockedOut),
    ]
    if (!identity.isLockedOut) {
      sets.push('failed_password_attempts = ?')
      values.push(0)
    }
    if (identity.passwordHash) {
      sets.push(
        'password = ?',
        'password_config = ?',
        'last_password_change_date = ?',
        'security_stamp_token = ?',
      )
      values.push(
        identity.passwordHash,
        identity.passwordConfig ?? null,
        DbDate.toDb(now),
        crypto.randomUUID(),
      )
    }
    await this.#db.exec(`UPDATE member SET ${sets.join(', ')} WHERE node_id = ?`, [
      ...values,
      node.id,
    ])
    if (identity.groupKeys) await this.#writeGroups(node.id, identity.groupKeys)
    return this.byKey(key)
  }

  /** Records a successful sign-in, clearing whatever failures came before it. */
  async recordLogin(key: string): Promise<void> {
    const node = await this.#nodes.byKey(key)
    if (!node) return
    await this.#db.exec(
      'UPDATE member SET last_login_date = ?, failed_password_attempts = 0 WHERE node_id = ?',
      [DbDate.toDb(new Date()), node.id],
    )
  }

  /**
   * Records a failed sign-in and locks the account out once `maxAttempts` is
   * reached, as Umbraco's lockout does.
   */
  async recordFailedLogin(key: string, maxAttempts: number): Promise<{ lockedOut: boolean }> {
    const node = await this.#nodes.byKey(key)
    if (!node) return { lockedOut: false }
    const rows = await this.#db.query<{ failed_password_attempts: number }>(
      'SELECT failed_password_attempts FROM member WHERE node_id = ?',
      [node.id],
    )
    const attempts = Number(rows[0]?.failed_password_attempts ?? 0) + 1
    const lockedOut = maxAttempts > 0 && attempts >= maxAttempts
    await this.#db.exec(
      `UPDATE member SET failed_password_attempts = ?, is_locked_out = ?${lockedOut ? ', last_lockout_date = ?' : ''}
        WHERE node_id = ?`,
      lockedOut
        ? [attempts, this.#db.dialect.boolValue(true), DbDate.toDb(new Date()), node.id]
        : [attempts, this.#db.dialect.boolValue(false), node.id],
    )
    return { lockedOut }
  }

  async delete(key: string): Promise<boolean> {
    const node = await this.#nodes.byKey(key)
    if (!node || node.objectType !== ObjectTypes.Member) return false
    await this.#db.exec('DELETE FROM member_group_member WHERE member_id = ?', [node.id])
    await this.#db.exec(
      'DELETE FROM external_login_token WHERE external_login_id IN (SELECT id FROM external_login WHERE user_or_member_key = ?)',
      [node.key],
    )
    await this.#db.exec('DELETE FROM external_login WHERE user_or_member_key = ?', [node.key])
    await this.#db.exec('DELETE FROM member WHERE node_id = ?', [node.id])
    return this.content.delete(key)
  }

  /** The Members collection: Umbraco's member filter, with the same columns and defaults. */
  async filter(criteria: MemberFilter): Promise<{ total: number; items: MemberCredentials[] }> {
    const wheres: string[] = []
    const values: unknown[] = []
    if (criteria.memberTypeKey) {
      wheres.push('tn.unique_id = ?')
      values.push(normaliseUuid(criteria.memberTypeKey))
    }
    if (criteria.isApproved !== undefined) {
      wheres.push('m.is_approved = ?')
      values.push(this.#db.dialect.boolValue(criteria.isApproved))
    }
    if (criteria.isLockedOut !== undefined) {
      wheres.push('m.is_locked_out = ?')
      values.push(this.#db.dialect.boolValue(criteria.isLockedOut))
    }
    if (criteria.memberGroupName) {
      wheres.push(
        `EXISTS (SELECT 1 FROM member_group_member mg JOIN node g ON g.id = mg.member_group_id
                  WHERE mg.member_id = m.node_id AND g.text = ?)`,
      )
      values.push(criteria.memberGroupName)
    }
    const text = criteria.filter?.trim()
    if (text) {
      wheres.push('(LOWER(m.email) LIKE ? OR LOWER(m.login_name) LIKE ? OR LOWER(n.text) LIKE ?)')
      const like = `%${text.toLowerCase()}%`
      values.push(like, like, like)
    }
    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const order = ORDER_COLUMNS[(criteria.orderBy ?? '').toLowerCase()] ?? ORDER_COLUMNS.username
    const direction = criteria.orderDirection === 'Descending' ? 'DESC' : 'ASC'

    const counted = await this.#db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM member m
         JOIN node n ON n.id = m.node_id
         JOIN content c ON c.node_id = m.node_id
         JOIN content_type ct ON ct.node_id = c.content_type_id
         JOIN node tn ON tn.id = ct.node_id
       ${where}`,
      values,
    )
    const rows = await this.#db.query<MemberRow>(
      `${SELECT} ${where} ORDER BY ${order} ${direction}, n.id LIMIT ? OFFSET ?`,
      [...values, criteria.take, criteria.skip],
    )
    const items = []
    for (const row of rows) items.push(await this.#hydrate(row))
    return { total: Number(counted[0]?.total ?? 0), items }
  }

  /** The member picker's search: name, username or e-mail, within the types allowed. */
  async search(
    query: string,
    options: { allowedMemberTypeKeys?: readonly string[]; skip: number; take: number },
  ): Promise<{ total: number; items: MemberCredentials[] }> {
    const allowed = options.allowedMemberTypeKeys ?? []
    const page = await this.filter({
      filter: query,
      skip: 0,
      take: Number.MAX_SAFE_INTEGER,
      orderBy: 'name',
    })
    const items =
      allowed.length === 0
        ? page.items
        : page.items.filter((member) =>
            allowed.map(normaliseUuid).includes(normaliseUuid(member.contentTypeKey)),
          )
    return {
      total: items.length,
      items: items.slice(options.skip, options.skip + options.take),
    }
  }

  /** Several members by key, in the order asked, for the item lookup. */
  async items(keys: readonly string[]): Promise<MemberCredentials[]> {
    const found = []
    for (const key of keys) {
      const member = await this.byKey(key)
      if (member) found.push(member)
    }
    return found
  }
}
