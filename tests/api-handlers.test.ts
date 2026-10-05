/** The Phase 1 Management API handlers, exercised with an authenticated caller. */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createManagementApiRouter, type Principal } from '@bunbraco/api-management'
import { createBackOfficePaths, createExtensionRegistry } from '@bunbraco/backoffice-host'
import { CORE_SECTION_ALIASES, ROOT_ACCESS } from '@bunbraco/core'
import { CORE_SECTIONS, createDeps, loadConfig } from '@bunbraco/server'

const paths = createBackOfficePaths()
const deps = createDeps({
  config: loadConfig(),
  paths,
  extensions: createExtensionRegistry(join(import.meta.dir, '../apps/site')),
})

const PRINCIPAL: Principal = {
  id: '1a2b3c4d-0000-0000-0000-000000000000',
  userName: 'admin',
  name: 'Administrator',
  email: 'admin@example.com',
  isAdmin: true,
  languageIsoCode: 'en-US',
  avatarUrls: [],
  allowedSections: [...CORE_SECTION_ALIASES],
  permissions: [],
  groupKeys: [],
  hasAccessToAllLanguages: true,
  languages: [],
  startNodes: { document: ROOT_ACCESS, media: ROOT_ACCESS, element: ROOT_ACCESS },
  groups: [],
}

const router = createManagementApiRouter({ deps, authenticate: async () => PRINCIPAL })
const V1 = '/umbraco/management/api/v1'
const get = (path: string) => router.dispatch(new Request(`http://localhost${path}`))

describe('server/information', () => {
  test('returns the fields that gate production-only UI', async () => {
    const body = await (await get(`${V1}/server/information`)).json()
    expect(Object.keys(body).sort()).toEqual([
      'assemblyVersion',
      'baseUtcOffset',
      'runtimeMode',
      'version',
    ])
    expect(['BackofficeDevelopment', 'Development', 'Production']).toContain(body.runtimeMode)
  })
})

describe('user/current', () => {
  test('carries every property the contract marks required', async () => {
    const response = await get(`${V1}/user/current`)
    expect(response.status).toBe(200)
    const body = await response.json()
    for (const required of [
      'id',
      'languageIsoCode',
      'documentStartNodeIds',
      'hasDocumentRootAccess',
      'mediaStartNodeIds',
      'hasMediaRootAccess',
      'elementStartNodeIds',
      'hasElementRootAccess',
      'avatarUrls',
      'languages',
      'hasAccessToAllLanguages',
      'hasAccessToSensitiveData',
      'fallbackPermissions',
      'permissions',
      'allowedSections',
      'isAdmin',
      'email',
      'userName',
      'name',
      'userGroupIds',
    ]) {
      expect(body).toHaveProperty(required)
    }
  })

  test('reflects the authenticated principal', async () => {
    const body = await (await get(`${V1}/user/current`)).json()
    expect(body.id).toBe(PRINCIPAL.id)
    expect(body.userName).toBe(PRINCIPAL.userName)
    expect(body.isAdmin).toBe(true)
  })

  test('allows only sections the backoffice knows how to render', async () => {
    // An unknown alias renders nothing; an empty list renders no navigation.
    const body = await (await get(`${V1}/user/current`)).json()
    expect(body.allowedSections).toEqual([...CORE_SECTIONS])
  })
})

describe('manifests', () => {
  test('public and private partition the full set', async () => {
    const all = await (await get(`${V1}/manifest/manifest`)).json()
    const pub = await (await get(`${V1}/manifest/manifest/public`)).json()
    const priv = await (await get(`${V1}/manifest/manifest/private`)).json()
    expect(pub.length + priv.length).toBe(all.length)
  })

  test('each manifest has the required wire shape', async () => {
    for (const manifest of await (await get(`${V1}/manifest/manifest`)).json()) {
      expect(typeof manifest.name).toBe('string')
      expect(Array.isArray(manifest.extensions)).toBe(true)
    }
  })
})

describe('localization', () => {
  test('cultures are paged with total/items', async () => {
    const body = await (await get(`${V1}/culture`)).json()
    expect(typeof body.total).toBe('number')
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items[0]).toHaveProperty('englishName')
  })

  test('the default language is flagged', async () => {
    const body = await (await get(`${V1}/language`)).json()
    expect(body.items.filter((l: { isDefault: boolean }) => l.isDefault)).toHaveLength(1)
    const fallback = await (await get(`${V1}/item/language/default`)).json()
    expect(fallback.isDefault).toBe(true)
  })

  test('respects skip and take', async () => {
    const all = await (await get(`${V1}/culture`)).json()
    const page = await (await get(`${V1}/culture?skip=2&take=2`)).json()
    expect(page.total).toBe(all.total)
    expect(page.items).toHaveLength(2)
    expect(page.items[0]).toEqual(all.items[2])
  })

  test('rejects a skip that is not a multiple of take', async () => {
    const response = await get(`${V1}/culture?skip=3&take=2`)
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.type).toBe('Error')
    expect(body.detail).toContain('multiple of take')
  })
})
