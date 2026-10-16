/**
 * The Microsoft Entra bundle (story 033): a Settings screen for the Entra sign-ins
 * a site declares in code with `entra()`. It changes their settings — tenant, app
 * credentials, the sign-in options and group mappings — and puts them back; it
 * never declares a provider. The overrides live in core, behind the
 * `identityProviders` capability, and apply at the next sign-in on every node.
 *
 * Reading is for anyone with the Settings section. Changing is for
 * administrators only, because a group mapping can make someone an administrator.
 */
import type {
  BundleRequest,
  BundleSection,
  ProviderOverrideInput,
  ServerBundle,
} from '@crombolo/server'
import manifest from '../package.json' with { type: 'json' }

const CAPABILITIES = ['identityProviders', 'log'] as const

type Capability = (typeof CAPABILITIES)[number]

export const ENTRA_BUNDLE_ID = manifest.crombolo.id

export interface EntraSettingsOptions {
  /** The section a caller must have to see the screen; Settings by default. */
  section?: BundleSection
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

const AUDIENCES = new Set(['member', 'user'])

/** The fields the screen sends, each checked for its type; nothing else is passed on. */
export function readOverrides(body: Record<string, unknown>): ProviderOverrideInput {
  const out: ProviderOverrideInput = {}
  for (const field of ['name', 'tenantId', 'clientId'] as const)
    if (field in body && (typeof body[field] === 'string' || body[field] === null))
      out[field] = (body[field] as string | null)?.trim() || undefined
  if ('clientSecret' in body) {
    const secret = body.clientSecret
    if (secret === null) out.clientSecret = null
    else if (typeof secret === 'string' && secret.trim()) out.clientSecret = secret.trim()
  }
  for (const field of ['autoCreate', 'linkByEmail', 'emailsVerified'] as const)
    if (field in body) out[field] = typeof body[field] === 'boolean' ? body[field] : undefined
  if ('groupMap' in body) {
    const map = body.groupMap
    if (map === null) out.groupMap = undefined
    else if (map && typeof map === 'object' && !Array.isArray(map)) {
      const entries = Object.entries(map as Record<string, unknown>)
        .filter(([key, value]) => key.trim() && typeof value === 'string' && value.trim())
        .map(([key, value]) => [key.trim(), (value as string).trim()])
      out.groupMap = Object.fromEntries(entries)
    }
  }
  if ('defaultGroups' in body) {
    const groups = body.defaultGroups
    out.defaultGroups = Array.isArray(groups)
      ? groups
          .filter((g): g is string => typeof g === 'string' && g.trim() !== '')
          .map((g) => g.trim())
      : undefined
  }
  return out
}

const parseBody = async (request: Request): Promise<Record<string, unknown>> => {
  const body = await request.json().catch(() => undefined)
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

type Context = BundleRequest<Capability>

/** The provider a route names, when it is an Entra one the config declares. */
async function entraProvider(context: Context) {
  const { audience, id } = context.params
  if (!audience || !AUDIENCES.has(audience)) return undefined
  const all = await context.host.identityProviders.list()
  return all.find((p) => p.kind === 'entra' && p.audience === audience && p.id === id)
}

const adminOnly = () =>
  json({ ok: false, message: 'Only an administrator can change how people sign in.' }, 403)

/** The Entra settings screen's server half, for `bundles: [entraSettings()]` in `crombolo.config.ts`. */
export function entraSettings(options: EntraSettingsOptions = {}): ServerBundle<Capability> {
  return {
    id: ENTRA_BUNDLE_ID,
    section: options.section ?? 'settings',
    capabilities: CAPABILITIES,
    routes: [
      {
        method: 'GET',
        path: 'providers',
        async handler({ host, principal }) {
          const providers = (await host.identityProviders.list()).filter((p) => p.kind === 'entra')
          return json({ canEdit: principal.isAdmin, providers })
        },
      },
      {
        method: 'GET',
        path: 'groups/:audience',
        async handler({ host, params }) {
          if (!params.audience || !AUDIENCES.has(params.audience))
            return json({ ok: false, message: 'Groups are for members or users.' }, 404)
          return json({
            groups: await host.identityProviders.groups(params.audience as 'member' | 'user'),
          })
        },
      },
      {
        method: 'PUT',
        path: 'providers/:audience/:id',
        async handler(context) {
          if (!context.principal.isAdmin) return adminOnly()
          const provider = await entraProvider(context)
          if (!provider) return json({ ok: false, message: 'There is no such Entra sign-in.' }, 404)
          const outcome = await context.host.identityProviders.update(
            provider.audience,
            provider.id,
            readOverrides(await parseBody(context.request)),
          )
          if (!outcome.ok) return json({ ok: false, message: outcome.error }, 400)
          context.host.log.info('{user} changed the {audience} Entra sign-in {id}', {
            user: context.principal.email,
            audience: provider.audience,
            id: provider.id,
          })
          return json({ ok: true, provider: await entraProvider(context) })
        },
      },
      {
        method: 'DELETE',
        path: 'providers/:audience/:id',
        async handler(context) {
          if (!context.principal.isAdmin) return adminOnly()
          const provider = await entraProvider(context)
          if (!provider) return json({ ok: false, message: 'There is no such Entra sign-in.' }, 404)
          await context.host.identityProviders.reset(provider.audience, provider.id)
          context.host.log.info('{user} put the {audience} Entra sign-in {id} back to the code', {
            user: context.principal.email,
            audience: provider.audience,
            id: provider.id,
          })
          return json({ ok: true, provider: await entraProvider(context) })
        },
      },
      {
        method: 'POST',
        path: 'providers/:audience/:id/test',
        async handler(context) {
          const provider = await entraProvider(context)
          if (!provider) return json({ ok: false, message: 'There is no such Entra sign-in.' }, 404)
          return json(await context.host.identityProviders.test(provider.audience, provider.id))
        },
      },
    ],
  }
}
