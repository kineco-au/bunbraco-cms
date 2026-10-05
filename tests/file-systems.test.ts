/**
 * Components, stylesheets and scripts: files on disk under components/,
 * css and scripts, edited through the Settings section by path — the tree,
 * items, create, read, update, rename, delete, folders — and served on the
 * front end. Partial views are TSX, and the snippets are TSX components.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

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

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'file-systems-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      stylesheetsDir: join(root, 'css'),
      scriptsDir: join(root, 'scripts'),
    },
  })
  open.push(h)
  return { h, root }
}

const AREAS = [
  {
    route: 'stylesheet',
    dir: 'css',
    sent: 'site.css',
    stored: 'site.css',
    content: 'body { margin: 0 }',
  },
  {
    route: 'script',
    dir: 'scripts',
    sent: 'site.js',
    stored: 'site.js',
    content: 'console.log(1)',
  },
  // The editor names partial views Razor-style; they are stored as TSX
  {
    route: 'partial-view',
    dir: 'components',
    sent: 'nav.cshtml',
    stored: 'nav.tsx',
    content: 'export default function Nav() { return <nav /> }',
  },
]

describe.each(AREAS)('$route files', (area) => {
  test('folders and files: create, read, update, rename, the tree and items, delete', async () => {
    const { h, root } = await site()
    const base = `${V1}/${area.route}`
    const enc = encodeURIComponent

    const folder = await h.post(`${base}/folder`, { name: 'shared', parent: null })
    expect(folder.status).toBe(201)
    expect(decodeURIComponent(folder.headers.get('umb-generated-resource') as string)).toBe(
      '/shared',
    )
    expect((await h.post(`${base}/folder`, { name: 'shared', parent: null })).status).toBe(400)

    const created = await h.post(base, {
      name: area.sent,
      parent: { path: '/shared' },
      content: area.content,
    })
    expect(created.status).toBe(201)
    const path = decodeURIComponent(created.headers.get('umb-generated-resource') as string)
    expect(path).toBe(`/shared/${area.stored}`)
    expect(readFileSync(join(root, area.dir, 'shared', area.stored), 'utf8')).toBe(area.content)
    expect(await h.json<unknown>(`${base}/${enc(path)}`)).toEqual<unknown>({
      name: area.stored,
      path,
      parent: { path: '/shared' },
      content: area.content,
    })

    // The rules: unique names, the area's extension, a parent that exists, no escaping the root
    const refused = async (name: string, parent: string | null = null) =>
      (await h.post(base, { name, parent: parent ? { path: parent } : null, content: '' })).status
    expect(await refused(area.sent, '/shared')).toBe(400)
    expect(await refused('notes.txt')).toBe(400)
    expect(await refused(area.sent, '/missing')).toBe(404)
    expect(await refused(`../${area.sent}`)).toBe(400)
    expect((await h.call(`${base}/${enc('/../secret')}`)).status).toBe(404)

    // The tree: folders first, then files
    await h.post(base, { name: `a-${area.sent}`, parent: null, content: '' })
    const rootItems = await h.json<{
      items: Array<{ name: string; isFolder: boolean; hasChildren: boolean }>
    }>(`${V1}/tree/${area.route}/root?skip=0&take=10`)
    expect(rootItems.items.map((i) => [i.name, i.isFolder, i.hasChildren])).toEqual([
      ['shared', true, true],
      [`a-${area.stored}`, false, false],
    ])
    const children = await h.json<{ items: Array<{ path: string; parent: { path: string } }> }>(
      `${V1}/tree/${area.route}/children?parentPath=${enc('/shared')}&skip=0&take=10`,
    )
    expect(children.items.map((i) => [i.path, i.parent.path])).toEqual([[path, '/shared']])
    const ancestors = await h.json<Array<{ path: string }>>(
      `${V1}/tree/${area.route}/ancestors?descendantPath=${enc(path)}`,
    )
    expect(ancestors.map((a) => a.path)).toEqual(['/shared', path])
    const siblings = await h.json<{
      items: Array<{ name: string }>
      totalBefore: number
      totalAfter: number
    }>(`${V1}/tree/${area.route}/siblings?path=${enc('/shared')}&before=0&after=5`)
    expect(siblings.items.map((i) => i.name)).toEqual(['shared', `a-${area.stored}`])
    expect(
      await h.json<unknown>(`${V1}/item/${area.route}?path=${enc(path)}&path=${enc('/shared')}`),
    ).toEqual<unknown>([
      { isFolder: false, name: area.stored, parent: { path: '/shared' }, path },
      { isFolder: true, name: 'shared', parent: null, path: '/shared' },
    ])

    // Update and rename
    expect((await h.put(`${base}/${enc(path)}`, { content: 'changed' })).status).toBe(200)
    expect(readFileSync(join(root, area.dir, 'shared', area.stored), 'utf8')).toBe('changed')
    const renamed = await h.put(`${base}/${enc(path)}/rename`, { name: `main-${area.sent}` })
    expect(renamed.status).toBe(201)
    const newPath = decodeURIComponent(renamed.headers.get('umb-generated-resource') as string)
    expect(newPath).toBe(`/shared/main-${area.stored}`)
    expect((await h.call(`${base}/${enc(path)}`)).status).toBe(404)

    // A folder with something in it stays; empty, it goes
    expect((await h.del(`${base}/folder/${enc('/shared')}`)).status).toBe(400)
    expect((await h.del(`${base}/${enc(newPath)}`)).status).toBe(200)
    expect((await h.del(`${base}/${enc(newPath)}`)).status).toBe(404)
    expect(await h.json<unknown>(`${base}/folder/${enc('/shared')}`)).toEqual<unknown>({
      name: 'shared',
      path: '/shared',
      parent: null,
    })
    expect((await h.del(`${base}/folder/${enc('/shared')}`)).status).toBe(200)
    expect(existsSync(join(root, area.dir, 'shared'))).toBe(false)
  })
})

describe('files on the front end and the snippets', () => {
  test('stylesheets and scripts are served at /css/ and /scripts/, and nothing else from there', async () => {
    const { h, root } = await site()
    await h.post(`${V1}/stylesheet`, { name: 'site.css', parent: null, content: 'body{}' })
    await h.post(`${V1}/script`, { name: 'site.js', parent: null, content: 'let a' })
    writeFileSync(join(root, 'css', 'notes.txt'), 'private')
    expect(await (await h.call('/css/site.css')).text()).toBe('body{}')
    expect(await (await h.call('/scripts/site.js')).text()).toBe('let a')
    expect((await h.call('/css/notes.txt')).status).toBe(404)
    expect((await h.call('/css/%2E%2E/components/x.css')).status).toBe(404)
    expect((await h.call('/css/missing.css')).status).toBe(404)
    // A new stylesheet is empty, and still a stylesheet
    await h.post(`${V1}/stylesheet`, { name: 'empty.css', parent: null, content: '' })
    const empty = await h.call('/css/empty.css')
    expect([empty.status, empty.headers.get('content-type')]).toEqual([
      200,
      'text/css;charset=utf-8',
    ])
  })

  test('the snippets are TSX components; Empty is the skeleton a new partial view starts from', async () => {
    const { h } = await site()
    const list = await h.json<{ total: number; items: Array<{ id: string; name: string }> }>(
      `${V1}/partial-view/snippet?skip=0&take=100`,
    )
    expect(list.items.map((s) => s.id)).toContain('Breadcrumb')
    expect(list.items[0]).toEqual({ id: 'Empty', name: 'Empty' })
    const empty = await h.json<{ content: string }>(`${V1}/partial-view/snippet/Empty`)
    expect(empty.content).toContain("import type { PageProps } from 'bunbraco'")
    expect(empty.content).toContain('export default function')
    expect(empty.content).not.toContain('@inherits')
    expect((await h.call(`${V1}/partial-view/snippet/Nope`)).status).toBe(404)
  })

  test('every snippet saves as a partial view and compiles', async () => {
    const { h, root } = await site()
    const list = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/partial-view/snippet?skip=0&take=100`,
    )
    const out = join(root, 'components')
    for (const { id } of list.items) {
      const { content } = await h.json<{ content: string }>(`${V1}/partial-view/snippet/${id}`)
      const created = await h.post(`${V1}/partial-view`, {
        name: `${id}.cshtml`,
        parent: null,
        content,
      })
      expect([id, created.status]).toEqual([id, 201])
    }
    // Each compiles as JSX with the site's runtime
    for (const { id } of list.items) {
      const result = await Bun.build({
        entrypoints: [join(out, `${id}.tsx`)],
        external: ['bunbraco'],
        target: 'bun',
        throw: false,
      })
      expect([id, result.success, result.logs.map(String)]).toEqual([id, true, []])
    }
  })
})
