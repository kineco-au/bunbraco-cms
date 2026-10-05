/**
 * The Packages section's marketplace over npm, and the runtime install.
 * docs/17-bundles.md.
 *
 * Nothing here reaches the network: the registry is a recorded response and the
 * installer is a stub, because what is being checked is the filtering rule, the
 * validation and what the user is told — not npm.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createExtensionRegistry } from '@bunbraco/backoffice-host'
import {
  bunInstaller,
  createMarketplace,
  isValidPackageName,
  isValidVersion,
  type PackageInstaller,
} from '@bunbraco/server'
import {
  BACKOFFICE,
  type Harness,
  ORIGIN,
  signedInServer,
  signInAsGroup,
} from './support/harness.ts'

const dirs: string[] = []
const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const REGISTRY = 'https://registry.example'

/** A site whose node_modules can be written to mid-test, as an install would. */
function site(installed: Record<string, { declares: boolean }> = {}): string {
  const parent = join(import.meta.dir, '..', 'output')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'marketplace-site-'))
  dirs.push(root)
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'a-site',
      dependencies: Object.fromEntries(Object.keys(installed).map((name) => [name, '^1.0.0'])),
    }),
  )
  for (const [name, options] of Object.entries(installed)) addPackage(root, name, options.declares)
  return root
}

function addPackage(root: string, name: string, declares: boolean, version = '1.2.3'): void {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version,
      ...(declares
        ? {
            bunbraco: {
              id: name,
              extensions: [{ type: 'dashboard', alias: `${name}.d`, name, element: 'd.js' }],
            },
          }
        : {}),
    }),
  )
}

const declare = (name: string) => ({
  name,
  version: '1.2.3',
  description: `${name} does a thing`,
  publisher: { username: 'someone' },
  links: { npm: `https://www.npmjs.com/package/${name}` },
})

/** A registry that answers a search and the packuments behind it. */
function registry(options: {
  hits: string[]
  declaring: string[]
  onSearch?: (text: string) => void
  fail?: boolean
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (options.fail) throw new Error('getaddrinfo ENOTFOUND registry.example')
    if (url.includes('/-/v1/search')) {
      const text = new URL(url).searchParams.get('text') ?? ''
      options.onSearch?.(text)
      return Response.json({ objects: options.hits.map((name) => ({ package: declare(name) })) })
    }
    const name = decodeURIComponent(url.slice(`${REGISTRY}/`.length))
    if (!options.hits.includes(name)) return new Response('Not Found', { status: 404 })
    return Response.json({
      'dist-tags': { latest: '1.2.3' },
      versions: {
        '1.2.3': options.declaring.includes(name)
          ? { bunbraco: { extensions: [{ type: 'dashboard' }] } }
          : {},
      },
    })
  }) as unknown as typeof fetch
}

interface Call {
  action: string
  specifier: string
  siteDir: string
}

function marketplace(options: {
  root?: string
  hits?: string[]
  declaring?: string[]
  fail?: boolean
  calls?: Call[]
  installs?: (call: Call) => { ok: boolean; output: string }
  onSearch?: (text: string) => void
}) {
  const root = options.root ?? site()
  const extensions = createExtensionRegistry(root, { cache: false })
  const installer: PackageInstaller = async (action, specifier, siteDir) => {
    const call = { action, specifier, siteDir }
    options.calls?.push(call)
    return options.installs?.(call) ?? { ok: true, output: '' }
  }
  return {
    root,
    extensions,
    market: createMarketplace({
      registry: REGISTRY,
      keyword: 'bunbraco-bundle',
      marketplaceUrl: 'https://www.npmjs.com/search?q=keywords%3Abunbraco-bundle',
      extensions,
      siteDir: root,
      fetch: registry({
        hits: options.hits ?? [],
        declaring: options.declaring ?? [],
        fail: options.fail,
        onSearch: options.onSearch,
      }),
      install: installer,
    }),
  }
}

describe('searching the registry', () => {
  test('searches the keyword, because it is the only thing npm indexes', async () => {
    const seen: string[] = []
    const { market } = marketplace({
      hits: ['@acme/seo'],
      declaring: ['@acme/seo'],
      onSearch: (text) => seen.push(text),
    })
    await market.search(undefined)
    expect(seen).toEqual(['keywords:bunbraco-bundle'])
  })

  test('adds the typed query alongside the keyword', async () => {
    const seen: string[] = []
    const { market } = marketplace({ hits: [], onSearch: (text) => seen.push(text) })
    await market.search('  seo  ')
    expect(seen).toEqual(['keywords:bunbraco-bundle seo'])
  })

  /** The keyword is a claim; the `bunbraco` field is the thing itself. */
  test('offers only the hits whose packument declares extensions', async () => {
    const { market } = marketplace({
      hits: ['@acme/seo', '@squatter/keyword-only'],
      declaring: ['@acme/seo'],
    })
    const found = await market.search(undefined)
    expect(found.map((item) => item.name)).toEqual(['@acme/seo'])
    expect(found[0]?.declaresExtensions).toBe(true)
    expect(found[0]?.description).toBe('@acme/seo does a thing')
    expect(found[0]?.publisher).toBe('someone')
  })

  test('marks what is already installed, with its version', async () => {
    const root = site({ '@acme/seo': { declares: true } })
    const { market } = marketplace({ root, hits: ['@acme/seo'], declaring: ['@acme/seo'] })
    const found = await market.search(undefined)
    expect(found[0]?.installedVersion).toBe('1.2.3')
  })

  test('an unreachable registry is an empty list, not an error', async () => {
    const { market } = marketplace({ fail: true })
    expect(await market.search(undefined)).toEqual([])
  })

  test('ignores a hit whose name npm would not accept', async () => {
    const { market } = marketplace({ hits: ['../etc/passwd'], declaring: ['../etc/passwd'] })
    expect(await market.search(undefined)).toEqual([])
  })

  test('names where to browse', () => {
    const { market } = marketplace({})
    expect(market.url()).toContain('keywords%3Abunbraco-bundle')
  })
})

describe('listing what is installed', () => {
  test('lists the declared extensions and leaves plain dependencies out', () => {
    const root = site({ '@acme/seo': { declares: true }, lodash: { declares: false } })
    const { market } = marketplace({ root })
    const items = market.installed()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      packageName: '@acme/seo',
      version: '1.2.3',
      extensionCount: 1,
    })
  })
})

describe('installing', () => {
  test('runs bun add in the site directory and reports the dependency', async () => {
    const calls: Call[] = []
    const root = site()
    const { market } = marketplace({
      root,
      calls,
      installs: (call) => {
        // Stand in for what `bun add` would leave behind.
        addPackage(root, '@acme/seo', true, '2.0.0')
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ name: 'a-site', dependencies: { '@acme/seo': '^2.0.0' } }),
        )
        expect(call.action).toBe('add')
        return { ok: true, output: 'installed' }
      },
    })

    const outcome = await market.install('@acme/seo', '2.0.0')
    expect(calls).toEqual([{ action: 'add', specifier: '@acme/seo@2.0.0', siteDir: root }])
    expect(outcome.ok).toBe(true)
    // The exact dependency line the site now holds, which is what there is to commit.
    expect(outcome.dependency).toEqual({
      name: '@acme/seo',
      range: '^2.0.0',
      version: '2.0.0',
    })
    // The install is this node's until it is committed, and says so.
    expect(outcome.message).toContain('Commit the changed package.json')
  })

  test('installs without a version when none is given', async () => {
    const calls: Call[] = []
    const { market } = marketplace({ calls })
    await market.install('@acme/seo', undefined)
    expect(calls[0]?.specifier).toBe('@acme/seo')
  })

  test('the next read sees it, because the install invalidates discovery', async () => {
    const root = site()
    const { market, extensions } = marketplace({
      root,
      installs: () => {
        addPackage(root, '@acme/seo', true)
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ name: 'a-site', dependencies: { '@acme/seo': '^1' } }),
        )
        return { ok: true, output: '' }
      },
    })
    expect(extensions.list()).toHaveLength(0)
    await market.install('@acme/seo', undefined)
    expect(extensions.list()).toHaveLength(1)
  })

  test('says so when the package declares no extensions', async () => {
    const root = site()
    const { market } = marketplace({
      root,
      installs: () => {
        addPackage(root, 'lodash', false)
        writeFileSync(
          join(root, 'package.json'),
          JSON.stringify({ name: 'a-site', dependencies: { lodash: '^4' } }),
        )
        return { ok: true, output: '' }
      },
    })
    const outcome = await market.install('lodash', undefined)
    expect(outcome.ok).toBe(true)
    expect(outcome.message).toContain('declares no backoffice extensions')
  })

  test("reports the installer's own output when it fails", async () => {
    const { market } = marketplace({
      installs: () => ({ ok: false, output: 'error: EACCES: permission denied' }),
    })
    const outcome = await market.install('@acme/seo', undefined)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('EACCES')
  })

  test('refuses a name or version that is not npm-shaped, without running anything', async () => {
    const calls: Call[] = []
    const { market } = marketplace({ calls })
    for (const name of ['../../etc/passwd', 'a; rm -rf /', '-D', '', 'UPPER'])
      expect((await market.install(name, undefined)).ok).toBe(false)
    for (const version of ['; rm -rf /', '--production', '`whoami`'])
      expect((await market.install('@acme/seo', version)).ok).toBe(false)
    expect(calls).toEqual([])
  })

  test('uninstalling runs bun remove', async () => {
    const calls: Call[] = []
    const { market } = marketplace({ calls })
    const outcome = await market.uninstall('@acme/seo')
    expect(calls).toEqual([
      { action: 'remove', specifier: '@acme/seo', siteDir: expect.any(String) },
    ])
    expect(outcome.ok).toBe(true)
    expect(outcome.message).toContain('Commit the changed package.json')
  })

  test('uninstalling refuses a name npm would not accept', async () => {
    const calls: Call[] = []
    const { market } = marketplace({ calls })
    expect((await market.uninstall('../../etc')).ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('the real installer', () => {
  /**
   * `bunInstaller` is the only part of this that touches the filesystem, and
   * the rest of the suite stubs it. Removing a dependency a site does not have
   * exercises the spawn, the working directory and the captured output without
   * reaching a registry.
   */
  test('runs bun in the site directory and reports its exit', async () => {
    const root = site()
    const result = await bunInstaller('remove', 'a-package-that-is-not-there', root)
    expect(result.ok).toBe(true)
    expect(typeof result.output).toBe('string')
    // The site's package.json is still a package.json afterwards.
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(json.name).toBe('a-site')
  })

  test('reports failure rather than throwing when bun cannot do it', async () => {
    const result = await bunInstaller('add', 'a-package-that-is-not-there', join(site(), 'nope'))
    expect(result.ok).toBe(false)
    expect(result.output.length).toBeGreaterThan(0)
  })
})

describe('the name and version rules', () => {
  test('accepts what npm accepts', () => {
    for (const name of ['lodash', '@acme/seo', 'a-b_c.d', '@a/b-c'])
      expect(isValidPackageName(name)).toBe(true)
    for (const name of ['', 'UPPER', '.hidden', '@acme', 'a/b/c', '../x', 'a b'])
      expect(isValidPackageName(name)).toBe(false)
  })

  test('accepts a version or a range, and nothing that looks like a flag', () => {
    for (const version of ['1.0.0', '^2.1', 'latest', '>=1 <2'])
      expect(isValidVersion(version)).toBe(true)
    for (const version of ['', '--production', '; whoami', '`x`', '$(x)'])
      expect(isValidVersion(version)).toBe(false)
  })
})

describe('the endpoints', () => {
  const PACKAGES = `${BACKOFFICE}/bunbraco/api/bundles`

  test('need a session', async () => {
    const h = await signedInServer()
    open.push(h)
    const anonymous = await h.server.fetch(new Request(`${ORIGIN}${PACKAGES}/installed`))
    expect(anonymous.status).toBe(401)
  })

  test('need the Packages section', async () => {
    const h = await signedInServer()
    open.push(h)
    // `writer` holds Content and not Packages.
    const writer = await signInAsGroup(h, 'writer')
    expect((await writer.call(`${PACKAGES}/installed`)).status).toBe(403)
  })

  test('list what is installed for someone who holds the section', async () => {
    const h = await signedInServer()
    open.push(h)
    const body = await h.json<{ items: unknown[] }>(`${PACKAGES}/installed`)
    expect(Array.isArray(body.items)).toBe(true)
  })

  test('answer the marketplace with the keyword in play', async () => {
    const h = await signedInServer()
    open.push(h)
    // The real registry is unreachable from the suite, which is the air-gapped
    // case: an empty list and a usable response rather than a failure.
    const body = await h.json<{ keyword: string; url: string; items: unknown[] }>(
      `${PACKAGES}/marketplace`,
    )
    expect(body.keyword).toBe('bunbraco-bundle')
    expect(body.url).toContain('bunbraco-bundle')
    expect(Array.isArray(body.items)).toBe(true)
  })

  test('refuse a bad install name with a 400 and a reason', async () => {
    const h = await signedInServer()
    open.push(h)
    const response = await h.post(`${PACKAGES}/install`, { name: '../../etc/passwd' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toContain('not a package name')
  })

  test('an unknown packages route is a 404', async () => {
    const h = await signedInServer()
    open.push(h)
    expect((await h.call(`${PACKAGES}/nonsense`)).status).toBe(404)
  })
})
