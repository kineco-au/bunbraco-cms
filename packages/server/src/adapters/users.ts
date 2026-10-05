/**
 * Users, user groups and user data over the identity tables, with Umbraco's
 * rules about who may see and change whom: only admins see or touch admins,
 * a non-admin may only hand out groups and start nodes they hold themselves,
 * and nobody deletes or disables their own account.
 */
import type {
  NodeLookup,
  Principal,
  Result,
  UserDataPort,
  UserGroupInput,
  UserGroupPort,
  UserGroupResponse,
  UserGroupStatus,
  UserPort,
  UserResponse,
  UserStatus,
} from '@bunbraco/api-management'
import {
  generateToken,
  hashPassword,
  hashToken,
  passwordConfigJson,
  verifyPassword,
} from '@bunbraco/auth'
import {
  DEFAULT_PASSWORD_CONFIGURATION,
  generateUserPassword,
  hasPathAccess,
  isValidEmail,
  isValidPassword,
  normaliseUuid,
  type Page,
  permissionsForPath,
  type StartNodes,
  sectionAppAlias,
  sectionName,
} from '@bunbraco/core'
import {
  type Db,
  DbDate,
  type GranularPermission,
  SUPER_USER_KEY,
  UserDataRepository,
  UserGroupRepository,
  type UserRecord,
  UserRepository,
  userState,
} from '@bunbraco/data'
import { loadAccess } from '../access.ts'
import type { BunbracoConfig } from '../config.ts'
import type { MediaFileStore } from '../media-files.ts'

const INVITE_HOURS = 72
const RESET_HOURS = 24
const AVATAR_SIZES = [30, 60, 90, 150, 300]
const AVATAR_EXTENSIONS = new Set(['jpeg', 'jpg', 'gif', 'bmp', 'png', 'tiff', 'tif', 'webp'])
/** Umbraco's system groups: their alias is fixed and they cannot be deleted. */
const SYSTEM_GROUPS = new Set(['admin', 'sensitiveData', 'translator'])
/**
 * Namespaces an API user's client ID away from the backoffice client's own,
 * which is `umbraco-back-office` and stays as it is — the vendored client sends
 * it. Migration 020 renamed the credentials that carried the old prefix.
 */
const CLIENT_ID_PREFIX = 'bunbraco-back-office-'
const ISO_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i

export function avatarUrls(avatar: string | null): string[] {
  return avatar ? AVATAR_SIZES.map((s) => `${avatar}?rmode=crop&width=${s}&height=${s}`) : []
}

const iso = (date: Date | undefined) => (date ? date.toISOString() : null)
const refs = (keys: readonly string[]) => keys.map((id) => ({ id }))

function toUserResponse(user: UserRecord, adminKey: string | undefined): UserResponse {
  return {
    id: user.key,
    languageIsoCode: user.languageIsoCode,
    documentStartNodeIds: refs(user.startNodes.document.keys),
    hasDocumentRootAccess: user.startNodes.document.root,
    mediaStartNodeIds: refs(user.startNodes.media.keys),
    hasMediaRootAccess: user.startNodes.media.root,
    elementStartNodeIds: refs(user.startNodes.element.keys),
    hasElementRootAccess: user.startNodes.element.root,
    avatarUrls: avatarUrls(user.avatar),
    state: userState(user),
    failedLoginAttempts: user.failedLoginAttempts,
    createDate: user.createDate.toISOString(),
    updateDate: user.updateDate.toISOString(),
    lastLoginDate: iso(user.lastLoginDate),
    lastLockoutDate: iso(user.lastLockoutDate),
    lastPasswordChangeDate: iso(user.lastPasswordChangeDate),
    isAdmin: adminKey !== undefined && user.groupKeys.includes(adminKey),
    kind: user.kind,
    email: user.email,
    userName: user.userName,
    name: user.name,
    userGroupIds: refs(user.groupKeys),
  }
}

type Tree = 'document' | 'media' | 'element'

export interface UserPortOptions {
  config: Pick<
    BunbracoConfig,
    'usernameIsEmail' | 'applicationUrl' | 'sendUserLink' | 'allowPasswordReset' | 'backOfficePath'
  >
  mediaFiles: MediaFileStore
  nodes: NodeLookup
  /** Signs a user out everywhere, as a password change set by someone else does. */
  endSessions: (userId: number) => Promise<void>
}

export function createUserPorts(
  db: Db,
  options: UserPortOptions,
): { users: UserPort; groups: UserGroupPort; userData: UserDataPort } {
  const users = new UserRepository(db)
  const groups = new UserGroupRepository(db)
  const { config, nodes } = options
  const adminKey = async () => (await groups.byAlias('admin'))?.key
  const isAdmin = (user: UserRecord, admin: string | undefined) =>
    admin !== undefined && user.groupKeys.includes(admin)

  /** Umbraco's `UserPermissionByResource`: only an admin may act on an admin. */
  const mayActOn = async (principal: Principal, targets: readonly UserRecord[]) => {
    if (principal.isAdmin) return true
    const admin = await adminKey()
    return !targets.some((t) => isAdmin(t, admin))
  }

  const chainsFor = async (tree: Tree, keys: readonly string[]) =>
    tree === 'media' ? nodes.media(keys) : nodes.documents(keys)

  /** Newly granted start nodes must lie where the performing user may work; root needs root. */
  const mayGrantStartNodes = async (
    performing: StartNodes,
    tree: Tree,
    granted: { root: boolean; keys: readonly string[] },
    had: { root: boolean; keys: readonly string[] },
  ) => {
    if (granted.root && !had.root && !performing.root) return false
    const added = granted.keys.filter((k) => !had.keys.includes(normaliseUuid(k)))
    if (added.length === 0 || tree === 'element') return true
    const found = await chainsFor(tree, added)
    return added.every((key) => {
      const node = found.get(normaliseUuid(key))
      return !node || hasPathAccess(performing, node.chain, node.trashed)
    })
  }

  /** Umbraco's `UserEditorAuthorizationHelper`: who may give which groups to whom. */
  const mayAssignGroups = async (
    principal: Principal,
    target: UserRecord | undefined,
    groupKeys: readonly string[],
  ) => {
    if (principal.isAdmin) return true
    const admin = await adminKey()
    if (target && isAdmin(target, admin)) return false
    const wanted = groupKeys.map(normaliseUuid)
    if (admin && wanted.includes(admin)) return false
    const had = new Set(target?.groupKeys ?? [])
    const mine = new Set(principal.groupKeys.map(normaliseUuid))
    return wanted.every((k) => had.has(k) || mine.has(k))
  }

  const visibleTo = async (principal: Principal) => {
    const admin = await adminKey()
    return (user: UserRecord) =>
      (normaliseUuid(principal.id) === SUPER_USER_KEY || user.key !== SUPER_USER_KEY) &&
      (principal.isAdmin || !isAdmin(user, admin))
  }

  const validateIdentity = async (
    input: { email: string; userName: string; name: string },
    self?: UserRecord,
  ): Promise<UserStatus> => {
    if (!isValidEmail(input.email)) return 'InvalidEmail'
    if (!input.userName) return 'InvalidUserName'
    if (config.usernameIsEmail && input.userName.toLowerCase() !== input.email.toLowerCase())
      return 'UserNameIsNotEmail'
    const byName = await users.byUserName(input.userName)
    if (byName && byName.key !== self?.key) return 'DuplicateUserName'
    const byEmail = await users.byEmail(input.email)
    if (byEmail && byEmail.key !== self?.key) return 'DuplicateEmail'
    return 'Success'
  }

  const sendLink = async (user: UserRecord, kind: 'invite' | 'reset', message: string | null) => {
    if (!config.sendUserLink) return false
    const token = generateToken(32)
    const hours = kind === 'invite' ? INVITE_HOURS : RESET_HOURS
    await users.saveToken(user.id, kind, hashToken(token), new Date(Date.now() + hours * 3_600_000))
    const flow =
      kind === 'invite'
        ? `flow=invite-user&userId=${user.key}&inviteCode=${encodeURIComponent(token)}`
        : `flow=reset-password&userId=${user.key}&resetCode=${encodeURIComponent(token)}`
    try {
      await config.sendUserLink({
        kind,
        to: { name: user.name, email: user.email },
        link: `${config.applicationUrl}${config.backOfficePath}/login?${flow}`,
        message,
      })
    } catch {
      // The provider rejected it or could not be reached. The sender has already
      // logged why; here it is only the difference between `Success` and
      // `CannotInvite`, and the saved token stays valid for a resend.
      return false
    }
    return true
  }

  const setPassword = async (user: UserRecord, password: string) => {
    await db.exec(
      `UPDATE user_account SET password_hash = ?, password_config = ?, security_stamp = ?,
         last_password_change_date = ?, failed_login_attempts = 0, update_date = ? WHERE id = ?`,
      [
        await hashPassword(password),
        passwordConfigJson(),
        crypto.randomUUID(),
        DbDate.toDb(new Date()),
        DbDate.toDb(new Date()),
        user.id,
      ],
    )
  }

  async function create(
    principal: Principal,
    input: Parameters<UserPort['create']>[1],
    invited: boolean,
  ): Promise<Result<UserRecord>> {
    const valid = await validateIdentity(input)
    if (valid !== 'Success') return { status: valid }
    if (input.groupKeys.length === 0) return { status: 'NoUserGroup' }
    if ((await groups.byKeys(input.groupKeys)).length !== new Set(input.groupKeys).size)
      return { status: 'MissingUserGroup' }
    if (!(await mayAssignGroups(principal, undefined, input.groupKeys)))
      return { status: 'Unauthorized' }
    const created = await users.create({
      key: input.key ?? crypto.randomUUID(),
      name: input.name || input.userName,
      userName: input.userName,
      email: input.email,
      kind: input.kind,
      groupKeys: input.groupKeys,
      languageIsoCode: null,
      invited,
    })
    return created ? { status: 'Success', value: created } : { status: 'MissingUserGroup' }
  }

  const findAll = async (keys: readonly string[]) => {
    const found = await users.byKeys(keys)
    return found.length === new Set(keys.map(normaliseUuid)).size ? found : undefined
  }

  const userPort: UserPort = {
    configuration: () => ({
      canInviteUsers: Boolean(config.sendUserLink),
      usernameIsEmail: config.usernameIsEmail,
      passwordConfiguration: DEFAULT_PASSWORD_CONFIGURATION,
      allowChangePassword: true,
      allowTwoFactor: false,
    }),
    currentConfiguration: () => ({
      keepUserLoggedIn: false,
      passwordConfiguration: DEFAULT_PASSWORD_CONFIGURATION,
      allowChangePassword: true,
      allowTwoFactor: false,
    }),
    passwordConfiguration: () => DEFAULT_PASSWORD_CONFIGURATION,

    async list(principal, skip, take) {
      const admin = await adminKey()
      const visible = (await users.all()).filter(await visibleTo(principal))
      visible.sort((a, b) => a.userName.localeCompare(b.userName))
      return {
        total: visible.length,
        items: visible.slice(skip, skip + take).map((u) => toUserResponse(u, admin)),
      }
    },

    async filter(principal, query) {
      const admin = await adminKey()
      const text = query.filter?.toLowerCase()
      const wantedGroups = query.groupKeys.map(normaliseUuid)
      const states = query.states.filter((s) => s !== 'All')
      const visible = (await users.all())
        .filter(await visibleTo(principal))
        .filter(
          (u) =>
            !text || u.name.toLowerCase().includes(text) || u.userName.toLowerCase().includes(text),
        )
        .filter(
          (u) => wantedGroups.length === 0 || u.groupKeys.some((g) => wantedGroups.includes(g)),
        )
        .filter((u) => states.length === 0 || states.includes(userState(u)))
      const field = (u: UserRecord): string | number => {
        switch (query.orderBy) {
          case 'Name':
            return u.name.toLowerCase()
          case 'Email':
            return u.email.toLowerCase()
          case 'Language':
            return u.languageIsoCode ?? ''
          case 'Id':
            return u.id
          case 'CreateDate':
            return u.createDate.getTime()
          case 'UpdateDate':
            return u.updateDate.getTime()
          case 'IsApproved':
            return u.isApproved ? 1 : 0
          case 'IsLockedOut':
            return u.isLockedOut ? 1 : 0
          case 'LastLoginDate':
            return u.lastLoginDate?.getTime() ?? 0
          default:
            return u.userName.toLowerCase()
        }
      }
      const sign = query.direction === 'Descending' ? -1 : 1
      visible.sort((a, b) => {
        const x = field(a)
        const y = field(b)
        return (x < y ? -1 : x > y ? 1 : 0) * sign
      })
      return {
        total: visible.length,
        items: visible
          .slice(query.skip, query.skip + query.take)
          .map((u) => toUserResponse(u, admin)),
      }
    },

    async get(principal, key) {
      const user = await users.byKey(key)
      if (!user) return { status: 'UserNotFound' }
      if (!(await mayActOn(principal, [user]))) return { status: 'Forbidden' }
      return { status: 'Success', value: toUserResponse(user, await adminKey()) }
    },

    async batch(principal, keys) {
      const admin = await adminKey()
      const visible = await visibleTo(principal)
      return (await users.byKeys(keys)).filter(visible).map((u) => toUserResponse(u, admin))
    },

    async create(principal, input) {
      const result = await create(principal, input, false)
      return result.status === 'Success' ? { status: 'Success', value: result.value.key } : result
    },

    async invite(principal, input, message) {
      if (!config.sendUserLink) return { status: 'CannotInvite' }
      const result = await create(principal, { ...input, kind: 'Default' }, true)
      if (result.status !== 'Success') return result
      await sendLink(result.value, 'invite', message)
      return { status: 'Success', value: result.value.key }
    },

    async resendInvite(principal, key, message) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (!(await mayActOn(principal, [user]))) return 'Forbidden'
      if (userState(user) !== 'Invited') return 'NotInInviteState'
      return (await sendLink(user, 'invite', message)) ? 'Success' : 'CannotInvite'
    },

    async verifyInvite(key, token) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (userState(user) !== 'Invited') return 'NotInInviteState'
      return (await users.checkToken(user.id, 'invite', hashToken(token), false))
        ? 'Success'
        : 'InvalidInviteToken'
    },

    async createInitialPassword(key, token, password) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (userState(user) !== 'Invited') return 'NotInInviteState'
      if (!isValidPassword(password)) return 'InvalidPassword'
      if (!(await users.checkToken(user.id, 'invite', hashToken(token), true)))
        return 'InvalidInviteToken'
      await setPassword(user, password)
      await users.approve(user.key)
      return 'Success'
    },

    async update(principal, key, input) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (!(await mayActOn(principal, [user]))) return 'Forbidden'
      const valid = await validateIdentity(input, user)
      if (valid !== 'Success') return valid
      if (input.languageIsoCode && !ISO_CODE.test(input.languageIsoCode)) return 'InvalidIsoCode'
      if (input.groupKeys.length === 0) return 'NoUserGroup'
      if ((await groups.byKeys(input.groupKeys)).length !== new Set(input.groupKeys).size)
        return 'MissingUserGroup'
      if (!(await mayAssignGroups(principal, user, input.groupKeys))) return 'Unauthorized'
      const startNodes = {
        document: { root: input.hasDocumentRootAccess, keys: input.documentStartNodeKeys },
        media: { root: input.hasMediaRootAccess, keys: input.mediaStartNodeKeys },
        element: { root: input.hasElementRootAccess, keys: input.elementStartNodeKeys },
      }
      for (const tree of ['document', 'media', 'element'] as const)
        if (
          !(await mayGrantStartNodes(
            principal.startNodes[tree],
            tree,
            startNodes[tree],
            user.startNodes[tree],
          ))
        )
          return 'Unauthorized'
      const result = await users.update(key, {
        name: input.name,
        userName: input.userName,
        email: input.email,
        languageIsoCode: input.languageIsoCode || null,
        groupKeys: input.groupKeys,
        startNodes,
      })
      if (result === 'not-found') return 'UserNotFound'
      if (result === 'missing-group') return 'MissingUserGroup'
      if (result === 'document') return 'ContentStartNodeNotFound'
      if (result === 'media') return 'MediaStartNodeNotFound'
      if (result === 'element') return 'ElementStartNodeNotFound'
      return 'Success'
    },

    async delete(principal, keys) {
      if (keys.map(normaliseUuid).includes(normaliseUuid(principal.id))) return 'CannotDeleteSelf'
      const found = await findAll(keys)
      if (!found) return 'UserNotFound'
      if (!(await mayActOn(principal, found))) return 'Forbidden'
      if (found.some((u) => u.lastLoginDate)) return 'CannotDeleteUserWithLoginHistory'
      for (const user of found) {
        if (user.avatar) await options.mediaFiles.remove(user.avatar)
        await users.delete(user.key)
      }
      return 'Success'
    },

    async setApproved(principal, keys, approved) {
      if (!approved && keys.map(normaliseUuid).includes(normaliseUuid(principal.id)))
        return 'CannotDisableSelf'
      const found = await findAll(keys)
      if (!found) return 'UserNotFound'
      if (!(await mayActOn(principal, found))) return 'Forbidden'
      if (!approved && found.some((u) => userState(u) === 'Invited'))
        return 'CannotDisableInvitedUser'
      await users.setApproved(keys, approved)
      if (!approved) for (const user of found) await options.endSessions(user.id)
      return 'Success'
    },

    async unlock(principal, keys) {
      const found = await findAll(keys)
      if (!found) return 'UserNotFound'
      if (!(await mayActOn(principal, found))) return 'Forbidden'
      await users.unlock(keys)
      return 'Success'
    },

    async setGroups(principal, userKeys, groupKeys) {
      const found = await findAll(userKeys)
      if (!found) return 'UserNotFound'
      if (!(await mayActOn(principal, found))) return 'Forbidden'
      for (const user of found)
        if (!(await mayAssignGroups(principal, user, groupKeys))) return 'Unauthorized'
      return (await users.setGroups(userKeys, groupKeys)) ? 'Success' : 'MissingUserGroup'
    },

    async changePassword(principal, key, newPassword, oldPassword) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (!(await mayActOn(principal, [user]))) return 'Forbidden'
      const self = user.key === normaliseUuid(principal.id)
      if (self) {
        if (!oldPassword) return 'SelfOldPasswordRequired'
        if (!(await verifyPassword(oldPassword, await users.passwordHash(user.key))))
          return 'InvalidPassword'
      }
      if (!isValidPassword(newPassword)) return 'InvalidPassword'
      await setPassword(user, newPassword)
      if (!self) await options.endSessions(user.id)
      return 'Success'
    },

    async resetPassword(principal, key) {
      const user = await users.byKey(key)
      if (!user) return { status: 'UserNotFound' }
      if (!(await mayActOn(principal, [user]))) return { status: 'Forbidden' }
      const password = generateUserPassword()
      await setPassword(user, password)
      if (user.key !== normaliseUuid(principal.id)) await options.endSessions(user.id)
      return { status: 'Success', value: password }
    },

    async setAvatar(principal, key, temporaryFileId) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (!(await mayActOn(principal, [user]))) return 'Forbidden'
      const upload = await options.mediaFiles.temporary(temporaryFileId)
      if (!upload) return 'AvatarFileNotFound'
      if (!AVATAR_EXTENSIONS.has(upload.fileName.split('.').pop()?.toLowerCase() ?? ''))
        return 'InvalidAvatar'
      const placed = await options.mediaFiles.place(temporaryFileId)
      if (!placed) return 'AvatarFileNotFound'
      if (user.avatar) await options.mediaFiles.remove(user.avatar)
      await users.setAvatar(user.key, placed.src)
      return 'Success'
    },

    async removeAvatar(principal, key) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (!(await mayActOn(principal, [user]))) return 'Forbidden'
      if (user.avatar) await options.mediaFiles.remove(user.avatar)
      await users.setAvatar(user.key, null)
      return 'Success'
    },

    async calculateStartNodes(principal, key) {
      const user = await users.byKey(key)
      if (!user) return { status: 'UserNotFound' }
      if (!(await mayActOn(principal, [user]))) return { status: 'Forbidden' }
      const { startNodes } = await loadAccess(db, user.id)
      return {
        status: 'Success',
        value: {
          id: user.key,
          documentStartNodeIds: refs(startNodes.document.keys),
          hasDocumentRootAccess: startNodes.document.root,
          mediaStartNodeIds: refs(startNodes.media.keys),
          hasMediaRootAccess: startNodes.media.root,
          elementStartNodeIds: refs(startNodes.element.keys),
          hasElementRootAccess: startNodes.element.root,
        },
      }
    },

    async clientCredentials(principal, key) {
      const user = await users.byKey(key)
      if (!user) return { status: 'UserNotFound' }
      if (!(await mayActOn(principal, [user]))) return { status: 'Forbidden' }
      return { status: 'Success', value: await users.clientCredentials(user.id) }
    },

    async addClientCredential(principal, key, clientId, secret) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (!(await mayActOn(principal, [user]))) return 'Forbidden'
      if (user.kind !== 'Api') return 'InvalidUserType'
      if (!clientId.startsWith(CLIENT_ID_PREFIX) || clientId.length <= CLIENT_ID_PREFIX.length)
        return 'InvalidClientId'
      if (!isValidPassword(secret)) return 'InvalidPassword'
      return (await users.addClientCredential(user.id, clientId, await hashPassword(secret)))
        ? 'Success'
        : 'DuplicateClientId'
    },

    async removeClientCredential(principal, key, clientId) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (!(await mayActOn(principal, [user]))) return 'Forbidden'
      await users.removeClientCredential(user.id, clientId)
      return 'Success'
    },

    async setLanguage(principal, isoCode) {
      if (!ISO_CODE.test(isoCode)) return 'InvalidIsoCode'
      await users.setLanguage(principal.id, isoCode)
      return 'Success'
    },

    async permissions(principal, tree, keys) {
      if (tree !== 'document') {
        // Media carries no verbs; element verbs are the groups' own until the Library exists
        const verbs =
          tree === 'element'
            ? [
                ...new Set(
                  principal.groups.flatMap((g) =>
                    g.defaults.filter((p) => p.startsWith('Umb.Element')),
                  ),
                ),
              ]
            : []
        return keys.map((nodeKey) => ({ nodeKey: normaliseUuid(nodeKey), permissions: verbs }))
      }
      const found = await nodes.documents(keys)
      return keys.flatMap((key) => {
        const node = found.get(normaliseUuid(key))
        if (!node) return []
        return [
          {
            nodeKey: normaliseUuid(key),
            permissions: [...permissionsForPath(principal.groups, node.chain)],
          },
        ]
      })
    },

    async forgotPassword(email) {
      if (!config.allowPasswordReset || !isValidEmail(email)) return
      const user = await users.byEmail(email)
      if (!user?.isApproved || user.isLockedOut) return
      await sendLink(user, 'reset', null)
    },

    async verifyResetCode(key, code) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      return (await users.checkToken(user.id, 'reset', hashToken(code), false))
        ? 'Success'
        : 'InvalidResetCode'
    },

    async resetWithCode(key, code, password) {
      const user = await users.byKey(key)
      if (!user) return 'UserNotFound'
      if (!isValidPassword(password)) return 'InvalidPassword'
      if (!(await users.checkToken(user.id, 'reset', hashToken(code), true)))
        return 'InvalidResetCode'
      await setPassword(user, password)
      await options.endSessions(user.id)
      return 'Success'
    },
  }

  return {
    users: userPort,
    groups: createUserGroupPort(db, { adminKey, nodes }),
    userData: createUserDataPort(db),
  }
}

function toPermissions(rows: readonly GranularPermission[]): UserGroupResponse['permissions'] {
  const out: UserGroupResponse['permissions'] = []
  const byKey = new Map<string, Set<string>>()
  const properties = new Map<
    string,
    { documentType: string; propertyType: string; verbs: Set<string> }
  >()
  const unknown = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.context === 'Document' && row.key) {
      const verbs = byKey.get(row.key) ?? new Set<string>()
      if (row.permission) verbs.add(row.permission)
      byKey.set(row.key, verbs)
    } else if (row.context === 'DocumentTypeProperty' && row.key) {
      const [propertyType, verb = ''] = row.permission.split('|')
      if (!propertyType) continue
      const id = `${row.key}|${propertyType}`
      const entry = properties.get(id) ?? {
        documentType: row.key,
        propertyType: normaliseUuid(propertyType),
        verbs: new Set<string>(),
      }
      if (verb) entry.verbs.add(verb)
      properties.set(id, entry)
    } else if (!row.key) {
      const verbs = unknown.get(row.context) ?? new Set<string>()
      if (row.permission) verbs.add(row.permission)
      unknown.set(row.context, verbs)
    }
  }
  for (const [document, verbs] of byKey)
    out.push({
      $type: 'DocumentPermissionPresentationModel',
      document: { id: document },
      verbs: [...verbs],
    })
  for (const entry of properties.values())
    out.push({
      $type: 'DocumentPropertyValuePermissionPresentationModel',
      documentType: { id: entry.documentType },
      propertyType: { id: entry.propertyType },
      verbs: [...entry.verbs],
    })
  for (const [context, verbs] of unknown)
    out.push({ $type: 'UnknownTypePermissionPresentationModel', context, verbs: [...verbs] })
  return out
}

function fromPermissions(permissions: UserGroupInput['permissions']): GranularPermission[] {
  const rows: GranularPermission[] = []
  for (const raw of permissions as unknown as Array<Record<string, unknown>>) {
    const verbs = Array.isArray(raw.verbs)
      ? [...new Set((raw.verbs as unknown[]).filter((v): v is string => typeof v === 'string'))]
      : []
    const idOf = (ref: unknown) => {
      const id = (ref as { id?: unknown } | null | undefined)?.id
      return typeof id === 'string' ? normaliseUuid(id) : null
    }
    switch (raw.$type) {
      case 'DocumentPermissionPresentationModel': {
        const key = idOf(raw.document)
        // No verbs is an explicit "nothing here", stored as one empty verb, as Umbraco does
        if (key)
          for (const verb of verbs.length ? verbs : [''])
            rows.push({ key, permission: verb, context: 'Document' })
        break
      }
      case 'ElementPermissionPresentationModel': {
        const key = idOf(raw.element)
        if (key)
          for (const verb of verbs.length ? verbs : [''])
            rows.push({ key, permission: verb, context: 'Element' })
        break
      }
      case 'DocumentPropertyValuePermissionPresentationModel': {
        const documentType = idOf(raw.documentType)
        const propertyType = idOf(raw.propertyType)
        if (documentType && propertyType)
          for (const verb of verbs.length ? verbs : [''])
            rows.push({
              key: documentType,
              permission: `${propertyType}|${verb}`,
              context: 'DocumentTypeProperty',
            })
        break
      }
      case 'UnknownTypePermissionPresentationModel':
        if (typeof raw.context === 'string')
          for (const verb of verbs) rows.push({ key: null, permission: verb, context: raw.context })
        break
    }
  }
  return rows
}

function createUserGroupPort(
  db: Db,
  deps: { adminKey: () => Promise<string | undefined>; nodes: NodeLookup },
): UserGroupPort {
  const groups = new UserGroupRepository(db)
  const users = new UserRepository(db)

  const toResponse = async (group: Awaited<ReturnType<UserGroupRepository['byKey']>> & object) => ({
    id: group.key,
    isDeletable: !SYSTEM_GROUPS.has(group.alias),
    aliasCanBeChanged: !SYSTEM_GROUPS.has(group.alias),
    name: group.name,
    alias: group.alias,
    description: group.description,
    icon: group.icon,
    sections: group.sections.map(sectionName),
    languages: group.languages,
    hasAccessToAllLanguages: group.hasAccessToAllLanguages,
    documentStartNode: group.startNodes.document.key ? { id: group.startNodes.document.key } : null,
    documentRootAccess: group.startNodes.document.root,
    mediaStartNode: group.startNodes.media.key ? { id: group.startNodes.media.key } : null,
    mediaRootAccess: group.startNodes.media.root,
    elementStartNode: group.startNodes.element.key ? { id: group.startNodes.element.key } : null,
    elementRootAccess: group.startNodes.element.root,
    fallbackPermissions: group.permissions,
    permissions: toPermissions(group.granular),
  })

  const isMember = (principal: Principal, key: string) =>
    principal.isAdmin || principal.groupKeys.map(normaliseUuid).includes(normaliseUuid(key))

  /** Umbraco's `UserGroupService.ValidateAccess` and input rules for create and update. */
  const validate = async (
    principal: Principal,
    input: UserGroupInput,
    existing?: { key: string; alias: string },
  ): Promise<UserGroupStatus> => {
    if (!input.name) return 'MissingName'
    if (input.name.length > 200) return 'NameTooLong'
    if (input.alias.length > 200) return 'AliasTooLong'
    if (existing && SYSTEM_GROUPS.has(existing.alias) && input.alias !== existing.alias)
      return 'CanNotUpdateAliasIsSystemUserGroup'
    const clash = await groups.byAlias(input.alias)
    if (clash && clash.key !== existing?.key) return 'DuplicateAlias'
    if (!principal.allowedSections.includes('Umb.Section.Users')) return 'Unauthorized'
    if (!principal.isAdmin) {
      const mine = new Set(principal.allowedSections)
      if (!input.sections.every((s) => mine.has(s))) return 'Unauthorized'
      for (const [tree, key] of [
        ['document', input.documentStartNode],
        ['media', input.mediaStartNode],
      ] as const) {
        if (!key) continue
        const found = await (tree === 'media'
          ? deps.nodes.media([key])
          : deps.nodes.documents([key]))
        const node = found.get(normaliseUuid(key))
        if (node && !hasPathAccess(principal.startNodes[tree], node.chain, node.trashed))
          return 'Unauthorized'
      }
    }
    return 'Success'
  }

  const save = async (input: UserGroupInput, key: string): Promise<UserGroupStatus> => {
    const result = await groups.save({
      key,
      alias: input.alias,
      name: input.name,
      description: input.description,
      icon: input.icon,
      sections: input.sections.map(sectionAppAlias),
      languages: input.languages,
      hasAccessToAllLanguages: input.hasAccessToAllLanguages,
      startNodes: {
        document: { root: input.documentRootAccess, key: input.documentStartNode },
        media: { root: input.mediaRootAccess, key: input.mediaStartNode },
        element: { root: input.elementRootAccess, key: input.elementStartNode },
      },
      permissions: input.fallbackPermissions,
      granular: fromPermissions(input.permissions),
    })
    if (result === 'saved') return 'Success'
    if (result === 'missing-language') return 'LanguageNotFound'
    return result.missingNode === 'document'
      ? 'DocumentStartNodeKeyNotFound'
      : result.missingNode === 'media'
        ? 'MediaStartNodeKeyNotFound'
        : 'ElementStartNodeKeyNotFound'
  }

  const page = async (
    list: Awaited<ReturnType<UserGroupRepository['all']>>,
    skip: number,
    take: number,
  ) => ({
    total: list.length,
    items: await Promise.all(list.slice(skip, skip + take).map(toResponse)),
  })

  const adminWouldBeEmpty = async (groupKey: string, removing: readonly string[]) => {
    if (normaliseUuid(groupKey) !== (await deps.adminKey())) return false
    const members = (await users.all()).filter((u) => u.groupKeys.includes(normaliseUuid(groupKey)))
    const gone = new Set(removing.map(normaliseUuid))
    return members.every((m) => gone.has(m.key))
  }

  return {
    list: async (skip, take) => page(await groups.all(), skip, take),

    async filter(principal, filter, skip, take) {
      const admin = await deps.adminKey()
      const text = filter.toLowerCase()
      const list = (await groups.all())
        .filter((g) => principal.isAdmin || (g.key !== admin && isMember(principal, g.key)))
        .filter((g) => !text || g.name.toLowerCase().includes(text))
      return page(list, skip, take)
    },

    async get(principal, key) {
      const group = await groups.byKey(key)
      if (!group) return 'NotFound'
      if (!isMember(principal, group.key)) return 'Forbidden'
      return toResponse(group)
    },

    async items(keys) {
      return (await groups.byKeys(keys)).map((g) => ({
        id: g.key,
        name: g.name,
        icon: g.icon,
        alias: g.alias,
        flags: [],
      }))
    },

    async create(principal, input) {
      const valid = await validate(principal, input)
      if (valid !== 'Success') return { status: valid }
      const key = normaliseUuid(input.key ?? crypto.randomUUID())
      if (await groups.byKey(key)) return { status: 'DuplicateAlias' }
      const saved = await save(input, key)
      if (saved !== 'Success') return { status: saved }
      // A non-admin who creates a group joins it, as in Umbraco
      if (!principal.isAdmin) await users.addToGroup(key, [principal.id])
      return { status: 'Success', key }
    },

    async update(principal, key, input) {
      const group = await groups.byKey(key)
      if (!group) return 'NotFound'
      if (!isMember(principal, group.key)) return 'Forbidden'
      const valid = await validate(principal, input, group)
      if (valid !== 'Success') return valid
      return save(input, group.key)
    },

    async delete(principal, keys) {
      const found = await groups.byKeys(keys)
      if (found.length !== new Set(keys.map(normaliseUuid)).size) return 'NotFound'
      if (!found.every((g) => isMember(principal, g.key))) return 'Forbidden'
      if (found.some((g) => SYSTEM_GROUPS.has(g.alias))) return 'IsSystemUserGroup'
      for (const group of found) await groups.delete(group.key)
      return 'Success'
    },

    async addUsers(principal, key, userKeys) {
      const group = await groups.byKey(key)
      if (!group) return 'NotFound'
      if (!isMember(principal, group.key)) return 'Forbidden'
      if ((await users.byKeys(userKeys)).length !== new Set(userKeys.map(normaliseUuid)).size)
        return 'UserNotFound'
      await users.addToGroup(group.key, userKeys)
      return 'Success'
    },

    async removeUsers(principal, key, userKeys) {
      const group = await groups.byKey(key)
      if (!group) return 'NotFound'
      if (!isMember(principal, group.key)) return 'Forbidden'
      if ((await users.byKeys(userKeys)).length !== new Set(userKeys.map(normaliseUuid)).size)
        return 'UserNotFound'
      if (await adminWouldBeEmpty(group.key, userKeys)) return 'AdminGroupCannotBeEmpty'
      await users.removeFromGroup(group.key, userKeys)
      return 'Success'
    },
  }
}

function createUserDataPort(db: Db): UserDataPort {
  const repo = new UserDataRepository(db)
  const idOf = async (principal: Principal) =>
    (await new UserRepository(db).byKey(principal.id))?.id ?? -1
  return {
    async list(principal, filter, skip, take) {
      return repo.list(await idOf(principal), filter, skip, take) as Promise<
        Page<{
          key: string
          group: string
          identifier: string
          value: string
        }>
      >
    },
    get: async (principal, key) => repo.get(await idOf(principal), key),
    async create(principal, entry) {
      return (await repo.create(await idOf(principal), entry)) === 'Success'
        ? 'Success'
        : 'AlreadyExists'
    },
    async update(principal, entry) {
      return (await repo.update(await idOf(principal), entry)) === 'Success'
        ? 'Success'
        : 'NotFound'
    },
    async delete(principal, key) {
      return (await repo.delete(await idOf(principal), key)) === 'Success' ? 'Success' : 'NotFound'
    },
  }
}
