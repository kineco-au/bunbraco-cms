/** A signed-in site with one nestable page type, and the tree operations the concurrency tests drive. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComponentRepository, ContentTypeRepository } from '@crombolo/data'
import type { CromboloConfig } from '@crombolo/server'
import { type Harness, signedInServer, V1 } from './harness.ts'

const VIEW = `export default function Page({ model }) {
  return <main><h1>{model.text('title')}</h1></main>
}
`

const PAGE_TOML = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

export interface TreeSite {
  h: Harness
  root: string
  typeKey: string
  componentKey: string
  close(): Promise<void>
}

export function writeTreeSite(): string {
  return writeTreeSchema(mkdtempSync(join(process.cwd(), 'output', 'crombolo-tree-')))
}

/** The page type and its view, into a site directory that already exists. */
export function writeTreeSchema(root: string): string {
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  return root
}

/** Boots a server on `root`; `keepDatabase` joins the database another node already uses. */
export async function treeSite(
  options: { root?: string; keepDatabase?: boolean; config?: Partial<CromboloConfig> } = {},
): Promise<TreeSite> {
  const root = options.root ?? writeTreeSite()
  const h = await signedInServer({
    keepDatabase: options.keepDatabase,
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      ...options.config,
    },
  })
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  return {
    h,
    root,
    typeKey,
    componentKey,
    async close() {
      await h.db.close().catch(() => {})
      if (!options.root) rmSync(root, { recursive: true, force: true })
    },
  }
}

const body = (site: TreeSite, name: string, title: string) => ({
  template: { id: site.componentKey },
  values: [{ alias: 'title', culture: null, segment: null, value: title }],
  variants: [{ culture: null, segment: null, name }],
})

/** The tree operations as an editor issues them, each answering its response. */
export function treeOps(site: TreeSite, h: Harness = site.h) {
  return {
    async create(name: string, parentKey: string | null): Promise<Response> {
      return h.post(`${V1}/document`, {
        ...body(site, name, name),
        documentType: { id: site.typeKey },
        parent: parentKey ? { id: parentKey } : null,
      })
    },
    save: (key: string, name: string, title: string) =>
      h.put(`${V1}/document/${key}`, body(site, name, title)),
    publish: (key: string) =>
      h.put(`${V1}/document/${key}/publish`, { publishSchedules: [{ culture: null }] }),
    unpublish: (key: string) => h.put(`${V1}/document/${key}/unpublish`, { cultures: null }),
    move: (key: string, targetKey: string | null) =>
      h.put(`${V1}/document/${key}/move`, { target: targetKey ? { id: targetKey } : null }),
    sort: (parentKey: string | null, keys: readonly string[]) =>
      h.put(`${V1}/document/sort`, {
        parent: parentKey ? { id: parentKey } : null,
        sorting: keys.map((id, sortOrder) => ({ id, sortOrder })),
      }),
    trash: (key: string) => h.put(`${V1}/document/${key}/move-to-recycle-bin`, {}),
    restore: (key: string) => h.put(`${V1}/recycle-bin/document/${key}/restore`, { target: null }),
    remove: (key: string) => h.del(`${V1}/recycle-bin/document/${key}`),
  }
}

/** Creates a page and answers its key, failing loudly when it cannot. */
export async function createPage(
  site: TreeSite,
  name: string,
  parentKey: string | null = null,
): Promise<string> {
  const response = await treeOps(site).create(name, parentKey)
  if (response.status !== 201)
    throw new Error(`create failed ${response.status}: ${await response.text()}`)
  return response.headers.get('umb-generated-resource') as string
}
