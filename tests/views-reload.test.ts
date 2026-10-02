/**
 * An edited template taking effect without restarting the node.
 *
 * This file used to pin the opposite. A view is a module, `import()` caches
 * modules by path with no eviction, and a query does not bust it on Bun — so a
 * node kept rendering the view it first imported and the only cure was a
 * restart. `snapshots.ts` is the fix: the renderer imports from a
 * content-addressed copy of the tree, so a change is a new path and the whole
 * graph re-resolves.
 *
 * Two servers share one database — a file on SQLite, the schema on Postgres —
 * because the case that matters is a template saved on one node reaching
 * another. Both run as production, where modules are cached hardest.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, cacheInstructionsAfter, TemplateRepository } from '@bunbraco/data'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

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

const HOME = `[document-type]
alias = "homePage"
name = "Home page"
allow-at-root = true
templates = ["homePage"]
default-template = "homePage"

[[property]]
alias = "heading"
name = "Heading"
type = "textstring"
`

/** A template that renders through a layout, so a component-only edit is testable. */
const TEMPLATE = `import { Layout } from './components/layout.tsx'
export default function Home({ model }) {
  return <Layout><h1>{model.value('heading')}</h1></Layout>
}
`
const layout = (marker: string) => `export const Layout = ({ children }) =>
  <main data-layout="${marker}">{children}</main>
`

describe('a template edited under a running node', () => {
  async function site() {
    const root = mkdtempSync(join(process.cwd(), 'output', 'views-reload-'))
    dirs.push(root)
    for (const dir of ['schema/document-types', 'Views/components'])
      mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'document-types', 'home.toml'), HOME)
    writeFileSync(join(root, 'Views', 'homePage.tsx'), TEMPLATE)
    writeFileSync(join(root, 'Views', 'components', 'layout.tsx'), layout('first'))
    return {
      root,
      schemaDir: join(root, 'schema'),
      viewsDir: join(root, 'Views'),
      sqliteFile: join(root, 'site.sqlite'),
    }
  }

  /**
   * The first node syncs: production refuses schema files whose elements carry
   * no keys, and assigning them is a development job. Every node after it runs
   * as production, which is where a cached module is hardest to shift.
   */
  async function boot(where: Awaited<ReturnType<typeof site>>, nodeId: string, first: boolean) {
    const { root, ...config } = where
    const h = await signedInServer({
      keepDatabase: !first,
      config: {
        ...config,
        siteDir: root,
        // Its own, as a deployed node has: two nodes sharing one would evict
        // generations the other is serving.
        viewsCacheDir: join(root, '.bunbraco', nodeId),
        // A short gate, and no coalescing floor: both are production intervals
        // that a test would otherwise have to wait out. The floor only ever
        // delays a change nobody announced.
        viewsSnapshot: { gateTtlMs: 50, minSwapIntervalMs: 0 },
        nodeId,
        development: first,
        schemaWritable: true,
      },
    })
    open.push(h)
    return h
  }

  const render = async (node: Harness) =>
    await (await node.server.fetch(new Request(`${ORIGIN}/`))).text()

  async function publishHome(h: Harness): Promise<void> {
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('homePage'))
      ?.key as string
    const templateKey = (await new TemplateRepository(h.server.db).byAlias('homePage'))
      ?.key as string
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: templateKey },
      parent: null,
      values: [{ alias: 'heading', culture: null, segment: null, value: 'Hello' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    const key = created.headers.get('umb-generated-resource') as string
    expect((await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
  }

  /** Saves a template through the Management API, as the editor does. */
  async function saveTemplate(node: Harness, content: string): Promise<void> {
    const key = (await new TemplateRepository(node.server.db).byAlias('homePage'))?.key as string
    const saved = await node.put(`${V1}/template/${key}`, {
      name: 'Home page',
      alias: 'homePage',
      content,
    })
    expect(saved.status).toBe(200)
  }

  test('is rendered by the node that saved it, with no restart', async () => {
    const where = await site()
    const writer = await boot(where, 'writer-node', true)
    await publishHome(writer)
    expect(await render(writer)).toContain('data-layout="first"')

    await saveTemplate(
      writer,
      `import { Layout } from './components/layout.tsx'
export default function Home({ model }) {
  return <Layout><h1>changed: {model.value('heading')}</h1></Layout>
}
`,
    )
    expect(await render(writer)).toContain('changed: Hello')
  })

  test('is announced to the other nodes as a views instruction', async () => {
    const where = await site()
    const writer = await boot(where, 'writer-node', true)
    await publishHome(writer)

    const before = (await cacheInstructionsAfter(writer.server.db, 0)).length
    await saveTemplate(writer, TEMPLATE.replace('h1', 'h2'))
    // Appended in the background, once the snapshot it names has been taken.
    await Bun.sleep(250)

    const added = (await cacheInstructionsAfter(writer.server.db, 0)).slice(before)
    const views = added.filter((instruction) => instruction.kind === 'views')
    expect(views.length).toBeGreaterThan(0)
    expect(views[0]?.createdBy).toBe('writer-node')
    // The hash it carries is the generation the write produced, so a receiver
    // knows when it has arrived.
    expect(views[0]?.payload.hash).toBe(writer.server.health().views.hash as string)
    expect(views[0]?.payload.alias).toBe('homePage')
  })

  test('reaches a node that had already cached the module, once it polls', async () => {
    const where = await site()
    const writer = await boot(where, 'writer-node', true)
    await publishHome(writer)

    const reader = await boot(where, 'reader-node', false)
    // Renders once, which is what puts the module in the reader's registry.
    expect(await render(reader)).toContain('data-layout="first"')
    const generation = reader.server.health().views.hash

    await saveTemplate(
      writer,
      `import { Layout } from './components/layout.tsx'
export default function Home({ model }) {
  return <Layout><h1>second: {model.value('heading')}</h1></Layout>
}
`,
    )
    expect(await render(writer)).toContain('second: Hello')

    expect(await reader.server.poll()).toBeGreaterThan(0)
    // A render never waits on a snapshot, so the first one after the
    // announcement starts the check and still serves the generation in use.
    expect(await render(reader)).toContain('data-layout="first"')
    await reader.server.snapshots.settle()

    expect(await render(reader)).toContain('second: Hello')
    expect(reader.server.health().views.hash).not.toBe(generation as string)
  })

  /**
   * The case no per-file scheme can see, and the reason the tree is the unit of
   * versioning: the template's own bytes never change.
   */
  test('reaches another node when only a component it imports changed', async () => {
    const where = await site()
    const writer = await boot(where, 'writer-node', true)
    await publishHome(writer)
    const reader = await boot(where, 'reader-node', false)
    expect(await render(reader)).toContain('data-layout="first"')

    // Written to disk directly: a component is not a template, so the editor
    // has no route for it — this is a deploy, or a bucket synced underneath.
    writeFileSync(join(where.viewsDir, 'components', 'layout.tsx'), layout('second'))

    // Nothing announced it, so the gate is what notices. A render starts the
    // check in the background and keeps serving, so the first one after the
    // gate opens may still be the old generation.
    await Bun.sleep(100)
    await render(reader)
    await reader.server.snapshots.settle()
    expect(await render(reader)).toContain('data-layout="second"')
  })
})
