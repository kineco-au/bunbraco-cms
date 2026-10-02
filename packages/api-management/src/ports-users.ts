/** Ports for backoffice users, user groups and user data. */
import type { ResponseOf } from '@bunbraco/contracts'
import type { Page } from '@bunbraco/core'
import type { Principal } from './router.ts'

export type UserResponse = ResponseOf<'GetUserById'>
export type UserGroupResponse = ResponseOf<'GetUserGroupById'>

/** Umbraco's `UserOperationStatus` names, as its problem details report them. */
export type UserStatus =
  | 'Success'
  | 'UserNotFound'
  | 'MissingUserGroup'
  | 'NoUserGroup'
  | 'DuplicateUserName'
  | 'DuplicateEmail'
  | 'InvalidEmail'
  | 'InvalidUserName'
  | 'UserNameIsNotEmail'
  | 'Unauthorized'
  | 'Forbidden'
  | 'CannotDeleteSelf'
  | 'CannotDisableSelf'
  | 'CannotDeleteUserWithLoginHistory'
  | 'CannotDisableInvitedUser'
  | 'CannotInvite'
  | 'InvalidPassword'
  | 'SelfOldPasswordRequired'
  | 'InvalidIsoCode'
  | 'ContentStartNodeNotFound'
  | 'MediaStartNodeNotFound'
  | 'ElementStartNodeNotFound'
  | 'InvalidInviteToken'
  | 'NotInInviteState'
  | 'AvatarFileNotFound'
  | 'InvalidAvatar'
  | 'InvalidUserType'
  | 'DuplicateClientId'
  | 'InvalidClientId'
  | 'InvalidResetCode'

export type UserOrder =
  | 'UserName'
  | 'Language'
  | 'Name'
  | 'Email'
  | 'Id'
  | 'CreateDate'
  | 'UpdateDate'
  | 'IsApproved'
  | 'IsLockedOut'
  | 'LastLoginDate'

export interface UserFilter {
  filter?: string
  groupKeys: string[]
  states: string[]
  orderBy: UserOrder
  direction: 'Ascending' | 'Descending'
  skip: number
  take: number
}

export interface UserInput {
  key?: string
  kind: 'Default' | 'Api'
  email: string
  userName: string
  name: string
  groupKeys: string[]
}

export interface UserUpdateInput {
  email: string
  userName: string
  name: string
  languageIsoCode: string
  groupKeys: string[]
  documentStartNodeKeys: string[]
  hasDocumentRootAccess: boolean
  mediaStartNodeKeys: string[]
  hasMediaRootAccess: boolean
  elementStartNodeKeys: string[]
  hasElementRootAccess: boolean
}

export type Result<T> = { status: 'Success'; value: T } | { status: Exclude<UserStatus, 'Success'> }

export interface UserPort {
  list(principal: Principal, skip: number, take: number): Promise<Page<UserResponse>>
  filter(principal: Principal, query: UserFilter): Promise<Page<UserResponse>>
  get(principal: Principal, key: string): Promise<Result<UserResponse>>
  batch(principal: Principal, keys: readonly string[]): Promise<UserResponse[]>
  create(principal: Principal, input: UserInput): Promise<Result<string>>
  invite(principal: Principal, input: UserInput, message: string | null): Promise<Result<string>>
  resendInvite(principal: Principal, key: string, message: string | null): Promise<UserStatus>
  /** Anonymous: whether an invitation token is still good. */
  verifyInvite(key: string, token: string): Promise<UserStatus>
  /** Anonymous: accepts an invitation by setting the first password. */
  createInitialPassword(key: string, token: string, password: string): Promise<UserStatus>
  update(principal: Principal, key: string, input: UserUpdateInput): Promise<UserStatus>
  delete(principal: Principal, keys: readonly string[]): Promise<UserStatus>
  setApproved(principal: Principal, keys: readonly string[], approved: boolean): Promise<UserStatus>
  unlock(principal: Principal, keys: readonly string[]): Promise<UserStatus>
  setGroups(
    principal: Principal,
    userKeys: readonly string[],
    groupKeys: readonly string[],
  ): Promise<UserStatus>
  changePassword(
    principal: Principal,
    key: string,
    newPassword: string,
    oldPassword: string | null,
  ): Promise<UserStatus>
  /** A generated password, which the backoffice shows once. */
  resetPassword(principal: Principal, key: string): Promise<Result<string>>
  setAvatar(principal: Principal, key: string, temporaryFileId: string): Promise<UserStatus>
  removeAvatar(principal: Principal, key: string): Promise<UserStatus>
  calculateStartNodes(
    principal: Principal,
    key: string,
  ): Promise<Result<ResponseOf<'GetUserByIdCalculateStartNodes'>>>
  clientCredentials(principal: Principal, key: string): Promise<Result<string[]>>
  addClientCredential(
    principal: Principal,
    key: string,
    clientId: string,
    secret: string,
  ): Promise<UserStatus>
  removeClientCredential(principal: Principal, key: string, clientId: string): Promise<UserStatus>
  setLanguage(principal: Principal, isoCode: string): Promise<UserStatus>
  /** The caller's verbs on each node, as the permission rules calculate them. */
  permissions(
    principal: Principal,
    tree: 'document' | 'media' | 'element',
    keys: readonly string[],
  ): Promise<Array<{ nodeKey: string; permissions: string[] }>>
  configuration(): ResponseOf<'GetUserConfiguration'>
  currentConfiguration(): ResponseOf<'GetUserCurrentConfiguration'>
  passwordConfiguration(): ResponseOf<'GetSecurityConfiguration'>['passwordConfiguration']
  /** Anonymous: sends a reset link when the address belongs to a user; says nothing either way. */
  forgotPassword(email: string): Promise<void>
  verifyResetCode(key: string, code: string): Promise<UserStatus>
  resetWithCode(key: string, code: string, password: string): Promise<UserStatus>
}

export interface UserGroupInput {
  key?: string
  name: string
  alias: string
  description: string | null
  icon: string | null
  sections: string[]
  languages: string[]
  hasAccessToAllLanguages: boolean
  documentStartNode: string | null
  documentRootAccess: boolean
  mediaStartNode: string | null
  mediaRootAccess: boolean
  elementStartNode: string | null
  elementRootAccess: boolean
  fallbackPermissions: string[]
  permissions: UserGroupResponse['permissions']
}

/** Umbraco's `UserGroupOperationStatus` names. */
export type UserGroupStatus =
  | 'Success'
  | 'NotFound'
  | 'Unauthorized'
  | 'Forbidden'
  | 'DuplicateAlias'
  | 'DuplicateName'
  | 'MissingName'
  | 'NameTooLong'
  | 'AliasTooLong'
  | 'IsSystemUserGroup'
  | 'CanNotUpdateAliasIsSystemUserGroup'
  | 'DocumentStartNodeKeyNotFound'
  | 'MediaStartNodeKeyNotFound'
  | 'ElementStartNodeKeyNotFound'
  | 'LanguageNotFound'
  | 'AdminGroupCannotBeEmpty'
  | 'UserNotFound'

export interface UserGroupPort {
  list(skip: number, take: number): Promise<Page<UserGroupResponse>>
  filter(
    principal: Principal,
    filter: string,
    skip: number,
    take: number,
  ): Promise<Page<UserGroupResponse>>
  get(principal: Principal, key: string): Promise<UserGroupResponse | 'NotFound' | 'Forbidden'>
  items(keys: readonly string[]): Promise<ResponseOf<'GetItemUserGroup'>>
  create(
    principal: Principal,
    input: UserGroupInput,
  ): Promise<{ status: UserGroupStatus; key?: string }>
  update(principal: Principal, key: string, input: UserGroupInput): Promise<UserGroupStatus>
  delete(principal: Principal, keys: readonly string[]): Promise<UserGroupStatus>
  addUsers(principal: Principal, key: string, userKeys: readonly string[]): Promise<UserGroupStatus>
  removeUsers(
    principal: Principal,
    key: string,
    userKeys: readonly string[],
  ): Promise<UserGroupStatus>
}

export interface UserDataEntryModel {
  key: string
  group: string
  identifier: string
  value: string
}

/** The current user's key/value data. */
export interface UserDataPort {
  list(
    principal: Principal,
    filter: { groups: string[]; identifiers: string[] },
    skip: number,
    take: number,
  ): Promise<Page<UserDataEntryModel>>
  get(principal: Principal, key: string): Promise<UserDataEntryModel | undefined>
  create(principal: Principal, entry: UserDataEntryModel): Promise<'Success' | 'AlreadyExists'>
  update(principal: Principal, entry: UserDataEntryModel): Promise<'Success' | 'NotFound'>
  delete(principal: Principal, key: string): Promise<'Success' | 'NotFound'>
}
