/**
 * Guards the published package set: one version across the workspace, metadata
 * npm needs, and entry points that exist. These are the mistakes that only show
 * up after a release, when the tarball is already on the registry.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
      '@bunbraco/render',
      '@bunbraco/schema',
      '@bunbraco/server',
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
      if (pkg.name === 'bunbraco') continue
      expect(dependencies).toContain(pkg.name)
    }
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
