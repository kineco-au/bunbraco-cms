/**
 * Backoffice users and user groups: accounts, membership, sections, languages,
 * start nodes and permission verbs. Password hashing and the rules about who
 * may change what live with the callers; this is storage.
 */
import { type GroupGrant, normaliseUuid, type StartNodePath } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { DbDate, fromDbBool } from '../dialect.ts'
import { mapNode, type NodeRow } from './nodes.ts'

export type UserKind = 'Default' | 'Api'
export type StartNodeTree = 'document' | 'media' | 'element'

/** Umbraco's `UserStartNodeDto.StartNodeTypeValue`. */
const START_NODE_TYPE: Record<StartNodeTree, number> = { document: 1, media: 2, element: 3 }
const ROOT_ID = -1

/** A user's own start nodes in one tree: root access, and/or specific nodes by key. */
export interface StartNodeSelection {
  root: boolean
  keys: string[]
}

/** A group's start node in one tree: the root, one node, or none. */
export interface GroupStartNode {
  root: boolean
  key: string | null
}

export interface UserRecord {
  id: number
  key: string
  name: string
  userName: string
  email: string
  languageIsoCode: string | null
  avatar: string | null
  kind: UserKind
  isApproved: boolean
  isLockedOut: boolean
  failedLoginAttempts: number
  lastLoginDate: Date | undefined
  lastLockoutDate: Date | undefined
  lastPasswordChangeDate: Date | undefined
  invitedDate: Date | undefined
  createDate: Date
  updateDate: Date
  groupKeys: string[]
  startNodes: Record<StartNodeTree, StartNodeSelection>
}

export type UserState = 'Active' | 'Disabled' | 'LockedOut' | 'Invited' | 'Inactive'

/** Umbraco's `User.UserState`. */
export function userState(user: UserRecord): UserState {
  if (!user.lastLoginDate && !user.isApproved && user.invitedDate) return 'Invited'
  if (user.isLockedOut) return 'LockedOut'
  if (!user.isApproved) return 'Disabled'
  if (!user.lastLoginDate) return 'Inactive'
  return 'Active'
}

export interface GranularPermission {
  /** The node (or property type) the verb applies to; null for a context-only verb. */
  key: string | null
  permission: string
  context: string
}

export interface UserGroupRecord {
  id: number
  key: string
  alias: string
  name: string
  description: string | null
  icon: string | null
  /** Stored application aliases (`content`), or a package section's alias as given. */
  sections: string[]
  languages: string[]
  hasAccessToAllLanguages: boolean
  startNodes: Record<StartNodeTree, GroupStartNode>
  permissions: string[]
  granular: GranularPermission[]
}

export interface UserGroupInput {
  key: string
  alias: string
  name: string
  description: string | null
  icon: string | null
  sections: string[]
  languages: string[]
  hasAccessToAllLanguages: boolean
  startNodes: Record<StartNodeTree, GroupStartNode>
  permissions: string[]
  granular: GranularPermission[]
}

export interface UserInput {
  key: string
  name: string
  userName: string
  email: string
  kind: UserKind
  groupKeys: string[]
  languageIsoCode: string | null
  /** Invited users are created unapproved, with an invitation date. */
  invited?: boolean
}

export interface UserUpdate {
  name: string
  userName: string
  email: string
  languageIsoCode: string | null
  groupKeys: string[]
  startNodes: Record<StartNodeTree, StartNodeSelection>
}

/** What access checks need about a user: their groups' grants and every start node's position. */
export interface UserAccessData {
  groups: GroupGrant[]
  languages: string[]
  hasAccessToAllLanguages: boolean
  groupStartNodes: Record<StartNodeTree, StartNodePath[]>
  userStartNodes: Record<StartNodeTree, StartNodePath[]>
}

const USER_COLUMNS = `id, key, user_name, login, email, language, avatar, kind, is_approved,
  is_locked_out, failed_login_attempts, last_login_date, last_lockout_date,
  last_password_change_date, invited_date, create_date, update_date`

const TREES: StartNodeTree[] = ['document', 'media', 'element']

const inList = (values: readonly unknown[]) => values.map(() => '?').join(', ')

export class UserRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async #nodeKeys(ids: readonly number[]): Promise<Map<number, NodeRow>> {
    const wanted = [...new Set(ids.filter((id) => id > 0))]
    if (wanted.length === 0) return new Map()
    const rows = await this.#db.query(
      `SELECT id, unique_id, parent_id, level, path, sort_order, trashed, text, node_object_type, create_date
       FROM node WHERE id IN (${inList(wanted)})`,
      wanted,
    )
    return new Map(rows.map((row) => [Number(row.id), mapNode(row)]))
  }

  /** Node ids for keys; undefined when any key is not a node. */
  async nodeIds(keys: readonly string[]): Promise<Map<string, number> | undefined> {
    if (keys.length === 0) return new Map()
    const wanted = keys.map(normaliseUuid)
    const rows = await this.#db.query<{ id: number; unique_id: string }>(
      `SELECT id, unique_id FROM node WHERE unique_id IN (${inList(wanted)})`,
      wanted,
    )
    const map = new Map(rows.map((r) => [normaliseUuid(String(r.unique_id)), Number(r.id)]))
    return wanted.every((k) => map.has(k)) ? map : undefined
  }

  async #hydrate(rows: Record<string, unknown>[]): Promise<UserRecord[]> {
    if (rows.length === 0) return []
    const ids = rows.map((r) => Number(r.id))
    const memberships = await this.#db.query<{ user_id: number; key: string }>(
      `SELECT m.user_id, g.key FROM user_group_member m JOIN user_group g ON g.id = m.user_group_id
       WHERE m.user_id IN (${inList(ids)}) ORDER BY g.id`,
      ids,
    )
    const starts = await this.#db.query<{
      user_id: number
      start_node: number
      start_node_type: number
    }>(
      `SELECT user_id, start_node, start_node_type FROM user_start_node WHERE user_id IN (${inList(ids)})`,
      ids,
    )
    const nodes = await this.#nodeKeys(starts.map((s) => Number(s.start_node)))
    return rows.map((row) => {
      const id = Number(row.id)
      const startNodes = Object.fromEntries(
        TREES.map((tree) => {
          const mine = starts.filter(
            (s) => Number(s.user_id) === id && Number(s.start_node_type) === START_NODE_TYPE[tree],
          )
          return [
            tree,
            {
              root: mine.some((s) => Number(s.start_node) === ROOT_ID),
              keys: mine.flatMap((s) => {
                const node = nodes.get(Number(s.start_node))
                return node ? [node.key] : []
              }),
            },
          ]
        }),
      ) as Record<StartNodeTree, StartNodeSelection>
      return {
        id,
        key: normaliseUuid(String(row.key)),
        name: String(row.user_name),
        userName: String(row.login),
        email: String(row.email),
        languageIsoCode: (row.language as string | null) ?? null,
        avatar: (row.avatar as string | null) ?? null,
        kind: Number(row.kind) === 1 ? 'Api' : 'Default',
        isApproved: fromDbBool(row.is_approved),
        isLockedOut: fromDbBool(row.is_locked_out),
        failedLoginAttempts: Number(row.failed_login_attempts ?? 0),
        lastLoginDate: DbDate.fromDb(row.last_login_date),
        lastLockoutDate: DbDate.fromDb(row.last_lockout_date),
        lastPasswordChangeDate: DbDate.fromDb(row.last_password_change_date),
        invitedDate: DbDate.fromDb(row.invited_date),
        createDate: DbDate.fromDb(row.create_date) ?? new Date(0),
        updateDate: DbDate.fromDb(row.update_date) ?? new Date(0),
        groupKeys: memberships
          .filter((m) => Number(m.user_id) === id)
          .map((m) => normaliseUuid(String(m.key))),
        startNodes,
      }
    })
  }

  async all(): Promise<UserRecord[]> {
    return this.#hydrate(
      await this.#db.query(`SELECT ${USER_COLUMNS} FROM user_account ORDER BY id`),
    )
  }

  async byKeys(keys: readonly string[]): Promise<UserRecord[]> {
    const wanted = keys.filter((k) => /^[0-9a-f-]{32,36}$/i.test(k)).map(normaliseUuid)
    if (wanted.length === 0) return []
    return this.#hydrate(
      await this.#db.query(
        `SELECT ${USER_COLUMNS} FROM user_account WHERE key IN (${inList(wanted)}) ORDER BY id`,
        wanted,
      ),
    )
  }

  async byKey(key: string): Promise<UserRecord | undefined> {
    return (await this.byKeys([key]))[0]
  }

  async byId(id: number): Promise<UserRecord | undefined> {
    return (
      await this.#hydrate(
        await this.#db.query(`SELECT ${USER_COLUMNS} FROM user_account WHERE id = ?`, [id]),
      )
    )[0]
  }

  async byUserName(userName: string): Promise<UserRecord | undefined> {
    return (
      await this.#hydrate(
        await this.#db.query(`SELECT ${USER_COLUMNS} FROM user_account WHERE login = ?`, [
          userName,
        ]),
      )
    )[0]
  }

  async byEmail(email: string): Promise<UserRecord | undefined> {
    return (
      await this.#hydrate(
        await this.#db.query(`SELECT ${USER_COLUMNS} FROM user_account WHERE email = ?`, [email]),
      )
    )[0]
  }

  async #groupIds(keys: readonly string[]): Promise<number[] | undefined> {
    if (keys.length === 0) return []
    const wanted = keys.map(normaliseUuid)
    const rows = await this.#db.query<{ id: number }>(
      `SELECT id FROM user_group WHERE key IN (${inList(wanted)})`,
      wanted,
    )
    return rows.length === new Set(wanted).size ? rows.map((r) => Number(r.id)) : undefined
  }

  async #setGroups(userId: number, groupIds: readonly number[]): Promise<void> {
    await this.#db.exec('DELETE FROM user_group_member WHERE user_id = ?', [userId])
    for (const groupId of new Set(groupIds))
      await this.#db.exec('INSERT INTO user_group_member (user_id, user_group_id) VALUES (?, ?)', [
        userId,
        groupId,
      ])
  }

  /** Creates the user; undefined when a group does not exist. */
  async create(input: UserInput): Promise<UserRecord | undefined> {
    return this.#db.transaction(async (tx) => {
      const repo = new UserRepository(tx)
      const groupIds = await repo.#groupIds(input.groupKeys)
      if (!groupIds) return undefined
      const now = DbDate.toDb(new Date())
      const bool = (v: boolean) => tx.dialect.boolValue(v)
      await tx.exec(
        `INSERT INTO user_account
           (key, user_name, login, email, security_stamp, language, kind, is_locked_out, is_approved,
            failed_login_attempts, invited_date, create_date, update_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normaliseUuid(input.key),
          input.name,
          input.userName,
          input.email,
          crypto.randomUUID(),
          input.languageIsoCode,
          input.kind === 'Api' ? 1 : 0,
          bool(false),
          bool(!input.invited),
          0,
          input.invited ? now : null,
          now,
          now,
        ],
      )
      const created = await repo.byKey(input.key)
      if (!created) return undefined
      await repo.#setGroups(created.id, groupIds)
      return repo.byKey(input.key)
    })
  }

  /** 'missing-group' or 'missing-node' when a reference does not resolve. */
  async update(
    key: string,
    change: UserUpdate,
  ): Promise<'updated' | 'not-found' | 'missing-group' | Exclude<StartNodeTree, never>> {
    return this.#db.transaction(async (tx) => {
      const repo = new UserRepository(tx)
      const user = await repo.byKey(key)
      if (!user) return 'not-found'
      const groupIds = await repo.#groupIds(change.groupKeys)
      if (!groupIds) return 'missing-group'
      const nodeIds: Array<{ tree: StartNodeTree; id: number }> = []
      for (const tree of TREES) {
        const selection = change.startNodes[tree]
        if (selection.root) nodeIds.push({ tree, id: ROOT_ID })
        const ids = await repo.nodeIds(selection.keys)
        if (!ids) return tree
        for (const id of ids.values()) nodeIds.push({ tree, id })
      }
      await tx.exec(
        'UPDATE user_account SET user_name = ?, login = ?, email = ?, language = ?, update_date = ? WHERE id = ?',
        [
          change.name,
          change.userName,
          change.email,
          change.languageIsoCode,
          DbDate.toDb(new Date()),
          user.id,
        ],
      )
      await repo.#setGroups(user.id, groupIds)
      await tx.exec('DELETE FROM user_start_node WHERE user_id = ?', [user.id])
      for (const { tree, id } of nodeIds)
        await tx.exec(
          'INSERT INTO user_start_node (user_id, start_node, start_node_type) VALUES (?, ?, ?)',
          [user.id, id, START_NODE_TYPE[tree]],
        )
      return 'updated'
    })
  }

  async setGroups(userKeys: readonly string[], groupKeys: readonly string[]): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const repo = new UserRepository(tx)
      const groupIds = await repo.#groupIds(groupKeys)
      if (!groupIds) return false
      for (const user of await repo.byKeys(userKeys)) await repo.#setGroups(user.id, groupIds)
      return true
    })
  }

  async addToGroup(groupKey: string, userKeys: readonly string[]): Promise<void> {
    const [groupId] = (await this.#groupIds([groupKey])) ?? []
    if (groupId === undefined) return
    for (const user of await this.byKeys(userKeys))
      if (!(await this.#groupIds(user.groupKeys))?.includes(groupId))
        await this.#db.exec(
          'INSERT INTO user_group_member (user_id, user_group_id) VALUES (?, ?)',
          [user.id, groupId],
        )
  }

  async removeFromGroup(groupKey: string, userKeys: readonly string[]): Promise<void> {
    const [groupId] = (await this.#groupIds([groupKey])) ?? []
    if (groupId === undefined) return
    for (const user of await this.byKeys(userKeys))
      await this.#db.exec('DELETE FROM user_group_member WHERE user_id = ? AND user_group_id = ?', [
        user.id,
        groupId,
      ])
  }

  async setApproved(keys: readonly string[], approved: boolean): Promise<void> {
    for (const user of await this.byKeys(keys))
      await this.#db.exec('UPDATE user_account SET is_approved = ?, update_date = ? WHERE id = ?', [
        this.#db.dialect.boolValue(approved),
        DbDate.toDb(new Date()),
        user.id,
      ])
  }

  async unlock(keys: readonly string[]): Promise<void> {
    for (const user of await this.byKeys(keys))
      await this.#db.exec(
        'UPDATE user_account SET is_locked_out = ?, failed_login_attempts = 0, update_date = ? WHERE id = ?',
        [this.#db.dialect.boolValue(false), DbDate.toDb(new Date()), user.id],
      )
  }

  async setLanguage(key: string, isoCode: string): Promise<void> {
    await this.#db.exec('UPDATE user_account SET language = ?, update_date = ? WHERE key = ?', [
      isoCode,
      DbDate.toDb(new Date()),
      normaliseUuid(key),
    ])
  }

  async setAvatar(key: string, avatar: string | null): Promise<void> {
    await this.#db.exec('UPDATE user_account SET avatar = ?, update_date = ? WHERE key = ?', [
      avatar,
      DbDate.toDb(new Date()),
      normaliseUuid(key),
    ])
  }

  async passwordHash(key: string): Promise<string | null> {
    const rows = await this.#db.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM user_account WHERE key = ?',
      [normaliseUuid(key)],
    )
    return rows[0]?.password_hash ?? null
  }

  /** An accepted invitation: the user becomes approved and gets their password. */
  async approve(key: string): Promise<void> {
    await this.setApproved([key], true)
  }

  /** Deletes the user and everything that is only theirs. */
  async delete(key: string): Promise<void> {
    const user = await this.byKey(key)
    if (!user) return
    await this.#db.transaction(async (tx) => {
      for (const table of [
        'user_group_member',
        'user_start_node',
        'user_data',
        'user_token',
        'user_client_credential',
        'user_notification',
        'auth_code',
        'auth_token',
        'user_login_session',
      ])
        await tx.exec(`DELETE FROM ${table} WHERE user_id = ?`, [user.id])
      await tx.exec('DELETE FROM user_account WHERE id = ?', [user.id])
    })
  }

  /** Stores a single-use token's hash for `purpose`, replacing any earlier one. */
  async saveToken(
    userId: number,
    purpose: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.#db.exec('DELETE FROM user_token WHERE user_id = ? AND purpose = ?', [
      userId,
      purpose,
    ])
    await this.#db.exec(
      'INSERT INTO user_token (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)',
      [tokenHash, userId, purpose, DbDate.toDb(expiresAt)],
    )
  }

  /** Whether the token is the user's live one for `purpose`; consuming removes it. */
  async checkToken(
    userId: number,
    purpose: string,
    tokenHash: string,
    consume: boolean,
    now = new Date(),
  ): Promise<boolean> {
    const rows = await this.#db.query<{ expires_at: unknown }>(
      'SELECT expires_at FROM user_token WHERE token_hash = ? AND user_id = ? AND purpose = ?',
      [tokenHash, userId, purpose],
    )
    const expires = DbDate.fromDb(rows[0]?.expires_at)
    if (!expires || expires.getTime() < now.getTime()) return false
    if (consume) await this.#db.exec('DELETE FROM user_token WHERE token_hash = ?', [tokenHash])
    return true
  }

  async clientCredentials(userId: number): Promise<string[]> {
    const rows = await this.#db.query<{ client_id: string }>(
      'SELECT client_id FROM user_client_credential WHERE user_id = ? ORDER BY client_id',
      [userId],
    )
    return rows.map((r) => String(r.client_id))
  }

  async clientCredentialOwner(
    clientId: string,
  ): Promise<{ userId: number; secretHash: string } | undefined> {
    const rows = await this.#db.query<{ user_id: number; secret_hash: string }>(
      'SELECT user_id, secret_hash FROM user_client_credential WHERE client_id = ?',
      [clientId],
    )
    return rows[0]
      ? { userId: Number(rows[0].user_id), secretHash: String(rows[0].secret_hash) }
      : undefined
  }

  async addClientCredential(
    userId: number,
    clientId: string,
    secretHash: string,
  ): Promise<boolean> {
    if (await this.clientCredentialOwner(clientId)) return false
    await this.#db.exec(
      'INSERT INTO user_client_credential (client_id, user_id, secret_hash, create_date) VALUES (?, ?, ?, ?)',
      [clientId, userId, secretHash, DbDate.toDb(new Date())],
    )
    return true
  }

  async removeClientCredential(userId: number, clientId: string): Promise<void> {
    await this.#db.exec('DELETE FROM user_client_credential WHERE user_id = ? AND client_id = ?', [
      userId,
      clientId,
    ])
  }

  /** The user's groups' grants, languages and start node positions, for access checks. */
  async access(userId: number): Promise<UserAccessData> {
    const user = await this.byId(userId)
    const groups = user ? await new UserGroupRepository(this.#db).byKeys(user.groupKeys) : []
    const nodeIds: Record<string, number> = {}
    for (const group of groups)
      for (const tree of TREES) {
        const key = group.startNodes[tree].key
        if (key) nodeIds[key] = 0
      }
    for (const tree of TREES) for (const key of user?.startNodes[tree].keys ?? []) nodeIds[key] = 0
    const keys = Object.keys(nodeIds)
    const rows =
      keys.length > 0
        ? await this.#db.query(
            `SELECT id, unique_id, parent_id, level, path, sort_order, trashed, text, node_object_type, create_date
             FROM node WHERE unique_id IN (${inList(keys)})`,
            keys,
          )
        : []
    const byKey = new Map(rows.map((r) => [normaliseUuid(String(r.unique_id)), mapNode(r)]))
    const chains = await this.#chains([...byKey.values()])
    const pathOf = (key: string): StartNodePath | undefined => {
      const node = byKey.get(key)
      return node && !node.trashed ? chains.get(node.id) : undefined
    }
    const positions = (selection: { root: boolean; keys: readonly string[] }): StartNodePath[] => [
      ...(selection.root ? [[] as StartNodePath] : []),
      ...selection.keys.flatMap((key) => {
        const path = pathOf(key)
        return path ? [path] : []
      }),
    ]
    const languageRows =
      groups.length > 0
        ? await this.#db.query<{ iso_code: string }>(
            `SELECT DISTINCT l.iso_code FROM user_group_language gl
             JOIN language l ON l.id = gl.language_id
             WHERE gl.user_group_id IN (${inList(groups.map((g) => g.id))})`,
            groups.map((g) => g.id),
          )
        : []
    return {
      groups: groups.map((group) => {
        const granular = new Map<string, string[]>()
        for (const row of group.granular)
          if (row.context === 'Document' && row.key) {
            const verbs = granular.get(row.key) ?? []
            if (row.permission) verbs.push(row.permission)
            granular.set(row.key, verbs)
          }
        return { key: group.key, alias: group.alias, defaults: group.permissions, granular }
      }),
      languages: languageRows.map((l) => String(l.iso_code)),
      hasAccessToAllLanguages: groups.some((g) => g.hasAccessToAllLanguages),
      groupStartNodes: Object.fromEntries(
        TREES.map((tree) => [
          tree,
          groups.flatMap((g) =>
            positions({
              root: g.startNodes[tree].root,
              keys: g.startNodes[tree].key ? [g.startNodes[tree].key as string] : [],
            }),
          ),
        ]),
      ) as Record<StartNodeTree, StartNodePath[]>,
      userStartNodes: Object.fromEntries(
        TREES.map((tree) => [tree, user ? positions(user.startNodes[tree]) : []]),
      ) as Record<StartNodeTree, StartNodePath[]>,
    }
  }

  /** Each node's ancestor keys then its own, root first. */
  async #chains(nodes: readonly NodeRow[]): Promise<Map<number, string[]>> {
    const ancestorIds = nodes.flatMap((n) =>
      n.path
        .split(',')
        .map(Number)
        .filter((id) => id > 0),
    )
    const all = await this.#nodeKeys(ancestorIds)
    return new Map(
      nodes.map((n) => [
        n.id,
        n.path
          .split(',')
          .map(Number)
          .filter((id) => id > 0)
          .flatMap((id) => {
            const node = all.get(id)
            return node ? [node.key] : []
          }),
      ]),
    )
  }
}

const GROUP_COLUMNS = `id, key, alias, name, description, icon, has_access_to_all_languages,
  start_content_id, start_media_id, start_element_id`

const GROUP_START_COLUMN: Record<StartNodeTree, string> = {
  document: 'start_content_id',
  media: 'start_media_id',
  element: 'start_element_id',
}

export class UserGroupRepository {
  #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async #hydrate(rows: Record<string, unknown>[]): Promise<UserGroupRecord[]> {
    if (rows.length === 0) return []
    const ids = rows.map((r) => Number(r.id))
    const keys = rows.map((r) => normaliseUuid(String(r.key)))
    const sections = await this.#db.query<{ user_group_id: number; app_alias: string }>(
      `SELECT user_group_id, app_alias FROM user_group_section WHERE user_group_id IN (${inList(ids)})`,
      ids,
    )
    const languages = await this.#db.query<{ user_group_id: number; iso_code: string }>(
      `SELECT gl.user_group_id, l.iso_code FROM user_group_language gl
       JOIN language l ON l.id = gl.language_id WHERE gl.user_group_id IN (${inList(ids)})
       ORDER BY l.iso_code`,
      ids,
    )
    const permissions = await this.#db.query<{ user_group_key: string; permission: string }>(
      `SELECT user_group_key, permission FROM user_group_permission
       WHERE user_group_key IN (${inList(keys)}) ORDER BY id`,
      keys,
    )
    const granular = await this.#db.query<{
      user_group_key: string
      unique_id: string | null
      permission: string
      context: string
    }>(
      `SELECT user_group_key, unique_id, permission, context FROM user_group_granular_permission
       WHERE user_group_key IN (${inList(keys)}) ORDER BY id`,
      keys,
    )
    const startIds = rows.flatMap((r) =>
      TREES.map((tree) => Number(r[GROUP_START_COLUMN[tree]] ?? 0)),
    )
    const nodes = new Map<number, string>()
    const positive = [...new Set(startIds.filter((id) => id > 0))]
    if (positive.length > 0)
      for (const row of await this.#db.query<{ id: number; unique_id: string }>(
        `SELECT id, unique_id FROM node WHERE id IN (${inList(positive)})`,
        positive,
      ))
        nodes.set(Number(row.id), normaliseUuid(String(row.unique_id)))

    return rows.map((row) => {
      const id = Number(row.id)
      const key = normaliseUuid(String(row.key))
      const start = (tree: StartNodeTree): GroupStartNode => {
        const value = row[GROUP_START_COLUMN[tree]]
        if (value === null || value === undefined) return { root: false, key: null }
        const nodeId = Number(value)
        if (nodeId === ROOT_ID) return { root: true, key: null }
        return { root: false, key: nodes.get(nodeId) ?? null }
      }
      return {
        id,
        key,
        alias: String(row.alias),
        name: String(row.name),
        description: (row.description as string | null) ?? null,
        icon: (row.icon as string | null) ?? null,
        sections: sections
          .filter((s) => Number(s.user_group_id) === id)
          .map((s) => String(s.app_alias)),
        languages: languages
          .filter((l) => Number(l.user_group_id) === id)
          .map((l) => String(l.iso_code)),
        hasAccessToAllLanguages: fromDbBool(row.has_access_to_all_languages),
        startNodes: {
          document: start('document'),
          media: start('media'),
          element: start('element'),
        },
        permissions: permissions
          .filter((p) => normaliseUuid(String(p.user_group_key)) === key)
          .map((p) => String(p.permission)),
        granular: granular
          .filter((g) => normaliseUuid(String(g.user_group_key)) === key)
          .map((g) => ({
            key: g.unique_id ? normaliseUuid(String(g.unique_id)) : null,
            permission: String(g.permission),
            context: String(g.context),
          })),
      }
    })
  }

  async all(): Promise<UserGroupRecord[]> {
    return this.#hydrate(
      await this.#db.query(`SELECT ${GROUP_COLUMNS} FROM user_group ORDER BY name`),
    )
  }

  async byKeys(keys: readonly string[]): Promise<UserGroupRecord[]> {
    const wanted = keys.filter((k) => /^[0-9a-f-]{32,36}$/i.test(k)).map(normaliseUuid)
    if (wanted.length === 0) return []
    return this.#hydrate(
      await this.#db.query(
        `SELECT ${GROUP_COLUMNS} FROM user_group WHERE key IN (${inList(wanted)}) ORDER BY name`,
        wanted,
      ),
    )
  }

  async byKey(key: string): Promise<UserGroupRecord | undefined> {
    return (await this.byKeys([key]))[0]
  }

  async byAlias(alias: string): Promise<UserGroupRecord | undefined> {
    return (
      await this.#hydrate(
        await this.#db.query(`SELECT ${GROUP_COLUMNS} FROM user_group WHERE alias = ?`, [alias]),
      )
    )[0]
  }

  /** How many users each group has, by group key. */
  async memberCounts(): Promise<Map<string, number>> {
    const rows = await this.#db.query<{ key: string; n: number }>(
      `SELECT g.key, COUNT(m.user_id) AS n FROM user_group g
       LEFT JOIN user_group_member m ON m.user_group_id = g.id GROUP BY g.key`,
    )
    return new Map(rows.map((r) => [normaliseUuid(String(r.key)), Number(r.n)]))
  }

  /**
   * Creates or replaces the group. 'missing-node' names the tree whose start
   * node does not exist; 'missing-language' a language that does not.
   */
  async save(
    input: UserGroupInput,
  ): Promise<'saved' | 'missing-language' | { missingNode: StartNodeTree }> {
    return this.#db.transaction(async (tx) => {
      const users = new UserRepository(tx)
      const starts: Record<StartNodeTree, number | null> = {
        document: null,
        media: null,
        element: null,
      }
      for (const tree of TREES) {
        const start = input.startNodes[tree]
        if (start.root) starts[tree] = ROOT_ID
        else if (start.key) {
          const ids = await users.nodeIds([start.key])
          if (!ids) return { missingNode: tree }
          starts[tree] = ids.get(normaliseUuid(start.key)) ?? null
        }
      }
      const languageIds: number[] = []
      if (input.languages.length > 0) {
        const rows = await tx.query<{ id: number; iso_code: string }>(
          `SELECT id, iso_code FROM language WHERE iso_code IN (${inList(input.languages)})`,
          input.languages,
        )
        if (rows.length !== new Set(input.languages).size) return 'missing-language'
        languageIds.push(...rows.map((r) => Number(r.id)))
      }
      const key = normaliseUuid(input.key)
      const now = DbDate.toDb(new Date())
      const bool = (v: boolean) => tx.dialect.boolValue(v)
      const existing = await new UserGroupRepository(tx).byKey(key)
      if (existing)
        await tx.exec(
          `UPDATE user_group SET alias = ?, name = ?, description = ?, icon = ?, has_access_to_all_languages = ?,
             start_content_id = ?, start_media_id = ?, start_element_id = ?, update_date = ? WHERE id = ?`,
          [
            input.alias,
            input.name,
            input.description,
            input.icon,
            bool(input.hasAccessToAllLanguages),
            starts.document,
            starts.media,
            starts.element,
            now,
            existing.id,
          ],
        )
      else
        await tx.exec(
          `INSERT INTO user_group (key, alias, name, description, icon, has_access_to_all_languages,
             start_content_id, start_media_id, start_element_id, create_date, update_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            key,
            input.alias,
            input.name,
            input.description,
            input.icon,
            bool(input.hasAccessToAllLanguages),
            starts.document,
            starts.media,
            starts.element,
            now,
            now,
          ],
        )
      const id = Number(
        (await tx.query<{ id: number }>('SELECT id FROM user_group WHERE key = ?', [key]))[0]?.id,
      )
      await tx.exec('DELETE FROM user_group_section WHERE user_group_id = ?', [id])
      for (const section of new Set(input.sections))
        await tx.exec('INSERT INTO user_group_section (user_group_id, app_alias) VALUES (?, ?)', [
          id,
          section,
        ])
      await tx.exec('DELETE FROM user_group_language WHERE user_group_id = ?', [id])
      for (const languageId of languageIds)
        await tx.exec(
          'INSERT INTO user_group_language (user_group_id, language_id) VALUES (?, ?)',
          [id, languageId],
        )
      await tx.exec('DELETE FROM user_group_permission WHERE user_group_key = ?', [key])
      for (const permission of new Set(input.permissions))
        await tx.exec(
          'INSERT INTO user_group_permission (user_group_key, permission) VALUES (?, ?)',
          [key, permission],
        )
      await tx.exec('DELETE FROM user_group_granular_permission WHERE user_group_key = ?', [key])
      for (const row of input.granular)
        await tx.exec(
          'INSERT INTO user_group_granular_permission (user_group_key, unique_id, permission, context) VALUES (?, ?, ?, ?)',
          [key, row.key ? normaliseUuid(row.key) : null, row.permission, row.context],
        )
      return 'saved'
    })
  }

  async delete(key: string): Promise<void> {
    const group = await this.byKey(key)
    if (!group) return
    await this.#db.transaction(async (tx) => {
      await tx.exec('DELETE FROM user_group_member WHERE user_group_id = ?', [group.id])
      await tx.exec('DELETE FROM user_group_section WHERE user_group_id = ?', [group.id])
      await tx.exec('DELETE FROM user_group_language WHERE user_group_id = ?', [group.id])
      await tx.exec('DELETE FROM user_group_permission WHERE user_group_key = ?', [group.key])
      await tx.exec('DELETE FROM user_group_granular_permission WHERE user_group_key = ?', [
        group.key,
      ])
      await tx.exec('DELETE FROM user_group WHERE id = ?', [group.id])
    })
  }
}
