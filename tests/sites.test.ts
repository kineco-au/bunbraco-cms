/**
 * The sites in `sites/`: each a private workspace run in place, shipped with the
 * CLI only when it opts in, and staged for that in the layout `init` reads.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { findTemplate, listTemplates, scaffoldFiles } from '@crombolo/cli'
import { siteMediaTypeFiles } from '@crombolo/schema'
import { ROOT } from '../scripts/packages.ts'
import {
  findSite,
  listSites,
  runState,
  SITES_DIR,
  stageTemplates,
  unstage,
} from '../scripts/sites.ts'

mkdirSync(join(ROOT, 'output'), { recursive: true })
const scratch: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(ROOT, 'output', 'sites-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

describe('the sites', () => {
  const sites = listSites()

  test('are found by their site.json, by id or by directory', () => {
    expect(sites.map((site) => site.id)).toEqual(['demo/crombolo', 'demo/harbourstone', 'starter'])
    expect(findSite('demo/harbourstone')?.dir).toBe(join(SITES_DIR, 'harbourstone'))
    expect(findSite('harbourstone')?.id).toBe('demo/harbourstone')
    expect(findSite('nope')).toBeUndefined()
  })

  test('are workspaces, so running one runs the working tree', () => {
    const root = json(join(ROOT, 'package.json')) as { workspaces: string[] }
    expect(root.workspaces).toContain('sites/*')
  })

  test.each(sites.map((site) => [site.id, site] as const))(
    '%s is a private package that depends on the workspace, and starts its own bundle',
    (_, site) => {
      const manifest = json(join(site.dir, 'package.json')) as {
        private?: boolean
        scripts: Record<string, string>
        dependencies: Record<string, string>
      }
      expect(manifest.private).toBe(true)
      for (const range of Object.values(manifest.dependencies)) expect(range).toBe('workspace:*')
      expect(manifest.scripts.start).toBe(`crombolo start --bundle ${site.bundle} --publish`)
      expect(existsSync(join(site.dir, site.bundle, 'package.json'))).toBe(true)
      expect(existsSync(join(site.dir, site.bundle, 'content', 'bundle.json'))).toBe(true)
    },
  )

  test.each(sites.map((site) => [site.id, site] as const))(
    '%s runs the server bundles its scaffold would wire',
    (_, site) => {
      // The site's own files and the ones `init` would write from its site.json
      // are two copies of one decision; this keeps them the same decision.
      const manifest = json(join(site.dir, 'package.json')) as {
        dependencies: Record<string, string>
      }
      const config = readFileSync(join(site.dir, 'crombolo.config.ts'), 'utf8')
      for (const bundle of site.bundles as { package: string; import: string }[]) {
        expect(Object.keys(manifest.dependencies)).toContain(bundle.package)
        expect(config).toContain(`import { ${bundle.import} } from '${bundle.package}'`)
      }
    },
  )

  test('ship only when they opt in', () => {
    expect(sites.filter((site) => site.distribute).map((site) => site.id)).toEqual([
      'demo/harbourstone',
      'starter',
    ])
  })
})

describe('staging a site as a template', () => {
  test('stages the distributed sites by default, and nothing else', () => {
    const into = tempDir()
    stageTemplates(into)
    expect(listTemplates(into).map((template) => template.id)).toEqual([
      'demo/harbourstone',
      'starter',
    ])
  })

  test('writes the layout init reads, and leaves the site’s own files behind', () => {
    const into = tempDir()
    const site = findSite('demo/harbourstone')
    if (!site) throw new Error('no harbourstone')
    stageTemplates(into, [site])
    const template = findTemplate('demo/harbourstone', into)
    expect(template?.serverBundles).toEqual([
      { package: '@crombolo/simple-redirects', import: 'redirects' },
    ])
    const dir = join(into, 'demo', 'harbourstone')
    expect(readdirSync(dir).sort()).toEqual(['CREDITS.md', 'bundle', 'files', 'template.json'])
    expect(readdirSync(join(dir, 'files')).sort()).toEqual(['components', 'css', 'schema'])
    expect(readdirSync(join(dir, 'bundle')).sort()).toEqual(['content', 'package.json'])
  })

  test('leaves out the media types init writes for itself', () => {
    const into = tempDir()
    const site = findSite('demo/harbourstone')
    if (!site) throw new Error('no harbourstone')
    for (const path of Object.keys(siteMediaTypeFiles()))
      expect([path, existsSync(join(site.dir, path))]).toEqual([path, true])
    stageTemplates(into, [site])
    expect(existsSync(join(into, 'demo', 'harbourstone', 'files', 'schema', 'media-types'))).toBe(
      false,
    )
    // So a scaffold from it still has them, from the CLI rather than the template.
    const paths = scaffoldFiles({ template: findTemplate('demo/harbourstone', into) }).map(
      (file) => file.path,
    )
    for (const path of Object.keys(siteMediaTypeFiles())) expect(paths).toContain(path)
  })

  test('refuses to overwrite a template that is already there', () => {
    const into = tempDir()
    mkdirSync(join(into, 'demo', 'harbourstone'), { recursive: true })
    expect(() => stageTemplates(into)).toThrow(/already exists/)
  })

  test('is taken away again, family directory and all, leaving the rest', () => {
    const into = tempDir()
    mkdirSync(join(into, 'basic'))
    const staged = stageTemplates(into, listSites())
    expect(staged).toHaveLength(3)
    unstage(staged, into)
    expect(readdirSync(into)).toEqual(['basic'])
  })
})

describe('what a site writes as it runs', () => {
  test('is the database, its backups, media, logs and the view cache', () => {
    const dir = tempDir()
    const names = [
      'crombolo.sqlite',
      'crombolo.sqlite-wal',
      'crombolo.sqlite.2026-10-14T00-45-07-199Z.content-import.bak',
      'media',
      'logs',
      '.crombolo',
    ]
    const committed = ['site.json', 'package.json', 'components', 'schema', 'bundles']
    for (const name of [...names, ...committed]) mkdirSync(join(dir, name))
    expect(
      runState(dir)
        .map((path) => path.slice(dir.length + 1))
        .sort(),
    ).toEqual([...names].sort())
  })

  test('is all gitignored, along with the templates staged from it', () => {
    // Read from the file rather than asked of git, which the test image has not got.
    const rules = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n')
    for (const rule of [
      '*.sqlite',
      '*.sqlite-*',
      '*.content-import.bak',
      'sites/*/media/',
      'logs/',
      '.crombolo/',
      'packages/cli/templates/*',
      '!packages/cli/templates/basic/',
    ])
      expect([rule, rules.includes(rule)]).toEqual([rule, true])
  })
})
