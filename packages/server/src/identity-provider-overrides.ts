/**
 * Settings an administrator changed for an identity provider the config
 * declares (story 033): kept in `key_value`, one row per provider and audience,
 * with the client secret sealed by `CROMBOLO_SECRET_KEY`. The config's preset is
 * the provider; these are only the fields changed, put on top of it at every
 * sign-in, so a change reaches every node with nothing to invalidate.
 */
import type { Db, ExternalLoginAudience } from '@crombolo/data'
import { entraIssuer, type IdentityProvider } from './identity-providers.ts'
import { openSecret, SECRET_KEY_VARIABLE, sealSecret, usableSecretKey } from './secrets.ts'

/** The fields an override may change. */
export interface ProviderOverrides {
  name?: string
  tenantId?: string
  issuer?: string
  clientId?: string
  autoCreate?: boolean
  linkByEmail?: boolean
  emailsVerified?: boolean
  groupMap?: Record<string, string>
  defaultGroups?: string[]
}

/** What an administrator sends: the fields to change, and a client secret to set (`null` clears it). */
export interface ProviderOverrideInput extends ProviderOverrides {
  clientSecret?: string | null
}

interface Stored extends ProviderOverrides {
  clientSecretSealed?: string
}

const OVERRIDABLE: readonly (keyof ProviderOverrides)[] = [
  'name',
  'tenantId',
  'issuer',
  'clientId',
  'autoCreate',
  'linkByEmail',
  'emailsVerified',
  'groupMap',
  'defaultGroups',
]

const keyOf = (audience: ExternalLoginAudience, id: string) =>
  `crombolo:identity-provider:${audience}:${id}`

/** The provider the config declares, with an administrator's changes on top. Pure. */
export function effectiveProvider(
  code: IdentityProvider,
  overrides: ProviderOverrides & { clientSecret?: string },
): IdentityProvider {
  const tenantId = overrides.tenantId ?? code.tenantId
  const issuer =
    overrides.issuer ??
    (code.kind === 'entra' && overrides.tenantId
      ? entraIssuer(overrides.tenantId)
      : code.oidc.issuer)
  return {
    ...code,
    ...(tenantId ? { tenantId } : {}),
    oidc: {
      ...code.oidc,
      name: overrides.name ?? code.oidc.name,
      issuer,
      clientId: overrides.clientId ?? code.oidc.clientId,
      clientSecret: overrides.clientSecret ?? code.oidc.clientSecret,
    },
    autoCreate: overrides.autoCreate ?? code.autoCreate,
    linkByEmail: overrides.linkByEmail ?? code.linkByEmail,
    emailsVerified: overrides.emailsVerified ?? code.emailsVerified,
    groupMap: overrides.groupMap ?? code.groupMap,
    defaultGroups: overrides.defaultGroups ?? code.defaultGroups,
  }
}

export class IdentityProviderOverrides {
  #db: Db
  #secretKey: string | undefined

  constructor(db: Db, secretKey: string | undefined) {
    this.#db = db
    this.#secretKey = usableSecretKey(secretKey)
  }

  async #read(audience: ExternalLoginAudience, id: string): Promise<Stored> {
    const rows = await this.#db.query<{ value: string | null }>(
      'SELECT value FROM key_value WHERE key = ?',
      [keyOf(audience, id)],
    )
    try {
      return rows[0]?.value ? (JSON.parse(rows[0].value) as Stored) : {}
    } catch {
      return {}
    }
  }

  /** The fields changed, with whether a client secret is kept here; never the secret itself. */
  async get(
    audience: ExternalLoginAudience,
    id: string,
  ): Promise<{ overrides: ProviderOverrides; hasClientSecret: boolean }> {
    const { clientSecretSealed, ...overrides } = await this.#read(audience, id)
    return { overrides, hasClientSecret: Boolean(clientSecretSealed) }
  }

  /** A provider as a sign-in uses it: the config's, with the changes and a kept secret on top. */
  async apply(audience: ExternalLoginAudience, code: IdentityProvider): Promise<IdentityProvider> {
    const { clientSecretSealed, ...overrides } = await this.#read(audience, code.oidc.id)
    if (Object.keys(overrides).length === 0 && !clientSecretSealed) return code
    let clientSecret: string | undefined
    if (clientSecretSealed && this.#secretKey) {
      try {
        clientSecret = openSecret(clientSecretSealed, this.#secretKey)
      } catch {
        clientSecret = undefined
      }
    }
    return effectiveProvider(code, { ...overrides, clientSecret })
  }

  /** Changes some fields. An empty string or an empty value clears a field back to the config's. */
  async update(
    audience: ExternalLoginAudience,
    id: string,
    input: ProviderOverrideInput,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const stored = await this.#read(audience, id)
    for (const field of OVERRIDABLE) {
      if (!(field in input)) continue
      const value = input[field]
      if (value === undefined || value === null || value === '') delete stored[field]
      else (stored as Record<string, unknown>)[field] = value
    }
    if (input.clientSecret === null || input.clientSecret === '') delete stored.clientSecretSealed
    else if (typeof input.clientSecret === 'string') {
      if (!this.#secretKey)
        return {
          ok: false,
          error: `Keeping a client secret here needs ${SECRET_KEY_VARIABLE} set on the server.`,
        }
      stored.clientSecretSealed = sealSecret(input.clientSecret, this.#secretKey)
    }
    await this.#write(audience, id, stored)
    return { ok: true }
  }

  /** Puts a provider back to what the config says. */
  async reset(audience: ExternalLoginAudience, id: string): Promise<void> {
    await this.#db.exec('DELETE FROM key_value WHERE key = ?', [keyOf(audience, id)])
  }

  async #write(audience: ExternalLoginAudience, id: string, stored: Stored): Promise<void> {
    const key = keyOf(audience, id)
    const now = this.#db.dialect.now()
    if (Object.keys(stored).length === 0) {
      await this.#db.exec('DELETE FROM key_value WHERE key = ?', [key])
      return
    }
    const value = JSON.stringify(stored)
    const updated = await this.#db.query<{ key: string }>(
      `UPDATE key_value SET value = ?, update_date = ${now} WHERE key = ? RETURNING key`,
      [value, key],
    )
    if (updated.length === 0)
      await this.#db.exec(`INSERT INTO key_value (key, value, update_date) VALUES (?, ?, ${now})`, [
        key,
        value,
      ])
  }
}

/** A provider as a bundle sees it: its effective settings and which of them were changed. */
export interface BundleIdentityProvider {
  audience: ExternalLoginAudience
  id: string
  kind: IdentityProvider['kind']
  name: string
  tenantId: string | null
  issuer: string
  clientId: string
  /** Whether there is a client secret, from the config or kept here. Never the secret. */
  hasClientSecret: boolean
  autoCreate: boolean
  linkByEmail: boolean
  emailsVerified: boolean
  groupMap: Record<string, string>
  defaultGroups: string[]
  /** The fields an administrator changed, `clientSecret` among them when one is kept here. */
  overridden: string[]
  /** The path to register with the provider as the redirect URL, after the site's address. */
  callbackPath: string
}

/** The `identityProviders` bundle capability (story 033): edit, never declare. */
export interface BundleIdentityProviders {
  list(): Promise<BundleIdentityProvider[]>
  update(
    audience: ExternalLoginAudience,
    id: string,
    input: ProviderOverrideInput,
  ): Promise<{ ok: true } | { ok: false; error: string }>
  reset(audience: ExternalLoginAudience, id: string): Promise<boolean>
  /** Whether the provider's discovery document answers, with what it says if not. */
  test(audience: ExternalLoginAudience, id: string): Promise<{ ok: boolean; message: string }>
  /** The groups a mapping can name: user groups by alias, member groups by name. */
  groups(audience: ExternalLoginAudience): Promise<Array<{ value: string; name: string }>>
}

export function createBundleIdentityProviders(options: {
  overrides: IdentityProviderOverrides
  members: readonly IdentityProvider[]
  backoffice: readonly IdentityProvider[]
  memberCallbackPath: string
  backofficeCallbackPath: string
  groups(audience: ExternalLoginAudience): Promise<Array<{ value: string; name: string }>>
}): BundleIdentityProviders {
  const declared = (audience: ExternalLoginAudience, id: string) =>
    (audience === 'member' ? options.members : options.backoffice).find((p) => p.oidc.id === id)

  const describe = async (
    audience: ExternalLoginAudience,
    code: IdentityProvider,
  ): Promise<BundleIdentityProvider> => {
    const effective = await options.overrides.apply(audience, code)
    const { overrides, hasClientSecret } = await options.overrides.get(audience, code.oidc.id)
    const base = audience === 'member' ? options.memberCallbackPath : options.backofficeCallbackPath
    return {
      audience,
      id: code.oidc.id,
      kind: code.kind,
      name: effective.oidc.name,
      tenantId: effective.tenantId ?? null,
      issuer: effective.oidc.issuer,
      clientId: effective.oidc.clientId,
      hasClientSecret: Boolean(effective.oidc.clientSecret),
      autoCreate: effective.autoCreate,
      linkByEmail: effective.linkByEmail,
      emailsVerified: effective.emailsVerified,
      groupMap: { ...effective.groupMap },
      defaultGroups: [...effective.defaultGroups],
      overridden: [...Object.keys(overrides), ...(hasClientSecret ? ['clientSecret'] : [])],
      callbackPath: `${base}/${code.oidc.id}/callback`,
    }
  }

  return {
    async list() {
      return Promise.all([
        ...options.members.map((p) => describe('member', p)),
        ...options.backoffice.map((p) => describe('user', p)),
      ])
    },
    async update(audience, id, input) {
      if (!declared(audience, id))
        return { ok: false, error: 'The config declares no such identity provider.' }
      return options.overrides.update(audience, id, input)
    },
    async reset(audience, id) {
      if (!declared(audience, id)) return false
      await options.overrides.reset(audience, id)
      return true
    },
    groups: (audience) => options.groups(audience),
    async test(audience, id) {
      const code = declared(audience, id)
      if (!code) return { ok: false, message: 'The config declares no such identity provider.' }
      const effective = await options.overrides.apply(audience, code)
      const url = `${effective.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        if (!response.ok) return { ok: false, message: `${url} answered ${response.status}.` }
        const document = (await response.json()) as { authorization_endpoint?: unknown }
        return typeof document.authorization_endpoint === 'string'
          ? { ok: true, message: `${effective.oidc.name} answered at ${effective.oidc.issuer}.` }
          : { ok: false, message: `${url} is not an OpenID Connect discovery document.` }
      } catch (error) {
        return { ok: false, message: `${url} could not be reached: ${(error as Error).message}` }
      }
    },
  }
}
