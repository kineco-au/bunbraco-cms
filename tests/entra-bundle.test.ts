/**
 * Story 033: an identity provider's settings, changed from the backoffice. Core
 * keeps the overrides (a sealed secret among them) and applies them at sign-in;
 * the Entra bundle is the screen's server half over them.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENTRA_BUNDLE_ID, entraSettings, readOverrides } from '@crombolo/entra'
import {
  type CromboloConfig,
  effectiveProvider,
  entra,
  IdentityProviderOverrides,
  oidc,
} from '@crombolo/server'
import { type Harness, signedInServer, signInAsGroup } from './support/harness.ts'

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const SECRET_KEY = 'a-test-secret-key-that-is-long-enough-to-use'

describe('a provider with overrides', () => {
  const code = entra({ tenantId: 'contoso', clientId: 'code-client', clientSecret: 'code-secret' })

  test("keeps the code's settings where nothing was changed", () => {
    expect(effectiveProvider(code, {})).toEqual(code)
  })

  test('takes the changes, and a new Entra tenant moves the issuer with it', () => {
    const changed = effectiveProvider(code, {
      tenantId: 'fabrikam',
      clientId: 'new-client',
      clientSecret: 'new-secret',
      linkByEmail: true,
      groupMap: { g1: 'editor' },
    })
    expect(changed.tenantId).toBe('fabrikam')
    expect(changed.oidc.issuer).toBe('https://login.microsoftonline.com/fabrikam/v2.0')
    expect([changed.oidc.clientId, changed.oidc.clientSecret]).toEqual(['new-client', 'new-secret'])
    expect([changed.linkByEmail, changed.groupMap]).toEqual([true, { g1: 'editor' }])
    expect(changed.oidc.id).toBe('entra')
  })
})

describe('what the screen may send', () => {
  test('is read field by field, and anything else is dropped', () => {
    expect(
      readOverrides({
        tenantId: ' t2 ',
        clientSecret: '  s3cret ',
        autoCreate: false,
        linkByEmail: 'yes',
        groupMap: { ' g1 ': ' editor ', '': 'x', g2: 7 },
        defaultGroups: ['writer', '', 3],
        issuer: 'https://evil.example',
      }),
    ).toEqual({
      tenantId: 't2',
      clientSecret: 's3cret',
      autoCreate: false,
      linkByEmail: undefined,
      groupMap: { g1: 'editor' },
      defaultGroups: ['writer'],
    })
    expect(readOverrides({ clientSecret: null, groupMap: null })).toEqual({
      clientSecret: null,
      groupMap: undefined,
    })
  })
})

describe(`overrides in the database (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('seal the secret, apply on top of the code, and reset to it', async () => {
    const h = await signedInServer()
    open.push(h)
    const code = oidc({ id: 'okta', name: 'Okta', issuer: 'https://okta.example', clientId: 'c' })
    const store = new IdentityProviderOverrides(h.server.db, SECRET_KEY)
    expect(
      await store.update('user', 'okta', { clientId: 'c2', clientSecret: 'shh', name: 'Our Okta' }),
    ).toEqual({ ok: true })

    const row = await h.server.db.query<{ value: string }>(
      "SELECT value FROM key_value WHERE key = 'crombolo:identity-provider:user:okta'",
    )
    expect(row[0]?.value).not.toContain('shh')
    expect(await store.get('user', 'okta')).toEqual({
      overrides: { clientId: 'c2', name: 'Our Okta' },
      hasClientSecret: true,
    })
    const applied = await store.apply('user', code)
    expect([applied.oidc.clientId, applied.oidc.clientSecret, applied.oidc.name]).toEqual([
      'c2',
      'shh',
      'Our Okta',
    ])
    // The other audience's provider of the same id is its own.
    expect((await store.apply('member', code)).oidc.clientId).toBe('c')

    // Clearing one field puts that field back.
    await store.update('user', 'okta', { name: '' })
    expect((await store.apply('user', code)).oidc.name).toBe('Okta')

    await store.reset('user', 'okta')
    expect(await store.apply('user', code)).toEqual(code)
  })

  test('refuse to keep a secret without CROMBOLO_SECRET_KEY', async () => {
    const h = await signedInServer()
    open.push(h)
    const store = new IdentityProviderOverrides(h.server.db, undefined)
    const refused = await store.update('user', 'okta', { clientSecret: 'shh' })
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.error).toContain('CROMBOLO_SECRET_KEY')
    expect(await store.update('user', 'okta', { clientId: 'fine' })).toEqual({ ok: true })
  })
})

/** A site declaring an Entra sign-in for the backoffice, an OIDC one for members, and the bundle. */
async function site(config: Partial<CromboloConfig> = {}, section?: 'content') {
  const root = mkdtempSync(join(process.cwd(), 'output', 'entra-bundle-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'a-site', dependencies: { '@crombolo/entra': '*' } }),
  )
  const h = await signedInServer({
    config: {
      siteDir: root,
      schemaDir: join(root, 'schema'),
      bundles: [entraSettings(section ? { section } : {})],
      backofficeIdentityProviders: [
        entra({ tenantId: 'contoso', clientId: 'code-client', clientSecret: 'code-secret' }),
      ],
      memberIdentityProviders: [
        oidc({ id: 'okta', name: 'Okta', issuer: 'https://okta.example', clientId: 'c' }),
      ],
      ...config,
    },
  })
  open.push(h)
  const base = `${h.server.paths.pluginPath}/api/bundle/${ENTRA_BUNDLE_ID}`
  return { h, base }
}

interface Listed {
  canEdit: boolean
  providers: Array<{
    audience: string
    id: string
    kind: string
    tenantId: string | null
    issuer: string
    clientId: string
    hasClientSecret: boolean
    overridden: string[]
    callbackPath: string
    groupMap: Record<string, string>
  }>
}

describe(`the Entra bundle (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('lists only the Entra sign-ins, as in force, and never a secret', async () => {
    const { h, base } = await site()
    const listed = await h.json<Listed>(`${base}/providers`)
    expect(listed.canEdit).toBe(true)
    expect(listed.providers).toHaveLength(1)
    const [provider] = listed.providers
    expect(provider).toMatchObject({
      audience: 'user',
      id: 'entra',
      kind: 'entra',
      tenantId: 'contoso',
      clientId: 'code-client',
      hasClientSecret: true,
      overridden: [],
      callbackPath: '/umbraco/management/api/v1/security/back-office/external/entra/callback',
    })
    expect(JSON.stringify(listed)).not.toContain('code-secret')
  })

  test('changes the tenant and the group mappings, and puts them back', async () => {
    const { h, base } = await site()
    const at = `${base}/providers/user/entra`
    const saved = await h.call(at, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'fabrikam', groupMap: { 'g-1': 'editor' } }),
    })
    expect(saved.status).toBe(200)
    const [changed] = (await h.json<Listed>(`${base}/providers`)).providers
    expect(changed?.issuer).toBe('https://login.microsoftonline.com/fabrikam/v2.0')
    expect(changed?.groupMap).toEqual({ 'g-1': 'editor' })
    expect(changed?.overridden.sort()).toEqual(['groupMap', 'tenantId'])

    expect((await h.call(at, { method: 'DELETE' })).status).toBe(200)
    const [back] = (await h.json<Listed>(`${base}/providers`)).providers
    expect([back?.tenantId, back?.overridden]).toEqual(['contoso', []])
  })

  test('keeps a new client secret only where it can be sealed', async () => {
    const without = await site()
    const refused = await without.h.call(`${without.base}/providers/user/entra`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientSecret: 'rotated' }),
    })
    expect(refused.status).toBe(400)

    const sealed = await site({ secretKey: SECRET_KEY })
    const accepted = await sealed.h.call(`${sealed.base}/providers/user/entra`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientSecret: 'rotated' }),
    })
    expect(accepted.status).toBe(200)
    const [provider] = (await sealed.h.json<Listed>(`${sealed.base}/providers`)).providers
    expect(provider?.overridden).toEqual(['clientSecret'])
    expect(JSON.stringify(provider)).not.toContain('rotated')
  })

  test('offers the user groups to map onto, and refuses a provider it does not edit', async () => {
    const { h, base } = await site()
    const groups = await h.json<{ groups: Array<{ value: string; name: string }> }>(
      `${base}/groups/user`,
    )
    expect(groups.groups.map((g) => g.value)).toContain('editor')
    expect((await h.call(`${base}/providers/member/okta`, { method: 'DELETE' })).status).toBe(404)
  })

  test('lets only an administrator change anything', async () => {
    const { h, base } = await site({}, 'content')
    const editor = await signInAsGroup(h, 'editor')
    const listed = await editor.json<Listed>(`${base}/providers`)
    expect(listed.canEdit).toBe(false)
    const refused = await editor.call(`${base}/providers/user/entra`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupMap: { anyone: 'admin' } }),
    })
    expect(refused.status).toBe(403)
    expect((await editor.call(`${base}/providers/user/entra`, { method: 'DELETE' })).status).toBe(
      403,
    )
  })
})
