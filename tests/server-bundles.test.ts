/**
 * The server-side bundle capability, and the guardrails that are the reason it
 * exists at all (`docs/17-bundles.md`).
 *
 * The mechanism is tested on its own here, with a stub host and no database: the
 * things that must hold — a bundle cannot leave its namespace, cannot be reached
 * without a session, cannot widen its own authorisation, cannot see a capability
 * it did not declare, and cannot take the request path down — are properties of
 * this file rather than of any particular bundle.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Principal } from '@bunbraco/api-management'
import {
  BUNDLE_API_SEGMENT,
  type BundleHost,
  createServerBundles,
  loadConfig,
  type ServerBundle,
  validateRedirectInput,
  validateServerBundles,
} from '@bunbraco/server'
import { ROOT } from '../scripts/packages.ts'

const PLUGIN_API = '/umbraco/bunbraco/api'
const BASE = `${PLUGIN_API}/${BUNDLE_API_SEGMENT}/`

const admin: Principal = {
  id: 'f0000000-0000-0000-0000-000000000001',
  userName: 'admin@example.com',
  name: 'Admin',
  email: 'admin@example.com',
  isAdmin: true,
  allowedSections: ['settings', 'content'],
  permissions: [],
  groupKeys: [],
  hasAccessToAllLanguages: true,
} as unknown as Principal

const editor: Principal = { ...admin, isAdmin: false, allowedSections: ['content'] }

/** Enough of a host to see what a handler is given, without a database. */
const stubHost = (): BundleHost => ({
  redirects: {
    list: async () => ({ total: 0, items: [] }),
    byKey: async () => undefined,
    save: async () => ({ ok: false, message: 'stub' }),
    replace: async () => ({ ok: false, message: 'stub' }),
    remove: async () => 'notFound',
  },
  documents: { url: async () => undefined },
  log: { info: () => {}, warn: () => {}, error: () => {} },
})

const silent = () => ({ info: () => {}, warn: () => {}, error: () => {} })

function mount(bundles: ServerBundle[]) {
  return createServerBundles({
    bundles,
    pluginApiPath: PLUGIN_API,
    host: stubHost(),
    log: silent,
  })
}

const ok = (body: unknown = { ok: true }) => Response.json(body)

const simple = (overrides: Partial<ServerBundle> = {}): ServerBundle =>
  ({
    id: 'demo',
    name: 'Demo',
    section: 'settings',
    capabilities: ['log'],
    routes: [{ method: 'GET', path: 'things', handler: () => ok() }],
    ...overrides,
  }) as ServerBundle

const call = (
  bundles: ReturnType<typeof mount>,
  path: string,
  init: RequestInit = {},
  principal = admin,
) => {
  const url = new URL(`http://localhost${path}`)
  return bundles.handle(new Request(url, init), url, principal)
}

describe('what a bundle may declare', () => {
  test('accepts an ordinary bundle', () => {
    expect(validateServerBundles([simple()])).toEqual([])
  })

  test('refuses an id that could escape its own namespace', () => {
    // The id is a URL segment, so a dot, a slash or an upper-case letter is not
    // a cosmetic objection: `../` in a segment is a different route entirely.
    for (const id of ['../other', 'a/b', 'Demo', 'demo.thing', '', 'a', 'x'.repeat(40)])
      expect(validateServerBundles([simple({ id })]), id).not.toBeEmpty()
  })

  test('refuses two bundles claiming one id', () => {
    const problems = validateServerBundles([simple(), simple({ name: 'Other' })])
    expect(problems.join('\n')).toContain('Two bundles claim the id "demo"')
  })

  test('refuses a capability no host offers', () => {
    const problems = validateServerBundles([
      simple({ capabilities: ['filesystem'] as unknown as ServerBundle['capabilities'] }),
    ])
    expect(problems.join('\n')).toContain('filesystem')
  })

  test('refuses a route path that is not a plain path', () => {
    for (const path of ['../../etc', '/leading', 'trailing/', 'has space', 'UPPER'])
      expect(
        validateServerBundles([simple({ routes: [{ method: 'GET', path, handler: () => ok() }] })]),
        path,
      ).not.toBeEmpty()
  })

  test('allows the namespace root and a parameter segment', () => {
    expect(
      validateServerBundles([
        simple({
          routes: [
            { method: 'GET', path: '', handler: () => ok() },
            { method: 'GET', path: 'rules/:key', handler: () => ok() },
          ],
        }),
      ]),
    ).toEqual([])
  })

  test('refuses the same method and path twice', () => {
    const problems = validateServerBundles([
      simple({
        routes: [
          { method: 'GET', path: 'things', handler: () => ok() },
          { method: 'GET', path: 'things', handler: () => ok() },
        ],
      }),
    ])
    expect(problems.join('\n')).toContain('declares "GET things" twice')
  })

  test('fails the boot rather than mounting half of a bad set', () => {
    // A bundle answering on a path nobody intended is worse than a site that
    // refuses to start and says which bundle is wrong.
    expect(() => mount([simple({ id: 'Bad' })])).toThrow(/cannot be mounted/)
  })

  test('names every problem at once, so one boot fixes them all', () => {
    try {
      mount([simple({ id: 'Bad', capabilities: ['nope'] as never })])
      throw new Error('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('id "Bad"')
      expect(message).toContain('nope')
    }
  })
})

describe('dispatch', () => {
  test('answers a declared route', async () => {
    const bundles = mount([simple()])
    const response = await call(bundles, `${BASE}demo/things`)
    expect(response?.status).toBe(200)
  })

  test('reports where each bundle is mounted', () => {
    expect(mount([simple()]).mounted[0]?.prefix).toBe(`${BASE}demo`)
  })

  test('passes the parameters of the matched route', async () => {
    let seen: Record<string, string> | undefined
    const bundles = mount([
      simple({
        routes: [
          {
            method: 'GET',
            path: 'rules/:key',
            handler: ({ params }) => {
              seen = params
              return ok()
            },
          },
        ],
      }),
    ])
    await call(bundles, `${BASE}demo/rules/abc-123`)
    expect(seen).toEqual({ key: 'abc-123' })
  })

  test('decodes a parameter, so a key with a slash in it cannot forge a route', async () => {
    let seen: Record<string, string> | undefined
    const bundles = mount([
      simple({
        routes: [
          {
            method: 'GET',
            path: 'rules/:key',
            handler: ({ params }) => {
              seen = params
              return ok()
            },
          },
        ],
      }),
    ])
    await call(bundles, `${BASE}demo/rules/a%2Fb`)
    expect(seen).toEqual({ key: 'a/b' })
  })

  test('tells a wrong method from an unknown path', async () => {
    const bundles = mount([simple()])
    expect((await call(bundles, `${BASE}demo/things`, { method: 'POST' }))?.status).toBe(405)
    expect((await call(bundles, `${BASE}demo/elsewhere`))?.status).toBe(404)
  })

  test('ignores a trailing slash rather than 404ing on it', async () => {
    const bundles = mount([simple()])
    expect((await call(bundles, `${BASE}demo/things/`))?.status).toBe(200)
  })

  test('passes a path no bundle claims back to the caller', async () => {
    // `undefined` rather than a 404: the server has its own routes after this
    // one, and a bundle namespace must not swallow them.
    expect(await call(mount([simple()]), `${BASE}absent/things`)).toBeUndefined()
    expect(await call(mount([simple()]), '/umbraco/bunbraco/api/forms')).toBeUndefined()
  })

  test('does not claim the Bundles section’s own endpoints', async () => {
    // `api/bundles/` and `api/bundle/` differ by one letter, and the marketplace
    // owns the first. The trailing slash in the base path is what keeps them
    // apart, which is too easy to lose to leave untested.
    expect(await call(mount([simple()]), `${PLUGIN_API}/bundles/marketplace`)).toBeUndefined()
  })

  test('a bundle with no routes answers nothing but is still mounted', async () => {
    const bundles = mount([simple({ routes: [] })])
    expect(bundles.mounted).toHaveLength(1)
    expect((await call(bundles, `${BASE}demo/anything`))?.status).toBe(404)
  })
})

describe('authorisation, which belongs to the host', () => {
  test('refuses a caller without the declared section', async () => {
    const bundles = mount([simple()])
    expect((await call(bundles, `${BASE}demo/things`, {}, editor))?.status).toBe(403)
  })

  test('checks the section before the handler runs, not inside it', async () => {
    let reached = false
    const bundles = mount([
      simple({
        routes: [
          {
            method: 'GET',
            path: 'things',
            handler: () => {
              reached = true
              return ok()
            },
          },
        ],
      }),
    ])
    await call(bundles, `${BASE}demo/things`, {}, editor)
    expect(reached).toBe(false)
  })

  test('gates every route on the same section, with no per-route opt out', async () => {
    const bundles = mount([
      simple({
        section: 'settings',
        routes: [
          { method: 'GET', path: 'a', handler: () => ok() },
          { method: 'POST', path: 'b', handler: () => ok() },
          { method: 'DELETE', path: 'c/:id', handler: () => ok() },
        ],
      }),
    ])
    for (const [path, method] of [
      ['a', 'GET'],
      ['b', 'POST'],
      ['c/1', 'DELETE'],
    ] as const)
      expect((await call(bundles, `${BASE}demo/${path}`, { method }, editor))?.status).toBe(403)
  })

  test('honours a bundle that chose a different section', async () => {
    const bundles = mount([simple({ section: 'content' })])
    expect((await call(bundles, `${BASE}demo/things`, {}, editor))?.status).toBe(200)
  })
})

describe('what a handler is given', () => {
  test('only the capabilities it declared', async () => {
    let host: Record<string, unknown> | undefined
    const bundles = mount([
      simple({
        capabilities: ['log'],
        routes: [
          {
            method: 'GET',
            path: 'things',
            handler: (context) => {
              host = context.host as unknown as Record<string, unknown>
              return ok()
            },
          },
        ],
      }),
    ])
    await call(bundles, `${BASE}demo/things`)
    expect(Object.keys(host ?? {})).toEqual(['log'])
    expect(host?.redirects).toBeUndefined()
    expect(host?.documents).toBeUndefined()
  })

  test('a frozen object, so one bundle cannot furnish another', async () => {
    let host: Record<string, unknown> | undefined
    const bundles = mount([
      simple({
        routes: [
          {
            method: 'GET',
            path: 'things',
            handler: (context) => {
              host = context.host as unknown as Record<string, unknown>
              return ok()
            },
          },
        ],
      }),
    ])
    await call(bundles, `${BASE}demo/things`)
    expect(Object.isFrozen(host)).toBe(true)
  })

  test('the authenticated caller, never an anonymous one', async () => {
    let principal: Principal | undefined
    const bundles = mount([
      simple({
        routes: [
          {
            method: 'GET',
            path: 'things',
            handler: (context) => {
              principal = context.principal
              return ok()
            },
          },
        ],
      }),
    ])
    await call(bundles, `${BASE}demo/things`)
    expect(principal?.email).toBe('admin@example.com')
  })

  test('a log named for the bundle rather than the host’s own', async () => {
    const named: string[] = []
    const bundles = createServerBundles({
      bundles: [
        simple({
          routes: [
            {
              method: 'GET',
              path: 'things',
              handler: ({ host }) => {
                host.log?.info('hello')
                return ok()
              },
            },
          ],
        }),
      ],
      pluginApiPath: PLUGIN_API,
      host: stubHost(),
      log: (id) => {
        named.push(id)
        return silent()
      },
    })
    await call(bundles, `${BASE}demo/things`)
    expect(named).toEqual(['demo'])
  })
})

describe('a bundle that misbehaves', () => {
  test('becomes its own 500 rather than an unhandled rejection', async () => {
    const bundles = mount([
      simple({
        routes: [
          {
            method: 'GET',
            path: 'things',
            handler: () => {
              throw new Error('boom')
            },
          },
        ],
      }),
    ])
    const response = await call(bundles, `${BASE}demo/things`)
    expect(response?.status).toBe(500)
    expect(await response?.text()).not.toContain('boom')
  })

  test('is named in the log when it fails', async () => {
    const errors: string[] = []
    const bundles = createServerBundles({
      bundles: [
        simple({
          routes: [
            {
              method: 'GET',
              path: 'things',
              handler: () => {
                throw new Error('boom')
              },
            },
          ],
        }),
      ],
      pluginApiPath: PLUGIN_API,
      host: stubHost(),
      log: () => ({ info: () => {}, warn: () => {}, error: (message) => errors.push(message) }),
    })
    await call(bundles, `${BASE}demo/things`)
    expect(errors.join('\n')).toContain('{bundle}')
  })

  test('cannot take another bundle down with it', async () => {
    const bundles = mount([
      simple({
        routes: [
          {
            method: 'GET',
            path: 'things',
            handler: () => {
              throw new Error('boom')
            },
          },
        ],
      }),
      simple({ id: 'other', name: 'Other' }),
    ])
    expect((await call(bundles, `${BASE}demo/things`))?.status).toBe(500)
    expect((await call(bundles, `${BASE}other/things`))?.status).toBe(200)
  })
})

describe('nothing mounts a bundle except the site’s own configuration', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

  test('the default is no bundles, whatever the environment says', () => {
    // There is deliberately no BUNBRACO_BUNDLES: an environment variable naming
    // a package would be a way to start third-party server code without a code
    // change, which is the whole thing this design refuses.
    expect(loadConfig({}).bundles).toEqual([])
    expect(read('packages/server/src/config.ts')).not.toContain('BUNBRACO_BUNDLES')
  })

  test('the server mounts exactly what the configuration listed', () => {
    expect(read('packages/server/src/server.ts')).toContain('bundles: config.bundles')
  })

  test('discovery reads manifests and never imports a dependency’s code', () => {
    // An installed bundle's client half is read as JSON out of its
    // `package.json`. If discovery ever evaluated a module from the package, an
    // install would be enough to run its code in this process.
    const discovery = read('packages/backoffice-host/src/extensions.ts')
    expect(discovery).toContain('JSON.parse')
    expect(discovery).not.toMatch(/\bimport\s*\(/)
    expect(discovery).not.toContain('require(')
  })

  test('installing one runs the package manager and nothing of the package', () => {
    const marketplace = read('packages/server/src/marketplace.ts')
    expect(marketplace).toContain('bun')
    expect(marketplace).not.toMatch(/\bimport\s*\(\s*(?:name|`|resolved)/)
  })

  test('a web node serves no bundle route at all', () => {
    // These are backoffice endpoints; a public node has no business holding them.
    expect(read('packages/server/src/server.ts')).toMatch(
      /const bundles = servesBackOffice\s*\?\s*createServerBundles\(/,
    )
  })
})

describe('the redirect rule a bundle may store', () => {
  const valid = {
    matchKind: 'exact' as const,
    pattern: '/old',
    targetKind: 'path' as const,
    target: '/new',
  }

  test('normalises the pattern the way the matcher will read it', () => {
    const checked = validateRedirectInput({ ...valid, pattern: 'Old/Page/' })
    expect(checked.ok && checked.value.pattern).toBe('/old/page')
  })

  test('defaults to a permanent redirect', () => {
    const checked = validateRedirectInput(valid)
    expect(checked.ok && checked.value.statusCode).toBe(301)
  })

  test('refuses a status code that is not a redirect', () => {
    for (const statusCode of [200, 404, 418, 303])
      expect(validateRedirectInput({ ...valid, statusCode }).ok, String(statusCode)).toBe(false)
    for (const statusCode of [301, 302, 307, 308])
      expect(validateRedirectInput({ ...valid, statusCode }).ok, String(statusCode)).toBe(true)
  })

  test('refuses a regular expression that will not compile', () => {
    // The matcher runs this against every unresolved request path, so a pattern
    // that throws there would 500 the public site rather than this screen.
    const checked = validateRedirectInput({ ...valid, matchKind: 'regex', pattern: '([a-' })
    expect(checked.ok).toBe(false)
    expect(!checked.ok && checked.message).toContain('regular expression')
  })

  test('keeps a regular expression exactly as written', () => {
    const checked = validateRedirectInput({
      ...valid,
      matchKind: 'regex',
      pattern: '^/News/(\\d+)$',
    })
    expect(checked.ok && checked.value.pattern).toBe('^/News/(\\d+)$')
  })

  test('refuses a rule that points a URL at itself', () => {
    const checked = validateRedirectInput({ ...valid, pattern: '/loop', target: '/loop/' })
    expect(!checked.ok && checked.message).toContain('itself')
  })

  test('requires a document key for a page target, and lowercases it', () => {
    expect(validateRedirectInput({ ...valid, targetKind: 'document', target: 'a page' }).ok).toBe(
      false,
    )
    const key = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
    const checked = validateRedirectInput({ ...valid, targetKind: 'document', target: key })
    expect(checked.ok && checked.value.target).toBe(key.toLowerCase())
  })

  test('requires a whole URL for an external target', () => {
    expect(validateRedirectInput({ ...valid, targetKind: 'url', target: 'example.com' }).ok).toBe(
      false,
    )
    expect(
      validateRedirectInput({ ...valid, targetKind: 'url', target: 'https://example.com/a' }).ok,
    ).toBe(true)
  })

  test('refuses an empty pattern or target', () => {
    expect(validateRedirectInput({ ...valid, pattern: '   ' }).ok).toBe(false)
    expect(validateRedirectInput({ ...valid, target: '' }).ok).toBe(false)
  })

  test('refuses a match or target kind it does not implement', () => {
    expect(validateRedirectInput({ ...valid, matchKind: 'glob' as never }).ok).toBe(false)
    expect(validateRedirectInput({ ...valid, targetKind: 'rewrite' as never }).ok).toBe(false)
  })

  test('treats an empty culture as every culture', () => {
    const checked = validateRedirectInput({ ...valid, culture: '  ' })
    expect(checked.ok && checked.value.culture).toBeNull()
  })

  test('lowercases a culture, which is how the matcher compares it', () => {
    const checked = validateRedirectInput({ ...valid, culture: 'en-US' })
    expect(checked.ok && checked.value.culture).toBe('en-us')
  })
})
