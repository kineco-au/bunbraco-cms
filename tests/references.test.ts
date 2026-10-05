/**
 * "What refers to this?" — the Info tab's list and the checks before a delete.
 *
 * These answered an empty page until now, which told an editor that nothing
 * referenced a document they were about to delete. The answer is derived from
 * the stored values, so it cannot drift from what the pickers actually hold.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository } from '@bunbraco/data'
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

const FILES: Record<string, string> = {
  'schema/schema.toml': '[schema]\nversion = "1.0.0"\n',
  'schema/document-types/page.toml': `[document-type]
key = "7a1c9c1e-0d4b-4c35-9d0c-6f2a1e2b3ca1"
alias = "page"
name = "Page"
icon = "icon-document"
allow-at-root = true

[[property]]
alias = "pick"
name = "Pick"
type = "contentPicker"

[[property]]
alias = "body"
name = "Body"
type = "textarea"
`,
}

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'references-'))
  dirs.push(root)
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const create = async (
    name: string,
    values: Record<string, unknown> = {},
    parent: string | null = null,
  ) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: null,
      parent: parent ? { id: parent } : null,
      values: Object.entries(values).map(([alias, value]) => ({
        alias,
        culture: null,
        segment: null,
        value,
      })),
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  return { h, create }
}

const udi = (key: string) => `umb://document/${key.replaceAll('-', '')}`

describe(`references (${process.env.BUNBRACO_DB ?? 'sqlite'})`, () => {
  test('name what points at a document, and say nothing when nothing does', async () => {
    const { h, create } = await site()
    const target = await create('Target')
    const lonely = await create('Lonely')
    const pointer = await create('Pointer', { pick: udi(target) })

    const found = await h.json<{
      total: number
      items: Array<{ $type: string; id: string; name: string; documentType: { alias: string } }>
    }>(`${V1}/document/${target}/referenced-by?skip=0&take=20`)
    expect(found.total).toBe(1)
    expect(found.items[0]?.id).toBe(pointer)
    expect(found.items[0]?.name).toBe('Pointer')
    // The client discriminates the list on $type.
    expect(found.items[0]?.$type).toBe('DocumentReferenceResponseModel')
    expect(found.items[0]?.documentType.alias).toBe('page')

    const none = await h.json<{ total: number; items: unknown[] }>(
      `${V1}/document/${lonely}/referenced-by?skip=0&take=20`,
    )
    expect(none).toEqual({ total: 0, items: [] })
  })

  test('a bare uuid in a value counts, and a document does not reference itself', async () => {
    const { h, create } = await site()
    const target = await create('Target')
    // Not every editor stores the `umb://` form.
    const bare = await create('Bare', { body: `see ${target} for more` })
    // A value that mentions the document's own key is not a reference to it.
    await h.put(`${V1}/document/${target}`, {
      template: null,
      values: [{ alias: 'body', culture: null, segment: null, value: `I am ${target}` }],
      variants: [{ culture: null, segment: null, name: 'Target' }],
    })

    const found = await h.json<{ total: number; items: Array<{ id: string }> }>(
      `${V1}/document/${target}/referenced-by?skip=0&take=20`,
    )
    expect(found.items.map((i) => i.id)).toEqual([bare])
  })

  test('are-referenced answers only for the keys something points at', async () => {
    const { h, create } = await site()
    const used = await create('Used')
    const unused = await create('Unused')
    await create('Pointer', { pick: udi(used) })

    const result = await h.json<{ total: number; items: Array<{ id: string }> }>(
      `${V1}/document/are-referenced?id=${used}&id=${unused}&skip=0&take=20`,
    )
    expect(result.total).toBe(1)
    expect(result.items).toEqual([{ id: used }])
  })

  test('referenced descendants warn before a branch is deleted, ignoring links inside it', async () => {
    const { h, create } = await site()
    const branch = await create('Branch')
    const inside = await create('Inside', {}, branch)
    const alsoInside = await create('Also inside', { pick: udi(inside) }, branch)
    const outside = await create('Outside')
    await h.put(`${V1}/document/${outside}`, {
      template: null,
      values: [{ alias: 'pick', culture: null, segment: null, value: udi(inside) }],
      variants: [{ culture: null, segment: null, name: 'Outside' }],
    })

    const result = await h.json<{ total: number; items: Array<{ id: string }> }>(
      `${V1}/document/${branch}/referenced-descendants?skip=0&take=20`,
    )
    // `inside` is referenced from outside the branch, so deleting it breaks a
    // link; `alsoInside` is referenced by nothing.
    expect(result.items).toEqual([{ id: inside }])
    expect(result.total).toBe(1)
    void alsoInside
  })

  test('page the list, and refuse nonsense paging', async () => {
    const { h, create } = await site()
    const target = await create('Target')
    for (const name of ['One', 'Two', 'Three']) await create(name, { pick: udi(target) })

    const first = await h.json<{ total: number; items: unknown[] }>(
      `${V1}/document/${target}/referenced-by?skip=0&take=2`,
    )
    expect([first.total, first.items.length]).toEqual([3, 2])
    const rest = await h.json<{ items: unknown[] }>(
      `${V1}/document/${target}/referenced-by?skip=2&take=2`,
    )
    expect(rest.items).toHaveLength(1)

    expect((await h.call(`${V1}/document/${target}/referenced-by?skip=-1&take=2`)).status).toBe(400)
  })
})
