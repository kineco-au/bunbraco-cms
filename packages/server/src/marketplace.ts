/**
 * The Bundles section's marketplace, over npm. `docs/17-bundles.md`.
 *
 * Discovery and declaration are two different things, because npm indexes only
 * one of them: a bundle is *found* by the `bunbraco-bundle` keyword, which is
 * the only thing registry search will match, and it *declares* itself with a
 * `bunbraco` field in its `package.json`. Search for the keyword, then read each
 * hit's packument — custom fields survive there — and offer only the packages
 * that actually declare extensions. A keyword squatter never reaches the list.
 *
 * The search is proxied rather than done in the browser: it works where the
 * browser cannot reach npm, and the backoffice keeps making same-origin
 * requests only.
 */
import { join } from 'node:path'
import { EXTENSION_KEYWORD, type ExtensionRegistry } from '@bunbraco/backoffice-host'
import { logger } from './logging.ts'

const log = logger('packages')

/** How long a search is reused. Long enough to page a list, short enough to stay fresh. */
const CACHE_MS = 5 * 60 * 1000

export interface MarketplaceListing {
  name: string
  version: string
  description: string
  publisher: string | null
  links: { npm: string; homepage: string | null; repository: string | null }
  /** Whether the latest version declares backoffice extensions. */
  declaresExtensions: boolean
  installedVersion: string | null
}

/** An installed extension as the Installed view lists it. */
export interface InstalledListing {
  /** The npm package name, which is what an uninstall names. */
  packageName: string
  /** The display name the package chose. */
  name: string
  id: string
  version: string
  extensionCount: number
}

export interface MarketplaceOptions {
  registry: string
  keyword: string
  marketplaceUrl: string
  extensions: ExtensionRegistry
  fetch?: typeof fetch
  /** Where `bun add` runs, which is the site that owns the package.json. */
  siteDir: string
  /** Overridden by tests; the real one shells out to Bun. */
  install?: PackageInstaller
}

export interface InstallOutcome {
  ok: boolean
  /**
   * The dependency line the site's `package.json` now holds, so the UI can show
   * exactly what there is to commit: the range as written, and the version that
   * resolved to.
   */
  dependency?: { name: string; range: string; version: string }
  message: string
}

export type PackageInstaller = (
  action: 'add' | 'remove',
  specifier: string,
  siteDir: string,
) => Promise<{ ok: boolean; output: string }>

interface SearchObject {
  package?: {
    name?: string
    version?: string
    description?: string
    publisher?: { username?: string }
    links?: Record<string, string>
  }
}

/** A name npm would accept, so nothing shell-ish or path-ish reaches `bun add`. */
export function isValidPackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214
}

/**
 * A version or range that cannot be mistaken for another argument.
 *
 * Ranges start with an operator — `^2.1`, `>=1 <2` — so those lead; `-` never
 * does, because `bun add` would read it as a flag. No shell is involved
 * (`Bun.spawn` takes an argv), so the space in a range is harmless.
 */
export function isValidVersion(version: string): boolean {
  return /^[A-Za-z0-9^~>=<*][A-Za-z0-9.^~>=<| *+-]*$/.test(version) && version.length <= 64
}

export interface Marketplace {
  /** Where someone browsing should be sent, when they want more than this list. */
  url(): string
  search(query: string | undefined): Promise<MarketplaceListing[]>
  installed(): InstalledListing[]
  install(name: string, version: string | undefined): Promise<InstallOutcome>
  uninstall(name: string): Promise<InstallOutcome>
}

/**
 * `bun add` in the site directory: Bun owns resolution and writes the lockfile.
 *
 * The spawn itself can fail rather than the command — an unreadable site
 * directory or a `bun` that is not on the path both throw out of `Bun.spawn` —
 * and that has to come back as a failed install with a reason, not as an
 * exception the route turns into a 500.
 */
export const bunInstaller: PackageInstaller = async (action, specifier, siteDir) => {
  try {
    const proc = Bun.spawn(['bun', action, specifier], {
      cwd: siteDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, output: `${stdout}${stderr}`.trim() }
  } catch (error) {
    return {
      ok: false,
      output: `bun ${action} could not be run in ${siteDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

export function createMarketplace(options: MarketplaceOptions): Marketplace {
  const call = options.fetch ?? fetch
  const install = options.install ?? bunInstaller

  /** The range `package.json` holds for a dependency, as `bun add` wrote it. */
  const rangeFor = async (name: string): Promise<string | undefined> => {
    try {
      const json = (await Bun.file(join(options.siteDir, 'package.json')).json()) as {
        dependencies?: Record<string, string>
      }
      return json.dependencies?.[name]
    } catch {
      return undefined
    }
  }
  let cached: { at: number; query: string; listings: MarketplaceListing[] } | undefined

  const installedVersion = (name: string): string | null =>
    options.extensions.list().find((extension) => extension.packageName === name)?.version ?? null

  /** Whether the registry says this package's latest version declares extensions. */
  const declares = async (name: string): Promise<boolean> => {
    try {
      const response = await call(`${options.registry}/${encodeURIComponent(name)}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return false
      const packument = (await response.json()) as {
        'dist-tags'?: { latest?: string }
        versions?: Record<string, { bunbraco?: { extensions?: unknown[] } }>
      }
      const latest = packument['dist-tags']?.latest
      const version = latest ? packument.versions?.[latest] : undefined
      return Array.isArray(version?.bunbraco?.extensions) && version.bunbraco.extensions.length > 0
    } catch {
      return false
    }
  }

  return {
    url: () => options.marketplaceUrl,

    async search(query) {
      const text = [`keywords:${options.keyword}`, query?.trim()].filter(Boolean).join(' ')
      if (cached && cached.query === text && Date.now() - cached.at < CACHE_MS)
        return cached.listings.map((listing) => ({
          ...listing,
          installedVersion: installedVersion(listing.name),
        }))

      let objects: SearchObject[] = []
      try {
        const response = await call(
          `${options.registry}/-/v1/search?text=${encodeURIComponent(text)}&size=50`,
          { headers: { accept: 'application/json' } },
        )
        if (!response.ok) throw new Error(`the registry answered ${response.status}`)
        objects = ((await response.json()) as { objects?: SearchObject[] }).objects ?? []
      } catch (error) {
        // An unreachable registry is an empty list with a log line, not a 500:
        // an air-gapped site should still be able to open the section.
        log.warning('The package registry could not be reached: {detail}', {
          detail: error instanceof Error ? error.message : String(error),
        })
        return []
      }

      // The packuments are read together: one request per hit, and a page of
      // hits read one at a time would make the view feel broken.
      const listings = await Promise.all(
        objects
          .map((object) => object.package)
          .filter((pkg): pkg is NonNullable<typeof pkg> =>
            Boolean(pkg?.name && isValidPackageName(pkg.name)),
          )
          .map(async (pkg): Promise<MarketplaceListing> => {
            const name = pkg.name as string
            return {
              name,
              version: pkg.version ?? '0.0.0',
              description: pkg.description ?? '',
              publisher: pkg.publisher?.username ?? null,
              links: {
                npm: pkg.links?.npm ?? `https://www.npmjs.com/package/${name}`,
                homepage: pkg.links?.homepage ?? null,
                repository: pkg.links?.repository ?? null,
              },
              declaresExtensions: await declares(name),
              installedVersion: installedVersion(name),
            }
          }),
      )
      // Only what really declares extensions: the keyword is a claim, the field
      // is the thing itself.
      const offered = listings.filter((listing) => listing.declaresExtensions)
      cached = { at: Date.now(), query: text, listings: offered }
      return offered
    },

    installed() {
      return options.extensions.list().map((extension) => ({
        packageName: extension.packageName,
        name: extension.manifest.name,
        id: extension.manifest.id ?? extension.packageName,
        version: extension.version,
        extensionCount: extension.manifest.extensions.length,
      }))
    },

    async install(name, version) {
      if (!isValidPackageName(name))
        return { ok: false, message: `'${name}' is not a package name npm would accept.` }
      if (version !== undefined && !isValidVersion(version))
        return { ok: false, message: `'${version}' is not a version npm would accept.` }

      const specifier = version ? `${name}@${version}` : name
      const result = await install('add', specifier, options.siteDir)
      options.extensions.invalidate()
      if (!result.ok)
        return {
          ok: false,
          message: result.output || `Installing ${specifier} failed.`,
        }

      const range = (await rangeFor(name)) ?? version ?? 'latest'
      const found = options.extensions.list().find((extension) => extension.packageName === name)
      if (!found)
        return {
          ok: true,
          dependency: { name, range, version: version ?? range },
          message: `${name} was installed, but it declares no backoffice extensions, so nothing was added to the backoffice.`,
        }
      return {
        ok: true,
        dependency: { name, range, version: found.version },
        // The install lives in this node's node_modules until the dependency is
        // committed; saying so is the difference between a surprise and a plan.
        message: `${name}@${found.version} is installed and active. Commit the changed package.json and bun.lock to keep it across deployments.`,
      }
    },

    async uninstall(name) {
      if (!isValidPackageName(name))
        return { ok: false, message: `'${name}' is not a package name npm would accept.` }
      const result = await install('remove', name, options.siteDir)
      options.extensions.invalidate()
      return result.ok
        ? {
            ok: true,
            message: `${name} was removed. Commit the changed package.json and bun.lock.`,
          }
        : { ok: false, message: result.output || `Removing ${name} failed.` }
    },
  }
}

export { EXTENSION_KEYWORD }
