/**
 * The hardening a security review of the API and front end asked for.
 *
 * Each test here stands for one finding, so a regression names the thing it
 * reopened rather than a symptom. Where a finding belongs to a feature's own
 * suite — the assistant's guardrails, the git routes, media uploads — the test
 * lives there instead and this file leaves it alone.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { authorize, type NodeLookup, type Principal, sectionsOf } from '@crombolo/api-management'
import { AuthService, type AuthStore, hashPassword } from '@crombolo/auth'
import { listOperations, loadSpec, type OperationInfo } from '@crombolo/contracts'
import { localReturnUrl, sectionKey, toSectionAliases } from '@crombolo/core'
import { loadConfig, type ServerBundle } from '@crombolo/server'
import { BACKOFFICE, type Harness, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

const site = async (config: Record<string, unknown> = {}) => {
  const h = await signedInServer({ config })
  open.push(h)
  return h
}

describe('a returnUrl that leaves the site', () => {
  test('is reduced to a local path, whichever way it is written', () => {
    expect(localReturnUrl('/umbraco/section/content')).toBe('/umbraco/section/content')
    expect(localReturnUrl('/a?b=1#c')).toBe('/a?b=1#c')
    // Normalised, so what is stored cannot be read differently later.
    expect(localReturnUrl('/../../x')).toBe('/x')

    // A browser reads every one of these as leaving the site.
    expect(localReturnUrl('//evil.example')).toBeUndefined()
    expect(localReturnUrl('/\\evil.example')).toBeUndefined()
    expect(localReturnUrl('\\\\/evil.example')).toBeUndefined()
    expect(localReturnUrl('https://evil.example/umbraco')).toBeUndefined()
    expect(localReturnUrl('javascript:fetch("/umbraco")')).toBeUndefined()
    // Tabs and newlines are stripped before a URL is resolved, so these would
    // otherwise pass a leading-slash test and then become protocol-relative.
    expect(localReturnUrl('/\t/evil.example')).toBeUndefined()
    expect(localReturnUrl('/\n\\evil.example')).toBeUndefined()
    expect(localReturnUrl(undefined)).toBeUndefined()
    expect(localReturnUrl('')).toBeUndefined()
  })

  test('never reaches the login page, which navigates there once signed in', async () => {
    const h = await site()
    const login = `${BACKOFFICE}/login`

    const hostile = await h.call(`${login}?returnUrl=${encodeURIComponent('javascript:alert(1)')}`)
    const html = await hostile.text()
    expect(hostile.status).toBe(200)
    expect(html).not.toContain('javascript:alert')
    expect(html).toContain(`return-url="${BACKOFFICE}"`)

    const offsite = await h.call(`${login}?returnUrl=${encodeURIComponent('https://evil.example')}`)
    expect(await offsite.text()).not.toContain('evil.example')

    // What the authorize endpoint actually sends is carried through unchanged.
    const resuming = await h.call(`${login}?returnUrl=${encodeURIComponent('/umbraco/oauth')}`)
    expect(await resuming.text()).toContain('return-url="/umbraco/oauth"')
  })

  test('and the login page checks it again before navigating', async () => {
    // The page is browser code, so this is a source-level guard: the navigation
    // happens the instant a session exists, which is the most valuable moment to
    // send someone elsewhere, and a page served from a cache or an older build
    // must not trust the attribute either.
    const page = await Bun.file('packages/backoffice-host/assets/login.js').text()
    expect(page).toContain('function localTarget(')
    expect(page).toContain('resolved.origin !== window.location.origin')
    expect(page).toContain('window.location.href = localTarget(this.returnUrl,')
    // Never the raw attribute.
    expect(page).not.toMatch(/location\.href\s*=\s*this\.returnUrl/)
  })
})

describe('the media collection', () => {
  const operation = (operationId: string): OperationInfo => {
    const found = listOperations(loadSpec()).find((o) => o.operationId === operationId)
    if (!found) throw new Error(`${operationId} is not in the contract.`)
    return found
  }

  const principal = (): Principal => ({
    id: 'u',
    userName: 'u',
    name: 'u',
    email: 'u@example.com',
    isAdmin: false,
    languageIsoCode: undefined,
    avatarUrls: [],
    allowedSections: ['Umb.Section.Media'],
    permissions: [],
    groupKeys: [],
    hasAccessToAllLanguages: true,
    languages: [],
    startNodes: {
      document: { root: false, keys: [] },
      // One folder, deep in the tree: the media a restricted user may work in.
      media: { root: false, keys: ['mine'] },
      element: { root: false, keys: [] },
    },
    groups: [],
  })

  const nodes: NodeLookup = {
    documents: async () => new Map(),
    media: async (keys) =>
      new Map(keys.map((key) => [key.toLowerCase(), { chain: [key], trashed: false }])),
    documentDescendants: async () => [],
    versionDocument: async () => undefined,
  }

  const ask = (query: string) =>
    authorize(
      operation('GetCollectionMedia'),
      {},
      new Request(`http://localhost/umbraco/management/api/v1/collection/media${query}`),
      principal(),
      nodes,
    )

  test('stops where the caller does, and omitting the parent means the root', async () => {
    expect(await ask('?id=mine&skip=0&take=10')).toBe(true)
    // Somebody else's folder: the section alone used to be enough to read it.
    expect(await ask('?id=theirs&skip=0&take=10')).toBe(false)
    // No parent is the root, which needs root access rather than no check.
    expect(await ask('?skip=0&take=10')).toBe(false)
  })

  test('sections are read the same way wherever they came from', () => {
    const bare = { ...principal(), allowedSections: ['media', 'Umb.Section.Settings'] }
    expect([...sectionsOf(bare)].sort()).toEqual(['media', 'settings'])
  })

  test('a core section compares as its stored alias whichever name it arrived under', () => {
    // Forms is the core section whose manifest alias is not `Umb.`-prefixed, so
    // stripping the prefix was never enough to match it.
    expect(sectionKey('Crombolo.Section.Forms')).toBe('forms')
    expect(sectionKey('forms')).toBe('forms')
    expect(sectionKey('Umb.Section.Content')).toBe('content')
    expect(sectionKey('Acme.Section.Design')).toBe('acme.section.design')
  })

  test('a section an extension registers survives sign-in; a bare unknown alias does not', () => {
    // Umbraco seeds `forms` with no section behind it, which is the case the drop
    // exists for. An extension's section is stored as its manifest alias and has
    // a manifest to render it, so it must come through.
    expect(toSectionAliases(['content', 'Acme.Section.Design', 'nothing', 'content'])).toEqual([
      'Umb.Section.Content',
      'Acme.Section.Design',
    ])
  })
})

describe('a section an extension registers', () => {
  const SECTION = 'Acme.Section.Design'
  const bundle: ServerBundle = {
    id: 'acme',
    name: 'Acme',
    section: SECTION,
    capabilities: [],
    routes: [{ method: 'GET', path: '', handler: () => Response.json({ ok: true }) }],
  }

  test('can be granted to a group, reaches the signed-in user, and opens the bundle', async () => {
    const h = await site({ bundles: [bundle] })
    const created = await h.post(`${V1}/user-group`, {
      name: 'Designers',
      alias: 'designers',
      sections: [SECTION, 'Umb.Section.Content'],
      languages: [],
      hasAccessToAllLanguages: true,
      documentRootAccess: true,
      documentStartNode: null,
      mediaRootAccess: true,
      mediaStartNode: null,
      elementRootAccess: false,
      elementStartNode: null,
      fallbackPermissions: [],
      permissions: [],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string

    // The grant is stored and read back as the alias the backoffice sent.
    const group = await h.json<{ sections: string[] }>(`${V1}/user-group/${key}`)
    expect(group.sections.sort()).toEqual([SECTION, 'Umb.Section.Content'])

    // The signed-in user holds it, which is what makes the backoffice show the tab.
    const designer = await signInAsGroup(h, 'designers')
    open.push(designer)
    const me = await designer.json<{ allowedSections: string[] }>(`${V1}/user/current`)
    expect(me.allowedSections).toContain(SECTION)

    // A bundle gated on it answers them and refuses the administrator, who was
    // never granted it: core sections do not imply an extension's.
    const route = `${BACKOFFICE}/crombolo/api/bundle/acme`
    expect((await designer.call(route)).status).toBe(200)
    expect((await h.call(route)).status).toBe(403)
  })
})

describe('the plugin routes outside the contract', () => {
  test('the change report gives the findings to Settings and the health to everyone', async () => {
    const h = await site()
    const report = `${BACKOFFICE}/crombolo/api/change-report`
    const asAdmin = await h.json<{ health: unknown; findings?: unknown[] }>(report)
    expect(asAdmin.findings).toEqual([])

    // A writer still learns that this node is read-only, because that is the
    // banner in their header and failing saves with no reason is worse than
    // knowing. What they do not get is which documents are unfilled.
    const writer = await signInAsGroup(h)
    const asWriter = await writer.json<{
      health: { ok: boolean }
      findings?: unknown[]
      counts?: unknown
    }>(report)
    expect(asWriter.health).toMatchObject({ ok: true })
    expect(asWriter.findings).toBeUndefined()
    expect(asWriter.counts).toBeUndefined()

    const anonymous = await h.server.fetch(new Request(`http://localhost${report}`))
    expect(anonymous.status).toBe(401)
  })
})

describe('a locked-out account', () => {
  const service = async (isLockedOut: boolean) => {
    const passwordHash = await hashPassword('the-real-password')
    const store = {
      findUserByLogin: async () => ({ id: 1, isLockedOut, isApproved: true, passwordHash }),
      recordLoginFailure: async () => 1,
      lockOut: async () => {},
      recordLoginSuccess: async () => {},
    } as unknown as AuthStore
    return new AuthService(store)
  }

  test('answers the same whether or not the password is right', async () => {
    const locked = await service(true)
    // Both are the lockout, so the status no longer says which guess was the
    // real password — which is what made guessing on after a lockout useful.
    expect(await locked.login('admin', 'the-real-password')).toMatchObject({
      status: 'notAllowed',
      reason: 'lockedOut',
    })
    expect(await locked.login('admin', 'wrong')).toMatchObject({
      status: 'notAllowed',
      reason: 'lockedOut',
    })
  })

  test('and once it is not locked, the two answers part company again', async () => {
    const usable = await service(false)
    expect((await usable.login('admin', 'the-real-password')).status).toBe('success')
    expect((await usable.login('admin', 'wrong')).status).toBe('invalid')
  })
})

describe('the request body limit', () => {
  test('is set on the server, far below the 128 MB Bun would otherwise accept', async () => {
    expect(loadConfig().maxRequestBodyBytes).toBe(32 * 1024 * 1024)
    const h = await site()
    expect(h.server.serveOptions.maxRequestBodySize).toBe(32 * 1024 * 1024)
    expect(h.server.serveOptions.maxRequestBodySize).toBeLessThan(128 * 1024 * 1024)
  })
})
