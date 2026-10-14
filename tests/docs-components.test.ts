/**
 * The examples in docs/writing-components.md, run: every `// components/…`
 * block is written into a site, type-checked as a site would be, and rendered
 * as the page the document builds.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ComponentRepository, ContentTypeRepository } from '@crombolo/data'
import { generateTypes, loadSchemaDirectory } from '@crombolo/schema'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

const GUIDE = join(import.meta.dir, '..', 'docs', 'writing-components.md')

/** Each fenced `tsx` block whose first line names its file under `components/`. */
function examples(): Map<string, string> {
  const files = new Map<string, string>()
  for (const part of readFileSync(GUIDE, 'utf8').split('```tsx\n').slice(1)) {
    const block = part.slice(0, part.indexOf('```'))
    const named = /^\/\/ (components\/\S+)\n/.exec(block)
    if (named) files.set(named[1] as string, block)
  }
  return files
}

const SHOWCASE = `[content-type]
alias = "showcasePage"
name = "Showcase Page"
allow-at-root = true
allow-children = ["showcasePage"]
compositions = ["seoFields"]
components = ["showcasePage"]
default-component = "showcasePage"

[[tab]]
name = "Content"

[[tab.property]]
alias = "title"
name = "Title"
type = "textstring"
mandatory = true

[[tab.property]]
alias = "body"
name = "Body"
type = "richtext"

[[tab.property]]
alias = "feedUrl"
name = "Events feed URL"
type = "textstring"
`

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

/** A site holding the document's components, its type, and the generated types. */
function siteFromGuide(): string {
  const root = mkdtempSync(join(process.cwd(), 'output', 'docs-components-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'showcase-page.toml'), SHOWCASE)
  writeFileSync(
    join(root, 'schema', 'content-types.d.ts'),
    generateTypes(loadSchemaDirectory(join(root, 'schema')).set),
  )
  for (const [file, source] of examples()) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  return root
}

describe('docs/writing-components.md', () => {
  test('has the components the page it builds imports', () => {
    expect([...examples().keys()].sort()).toEqual([
      'components/shared/arrow-icon.tsx',
      'components/shared/badge.tsx',
      'components/shared/breadcrumbs.tsx',
      'components/shared/card-list.tsx',
      'components/shared/hero.tsx',
      'components/shared/layout.tsx',
      'components/shared/newsletter-form.tsx',
      'components/shared/theme.tsx',
      'components/shared/upcoming-events.tsx',
      'components/showcasePage.tsx',
    ])
  })

  test('type-checks, as a site’s own tsconfig would check it', async () => {
    const root = siteFromGuide()
    const site = (await Bun.file('apps/site/tsconfig.json').json()) as {
      compilerOptions: Record<string, unknown>
    }
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: site.compilerOptions, include: ['components', 'schema'] }),
    )
    const tsc = Bun.spawn(['bun', 'node_modules/typescript/bin/tsc', '-p', root], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${await new Response(tsc.stdout).text()}${await new Response(tsc.stderr).text()}`
    expect(out.trim()).toBe('')
    expect(await tsc.exited).toBe(0)
  }, 60_000)

  test('renders the page it builds, and a page beneath it', async () => {
    const feed = Bun.serve({
      port: 0,
      fetch: () => Response.json([{ title: 'Open day', startsAt: '2026-11-02T09:00:00Z' }]),
    })
    try {
      const root = siteFromGuide()
      const h = await signedInServer({
        config: {
          siteDir: root,
          schemaDir: join(root, 'schema'),
          componentsDir: join(root, 'components'),
          componentsCacheDir: join(root, '.crombolo', 'components'),
          development: true,
          schemaWritable: true,
        },
      })
      open.push(h)
      const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('showcasePage'))
        ?.key as string
      const componentKey = (await new ComponentRepository(h.server.db).byAlias('showcasePage'))
        ?.key as string
      const publish = async (name: string, parent: string | null) => {
        const created = await h.post(`${V1}/document`, {
          documentType: { id: typeKey },
          template: { id: componentKey },
          parent: parent ? { id: parent } : null,
          values: [
            { alias: 'title', culture: null, segment: null, value: name },
            {
              alias: 'feedUrl',
              culture: null,
              segment: null,
              value: `http://localhost:${feed.port}/events`,
            },
          ],
          variants: [{ culture: null, segment: null, name }],
        })
        const key = created.headers.get('umb-generated-resource') as string
        expect(
          (await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status,
        ).toBe(200)
        return key
      }
      const home = await publish('Home', null)
      await publish('Visit us', home)

      const page = await (await h.server.fetch(new Request(`${ORIGIN}/`))).text()
      expect(page.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true)
      expect(page).toContain('<body class="theme-dark">')
      expect(page).toContain('style="min-height:320px;--hero-gap:2rem"')
      expect(page).toContain('<h1>Home</h1>')
      expect(page).toContain('stroke-width="1.5"')
      expect(page).toContain('<div class="panel panel--dark">')
      expect(page).toContain(
        '<a href="/visit-us">Visit us</a><span class="badge badge--info">New</span>',
      )
      expect(page).toContain('<time datetime="2026-11-02T09:00:00Z">2026-11-02</time> Open day')
      expect(page).toContain('<label for=":b0:">Email</label><input id=":b0:"')
      expect(page).toContain('<option value="News" selected>News</option>')
      expect(page).toContain('<input type="checkbox" name="updates" checked />')
      // The home page has no ancestors, so no breadcrumbs.
      expect(page).not.toContain('aria-label="Breadcrumbs"')

      const child = await (await h.server.fetch(new Request(`${ORIGIN}/visit-us`))).text()
      expect(child).toContain(
        '<nav aria-label="Breadcrumbs"><a href="/">Home</a><span aria-current="page">Visit us</span></nav>',
      )
      expect(child).toContain('<p>Nothing here yet.</p>')
    } finally {
      feed.stop(true)
    }
  }, 30_000)
})
