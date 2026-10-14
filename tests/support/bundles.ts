/**
 * Bundles as the tests need them: a package as discovery would return it, and a
 * site directory whose `package.json` declares packages for discovery to find.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BundlePackage } from '@crombolo/backoffice-host'
import { VERSION } from '@crombolo/server'

/** A bundle package with a server half, for code that only reads what discovery found. */
export function stubBundlePackage(id: string, over: Partial<BundlePackage> = {}): BundlePackage {
  return {
    packageName: `@acme/${id}`,
    version: '1.0.0',
    directory: `/nowhere/${id}`,
    id,
    name: id,
    peerRange: `^${VERSION}`,
    private: false,
    field: { id, server: id },
    contentDir: undefined,
    carries: { extensions: false, content: false, server: true },
    ...over,
  }
}

export interface FixturePackage {
  /** Merged over a name, a version and a peer range on this release. */
  json?: object
  /** Files to write inside the package, by relative path. */
  files?: Record<string, string>
}

/**
 * A site directory under `output/` whose `package.json` declares these
 * dependencies. A fixture is written into the site's own `node_modules`; a name
 * given `null` is left to resolve from the repository's, which is how a
 * workspace package such as `@crombolo/simple-redirects` is found.
 */
export function siteDeclaring(
  prefix: string,
  dependencies: Record<string, FixturePackage | null>,
): string {
  const parent = join(process.cwd(), 'output')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, `${prefix}-`))
  // Its own empty views tree, so a server booted here renders nothing it shares.
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'a-site',
      dependencies: Object.fromEntries(Object.keys(dependencies).map((name) => [name, '*'])),
    }),
  )
  for (const [name, fixture] of Object.entries(dependencies)) {
    if (!fixture) continue
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        peerDependencies: { '@crombolo/crombolo': `^${VERSION}` },
        ...fixture.json,
      }),
    )
    for (const [path, content] of Object.entries(fixture.files ?? {})) {
      const file = join(dir, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, content)
    }
  }
  return root
}
