/**
 * Async components: a template, a layout or anything they render may await, and
 * the page is built once it has all resolved — within a deadline, with a signal
 * that tells the template when to stop.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComponentRepository, ContentTypeRepository } from '@crombolo/data'
import { RawHtml } from '@crombolo/render'
import { type Child, element, Fragment, jsx, renderToString } from '@crombolo/render/jsx-runtime'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

const later = <T>(value: T, ms = 5): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms))

describe('the JSX runtime', () => {
  test('a tree with nothing async renders synchronously, as it always has', () => {
    const html = jsx('p', { children: ['a', jsx('b', { children: 'c' })] })
    expect(html).toBeInstanceOf(RawHtml)
    expect(renderToString(html)).toBe('<p>a<b>c</b></p>')
  })

  test('an async component is awaited, and its text escaped like any other', async () => {
    const Greeting = async ({ name }: { name: string }) =>
      jsx('em', { children: await later(name) })
    const html = jsx('p', {
      children: ['Hi ', jsx(Greeting as never, { name: '<Ann>' }), '!'],
    })
    expect(html).toBeInstanceOf(Promise)
    expect(await renderToString(html)).toBe('<p>Hi <em>&lt;Ann&gt;</em>!</p>')
  })

  test('nested async components and mixed arrays keep their order', async () => {
    const Slow = async ({ text, ms }: { text: string; ms: number }) => await later(text, ms)
    const children: Child = [
      jsx(Slow as never, { text: '1', ms: 15 }),
      '2',
      jsx(Fragment, { children: [jsx(Slow as never, { text: '3', ms: 1 }), '4'] }),
      later('5'),
    ]
    expect(await renderToString(jsx('div', { children }))).toBe('<div>12345</div>')
  })

  test('siblings start together rather than one after another', async () => {
    const order: string[] = []
    const Step = async ({ name }: { name: string }) => {
      order.push(`${name}:start`)
      await later(null, 10)
      order.push(`${name}:end`)
      return name
    }
    await renderToString(
      jsx('div', {
        children: [jsx(Step as never, { name: 'a' }), jsx(Step as never, { name: 'b' })],
      }),
    )
    expect(order.slice(0, 2)).toEqual(['a:start', 'b:start'])
  })

  test('a failure reaches whoever renders the page, and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', record)
    try {
      const Broken = async () => {
        throw new Error('upstream down')
      }
      const Fine = async () => await later('ok', 10)
      const html = jsx('div', {
        children: [jsx(Broken as never, {}), jsx(Fine as never, {}), jsx(Broken as never, {})],
      })
      await expect(renderToString(html)).rejects.toThrow('upstream down')
      await later(null, 20)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  test('an attribute may not be a promise', () => {
    expect(() => jsx('a', { href: later('/x') })).toThrow(
      'The "href" attribute of <a> is a promise',
    )
  })

  test('setInnerHTML may be a promise, and is still escaped unless marked dangerous', async () => {
    expect(await renderToString(jsx('div', { setInnerHTML: { __html: later('<i>x</i>') } }))).toBe(
      '<div>&lt;i&gt;x&lt;/i&gt;</div>',
    )
    expect(
      await renderToString(
        jsx('div', { setInnerHTML: { __html: later('<i>x</i>'), dangerously: true } }),
      ),
    ).toBe('<div><i>x</i></div>')
  })

  test('element() is for markup that must be ready now, and refuses an async child', () => {
    expect(element('p', { children: 'x' }).value).toBe('<p>x</p>')
    expect(() => element('p', { children: later('x') })).toThrow('async child')
  })
})

const HOME = `[content-type]
alias = "homePage"
name = "Home page"
allow-at-root = true
components = ["homePage"]
default-component = "homePage"

[[property]]
alias = "heading"
name = "Heading"
type = "textstring"
`

/** Marks the signal's abort where the test can see it, then waits for ever. */
const HANGS = `export default async function Home({ signal }) {
  signal.addEventListener('abort', () => {
    globalThis.__renderAborted = String(signal.reason?.message ?? signal.reason)
  })
  await new Promise(() => {})
}
`

describe('an async page', () => {
  const open: Harness[] = []
  const dirs: string[] = []
  afterEach(async () => {
    while (open.length > 0)
      await open
        .pop()
        ?.db.close()
        .catch(() => {})
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
    delete (globalThis as { __renderAborted?: string }).__renderAborted
  })

  async function site(components: Record<string, string>, renderTimeoutMs?: number) {
    const root = mkdtempSync(join(process.cwd(), 'output', 'async-rendering-'))
    dirs.push(root)
    for (const dir of ['schema/content-types', 'components'])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'content-types', 'home.toml'), HOME)
    for (const [name, source] of Object.entries(components))
      writeFileSync(join(root, 'components', name), source)
    const h = await signedInServer({
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        componentsCacheDir: join(root, '.crombolo', 'components'),
        development: true,
        schemaWritable: true,
        ...(renderTimeoutMs === undefined ? {} : { renderTimeoutMs }),
      },
    })
    open.push(h)
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('homePage'))
      ?.key as string
    const componentKey = (await new ComponentRepository(h.server.db).byAlias('homePage'))
      ?.key as string
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: null,
      values: [{ alias: 'heading', culture: null, segment: null, value: 'Hello' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    const key = created.headers.get('umb-generated-resource') as string
    expect((await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    return h
  }

  test('an async template and an async layout render the page', async () => {
    const h = await site({
      'homePage.tsx': `export const layout = 'layout'
const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 5))
async function Aside() {
  return <aside>{await later('aside')}</aside>
}
export default async function Home({ model }) {
  const heading = await later(model.value('heading'))
  return <><h1>{heading}</h1><Aside /></>
}
`,
      'layout.tsx': `export default async function Layout({ children }) {
  const title = await Promise.resolve('Site')
  return <html><head><title>{title}</title></head><body>{children}</body></html>
}
`,
    })
    const response = await h.server.fetch(new Request(`${ORIGIN}/`))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(
      '<!DOCTYPE html><html><head><title>Site</title></head><body><h1>Hello</h1><aside>aside</aside></body></html>',
    )
  })

  test('a page past the time limit fails as a template error naming it, and its signal aborts', async () => {
    const h = await site({ 'homePage.tsx': HANGS }, 100)
    const response = await h.server.fetch(new Request(`${ORIGIN}/`))
    expect(response.status).toBe(500)
    expect(await response.text()).toContain("Rendering 'homePage' took longer than 100ms.")
    expect((globalThis as { __renderAborted?: string }).__renderAborted).toContain(
      'took longer than 100ms',
    )
  })

  test('a visitor who leaves stops the render, and it is not reported as a template error', async () => {
    const h = await site({ 'homePage.tsx': HANGS }, 0)
    const visitor = new AbortController()
    setTimeout(() => visitor.abort(), 50)
    const response = await h.server.fetch(new Request(`${ORIGIN}/`, { signal: visitor.signal }))
    expect(response.status).toBe(499)
    expect((globalThis as { __renderAborted?: string }).__renderAborted).toBeDefined()
  })
})

/** The fenced block in `docs/adding-a-page.md` that starts with `// components/<file>`. */
function guideComponent(file: string): string {
  const guide = readFileSync(join(import.meta.dir, '..', 'docs', 'adding-a-page.md'), 'utf8')
  const block = guide
    .split('```tsx\n')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('```')))
    .find((part) => part.startsWith(`// components/${file}\n`))
  if (!block) throw new Error(`docs/adding-a-page.md has no block for components/${file}`)
  return block
}

describe('the events page in docs/adding-a-page.md', () => {
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

  async function eventsSite(feedUrl: string) {
    const root = mkdtempSync(join(process.cwd(), 'output', 'adding-a-page-'))
    dirs.push(root)
    for (const dir of ['schema/content-types', 'components/shared'])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(
      join(root, 'schema', 'content-types', 'events-page.toml'),
      `[content-type]
alias = "eventsPage"
name = "Events Page"
allow-at-root = true
components = ["eventsPage"]
default-component = "eventsPage"

[[tab]]
name = "Content"

[[tab.property]]
alias = "title"
name = "Title"
type = "textstring"
mandatory = true

[[tab.property]]
alias = "intro"
name = "Introduction"
type = "richtext"

[[tab.property]]
alias = "feedUrl"
name = "Events feed URL"
type = "textstring"
mandatory = true
`,
    )
    writeFileSync(join(root, 'components', 'eventsPage.tsx'), guideComponent('eventsPage.tsx'))
    writeFileSync(
      join(root, 'components', 'shared', 'layout.tsx'),
      guideComponent('shared/layout.tsx'),
    )
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
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('eventsPage'))
      ?.key as string
    const componentKey = (await new ComponentRepository(h.server.db).byAlias('eventsPage'))
      ?.key as string
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: null,
      values: [
        { alias: 'title', culture: null, segment: null, value: 'Events' },
        { alias: 'feedUrl', culture: null, segment: null, value: feedUrl },
      ],
      variants: [{ culture: null, segment: null, name: 'Events' }],
    })
    const key = created.headers.get('umb-generated-resource') as string
    expect((await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    return h
  }

  test('renders the events the feed returns, inside the layout', async () => {
    const feed = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json([
          { id: '1', title: 'Open day', startsAt: '2026-11-02T09:00:00Z', venue: 'Main hall' },
        ]),
    })
    try {
      const h = await eventsSite(`http://localhost:${feed.port}/events`)
      const response = await h.server.fetch(new Request(`${ORIGIN}/`))
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('<title>Events</title>')
      expect(html).toContain('<h1>Events</h1>')
      expect(html).toContain(
        '<time datetime="2026-11-02T09:00:00Z">2 Nov 2026</time> Open day, Main hall',
      )
    } finally {
      feed.stop(true)
    }
  })

  test('renders the page without the list when the feed is down', async () => {
    const feed = Bun.serve({ port: 0, fetch: () => new Response('down', { status: 503 }) })
    try {
      const h = await eventsSite(`http://localhost:${feed.port}/events`)
      const response = await h.server.fetch(new Request(`${ORIGIN}/`))
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('Upcoming events can&#39;t be shown right now.')
    } finally {
      feed.stop(true)
    }
  })
})
