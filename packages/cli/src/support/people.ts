/**
 * Back-office users from the command line (story 151), through the same user
 * port the Management API uses, so a rule the back office keeps — who may act
 * on an admin, what an invite is — is the rule here too. It opens the site's
 * database directly, not through the server, so it works when the site will not
 * boot; in a container it runs through `docker exec`.
 */
import type { Principal, UserPort, UserStatus } from '@crombolo/api-management'
import { AuthStore } from '@crombolo/auth'
import { type Db, SUPER_USER_KEY, UserRepository } from '@crombolo/data'
import {
  bootstrapDatabase,
  type CromboloConfig,
  createNodeLookup,
  createUserPorts,
  MediaFileStore,
  mediaStoreFor,
  TwoFactorService,
} from '@crombolo/server'
import { CliError, type ErrorKind } from '../errors.ts'

/** The operator: an administrator who is nobody in particular, so no rule about acting on oneself applies. */
const CLI_PRINCIPAL_ID = '00000000-0000-4000-8000-0000000c1c1e'

const principal = (id: string): Principal =>
  ({
    id,
    userName: 'crombolo',
    name: 'The command line',
    email: '',
    isAdmin: true,
    languageIsoCode: undefined,
    avatarUrls: [],
    allowedSections: [],
    permissions: [],
    groupKeys: [],
    hasAccessToAllLanguages: true,
    languages: [],
  }) as unknown as Principal

/** Sees every user, the built-in administrator included, as only that administrator may. */
export const OBSERVER = principal(SUPER_USER_KEY)
/** Acts on any user, the built-in administrator included. */
export const OPERATOR = principal(CLI_PRINCIPAL_ID)

export interface People {
  config: CromboloConfig
  db: Db
  users: UserPort
  repository: UserRepository
  twoFactor: TwoFactorService
  /** The link the last invite would have e-mailed. */
  lastLink(): string | undefined
}

export async function openPeople(config: CromboloConfig): Promise<People> {
  const { db } = await bootstrapDatabase(config)
  const store = new AuthStore(db)
  let link: string | undefined
  const { users } = createUserPorts(db, {
    config: {
      ...config,
      // Captured, not sent: the command prints it, for a site with no e-mail.
      sendUserLink: async (message) => {
        link = message.link
      },
    },
    mediaFiles: new MediaFileStore(await mediaStoreFor(config)),
    nodes: createNodeLookup(db),
    endSessions: async (userId) => {
      await store.endAllSessionsForUser(userId)
    },
  })
  return {
    config,
    db,
    users,
    repository: new UserRepository(db),
    twoFactor: new TwoFactorService(db, { secretKey: config.secretKey, issuer: config.siteName }),
    lastLink: () => link,
  }
}

/** A user by e-mail or username, whatever the casing; `not_found` otherwise. */
export async function userNamed(people: People, who: string) {
  const wanted = who.trim().toLowerCase()
  const rows = await people.db.query<{ key: string }>(
    'SELECT key FROM user_account WHERE LOWER(email) = ? OR LOWER(user_name) = ?',
    [wanted, wanted],
  )
  const key = rows[0]?.key
  const user = key ? await people.repository.byKey(String(key)) : undefined
  if (!user)
    throw new CliError('not_found', `No user "${who}".`, {
      hint: '`crombolo users list` lists them.',
    })
  return user
}

const STATUS_KINDS: Partial<Record<UserStatus, ErrorKind>> = {
  UserNotFound: 'not_found',
  MissingUserGroup: 'not_found',
  DuplicateUserName: 'conflict',
  DuplicateEmail: 'conflict',
  InvalidEmail: 'usage',
  InvalidUserName: 'usage',
  UserNameIsNotEmail: 'usage',
  InvalidPassword: 'usage',
  NoUserGroup: 'usage',
}

const STATUS_MESSAGES: Partial<Record<UserStatus, string>> = {
  CannotDisableInvitedUser: 'An invited user cannot be disabled; delete the invitation instead.',
  CannotInvite: 'The invitation could not be made.',
  InvalidPassword: "That password does not meet this site's password rules.",
  DuplicateEmail: 'Another user has that e-mail address.',
  DuplicateUserName: 'Another user has that username.',
  MissingUserGroup: 'There is no group with that alias.',
}

/** A user port status other than `Success`, as a failure. */
export function checkStatus(status: UserStatus): void {
  if (status === 'Success') return
  throw new CliError(STATUS_KINDS[status] ?? 'refused', STATUS_MESSAGES[status] ?? status)
}

export function describeUser(user: {
  key: string
  name: string
  email: string
  userName: string
}): string {
  return `${user.name} <${user.email || user.userName}>`
}
