/**
 * The Bundles section's marketplace, over npm. `docs/bundles.md`.
 *
 * Discovery and declaration are two different things, because npm indexes only
 * one of them: a bundle is *found* by the `crombolo-bundle` keyword, which is
 * the only thing registry search will match, and it *declares* itself with a
 * `crombolo` field in its `package.json`. Search for the keyword, then read each
 * hit's packument — custom fields survive there — and offer only the packages
 * whose manifest is a valid bundle. A keyword squatter never reaches the list.
 *
 * An install is `bun add`, and then — unless the site or the request says not
 * to — the content the bundle carries, through the same installer as
 * `crombolo bundle install`. A bundle's server half is never loaded by an
 * install: that still takes an edit to `crombolo.config.ts` and a deploy.
 *
 * The search is proxied rather than done in the browser: it works where the
 * browser cannot reach npm, and the backoffice keeps making same-origin
 * requests only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BundlePackage,
  EXTENSION_KEYWORD,
  type ExtensionRegistry,
  type PackageJson,
  validateBundlePackage,
} from '@crombolo/backoffice-host'
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
  /** What the latest version carries; only a valid bundle is listed at all. */
  carries: BundlePackage['carries']
  installedVersion: string | null
}

/** A bundle the site depends on, as the Installed view lists it. */
export interface InstalledListing {
  /** The npm package name, which is what an uninstall names. */
  packageName: string
  /** The display name the package chose. */
  name: string
  id: string
  version: string
  extensionCount: number
  carries: BundlePackage['carries']
  /** Whether its server half is imported into `crombolo.config.ts`; only meaningful when it carries one. */
  wired: boolean
  /** The version whose content was applied here, or null when none has been. */
  contentApplied: string | null
  /** What the package says it is, from its `package.json`; empty when it says nothing. */
  description: string
  /** The crombolo releases it is written for. */
  peerRange: string
}

/** What became of the content half of an install. */
export interface ContentOutcome {
  applied: boolean
  /** Set when it was applied: the transfer run that can revert it. */
  runId?: string
  message: string
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
  /** The ids of the bundles whose server half this node has mounted. */
  wired?: () => readonly string[]
  /** The version of a package whose content has been applied here. */
  contentApplied?: (packageName: string) => Promise<string | null>
  /**
   * Installs the content half of a bundle the site now depends on. Absent where
   * content cannot be applied, which declines it for every install.
   */
  applyContent?: (packageName: string) => Promise<ContentOutcome>
  /** The site's `applyBundleContentOnInstall`. */
  applyContentOnInstall?: boolean
  /**
   * False refuses installing and removing here: the dependency belongs in
   * `package.json` and a deploy, so every node has it and it outlives a restart.
   */
  installs?: boolean
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
  /** What happened to the content the bundle carries; absent when it carries none. */
  content?: ContentOutcome
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
  installed(): Promise<InstalledListing[]>
  install(
    name: string,
    version: string | undefined,
    options?: { applyContent?: boolean },
  ): Promise<InstallOutcome>
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
    options.extensions.bundles().bundles.find((bundle) => bundle.packageName === name)?.version ??
    null

  /** What the registry says this package's latest version carries, when it is a valid bundle. */
  const declares = async (name: string): Promise<BundlePackage['carries'] | undefined> => {
    try {
      const response = await call(`${options.registry}/${encodeURIComponent(name)}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return undefined
      const packument = (await response.json()) as {
        'dist-tags'?: { latest?: string }
        versions?: Record<string, PackageJson>
      }
      const latest = packument['dist-tags']?.latest
      const version = latest ? packument.versions?.[latest] : undefined
      if (!version || validateBundlePackage(version).length > 0) return undefined
      const field = version.crombolo as {
        extensions?: unknown[]
        content?: string
        server?: string
      }
      return {
        extensions: Array.isArray(field.extensions) && field.extensions.length > 0,
        content: field.content !== undefined,
        server: field.server !== undefined,
      }
    } catch {
      return undefined
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
          .map(async (pkg): Promise<MarketplaceListing | undefined> => {
            const name = pkg.name as string
            const carries = await declares(name)
            if (!carries) return undefined
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
              carries,
              installedVersion: installedVersion(name),
            }
          }),
      )
      // Only what really is a bundle: the keyword is a claim, the manifest is
      // the thing itself.
      const offered = listings.filter((listing): listing is MarketplaceListing => Boolean(listing))
      cached = { at: Date.now(), query: text, listings: offered }
      return offered
    },

    async installed() {
      const wired = new Set(options.wired?.() ?? [])
      return Promise.all(
        options.extensions.bundles().bundles.map(async (bundle) => ({
          packageName: bundle.packageName,
          name: bundle.name,
          id: bundle.id,
          version: bundle.version,
          extensionCount: bundle.field.extensions?.length ?? 0,
          carries: bundle.carries,
          wired: wired.has(bundle.id),
          contentApplied: (await options.contentApplied?.(bundle.packageName)) ?? null,
          description: descriptionOf(bundle.directory),
          peerRange: bundle.peerRange,
        })),
      )
    },

    async install(name, version, request = {}) {
      if (options.installs === false) return refusedHere(name, 'add')
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
      const found = options.extensions
        .bundles()
        .bundles.find((bundle) => bundle.packageName === name)
      if (!found)
        return {
          ok: true,
          dependency: { name, range, version: version ?? range },
          message: `${name} was installed, but it is not a valid bundle, so nothing was added to the backoffice.`,
        }

      // The content half lands after the dependency, so a refused check leaves
      // the package installed and says why, rather than undoing an install that
      // succeeded.
      let content: ContentOutcome | undefined
      if (found.carries.content) {
        const declined = request.applyContent === false || options.applyContentOnInstall === false
        content =
          declined || !options.applyContent
            ? {
                applied: false,
                message: `Its content was not applied. Run \`crombolo bundle install ${name}\` to apply it.`,
              }
            : await options.applyContent(name).catch((error: unknown) => ({
                applied: false,
                message: `Its content could not be applied: ${error instanceof Error ? error.message : String(error)}`,
              }))
      }
      return {
        ok: true,
        dependency: { name, range, version: found.version },
        // The install lives in this node's node_modules until the dependency is
        // committed; saying so is the difference between a surprise and a plan.
        message: `${name}@${found.version} is installed. Commit the changed package.json and bun.lock to keep it across deployments.${
          found.carries.server
            ? ' Its server half runs only once crombolo.config.ts imports it and the site is deployed.'
            : ''
        }`,
        ...(content ? { content } : {}),
      }
    },

    async uninstall(name) {
      if (options.installs === false) return refusedHere(name, 'remove')
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

/** A package's own description, read leniently: anything unreadable is none. */
function descriptionOf(directory: string): string {
  try {
    const json = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      description?: unknown
    }
    return typeof json.description === 'string' ? json.description : ''
  } catch {
    return ''
  }
}

/** What a site that does not install at runtime says instead, with what to do. */
function refusedHere(name: string, verb: 'add' | 'remove'): InstallOutcome {
  return {
    ok: false,
    message:
      verb === 'add'
        ? `Packages are not installed from the backoffice on this site. Add ${name} to the site's package.json (bun add ${name}) and deploy, so every server has it.`
        : `Packages are not removed from the backoffice on this site. Remove ${name} from the site's package.json (bun remove ${name}) and deploy.`,
  }
}

export { EXTENSION_KEYWORD }
