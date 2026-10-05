/**
 * Guards the published package set: one version across the workspace, metadata
 * npm needs, and entry points that exist. These are the mistakes that only show
 * up after a release, when the tarball is already on the registry.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { EXTENSION_KEYWORD } from '@bunbraco/backoffice-host'
import { VERSION } from '@bunbraco/server'
import {
  BACKOFFICE_DIST,
  lockedVersions,
  publishablePackages,
  publishOrder,
  ROOT,
  sharedVersion,
  workspacePackages,
} from '../scripts/packages.ts'

const REPOSITORY = 'git+https://github.com/kineco-au/bunbraco-cms.git'
const packages = publishablePackages()

/** Published, but installed only by a site that wants it. */
const OPT_IN = new Set(['@bunbraco/import-umbraco', '@bunbraco/simple-redirects'])

/** Published bundles, which npm has to be able to find by keyword. */
const BUNDLES = new Set(['@bunbraco/simple-redirects'])

/** A sibling package in an import or export specifier, subpath and all. */
const SIBLING_IMPORT = /from '(@bunbraco\/[^']+)'/g

/** The TypeScript a package ships, skipping generated output and vendored dist. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'generated' || entry.name === 'dist')
        continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path)
    }
  }
  walk(dir)
  return out
}

/** Every path an `exports` entry can point at, flattened. */
function entryPoints(pkg: (typeof packages)[number]): string[] {
  const targets = Object.values(pkg.manifest.exports ?? {}).flatMap((target) =>
    typeof target === 'string' ? [target] : Object.values(target),
  )
  return [...targets, ...Object.values(pkg.manifest.bin ?? {})]
}

describe('the published package set', () => {
  test('is the whole of packages/ bar nothing private', () => {
    expect(packages.map((pkg) => pkg.name)).toEqual([
      '@bunbraco/api-management',
      '@bunbraco/assistant',
      '@bunbraco/auth',
      '@bunbraco/backoffice-dist',
      '@bunbraco/backoffice-host',
      '@bunbraco/cli',
      '@bunbraco/contracts',
      '@bunbraco/core',
      '@bunbraco/data',
      '@bunbraco/import-umbraco',
      '@bunbraco/render',
      '@bunbraco/schema',
      '@bunbraco/server',
      '@bunbraco/simple-redirects',
      '@bunbraco/transfer',
      'bunbraco',
    ])
  })

  test('shares one version, and the backoffice tracks the Umbraco release', () => {
    const version = sharedVersion()
    for (const pkg of packages) {
      if (pkg.name === BACKOFFICE_DIST) continue
      expect(pkg.manifest.version).toBe(version)
    }
    const dist = packages.find((pkg) => pkg.name === BACKOFFICE_DIST)
    expect(dist?.manifest.version).toMatch(/^18\./)
  })

  test('agrees with bun.lock, which is what bun pack resolves siblings from', () => {
    const locked = lockedVersions()
    for (const pkg of packages) expect(locked.get(pkg.relative)).toBe(pkg.manifest.version)
  })

  test('is reachable from the bunbraco package, so nothing ships orphaned', () => {
    const umbrella = packages.find((pkg) => pkg.name === 'bunbraco')
    const dependencies = Object.keys(umbrella?.manifest.dependencies ?? {})
    for (const pkg of packages) {
      if (pkg.name === 'bunbraco' || OPT_IN.has(pkg.name)) continue
      expect(dependencies).toContain(pkg.name)
    }
  })

  test('publishes every bundle under the keyword the marketplace searches', () => {
    // The `bunbraco` field is what declares the extensions, but npm will not
    // index a custom field — only keywords — so a bundle without this one is
    // invisible in the Bundles section however correct the rest of it is
    // (`docs/17-bundles.md`).
    for (const name of BUNDLES) {
      const bundle = packages.find((pkg) => pkg.name === name)
      expect(bundle?.manifest.keywords ?? [], name).toContain(EXTENSION_KEYWORD)
    }
  })

  test('declares each bundle’s extensions where discovery reads them', () => {
    for (const name of BUNDLES) {
      const bundle = packages.find((pkg) => pkg.name === name)
      // Discovery reads `bunbraco.extensions` from the dependency's own
      // manifest, and `files` has to carry whatever those point at.
      const field = bundle?.manifest.bunbraco
      expect(field?.extensions ?? [], name).not.toBeEmpty()
      for (const extension of field?.extensions ?? []) {
        const asset =
          (extension as { element?: string; js?: string }).element ??
          (extension as { js?: string }).js
        if (!asset) continue
        expect(existsSync(join(bundle?.dir ?? '', asset)), `${name} ${asset}`).toBe(true)
        expect(bundle?.manifest.files ?? [], name).toContain(asset.split('/')[0] as string)
      }
    }
  })

  test('keeps an opt-in package out of every site that did not ask for it', () => {
    // The Umbraco importer is run once, by someone migrating a site, and brings a
    // .bacpac reader with it. The CLI loads it on demand and says how to add it,
    // so nothing a site installs may depend on it.
    for (const pkg of packages) {
      if (OPT_IN.has(pkg.name)) continue
      for (const name of Object.keys(pkg.manifest.dependencies ?? {}))
        expect(OPT_IN.has(name), `${pkg.name} depends on ${name}`).toBe(false)
    }
    const cli = readFileSync(join(ROOT, 'packages/cli/bin/bunbraco.ts'), 'utf8')
    expect(cli).toContain("await import('@bunbraco/import-umbraco')")
    expect(cli).not.toMatch(/^import .* from '@bunbraco\/import-umbraco'/m)
  })

  test('reports the shared version at runtime', () => {
    expect(VERSION).toBe(sharedVersion())
  })

  test('keeps the workspace root and the example site unpublished', () => {
    for (const file of ['package.json', 'apps/site/package.json']) {
      const manifest = JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as { private?: boolean }
      expect(manifest.private).toBe(true)
    }
  })

  test('carries a licence and the third-party notice', () => {
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true)
    expect(existsSync(join(ROOT, 'NOTICE'))).toBe(true)
  })
})

describe('each published manifest', () => {
  for (const pkg of packages) {
    describe(pkg.name, () => {
      test('ships the third-party notice, which npm does not add for us', () => {
        // Every package, not only the ones that redistribute third-party
        // material: `bunbraco` is what a site installs and what a downstream
        // redistributor reads. `publish-packages.ts` copies the file in while
        // packing, so the manifest has to list it or the copy is dropped.
        expect(pkg.manifest.files ?? []).toContain('NOTICE')
      })

      test('declares what npm and a reader need', () => {
        expect(pkg.manifest.description ?? '').not.toBe('')
        expect(pkg.manifest.license).toBe('MIT')
        expect(pkg.manifest.engines?.bun).toBe('>=1.3.0')
        expect(pkg.manifest.files ?? []).not.toBeEmpty()
      })

      test('points at its own directory in the repository', () => {
        expect(pkg.manifest.repository?.url).toBe(REPOSITORY)
        expect(pkg.manifest.repository?.directory).toBe(pkg.relative)
      })

      test('resolves every entry point on disk', () => {
        for (const target of entryPoints(pkg)) {
          expect(target.startsWith('./')).toBe(true)
          expect(existsSync(join(pkg.dir, target))).toBe(true)
        }
      })

      test('depends on siblings through the workspace protocol', () => {
        for (const [name, range] of Object.entries(pkg.manifest.dependencies ?? {}))
          if (name.startsWith('@bunbraco/')) expect(range).toBe('workspace:*')
      })

      test('declares every sibling its source imports', () => {
        // An undeclared sibling still resolves here, and usually resolves for a
        // consumer too, because a hoisted `node_modules` happens to carry it.
        // That is luck, not a dependency: a stricter installer, or a release
        // that stops depending on the sibling for its own reasons, breaks the
        // package with nothing in its manifest to explain why.
        const declared = new Set(Object.keys(pkg.manifest.dependencies ?? {}))
        const imported = new Set<string>()
        for (const file of sourceFiles(pkg.dir))
          for (const match of readFileSync(file, 'utf8').matchAll(SIBLING_IMPORT)) {
            const [scope, name] = (match[1] as string).split('/')
            imported.add(`${scope}/${name}`)
          }
        for (const name of imported)
          if (name !== pkg.name)
            expect([...declared], `${pkg.name} imports ${name}`).toContain(name)
      })
    })
  }
})

describe('publishOrder', () => {
  test('lists a dependency before every package that needs it', () => {
    const ordered = publishOrder(packages).map((pkg) => pkg.name)
    expect(ordered).toHaveLength(packages.length)
    for (const pkg of packages)
      for (const name of Object.keys(pkg.manifest.dependencies ?? {}))
        if (name.startsWith('@bunbraco/'))
          expect(ordered.indexOf(name)).toBeLessThan(ordered.indexOf(pkg.name))
  })

  test('puts core first and the umbrella package last', () => {
    const ordered = publishOrder(packages).map((pkg) => pkg.name)
    expect(ordered[0]).toBe('@bunbraco/core')
    expect(ordered.at(-1)).toBe('bunbraco')
  })
})

describe('the generated artefacts a release needs', () => {
  test('are listed in the files of the packages that carry them', () => {
    const byName = new Map(workspacePackages().map((pkg) => [pkg.name, pkg]))
    expect(byName.get('@bunbraco/contracts')?.manifest.files).toContain('generated')
    expect(byName.get(BACKOFFICE_DIST)?.manifest.files).toContain('dist')
    // The starter sites `bunbraco init --template` writes, which are files
    // beside the code rather than anything a build step produces.
    expect(byName.get('@bunbraco/cli')?.manifest.files).toContain('templates')
  })
})

describe('the release workflow', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')

  test('names the run after the tag, so two releases are told apart', () => {
    // A push event is otherwise titled with the tagged commit's message, which
    // makes the Actions list read as whatever the last commit happened to say.
    expect(workflow).toMatch(/^run-name:.*github\.ref_name/m)
  })

  test('triggers only on a v tag, never a branch', () => {
    // Matched loosely on purpose: what matters is the trigger, not whether the
    // file was last formatted with single or double quotes.
    expect(workflow).toMatch(/tags:\s*\[\s*['"]v\*['"]\s*\]/)
    expect(workflow).not.toMatch(/^\s+branches:/m)
  })

  test('refuses a tag that disagrees with the package version', () => {
    // What stops `git tag v0.9.0` publishing 0.3.0 to the registry under the
    // wrong name — which cannot be taken back once uploaded.
    expect(workflow).toContain('GITHUB_REF_NAME#v')
    expect(workflow).toContain('does not match')
  })

  test('cannot publish without a green build', () => {
    // `needs: ci` is the whole gate: without it a red suite still ships.
    expect(workflow).toMatch(/needs:\s*ci/)
    expect(workflow).toContain('bun run release:publish')
  })
})

describe('every image a template redistributes', () => {
  /** The binaries under a template's bundle, which ship inside `@bunbraco/cli`. */
  const images = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) =>
          /\.(jpg|jpeg|png|gif|webp|avif|svg)$/i.test(file),
        )
      : []

  test('has a row in its template’s CREDITS.md', () => {
    // `bunbraco init --template` copies these onto someone else's machine, so they
    // are redistributed and each one needs a recorded source. Unattributed is the
    // kind of thing only ever noticed years later, so it is a test rather than a
    // convention.
    const templates = join(ROOT, 'packages/cli/templates')
    if (!existsSync(templates)) return
    for (const template of readdirSync(join(templates, 'demo'), { withFileTypes: true })) {
      if (!template.isDirectory()) continue
      const dir = join(templates, 'demo', template.name)
      const found = images(join(dir, 'bundle', 'blobs'))
      if (found.length === 0) continue
      const credits = join(dir, 'CREDITS.md')
      expect([template.name, existsSync(credits)]).toEqual([template.name, true])
      const text = readFileSync(credits, 'utf8')
      for (const image of found)
        expect([image, text.includes(basename(image))]).toEqual([image, true])
    }
  })
})
