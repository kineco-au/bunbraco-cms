/**
 * Backoffice users signing in through an identity provider (story 031): the
 * user side of `external-sign-in.ts`. A sign-in ends in the same session a
 * password sign-in does, so the authorize endpoint carries on from there.
 */
import type { AuthService } from '@crombolo/auth'
import { type Db, UserGroupRepository, type UserRecord, UserRepository } from '@crombolo/data'
import type { ExternalAccount, ExternalSignInAudience } from './external-sign-in.ts'
import type { IdentityProvider } from './identity-providers.ts'

/** Where backoffice sign-ins through a provider answer, under the security path the login uses. */
export const BACKOFFICE_EXTERNAL_PATH = '/umbraco/management/api/v1/security/back-office/external'

export function backofficeAudience(
  db: Db,
  options: {
    auth: AuthService
    providers: readonly IdentityProvider[]
    backOfficePath: string
    /** The `Set-Cookie` value for a new backoffice session. */
    sessionCookie(sessionId: string): string
    clientAddress?(request: Request): string | undefined
    /** Called once a user is signed in, for the audit log. */
    onSignIn?(user: UserRecord, request: Request): Promise<void>
  },
): ExternalSignInAudience {
  const users = new UserRepository(db)
  const groups = new UserGroupRepository(db)

  const aliasesOf = async (user: UserRecord) => {
    const found = await groups.byKeys(user.groupKeys)
    return found.map((g) => g.alias)
  }
  const keysOf = async (aliases: readonly string[]) => {
    const all = await groups.all()
    return aliases.flatMap((alias) => {
      const group = all.find((g) => g.alias.toLowerCase() === alias.toLowerCase())
      return group ? [group.key] : []
    })
  }
  const asAccount = async (user: UserRecord): Promise<ExternalAccount> => ({
    key: user.key,
    email: user.email,
    groups: await aliasesOf(user),
  })

  return {
    audience: 'user',
    providers: options.providers,
    basePath: BACKOFFICE_EXTERNAL_PATH,
    byKey: async (key) => {
      const user = await users.byKey(key)
      return user ? asAccount(user) : undefined
    },
    byEmail: async (email) => {
      const user = await users.byEmail(email)
      return user ? asAccount(user) : undefined
    },
    create: async (identity, provider, groupAliases) => {
      const email = identity.email as string
      const userName = (await users.byUserName(email))
        ? `${provider.oidc.id}-${identity.subject}`
        : email
      const created = await users.create({
        key: crypto.randomUUID(),
        name: identity.name || email,
        userName,
        email,
        kind: 'Default',
        groupKeys: await keysOf(groupAliases),
        languageIsoCode: null,
      })
      if (!created) throw new Error(`A user for ${email} could not be created.`)
      return asAccount(created)
    },
    setGroups: async (account, groupAliases) => {
      await users.setGroups([account.key], await keysOf(groupAliases))
    },
    signIn: async (account, request) => {
      const user = await users.byKey(account.key)
      if (!user) return { refused: 'This account no longer exists.' }
      const result = await options.auth.signInExternally(
        user.userName,
        options.clientAddress?.(request),
      )
      if (result.status !== 'success')
        return {
          refused:
            result.reason === 'lockedOut'
              ? 'This account is locked out.'
              : 'This account is not allowed to sign in yet.',
        }
      await options.onSignIn?.(user, request)
      return { cookies: [options.sessionCookie(result.sessionId)] }
    },
    failed: (returnUrl, reason) =>
      `${options.backOfficePath}/login?returnUrl=${encodeURIComponent(returnUrl)}&externalLoginError=${encodeURIComponent(reason)}`,
  }
}
