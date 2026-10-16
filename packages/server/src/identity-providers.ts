/**
 * External identity providers (story 031): typed presets a site's config lists,
 * one list for members and one for backoffice users. Each preset knows its
 * provider's issuer, scopes and claims; the rest says what a first sign-in may
 * do and how groups follow the account.
 *
 * ```ts
 * defineConfig({
 *   backofficeIdentityProviders: [entra({ tenantId, clientId, clientSecret, groups: { map: { … } } })],
 *   memberIdentityProviders: [awsIdentityCenter({ issuer, clientId, clientSecret })],
 * })
 * ```
 */
import type { OidcClaims, OidcProviderOptions } from '@crombolo/auth'

/** What every preset takes besides the provider's own settings. */
export interface IdentityProviderOptions {
  /** The provider's id, in its URLs and in `external_login`; the preset's name by default. */
  id?: string
  /** What its sign-in button says: "Sign in with {name}". */
  name?: string
  /** Create a member or user for an account nobody has yet. On by default. */
  autoCreate?: boolean
  /**
   * Link a first sign-in to an existing member or user with the same email,
   * when the provider says the email is verified. Off by default: without it, an
   * email already taken is refused rather than merged.
   */
  linkByEmail?: boolean
  /**
   * Treat every email this provider sends as verified. For a provider whose
   * emails are the organisation's own, such as one Entra tenant, which sends no
   * `email_verified` claim.
   */
  emailsVerified?: boolean
  /**
   * Groups that follow the account: claim values mapped to member groups (for
   * members) or user group aliases (for users), made to match the claim on
   * every sign-in. Groups outside the map are left as they are.
   */
  groups?: { claim?: string; map: Record<string, string> }
  /** Groups a new member or user joins, besides the mapped ones. */
  defaultGroups?: readonly string[]
  /** Members only: the member type a new member is created as, by alias; `Member` by default. */
  memberType?: string
}

/** Which preset made a provider: what the Entra bundle looks for. */
export type IdentityProviderKind = 'entra' | 'aws' | 'oidc'

/** A provider, ready for the config. */
export interface IdentityProvider {
  kind: IdentityProviderKind
  /** Entra only: the tenant its issuer is for, which an override may change. */
  tenantId?: string
  oidc: OidcProviderOptions
  autoCreate: boolean
  linkByEmail: boolean
  emailsVerified: boolean
  groupMap: Readonly<Record<string, string>>
  defaultGroups: readonly string[]
  memberType: string | undefined
}

const ID = /^[a-z0-9][a-z0-9-]*$/

/** Entra's issuer for a tenant. */
export const entraIssuer = (tenantId: string) =>
  `https://login.microsoftonline.com/${tenantId}/v2.0`

function preset(
  kind: IdentityProviderKind,
  defaults: { id: string; name: string },
  provider: { issuer: string; clientId: string; clientSecret?: string; scopes?: readonly string[] },
  claims: OidcClaims,
  options: IdentityProviderOptions,
): IdentityProvider {
  const id = options.id ?? defaults.id
  if (!ID.test(id))
    throw new Error(`An identity provider's id is letters, digits and dashes: "${id}" is not.`)
  if (!provider.issuer) throw new Error(`The ${defaults.name} identity provider needs an issuer.`)
  if (!provider.clientId)
    throw new Error(`The ${defaults.name} identity provider needs a clientId.`)
  return {
    kind,
    oidc: {
      id,
      name: options.name ?? defaults.name,
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      scopes: provider.scopes ?? ['openid', 'profile', 'email'],
      // A group map with no claim named reads the usual `groups` claim.
      claims: {
        ...claims,
        groups: options.groups?.claim ?? claims.groups ?? (options.groups ? 'groups' : undefined),
      },
    },
    autoCreate: options.autoCreate ?? true,
    linkByEmail: options.linkByEmail ?? false,
    emailsVerified: options.emailsVerified ?? false,
    groupMap: options.groups?.map ?? {},
    defaultGroups: options.defaultGroups ?? [],
    memberType: options.memberType,
  }
}

/**
 * Microsoft Entra ID, for one tenant. Register a web app with a client secret
 * and the redirect URLs in `docs/operations.md`; for groups, add the `groups`
 * claim to its token configuration.
 */
export function entra(
  options: IdentityProviderOptions & { tenantId: string; clientId: string; clientSecret?: string },
): IdentityProvider {
  if (!options.tenantId) throw new Error('The Entra identity provider needs a tenantId.')
  const provider = preset(
    'entra',
    { id: 'entra', name: 'Microsoft' },
    {
      issuer: entraIssuer(options.tenantId),
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    },
    { email: 'email', name: 'name', groups: 'groups' },
    options,
  )
  return { ...provider, tenantId: options.tenantId }
}

/**
 * AWS IAM Identity Center, through the OpenID Connect application its
 * instance issues; `issuer` is that instance's issuer URL.
 */
export function awsIdentityCenter(
  options: IdentityProviderOptions & { issuer: string; clientId: string; clientSecret?: string },
): IdentityProvider {
  return preset(
    'aws',
    { id: 'aws', name: 'AWS' },
    { issuer: options.issuer, clientId: options.clientId, clientSecret: options.clientSecret },
    { email: 'email', name: 'name', groups: 'groups' },
    options,
  )
}

/** Any OpenID Connect provider, by its issuer: Google, Okta, Auth0, Keycloak and the like. */
export function oidc(
  options: IdentityProviderOptions & {
    id: string
    name: string
    issuer: string
    clientId: string
    clientSecret?: string
    scopes?: readonly string[]
    claims?: Partial<OidcClaims>
  },
): IdentityProvider {
  return preset(
    'oidc',
    { id: options.id, name: options.name },
    {
      issuer: options.issuer,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      scopes: options.scopes,
    },
    { email: 'email', name: 'name', ...options.claims },
    options,
  )
}

/** Refuses two providers with one id in a list, which would share one set of URLs. */
export function checkIdentityProviders(
  list: readonly IdentityProvider[],
  label: string,
): readonly IdentityProvider[] {
  const seen = new Set<string>()
  for (const provider of list) {
    if (seen.has(provider.oidc.id))
      throw new Error(`Two ${label} identity providers have the id "${provider.oidc.id}".`)
    seen.add(provider.oidc.id)
  }
  return list
}
