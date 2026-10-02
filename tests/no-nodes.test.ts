/**
 * What a site serves before anybody has published anything.
 *
 * Umbraco shows a "no nodes" screen; `docs/06-features.md` asks for the same.
 * The rule worth holding is which 404 is which: the explanation only appears
 * while the published tree is empty, so a missing path on a live site keeps the
 * plain answer a crawler and a monitor expect.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TemplateRepository } from '@bunbraco/data'
import { signedInServer, V1 } from './support/harness.ts'

const TYPE = `[document-type]
key = "0f74e1c2-5a16-4d9c-9c70-9a2a6c3a1f10"
alias = "page"
name = "Page"
allow-at-root = true
templates = ["page"]
default-template = "page"

[[property]]
key = "0f74e1c2-5a16-4d9c-9c70-9a2a6c3a1f11"
alias = "title"
name = "Title"
type = "textstring"
`

const VIEW = `export default function Page({ model }) {
  return <main><h1>{model.text('title')}</h1></main>
}
`

describe('a site with nothing published', () => {
  const open: Array<{ db: { close(): Promise<void> } }> = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const h of open.splice(0)) await h.db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function site() {
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    const root = mkdtempSync(join(process.cwd(), 'output', 'no-nodes-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(root, 'Views'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE)
    writeFileSync(join(root, 'Views', 'page.tsx'), VIEW)
    const h = await signedInServer({
      config: {
        siteName: 'Fresh Site',
        schemaDir: join(root, 'schema'),
        viewsDir: join(root, 'Views'),
      },
    })
    open.push(h)
    return h
  }

  test('explains itself, and says so with a 404 rather than pretending to work', async () => {
    const h = await site()
    const response = await h.call('/')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Nothing is published yet')
    // The site's own name, and the way in.
    expect(html).toContain('Fresh Site')
    expect(html).toContain(h.server.config.backOfficePath)
    // Nothing for a crawler to index while there is nothing to see.
    expect(html).toContain('name="robots" content="noindex"')
  })

  test('answers it at any path, since no path can be right yet', async () => {
    const h = await site()
    expect((await h.call('/anything/at/all')).status).toBe(404)
    expect(await (await h.call('/anything/at/all')).text()).toContain('Nothing is published yet')
  })

  test('and stops once a page is published, leaving a missing path a plain 404', async () => {
    const h = await site()
    const template = (await new TemplateRepository(h.server.db).byAlias('page'))?.key as string
    const created = await h.post(`${V1}/document`, {
      documentType: { id: '0f74e1c2-5a16-4d9c-9c70-9a2a6c3a1f10' },
      template: { id: template },
      parent: null,
      values: [{ alias: 'title', culture: null, segment: null, value: 'Home' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string

    // A draft is not a published site: the explanation still stands.
    expect(await (await h.call('/')).text()).toContain('Nothing is published yet')

    expect((await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    // This process has already built a snapshot of an empty site, and a publish
    // reaches it as a cache instruction — which the poller applies.
    await h.server.poll()
    const home = await h.call('/')
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('<h1>Home</h1>')

    const missing = await h.call('/no-such-page')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('text/plain')
    expect(await missing.text()).toBe('Not Found')
  })
})
