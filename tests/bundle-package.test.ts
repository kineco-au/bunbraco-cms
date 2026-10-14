/**
 * A bundle is an npm package: the `crombolo` field of its `package.json` is the
 * manifest, read and validated in one place. docs/bundles.md, story 063.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  CORE_PACKAGE,
  declaresBundle,
  discoverBundles,
  type PackageJson,
  peerRangeProblem,
  readBundlePackage,
  validateBundlePackage,
} from '@crombolo/backoffice-host'
import { VERSION } from '@crombolo/server'
import { siteDeclaring, stubBundlePackage } from './support/bundles.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const valid = (over: Record<string, unknown> = {}, crombolo: Record<string, unknown> = {}) =>
  ({
    name: '@acme/tasks',
    version: '1.0.0',
    peerDependencies: { [CORE_PACKAGE]: `^${VERSION}` },
    crombolo: { id: 'acme-tasks', name: 'Tasks', server: 'tasks', ...crombolo },
    ...over,
  }) as PackageJson

const problemsOf = (json: PackageJson, directory?: string) =>
  validateBundlePackage(json, directory).join('\n')

describe('the manifest', () => {
  test('accepts a bundle that declares a server half', () => {
    expect(validateBundlePackage(valid())).toEqual([])
  })

  test('requires an id that is a route segment', () => {
    for (const id of [undefined, 'Acme.Tasks', 'a', '../x', 'acme_tasks', 'x'.repeat(40)])
      expect(problemsOf(valid({}, { id })), String(id)).toContain('"crombolo.id"')
  })

  test('requires a package name and version', () => {
    expect(problemsOf(valid({ name: undefined }))).toContain('no "name"')
    expect(problemsOf(valid({ version: undefined }))).toContain('no "version"')
  })

  test('requires a peer range on core', () => {
    expect(problemsOf(valid({ peerDependencies: undefined }))).toContain(
      `peerDependencies["${CORE_PACKAGE}"]`,
    )
  })

  test('refuses a bundle that declares nothing to do', () => {
    const json = valid({}, { server: undefined, extensions: [] })
    expect(problemsOf(json)).toContain('a bundle that does nothing')
  })

  test('refuses a server half that is not an export name', () => {
    expect(problemsOf(valid({}, { server: './src/index.ts' }))).toContain('"crombolo.server"')
  })

  test('refuses content outside the package', () => {
    for (const content of ['../elsewhere', '/etc', 'a/../../b'])
      expect(problemsOf(valid({}, { content })), content).toContain('outside the package')
  })

  test('refuses content that holds no payload', () => {
    const root = siteDeclaring('bundle-package', {
      '@acme/tasks': { json: valid({}, { content: 'content' }) },
    })
    dirs.push(root)
    const dir = join(root, 'node_modules', '@acme/tasks')
    expect(problemsOf(valid({}, { content: 'content' }), dir)).toContain('holds no bundle.json')
  })

  test('reports every problem at once', () => {
    const json = valid({ version: undefined, peerDependencies: undefined }, { id: 'X' })
    expect(validateBundlePackage(json)).toHaveLength(3)
  })

  test('core itself is never a bundle, though it carries a crombolo field', () => {
    expect(declaresBundle({ name: CORE_PACKAGE, crombolo: { migrations: 'compatible' } })).toBe(
      false,
    )
    expect(declaresBundle(valid())).toBe(true)
    expect(declaresBundle({ name: 'lodash' })).toBe(false)
  })
})

describe('reading one', () => {
  test('a package with content carries it, at a path inside the package', () => {
    const root = siteDeclaring('bundle-package', {
      '@acme/tasks': {
        json: valid({}, { content: 'content', server: undefined }),
        files: { 'content/bundle.json': '{}' },
      },
    })
    dirs.push(root)
    const { bundle, problems } = readBundlePackage(join(root, 'node_modules', '@acme/tasks'))
    expect(problems).toEqual([])
    expect(bundle?.carries).toEqual({ extensions: false, content: true, server: false })
    expect(bundle?.contentDir).toBe(join(root, 'node_modules', '@acme/tasks', 'content'))
    expect(bundle?.name).toBe('Tasks')
  })

  test('discovery reports a malformed bundle by package, and keeps the rest', () => {
    const root = siteDeclaring('bundle-package', {
      '@acme/tasks': { json: valid() },
      '@acme/broken': { json: valid({ name: '@acme/broken' }, { id: 'Broken' }) },
      lodash: { json: { name: 'lodash' } },
    })
    dirs.push(root)
    const found = discoverBundles(root)
    expect(found.bundles.map((bundle) => bundle.packageName)).toEqual(['@acme/tasks'])
    expect(found.problems.map((problem) => problem.packageName)).toEqual(['@acme/broken'])
  })
})

describe('the peer range', () => {
  test('admits the running release when it should', () => {
    expect(peerRangeProblem(stubBundlePackage('tasks'), VERSION)).toBeUndefined()
  })

  test('names the bundle, its range and the running version when it does not', () => {
    const problem = peerRangeProblem(stubBundlePackage('tasks', { peerRange: '^0.1.0' }), VERSION)
    expect(problem).toContain('@acme/tasks')
    expect(problem).toContain('^0.1.0')
    expect(problem).toContain(VERSION)
  })

  test('refuses a range that is not one', () => {
    expect(
      peerRangeProblem(stubBundlePackage('tasks', { peerRange: 'not a range' }), VERSION),
    ).toBeDefined()
  })
})
