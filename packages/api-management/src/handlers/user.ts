/**
 * Users, user groups, user data, the current user, and the anonymous invite
 * and password-reset endpoints. Statuses map to responses as Umbraco's
 * controllers map them, so the backoffice shows the same messages.
 */
import {
  invalidSkipTake,
  notFound,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@bunbraco/core'
import type { CurrentUserPort, UserItemPort } from '../ports.ts'
import type {
  UserDataPort,
  UserFilter,
  UserGroupInput,
  UserGroupPort,
  UserGroupStatus,
  UserOrder,
  UserPort,
  UserStatus,
  UserUpdateInput,
} from '../ports-users.ts'
import type { ManagementApiRouter, Principal, RequestContext } from '../router.ts'
import { created } from './content-type.ts'

const V1 = '/umbraco/management/api/v1'

const bad = (title: string, detail: string, operationStatus: string, status = 400) =>
  problemResponse(problemDetails({ title, detail, status, operationStatus }))

const USER_PROBLEMS: Partial<Record<UserStatus, [number, string, string]>> = {
  UserNotFound: [404, 'The user was not found', 'The specified user was not found.'],
  MissingUserGroup: [404, 'Missing User Group', 'The specified user group was not found.'],
  NoUserGroup: [400, 'No User Group Specified', 'A user must be assigned to at least one group.'],
  DuplicateUserName: [400, 'Duplicate Username', 'The username is already in use.'],
  DuplicateEmail: [400, 'Duplicate Email', 'The email is already in use.'],
  InvalidEmail: [400, 'Invalid email', 'The email is invalid.'],
  InvalidUserName: [400, 'Invalid username', 'The username is invalid.'],
  UserNameIsNotEmail: [400, 'Invalid Username', 'The username must be the same as the email.'],
  CannotDeleteSelf: [400, 'Cannot delete', 'A user cannot delete itself.'],
  CannotDisableSelf: [400, 'Cannot disable', 'A user cannot disable itself.'],
  CannotDeleteUserWithLoginHistory: [
    400,
    'Cannot delete user',
    'The user has logged in and cannot be deleted; disable it instead.',
  ],
  CannotDisableInvitedUser: [
    400,
    'Cannot disable invited user',
    'An invited user cannot be disabled.',
  ],
  CannotInvite: [
    500,
    'Cannot send user invitation',
    'This site cannot send e-mail, so users cannot be invited. Configure an e-mail provider — BUNBRACO_EMAIL_PROVIDER, or `email` in bunbraco.config.ts — or create the user and give them a password instead.',
  ],
  InvalidPassword: [
    400,
    'Invalid password',
    'The password does not meet the password requirements.',
  ],
  SelfOldPasswordRequired: [
    400,
    'Old password required',
    'The old password is required to change your own password.',
  ],
  InvalidIsoCode: [400, 'Invalid ISO code', 'The specified ISO code is invalid.'],
  ContentStartNodeNotFound: [
    400,
    'Content Start Node not found',
    'Some content start nodes were not found.',
  ],
  MediaStartNodeNotFound: [
    400,
    'Media Start Node not found',
    'Some media start nodes were not found.',
  ],
  ElementStartNodeNotFound: [
    400,
    'Element Start Node not found',
    'Some element start nodes were not found.',
  ],
  InvalidInviteToken: [
    400,
    'Invalid verification token',
    'The specified verification token is invalid.',
  ],
  InvalidResetCode: [400, 'Invalid reset code', 'The reset code is invalid or has expired.'],
  NotInInviteState: [400, 'Invalid user state', 'The user is not in the invited state.'],
  AvatarFileNotFound: [400, 'Avatar file not found', 'The file key did not resolve in to a file.'],
  InvalidAvatar: [400, 'Invalid avatar', 'The selected avatar is invalid.'],
  InvalidUserType: [400, 'Invalid user type', 'Only API users can have client credentials.'],
  DuplicateClientId: [400, 'Duplicate client ID', 'The client ID is already in use.'],
  InvalidClientId: [
    400,
    'Invalid client ID',
    'The client ID must be prefixed with "bunbraco-back-office-".',
  ],
}

/** A user status as the response Umbraco sends; undefined for success. */
export function userStatusResponse(status: UserStatus): Response | undefined {
  if (status === 'Success') return undefined
  // Umbraco answers these with bare status codes
  if (status === 'Unauthorized') return new Response(null, { status: 401 })
  if (status === 'Forbidden') return new Response(null, { status: 403 })
  const [code, title, detail] = USER_PROBLEMS[status] ?? [400, 'Unknown failure', status]
  return bad(title, detail, status, code)
}

const GROUP_PROBLEMS: Partial<Record<UserGroupStatus, [number, string, string]>> = {
  NotFound: [404, 'The user group could not be found', 'The user group could not be found.'],
  UserNotFound: [404, 'User key not found', 'The user key was not found.'],
  DuplicateAlias: [409, 'Duplicate alias', 'A user group already exists with the specified alias.'],
  CanNotUpdateAliasIsSystemUserGroup: [
    400,
    'System user group',
    'The alias of a system user group cannot be changed.',
  ],
  IsSystemUserGroup: [400, 'System user group', 'A system user group cannot be deleted.'],
  DocumentStartNodeKeyNotFound: [
    404,
    'Document start node key not found',
    'The document start node could not be found.',
  ],
  MediaStartNodeKeyNotFound: [
    404,
    'Media start node key not found',
    'The media start node could not be found.',
  ],
  ElementStartNodeKeyNotFound: [
    404,
    'Element start node key not found',
    'The element start node could not be found.',
  ],
  LanguageNotFound: [404, 'Language not found', 'A language could not be found.'],
  NameTooLong: [400, 'Name too long', 'The user group name must be 200 characters or less.'],
  AliasTooLong: [400, 'Alias too long', 'The user group alias must be 200 characters or less.'],
  MissingName: [400, 'Missing user group name.', 'The user group name is required.'],
  AdminGroupCannotBeEmpty: [
    400,
    'Admin group cannot be empty',
    'The admin group must have at least one user.',
  ],
}

function groupStatusResponse(status: UserGroupStatus): Response | undefined {
  if (status === 'Success') return undefined
  if (status === 'Forbidden') return new Response(null, { status: 403 })
  if (status === 'Unauthorized')
    return problemResponse(
      problemDetails({
        title: 'Unauthorized access',
        detail:
          'The performing user does not have the necessary access to perform this operation. Check the log for details.',
        status: 401,
        operationStatus: 'Unauthorized',
      }),
    )
  const [code, title, detail] = GROUP_PROBLEMS[status] ?? [400, 'Unknown failure', status]
  return bad(title, detail, status, code)
}

const ok = () => new Response(null, { status: 200 })

async function body(ctx: RequestContext): Promise<Record<string, unknown>> {
  return ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
}

const refId = (value: unknown): string | null => {
  const id = (value as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' ? id : null
}
const refIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(refId).filter((id): id is string => id !== null) : []
const str = (value: unknown) => (typeof value === 'string' ? value : '')

function skipTake(ctx: RequestContext): { skip: number; take: number } | Response {
  const parsed = parseSkipTake(ctx.url.searchParams)
  return parsed.ok ? parsed.value : problemResponse(invalidSkipTake())
}

const me = (ctx: RequestContext) => ctx.principal as Principal

function readGroup(b: Record<string, unknown>): UserGroupInput {
  return {
    key: typeof b.id === 'string' ? b.id : undefined,
    name: str(b.name).trim(),
    alias: str(b.alias).trim(),
    description: typeof b.description === 'string' ? b.description : null,
    icon: typeof b.icon === 'string' ? b.icon : null,
    sections: Array.isArray(b.sections) ? b.sections.filter((s) => typeof s === 'string') : [],
    languages: Array.isArray(b.languages) ? b.languages.filter((s) => typeof s === 'string') : [],
    hasAccessToAllLanguages: b.hasAccessToAllLanguages === true,
    documentStartNode: refId(b.documentStartNode),
    documentRootAccess: b.documentRootAccess === true,
    mediaStartNode: refId(b.mediaStartNode),
    mediaRootAccess: b.mediaRootAccess === true,
    elementStartNode: refId(b.elementStartNode),
    elementRootAccess: b.elementRootAccess === true,
    fallbackPermissions: Array.isArray(b.fallbackPermissions)
      ? b.fallbackPermissions.filter((s) => typeof s === 'string')
      : [],
    permissions: (Array.isArray(b.permissions)
      ? b.permissions
      : []) as UserGroupInput['permissions'],
  }
}

export function registerUserHandlers(
  router: ManagementApiRouter,
  currentUser: CurrentUserPort,
  items?: UserItemPort,
  ports: { users?: UserPort; groups?: UserGroupPort; userData?: UserDataPort } = {},
): void {
  router.handle('GetUserCurrent', async (ctx) => Response.json(await currentUser.get(me(ctx))))

  if (items)
    router.handle('GetItemUser', async (ctx) => {
      const found = await items.items(ctx.url.searchParams.getAll('id'))
      return Response.json(
        found.map((user) => ({
          id: user.key,
          name: user.name,
          avatarUrls: user.avatarUrls,
          kind: user.kind ?? 'Default',
          flags: [],
        })),
      )
    })

  const { users, groups, userData } = ports
  if (users) registerUsers(router, users)
  if (groups) registerGroups(router, groups)
  if (userData) registerUserData(router, userData)
}

function registerUsers(router: ManagementApiRouter, users: UserPort): void {
  const status = (s: UserStatus) => userStatusResponse(s) ?? ok()

  router.handle('GetUserConfiguration', () => Response.json(users.configuration()))
  router.handle('GetUserCurrentConfiguration', () => Response.json(users.currentConfiguration()))
  router.handle('GetSecurityConfiguration', () =>
    Response.json({ passwordConfiguration: users.passwordConfiguration() }),
  )

  router.handle('GetUser', async (ctx) => {
    const paging = skipTake(ctx)
    if (paging instanceof Response) return paging
    return Response.json(await users.list(me(ctx), paging.skip, paging.take))
  })

  router.handle('GetFilterUser', async (ctx) => {
    const paging = skipTake(ctx)
    if (paging instanceof Response) return paging
    const q = ctx.url.searchParams
    const query: UserFilter = {
      filter: q.get('filter') ?? undefined,
      groupKeys: q.getAll('userGroupIds'),
      states: q.getAll('userStates'),
      orderBy: (q.get('orderBy') ?? 'UserName') as UserOrder,
      direction: q.get('orderDirection') === 'Descending' ? 'Descending' : 'Ascending',
      ...paging,
    }
    return Response.json(await users.filter(me(ctx), query))
  })

  router.handle('GetUserById', async (ctx) => {
    const found = await users.get(me(ctx), ctx.params.id as string)
    return found.status === 'Success' ? Response.json(found.value) : status(found.status)
  })

  router.handle('GetUserBatch', async (ctx) => {
    const found = await users.batch(me(ctx), ctx.url.searchParams.getAll('id'))
    return Response.json({ total: found.length, items: found })
  })

  const readInput = (b: Record<string, unknown>) => ({
    key: typeof b.id === 'string' ? b.id : undefined,
    kind: b.kind === 'Api' ? ('Api' as const) : ('Default' as const),
    email: str(b.email).trim(),
    userName: str(b.userName).trim(),
    name: str(b.name).trim(),
    groupKeys: refIds(b.userGroupIds),
  })

  router.handle('PostUser', async (ctx) => {
    const result = await users.create(me(ctx), readInput(await body(ctx)))
    if (result.status !== 'Success') return status(result.status)
    return created(`${ctx.url.origin}${V1}/user/${result.value}`, result.value)
  })

  router.handle('PostUserInvite', async (ctx) => {
    const b = await body(ctx)
    const result = await users.invite(
      me(ctx),
      readInput(b),
      typeof b.message === 'string' ? b.message : null,
    )
    if (result.status !== 'Success') return status(result.status)
    return created(`${ctx.url.origin}${V1}/user/${result.value}`, result.value)
  })

  router.handle('PostUserInviteResend', async (ctx) => {
    const b = await body(ctx)
    return status(
      await users.resendInvite(
        me(ctx),
        refId(b.user) ?? '',
        typeof b.message === 'string' ? b.message : null,
      ),
    )
  })

  const passwordConfiguration = () =>
    Response.json({ passwordConfiguration: users.passwordConfiguration() })

  router.handle('PostUserInviteVerify', async (ctx) => {
    const b = await body(ctx)
    const result = await users.verifyInvite(refId(b.user) ?? '', str(b.token))
    return userStatusResponse(result) ?? passwordConfiguration()
  })

  router.handle('PostUserInviteCreatePassword', async (ctx) => {
    const b = await body(ctx)
    return status(
      await users.createInitialPassword(refId(b.user) ?? '', str(b.token), str(b.password)),
    )
  })

  router.handle('PutUserById', async (ctx) => {
    const b = await body(ctx)
    const input: UserUpdateInput = {
      email: str(b.email).trim(),
      userName: str(b.userName).trim(),
      name: str(b.name).trim(),
      languageIsoCode: str(b.languageIsoCode),
      groupKeys: refIds(b.userGroupIds),
      documentStartNodeKeys: refIds(b.documentStartNodeIds),
      hasDocumentRootAccess: b.hasDocumentRootAccess === true,
      mediaStartNodeKeys: refIds(b.mediaStartNodeIds),
      hasMediaRootAccess: b.hasMediaRootAccess === true,
      elementStartNodeKeys: refIds(b.elementStartNodeIds),
      hasElementRootAccess: b.hasElementRootAccess === true,
    }
    return status(await users.update(me(ctx), ctx.params.id as string, input))
  })

  router.handle('DeleteUserById', async (ctx) =>
    status(await users.delete(me(ctx), [ctx.params.id as string])),
  )
  router.handle('DeleteUser', async (ctx) =>
    status(await users.delete(me(ctx), refIds((await body(ctx)).userIds))),
  )
  router.handle('PostUserDisable', async (ctx) =>
    status(await users.setApproved(me(ctx), refIds((await body(ctx)).userIds), false)),
  )
  router.handle('PostUserEnable', async (ctx) =>
    status(await users.setApproved(me(ctx), refIds((await body(ctx)).userIds), true)),
  )
  router.handle('PostUserUnlock', async (ctx) =>
    status(await users.unlock(me(ctx), refIds((await body(ctx)).userIds))),
  )
  router.handle('PostUserSetUserGroups', async (ctx) => {
    const b = await body(ctx)
    return status(await users.setGroups(me(ctx), refIds(b.userIds), refIds(b.userGroupIds)))
  })

  router.handle('PostUserByIdChangePassword', async (ctx) =>
    status(
      await users.changePassword(
        me(ctx),
        ctx.params.id as string,
        str((await body(ctx)).newPassword),
        null,
      ),
    ),
  )
  router.handle('PostUserCurrentChangePassword', async (ctx) => {
    const b = await body(ctx)
    return status(
      await users.changePassword(
        me(ctx),
        me(ctx).id,
        str(b.newPassword),
        typeof b.oldPassword === 'string' ? b.oldPassword : null,
      ),
    )
  })

  router.handle('PostUserByIdResetPassword', async (ctx) => {
    const result = await users.resetPassword(me(ctx), ctx.params.id as string)
    return result.status === 'Success'
      ? Response.json({ resetPassword: result.value })
      : status(result.status)
  })

  router.handle('PostUserAvatarById', async (ctx) =>
    status(
      await users.setAvatar(me(ctx), ctx.params.id as string, refId((await body(ctx)).file) ?? ''),
    ),
  )
  router.handle('DeleteUserAvatarById', async (ctx) =>
    status(await users.removeAvatar(me(ctx), ctx.params.id as string)),
  )
  router.handle('PostUserCurrentAvatar', async (ctx) =>
    status(await users.setAvatar(me(ctx), me(ctx).id, refId((await body(ctx)).file) ?? '')),
  )
  router.handle('DeleteUserCurrentAvatar', async (ctx) =>
    status(await users.removeAvatar(me(ctx), me(ctx).id)),
  )

  router.handle('GetUserByIdCalculateStartNodes', async (ctx) => {
    const result = await users.calculateStartNodes(me(ctx), ctx.params.id as string)
    return result.status === 'Success' ? Response.json(result.value) : status(result.status)
  })

  router.handle('GetUserByIdClientCredentials', async (ctx) => {
    const result = await users.clientCredentials(me(ctx), ctx.params.id as string)
    return result.status === 'Success' ? Response.json(result.value) : status(result.status)
  })
  router.handle('PostUserByIdClientCredentials', async (ctx) => {
    const b = await body(ctx)
    return status(
      await users.addClientCredential(
        me(ctx),
        ctx.params.id as string,
        str(b.clientId),
        str(b.clientSecret),
      ),
    )
  })
  router.handle('DeleteUserByIdClientCredentialsByClientId', async (ctx) =>
    status(
      await users.removeClientCredential(
        me(ctx),
        ctx.params.id as string,
        ctx.params.clientId as string,
      ),
    ),
  )

  router.handle('PutUserCurrentProfile', async (ctx) =>
    status(await users.setLanguage(me(ctx), str((await body(ctx)).languageIsoCode))),
  )

  for (const [operation, tree] of [
    ['GetUserCurrentPermissions', 'document'],
    ['GetUserCurrentPermissionsDocument', 'document'],
    ['GetUserCurrentPermissionsMedia', 'media'],
    ['GetUserCurrentPermissionsElement', 'element'],
  ] as const)
    router.handle(operation, async (ctx) =>
      Response.json({
        permissions: await users.permissions(me(ctx), tree, ctx.url.searchParams.getAll('id')),
      }),
    )

  // No two-factor providers are installed: every provider lookup finds nothing.
  const noProvider = () =>
    bad(
      'Provider not found',
      'No two-factor provider with that name is installed.',
      'ProviderNameNotFound',
      404,
    )
  router.handle('GetUserCurrent2fa', () => Response.json([]))
  router.handle('GetUserCurrent2faByProviderName', noProvider)
  router.handle('PostUserCurrent2faByProviderName', noProvider)
  router.handle('DeleteUserCurrent2faByProviderName', noProvider)
  router.handle('GetUserById2fa', async (ctx) => {
    const found = await users.get(me(ctx), ctx.params.id as string)
    return found.status === 'Success' ? Response.json([]) : status(found.status)
  })
  router.handle('DeleteUserById2faByProviderName', noProvider)
  // External backoffice logins arrive with WP-6.8's providers.
  router.handle('GetUserCurrentLoginProviders', () => Response.json([]))

  router.handle('PostSecurityForgotPassword', async (ctx) => {
    await users.forgotPassword(str((await body(ctx)).email).trim())
    return ok()
  })
  router.handle('PostSecurityForgotPasswordVerify', async (ctx) => {
    const b = await body(ctx)
    const result = await users.verifyResetCode(refId(b.user) ?? '', str(b.resetCode))
    return userStatusResponse(result) ?? passwordConfiguration()
  })
  router.handle('PostSecurityForgotPasswordReset', async (ctx) => {
    const b = await body(ctx)
    const result = await users.resetWithCode(refId(b.user) ?? '', str(b.resetCode), str(b.password))
    return userStatusResponse(result) ?? new Response(null, { status: 204 })
  })
}

function registerGroups(router: ManagementApiRouter, groups: UserGroupPort): void {
  const status = (s: UserGroupStatus) => groupStatusResponse(s) ?? ok()

  router.handle('GetUserGroup', async (ctx) => {
    const paging = skipTake(ctx)
    if (paging instanceof Response) return paging
    return Response.json(await groups.list(paging.skip, paging.take))
  })
  router.handle('GetFilterUserGroup', async (ctx) => {
    const paging = skipTake(ctx)
    if (paging instanceof Response) return paging
    return Response.json(
      await groups.filter(
        me(ctx),
        ctx.url.searchParams.get('filter') ?? '',
        paging.skip,
        paging.take,
      ),
    )
  })
  router.handle('GetItemUserGroup', async (ctx) =>
    Response.json(await groups.items(ctx.url.searchParams.getAll('id'))),
  )
  router.handle('GetUserGroupById', async (ctx) => {
    const found = await groups.get(me(ctx), ctx.params.id as string)
    if (found === 'NotFound') return status('NotFound')
    if (found === 'Forbidden') return status('Forbidden')
    return Response.json(found)
  })
  router.handle('PostUserGroup', async (ctx) => {
    const result = await groups.create(me(ctx), readGroup(await body(ctx)))
    if (result.status !== 'Success' || !result.key) return status(result.status)
    return created(`${ctx.url.origin}${V1}/user-group/${result.key}`, result.key)
  })
  router.handle('PutUserGroupById', async (ctx) =>
    status(await groups.update(me(ctx), ctx.params.id as string, readGroup(await body(ctx)))),
  )
  router.handle('DeleteUserGroupById', async (ctx) =>
    status(await groups.delete(me(ctx), [ctx.params.id as string])),
  )
  router.handle('DeleteUserGroup', async (ctx) =>
    status(await groups.delete(me(ctx), refIds((await body(ctx)).userGroupIds))),
  )
  // The body is a bare array of references
  router.handle('PostUserGroupByIdUsers', async (ctx) =>
    status(
      await groups.addUsers(me(ctx), ctx.params.id as string, refIds(await ctx.request.json())),
    ),
  )
  router.handle('DeleteUserGroupByIdUsers', async (ctx) =>
    status(
      await groups.removeUsers(me(ctx), ctx.params.id as string, refIds(await ctx.request.json())),
    ),
  )
}

function registerUserData(router: ManagementApiRouter, data: UserDataPort): void {
  const operationStatus = (s: string, code: number) =>
    new Response(JSON.stringify(s), {
      status: code,
      headers: { 'content-type': 'application/json' },
    })

  router.handle('GetUserData', async (ctx) => {
    const paging = skipTake(ctx)
    if (paging instanceof Response) return paging
    const q = ctx.url.searchParams
    const page = await data.list(
      me(ctx),
      { groups: q.getAll('groups'), identifiers: q.getAll('identifiers') },
      paging.skip,
      paging.take,
    )
    return Response.json(paged(page.items, page.total))
  })
  router.handle('GetUserDataById', async (ctx) => {
    const found = await data.get(me(ctx), ctx.params.id as string)
    if (!found) return problemResponse(notFound('User data not found'))
    return Response.json({ group: found.group, identifier: found.identifier, value: found.value })
  })
  router.handle('PostUserData', async (ctx) => {
    const b = await body(ctx)
    const key = typeof b.key === 'string' ? b.key : crypto.randomUUID()
    const result = await data.create(me(ctx), {
      key,
      group: str(b.group),
      identifier: str(b.identifier),
      value: str(b.value),
    })
    if (result !== 'Success') return operationStatus(result, 400)
    return created(`${ctx.url.origin}${V1}/user-data/${key}`, key)
  })
  router.handle('PutUserData', async (ctx) => {
    const b = await body(ctx)
    const result = await data.update(me(ctx), {
      key: str(b.key),
      group: str(b.group),
      identifier: str(b.identifier),
      value: str(b.value),
    })
    return result === 'Success' ? ok() : operationStatus(result, 404)
  })
  router.handle('DeleteUserDataById', async (ctx) => {
    const result = await data.delete(me(ctx), ctx.params.id as string)
    return result === 'Success' ? ok() : operationStatus(result, 404)
  })
}
