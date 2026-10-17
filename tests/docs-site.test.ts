/**
 * The product site's docs section (story 157): the guides rendered from
 * Markdown, the reference generated from the command line and the settings
 * list, and the committed bundle that carries both with the page types and
 * views they need.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { SearchIndex } from '@crombolo/data'
import { installBundleContent, SETTINGS } from '@crombolo/server'
import { buildManifest } from '../packages/cli/src/manifest.ts'
import {
  configurationHtml,
  DOCS_DIR,
  type DocsPage,
  docsKey,
  docsTree,
  parseGuide,
  renderMarkdown,
} from '../scripts/docs-site.ts'
import { ROOT } from '../scripts/packages.ts'
import { type Harness, signedInServer } from './support/harness.ts'

const BUNDLE = join(ROOT, 'sites/crombolo/bundles/demo-crombolo')
const NODES = join(BUNDLE, 'content/nodes')
const CLI_REFERENCE_KEY = '3c1e9b52-7d40-4f18-9a6e-150c11ec0150'

interface StoredNode {
  values: Array<{ property: string; value: unknown }>
}

const stored = (key: string): StoredNode | undefined => {
  const file = join(NODES, `${key}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StoredNode) : undefined
}

const storedValue = (node: StoredNode | undefined, property: string) =>
  node?.values.find((v) => v.property === property)?.value

const everyPage = (pages: readonly DocsPage[]): DocsPage[] =>
  pages.flatMap((page) => [page, ...everyPage(page.children)])

describe('the guides', () => {
  test('Markdown headings get ids, unique on the page, for "On this page"', () => {
    const html = renderMarkdown('## Set it up\n\ntext\n\n## Set it up\n\n### The `crombolo` file\n')
    expect(html).toContain('<h2 id="set-it-up">Set it up</h2>')
    expect(html).toContain('<h2 id="set-it-up-2">Set it up</h2>')
    expect(html).toContain('<h3 id="the-crombolo-file">The <code>crombolo</code> file</h3>')
  })

  test('a guide must say what it is, and leave the page title to the page', () => {
    const ok = parseGuide('a.md', '---\ntitle: A\nsummary: About a.\norder: 2\n---\n\n## One\n')
    expect(ok).toMatchObject({ title: 'A', summary: 'About a.', order: 2, body: '## One' })
    expect(() => parseGuide('b.md', '## No front matter\n')).toThrow('no front matter')
    expect(() => parseGuide('c.md', '---\ntitle: C\norder: 1\n---\n')).toThrow('"summary"')
    expect(() => parseGuide('d.md', '---\ntitle: D\nsummary: d\norder: 1\n---\n# D\n')).toThrow(
      'start at ##',
    )
  })

  test('every guide in the repository is well formed', () => {
    const pages = everyPage(docsTree({ version: '0', commands: {} }))
    const written = pages.filter((page) => page.editUrl)
    expect(written.map((page) => page.path)).toContain('getting-started')
    expect(written.filter((page) => page.path.startsWith('guides/')).length).toBeGreaterThan(0)
    for (const page of written) {
      expect(page.body, page.path).toBeTruthy()
      // Written for a visitor, not for someone reading the repository.
      expect(page.body, page.path).not.toMatch(/packages\/[a-z-]+\/src|story \d{3}/i)
    }
    expect(existsSync(join(DOCS_DIR, 'getting-started.md'))).toBe(true)
  })
})

describe('the configuration reference', () => {
  test('lists every setting the server reads, once', () => {
    const html = configurationHtml()
    for (const setting of SETTINGS)
      expect(html.split(`<tr><td><code>${setting.env}</code></td>`), setting.env).toHaveLength(2)
  })
})

describe('the committed bundle', () => {
  test('holds every docs page as the build writes it today', async () => {
    const pages = everyPage(docsTree(await buildManifest()))
    for (const page of pages) {
      const node = stored(docsKey(page.path))
      expect(node, `${page.path}: run \`bun run build:template demo/crombolo\``).toBeDefined()
      const body = (storedValue(node, 'body') as { markup?: string } | undefined)?.markup
      expect(
        body === page.body,
        `${page.path} changed: run \`bun run build:template demo/crombolo\` to rewrite the docs`,
      ).toBe(true)
    }
  })

  test('the old command line page sends visitors to the docs', () => {
    const target = docsKey('reference/command-line').replaceAll('-', '')
    expect(storedValue(stored(CLI_REFERENCE_KEY), 'umbracoRedirect')).toBe(
      `umb://document/${target}`,
    )
  })

  test('carries the site’s schema and views with its content', () => {
    for (const file of [
      'content/schema/content-types/docs-page.toml',
      'content/schema/content-types/docs-section.toml',
      'content/components/pages/docsPage.tsx',
      'content/components/shared/docs.tsx',
      'content/styles/site.css',
    ])
      expect(existsSync(join(BUNDLE, file)), file).toBe(true)
    // And as the site has them, so the bundle is never a stale copy.
    expect(readFileSync(join(BUNDLE, 'content/components/pages/docsPage.tsx'), 'utf8')).toBe(
      readFileSync(join(ROOT, 'sites/crombolo/components/pages/docsPage.tsx'), 'utf8'),
    )
  })
})

describe('installed on a site that has none of it', () => {
  const open: Harness[] = []
  const dirs: string[] = []
  afterEach(async () => {
    while (open.length > 0)
      await open
        .pop()
        ?.db.close()
        .catch(() => {})
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })

  async function emptySite() {
    const root = mkdtempSync(join(ROOT, 'output', 'docs-site-'))
    dirs.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'platform-copy' }))
    for (const dir of ['schema', 'components', 'css', 'scripts'])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        stylesheetsDir: join(root, 'css'),
        scriptsDir: join(root, 'scripts'),
        // Views the install writes are picked up on the next request, not seconds later.
        componentsSnapshot: { gateTtlMs: 0, minSwapIntervalMs: 0 },
      },
    })
    open.push(h)
    return { h, root }
  }

  test('one install brings the types, the views and the pages, and they render', async () => {
    const { h, root } = await emptySite()
    const copy = join(root, 'bundle')
    cpSync(BUNDLE, copy, { recursive: true })
    const result = await installBundleContent(h.server.db, h.server.config, {
      bundle: copy,
      publish: true,
      backupTaken: true,
    })
    expect(result.problems).toEqual([])

    // A render answers from the views it has and checks for new ones behind it,
    // so the views the install wrote arrive a request or two later.
    let docs = await h.call('/docs/')
    for (let tries = 0; docs.status !== 200 && tries < 50; tries++) {
      await Bun.sleep(20)
      docs = await h.call('/docs/')
    }
    expect(docs.status).toBe(200)
    const front = await docs.text()
    expect(front).toContain('<nav class="docs-nav" aria-label="Docs">')
    expect(front).toContain('href="/docs/getting-started"')

    const content = await (await h.call('/docs/reference/command-line/content/')).text()
    expect(content).toContain('id="content-publish"')
    expect(content).toContain('aria-label="On this page"')
    expect(content).toContain('Generated from')

    const old = await h.call('/developers/command-line/', { redirect: 'manual' })
    expect(old.status).toBe(302)
    expect(old.headers.get('location')).toEndWith('/docs/reference/command-line')

    // Docs pages are found by the site's search, from a word in their body,
    // once the indexer has been round: a job does that every few seconds.
    await new SearchIndex(h.server.db).indexAll()
    const found = await (await h.call('/docs/search/?q=clispec')).text()
    expect(found).toContain('href="/docs/reference/command-line"')

    // A view that differs here — edited on the platform, or older than the
    // release — is refused without permission, and replaced with it.
    const view = join(root, 'components/pages/docsPage.tsx')
    writeFileSync(view, readFileSync(view, 'utf8').replace('Suggest a change', 'Propose a change'))
    const install = (replaceFiles: boolean) =>
      installBundleContent(h.server.db, h.server.config, {
        bundle: copy,
        publish: true,
        backupTaken: true,
        replaceFiles,
      })
    expect((await install(false)).problems.join('\n')).toContain('components/pages/docsPage.tsx')
    expect((await install(true)).problems).toEqual([])
    expect(readFileSync(view, 'utf8')).toContain('Suggest a change')
  })
})
