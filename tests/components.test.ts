/**
 * `components check`, `components list` and the asset trees beside them.
 *
 * A component is loaded when a request renders it, so one that does not compile
 * is a 500 waiting for a visitor. These hold the check to catching that — and to
 * the rule that replaced the old directory split: a component is a template
 * because a document type names it, at whatever depth it sits.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assetDirs,
  assetScaffold,
  checkComponents,
  componentFileFor,
  componentScaffold,
  isSafeAlias,
  listAssets,
  listComponents,
  loadConfig,
} from '@bunbraco/server'

const GOOD = `import type { PageProps } from 'bunbraco'

export default function Page({ model }: PageProps) {
  return <main>{model.text('title')}</main>
}
`

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function site(files: Record<string, string>): { root: string; componentsDir: string } {
  mkdirSync(join(process.cwd(), 'output'), { recursive: true })
  const root = mkdtempSync(join(process.cwd(), 'output', 'views-'))
  dirs.push(root)
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  return { root, componentsDir: join(root, 'components') }
}

describe('what is in components/', () => {
  test('is every .tsx at any depth, aliased by its path', () => {
    const { componentsDir } = site({
      'components/pages/homePage.tsx': GOOD,
      'components/shared/layout.tsx': GOOD,
      'components/spare.tsx': GOOD,
      'components/notes.md': 'not a component',
    })
    // The alias carries the folder, which is what lets two files share a
    // basename and still be told apart by the schema.
    expect(listComponents(componentsDir)).toEqual([
      { alias: 'pages/homePage', path: join(componentsDir, 'pages', 'homePage.tsx') },
      { alias: 'shared/layout', path: join(componentsDir, 'shared', 'layout.tsx') },
      { alias: 'spare', path: join(componentsDir, 'spare.tsx') },
    ])
  })

  test('is nothing at all when there is no components directory', () => {
    const { root } = site({ 'schema/schema.toml': '[schema]\nversion = "1.0.0"\n' })
    expect(listComponents(join(root, 'components'))).toEqual([])
  })

  test('tells the same basename apart by its folder', () => {
    // The old layout could not express this: one flat level of templates meant
    // one file per alias, full stop.
    const { componentsDir } = site({
      'components/pages/card.tsx': GOOD,
      'components/shared/card.tsx': GOOD,
    })
    expect(listComponents(componentsDir).map((c) => c.alias)).toEqual(['pages/card', 'shared/card'])
  })
})

describe('an alias is a path, so it has to stay inside the root', () => {
  test('refuses one that climbs out, is absolute, or is a drive', () => {
    for (const alias of ['../secrets', 'a/../../b', '/etc/passwd', 'C:/x', '', 'a//b', '.'])
      expect([alias, isSafeAlias(alias)]).toEqual([alias, false])
  })

  test('allows a plain name and a nested one', () => {
    for (const alias of ['homePage', 'pages/homePage', 'a/b/c'])
      expect([alias, isSafeAlias(alias)]).toEqual([alias, true])
  })

  test('componentFileFor throws rather than resolving outside the root', () => {
    const { componentsDir } = site({})
    expect(() => componentFileFor(componentsDir, '../escape')).toThrow()
  })
})

describe('where the components live', () => {
  test('moving them moves nothing else', () => {
    const { root } = site({ 'components/homePage.tsx': GOOD })
    const moved = loadConfig({ componentsDir: join(root, 'elsewhere') }, root)
    expect(moved.componentsDir).toBe(join(root, 'elsewhere'))
  })

  /**
   * App_Plugins is gone (`docs/17-bundles.md`): backoffice extensions are the
   * site's npm dependencies, so there is no plugin directory to point anywhere.
   */
  test('there is no plugin directory setting any more', () => {
    const { root } = site({ 'components/homePage.tsx': GOOD })
    expect('appPluginsDir' in loadConfig({}, root)).toBe(false)
  })
})

describe('checking the components', () => {
  test('passes a site whose components compile', async () => {
    const { root, componentsDir } = site({ 'components/homePage.tsx': GOOD })
    const report = await checkComponents({
      componentsDir,
      siteDir: root,
      declaredComponents: ['homePage'],
    })
    expect(report.problems).toEqual([])
    expect(report.components).toHaveLength(1)
    expect(report.declared).toEqual(['homePage'])
  })

  test('catches a syntax error, and says which line', async () => {
    const { root, componentsDir } = site({
      'components/broken.tsx': 'export default function Broken() {\n  return <p>{oops\n}\n',
    })
    const report = await checkComponents({ componentsDir, siteDir: root })
    expect(report.problems).toHaveLength(1)
    // Bun's own message is a bare "Syntax Error", so the position is the part
    // worth having: without it the report says nothing anybody can act on.
    expect(report.problems[0]?.file).toMatch(/components\/broken\.tsx:\d+/)
  })

  test('catches an import that does not resolve, which a render would die on', async () => {
    const { root, componentsDir } = site({
      'components/bad.tsx': `import { nope } from './nowhere.ts'\nexport default () => <p>{nope}</p>\n`,
    })
    const report = await checkComponents({ componentsDir, siteDir: root })
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]?.message).toContain('nowhere.ts')
  })

  /**
   * It resolves today and breaks the moment the view is rendered from a
   * snapshot, which copies the tree and nothing above it. Caught at check time,
   * where the message can explain itself.
   */
  test('refuses a relative import that climbs out of components/', async () => {
    const { root, componentsDir } = site({
      'lib/format.ts': 'export const f = (s: string) => s\n',
      'components/homePage.tsx': `import { f } from '../lib/format.ts'\nexport default () => f('x')\n`,
    })
    const report = await checkComponents({ componentsDir, siteDir: root })
    expect(report.problems.map((p) => p.message).join('\n')).toContain('outside components/')
  })

  test('allows an import that stays inside the tree', async () => {
    const { root, componentsDir } = site({
      'components/shared/layout.tsx': GOOD,
      'components/pages/homePage.tsx': `import '../shared/layout.tsx'\nexport default () => 'x'\n`,
    })
    const report = await checkComponents({ componentsDir, siteDir: root })
    expect(report.problems.filter((p) => p.message.includes('outside components/'))).toEqual([])
  })

  test('reports a template a document type declares and nothing provides', async () => {
    const { root, componentsDir } = site({ 'components/homePage.tsx': GOOD })
    const report = await checkComponents({
      componentsDir,
      siteDir: root,
      declaredComponents: ['homePage', 'contentPage'],
    })
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]?.message).toContain('contentPage')
  })

  test('says nothing about a component no type declares', async () => {
    const { root, componentsDir } = site({
      'components/homePage.tsx': GOOD,
      'components/spare.tsx': GOOD,
    })
    const report = await checkComponents({
      componentsDir,
      siteDir: root,
      declaredComponents: ['homePage'],
    })
    expect(report.problems).toEqual([])
  })

  test('says types were not checked when the site has no compiler', async () => {
    const { root, componentsDir } = site({ 'components/homePage.tsx': GOOD })
    const report = await checkComponents({ componentsDir, siteDir: root })
    expect(report.types.checked).toBe(false)
    expect(report.types.note).toContain('typescript')
    expect(report.types.problems).toEqual([])
  })
})

describe('the files beside the views', () => {
  test('scaffolds a component, which is not a page', () => {
    const { componentsDir } = site({})
    expect(componentFileFor(componentsDir, 'shared/header')).toBe(
      join(componentsDir, 'shared', 'header.tsx'),
    )
    expect(componentFileFor(componentsDir, 'homePage')).toBe(join(componentsDir, 'homePage.tsx'))
    // Named off the file, not the folder it happens to be in.
    const scaffold = componentScaffold('shared/site-header')
    expect(scaffold).toContain('export function SiteHeader(')
    expect(scaffold).not.toContain('export default')
  })

  test('lists stylesheets and scripts from the places the backoffice edits', () => {
    const { root } = site({
      'css/site.css': 'body { margin: 0 }',
      'css/print/page.css': '@media print {}',
      'scripts/menu.js': 'export {}',
      'scripts/notes.txt': 'not a script',
    })
    const config = { stylesheetsDir: join(root, 'css'), scriptsDir: join(root, 'scripts') }
    expect(listAssets(config)).toEqual([
      { kind: 'stylesheet', name: 'print/page.css', path: join(root, 'css', 'print', 'page.css') },
      { kind: 'stylesheet', name: 'site.css', path: join(root, 'css', 'site.css') },
      { kind: 'script', name: 'menu.js', path: join(root, 'scripts', 'menu.js') },
    ])
    expect(assetDirs(config).stylesheet.extension).toBe('.css')
    expect(assetScaffold('stylesheet', 'site.css')).toContain('/css/site.css')
    expect(assetScaffold('script', 'menu.js')).toContain('/scripts/menu.js')
  })
})
