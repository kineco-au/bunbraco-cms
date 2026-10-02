/**
 * `views check`, `views list` and the asset trees beside them.
 *
 * A view is loaded when a request renders it, so a view that does not compile
 * is a 500 waiting for a visitor. These hold the check to catching that — and
 * to knowing which `.tsx` under `Views/` is a template, since only the top
 * level is one and everything else is a component a view imports.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assetDirs,
  assetScaffold,
  checkViews,
  listAssets,
  listViews,
  loadConfig,
  partialScaffold,
  viewFileFor,
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

function site(files: Record<string, string>): { root: string; viewsDir: string } {
  mkdirSync(join(process.cwd(), 'output'), { recursive: true })
  const root = mkdtempSync(join(process.cwd(), 'output', 'views-'))
  dirs.push(root)
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  return { root, viewsDir: join(root, 'Views') }
}

describe('what is in Views/', () => {
  test('is a template only at the top level, and a component anywhere below', () => {
    const { viewsDir } = site({
      'Views/homePage.tsx': GOOD,
      'Views/Partials/header.tsx': GOOD,
      'Views/components/layout.tsx': GOOD,
      'Views/notes.md': 'not a view',
    })
    expect(listViews(viewsDir)).toEqual([
      { kind: 'partial', alias: 'header', path: join(viewsDir, 'Partials', 'header.tsx') },
      { kind: 'component', alias: 'layout', path: join(viewsDir, 'components', 'layout.tsx') },
      { kind: 'template', alias: 'homePage', path: join(viewsDir, 'homePage.tsx') },
    ])
  })

  test('is nothing at all when there is no Views directory', () => {
    const { root } = site({ 'schema/schema.toml': '[schema]\nversion = "1.0.0"\n' })
    expect(listViews(join(root, 'Views'))).toEqual([])
  })
})

describe('where the views and the plugins live', () => {
  test('are independent paths, so moving one does not move the other', () => {
    const { root } = site({ 'Views/homePage.tsx': GOOD })
    const moved = loadConfig({ viewsDir: join(root, 'elsewhere') }, root)
    // App_Plugins used to be derived as `viewsDir/../App_Plugins`, so pointing
    // the views at a mounted bucket or a cache directory took the backoffice's
    // plugins with it and the editor silently lost them.
    expect(moved.viewsDir).toBe(join(root, 'elsewhere'))
    expect(moved.appPluginsDir).toBe(join(root, 'App_Plugins'))
  })

  test('are each settable on their own', () => {
    const { root } = site({ 'Views/homePage.tsx': GOOD })
    // Compared against an untouched config rather than a literal: the suite sets
    // BUNBRACO_VIEWS_DIR, so the default here is not `Views`.
    const plain = loadConfig({}, root)
    const config = loadConfig({ appPluginsDir: join(root, 'plugins') }, root)
    expect(config.appPluginsDir).toBe(join(root, 'plugins'))
    expect(config.viewsDir).toBe(plain.viewsDir)
  })
})

describe('checking the views', () => {
  test('passes a site whose views compile', async () => {
    const { root, viewsDir } = site({ 'Views/homePage.tsx': GOOD })
    const report = await checkViews({
      viewsDir,
      siteDir: root,
      declaredTemplates: ['homePage'],
    })
    expect(report.problems).toEqual([])
    expect(report.views).toHaveLength(1)
  })

  test('catches a syntax error, and says which line', async () => {
    const { root, viewsDir } = site({
      'Views/broken.tsx': 'export default function Broken() {\n  return <p>{oops\n}\n',
    })
    const report = await checkViews({ viewsDir, siteDir: root })
    expect(report.problems).toHaveLength(1)
    // Bun's own message is a bare "Syntax Error", so the position is the part
    // worth having: without it the report says nothing anybody can act on.
    expect(report.problems[0]?.file).toMatch(/Views\/broken\.tsx:\d+/)
  })

  test('catches an import that does not resolve, which a render would die on', async () => {
    const { root, viewsDir } = site({
      'Views/bad.tsx': `import { nope } from './nowhere.ts'\nexport default () => <p>{nope}</p>\n`,
    })
    const report = await checkViews({ viewsDir, siteDir: root })
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]?.message).toContain('nowhere.ts')
  })

  /**
   * It resolves today and breaks the moment the view is rendered from a
   * snapshot, which copies the tree and nothing above it. Caught at check time,
   * where the message can explain itself.
   */
  test('refuses a relative import that climbs out of Views/', async () => {
    const { root, viewsDir } = site({
      'lib/format.ts': 'export const f = (s: string) => s\n',
      'Views/homePage.tsx': `import { f } from '../lib/format.ts'\nexport default () => f('x')\n`,
    })
    const report = await checkViews({ viewsDir, siteDir: root })
    expect(report.problems.map((p) => p.message).join('\n')).toContain('outside Views/')
  })

  test('allows an import that stays inside the tree', async () => {
    const { root, viewsDir } = site({
      'Views/components/layout.tsx': GOOD,
      'Views/homePage.tsx': `import './components/layout.tsx'\nexport default () => 'x'\n`,
    })
    const report = await checkViews({ viewsDir, siteDir: root })
    expect(report.problems.filter((p) => p.message.includes('outside Views/'))).toEqual([])
  })

  test('reports a template a document type declares and nothing provides', async () => {
    const { root, viewsDir } = site({ 'Views/homePage.tsx': GOOD })
    const report = await checkViews({
      viewsDir,
      siteDir: root,
      declaredTemplates: ['homePage', 'contentPage'],
    })
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]?.message).toContain('contentPage')
  })

  test('says nothing about a view no type declares, which may be a component', async () => {
    const { root, viewsDir } = site({ 'Views/homePage.tsx': GOOD, 'Views/spare.tsx': GOOD })
    const report = await checkViews({ viewsDir, siteDir: root, declaredTemplates: ['homePage'] })
    expect(report.problems).toEqual([])
  })

  test('says types were not checked when the site has no compiler', async () => {
    const { root, viewsDir } = site({ 'Views/homePage.tsx': GOOD })
    const report = await checkViews({ viewsDir, siteDir: root })
    expect(report.types.checked).toBe(false)
    expect(report.types.note).toContain('typescript')
    expect(report.types.problems).toEqual([])
  })
})

describe('the files beside the views', () => {
  test('scaffolds a partial that is a component, not a page', () => {
    const { viewsDir } = site({})
    expect(viewFileFor(viewsDir, 'header', true)).toBe(join(viewsDir, 'Partials', 'header.tsx'))
    expect(viewFileFor(viewsDir, 'homePage')).toBe(join(viewsDir, 'homePage.tsx'))
    const scaffold = partialScaffold('header')
    expect(scaffold).toContain('export function Header(')
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
