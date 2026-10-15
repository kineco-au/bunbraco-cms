/**
 * Story 046: Umbraco's relation types, listed read-only, with their relations
 * derived rather than stored; and the recycle bins' "what refers to what is in
 * here", which the empty-bin dialog warns with.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ContentTypeRepository,
  deriveReferences,
  type KnownNode,
  nameBasedUuid,
  RELATION_TYPES,
  referencedKeysIn,
} from '@crombolo/data'
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

const A = '0c1d2e3f-4a5b-4c6d-8e7f-001122334455'
const B = 'a1b2c3d4-e5f6-4a7b-8c9d-aabbccddeeff'

describe('relation type keys', () => {
  test('are the keys Umbraco gives them, so they match a real install', () => {
    const copy = RELATION_TYPES.find((t) => t.alias === 'relateDocumentOnCopy')
    expect(copy?.key).toBe('4cbeb612-e689-3563-b755-bf3ede295433')
  })

  test('the same name always gives the same key, and a different one a different key', () => {
    expect(nameBasedUuid('x')).toBe(nameBasedUuid('x'))
    expect(nameBasedUuid('x')).not.toBe(nameBasedUuid('y'))
    expect(nameBasedUuid('x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test('there are the nine Umbraco installs, in its order', () => {
    expect(RELATION_TYPES.map((t) => t.alias)).toEqual([
      'relateDocumentOnCopy',
      'relateParentDocumentOnDelete',
      'relateParentMediaFolderOnDelete',
      'umbMedia',
      'umbDocument',
      'umbMember',
      'umbElement',
      'relateParentElementContainerOnElementDelete',
      'relateParentElementContainerOnContainerDelete',
    ])
  })
})

describe('reading references out of a value', () => {
  test('finds a picker’s udi and a bare uuid, once each', () => {
    const udi = `umb://document/${A.replaceAll('-', '')}`
    expect(referencedKeysIn(`["${udi}","${B}","${udi}"]`).sort()).toEqual([A, B].sort())
  })

  test('finds nothing in text that names no item', () => {
    expect(referencedKeysIn('Just some words, and a date 2026-10-15.')).toEqual([])
  })

  test('relates each pair once, never an item to itself, and only to items that exist', () => {
    const nodes = new Map<string, KnownNode>([
      [A, { id: 1, key: A, objectType: 'doc' }],
      [B, { id: 2, key: B, objectType: 'media' }],
    ])
    const edges = deriveReferences(
      [
        { nodeId: 1, text: `${A} ${B}` },
        { nodeId: 1, text: B },
        { nodeId: 3, text: `${A} 99999999-9999-4999-8999-999999999999` },
      ],
      nodes,
    )
    expect(edges).toEqual([
      { fromId: 1, toId: 2, toObjectType: 'media' },
      { fromId: 3, toId: 1, toObjectType: 'doc' },
    ])
  })
})

const FILES: Record<string, string> = {
  'schema/schema.toml': '[schema]\nversion = "1.0.0"\n',
  'schema/content-types/page.toml': `[content-type]
key = "7a1c9c1e-0d4b-4c35-9d0c-6f2a1e2b3ca2"
alias = "page"
name = "Page"
icon = "icon-document"
allow-at-root = true
allow-children = ["page"]

[[property]]
alias = "pick"
name = "Pick"
type = "contentPicker"
`,
}

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'relations-'))
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
  const create = async (name: string, pick?: string, parent: string | null = null) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: null,
      parent: parent ? { id: parent } : null,
      values: pick
        ? [
            {
              alias: 'pick',
              culture: null,
              segment: null,
              value: `umb://document/${pick.replaceAll('-', '')}`,
            },
          ]
        : [],
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  return { h, create }
}

const keyOf = (alias: string) => RELATION_TYPES.find((t) => t.alias === alias)?.key as string

interface PagedRelations {
  total: number
  items: Array<{
    id: string
    relationType: { id: string }
    parent: { id: string; name: string }
    child: { id: string; name: string }
    createDate: string
  }>
}

describe('relation types through the API', () => {
  test('are listed, read one at a time, and as items that cannot be deleted', async () => {
    const { h } = await site()
    const list = await h.json<{
      total: number
      items: Array<{ id: string; alias: string; isDependency: boolean; parentObject: unknown }>
    }>(`${V1}/relation-type?skip=0&take=100`)
    expect(list.total).toBe(9)
    const related = list.items.find((t) => t.alias === 'umbDocument')
    expect(related).toMatchObject({ isDependency: true, parentObject: null })
    const onDelete = await h.json<{ name: string; parentObject: { name: string } }>(
      `${V1}/relation-type/${keyOf('relateParentDocumentOnDelete')}`,
    )
    expect(onDelete).toMatchObject({
      name: 'Relate Parent Document On Delete',
      parentObject: { name: 'Document' },
    })
    expect((await h.call(`${V1}/relation-type/${crypto.randomUUID()}`)).status).toBe(404)
    const items = await h.json<
      Array<{ id: string; name: string; isDeletable: boolean; flags: unknown[] }>
    >(`${V1}/item/relation-type?id=${keyOf('umbMedia')}&id=${crypto.randomUUID()}`)
    expect(items).toEqual([
      { id: keyOf('umbMedia'), name: 'Related Media', isDeletable: false, flags: [] },
    ])
  })

  test('"Related Document" lists what picks what, from the current values', async () => {
    const { h, create } = await site()
    const target = await create('Target')
    const pointer = await create('Pointer', target)
    const relations = await h.json<PagedRelations>(
      `${V1}/relation/type/${keyOf('umbDocument')}?skip=0&take=10`,
    )
    expect(relations.total).toBe(1)
    expect(relations.items[0]).toMatchObject({
      relationType: { id: keyOf('umbDocument') },
      parent: { id: pointer, name: 'Pointer' },
      child: { id: target, name: 'Target' },
    })

    // Derived, so it follows the value: picking nothing ends the relation.
    await h.put(`${V1}/document/${pointer}`, {
      template: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Pointer' }],
    })
    const after = await h.json<PagedRelations>(
      `${V1}/relation/type/${keyOf('umbDocument')}?skip=0&take=10`,
    )
    expect(after.total).toBe(0)
  })

  test('"Relate Parent Document On Delete" names where a trashed page came from', async () => {
    const { h, create } = await site()
    const parent = await create('Parent')
    const child = await create('Child', undefined, parent)
    expect((await h.put(`${V1}/document/${child}/move-to-recycle-bin`, {})).status).toBe(200)
    const relations = await h.json<PagedRelations>(
      `${V1}/relation/type/${keyOf('relateParentDocumentOnDelete')}?skip=0&take=10`,
    )
    expect(relations.items.map((r) => [r.parent.name, r.child.name])).toEqual([['Parent', 'Child']])
    expect(Number.isNaN(Date.parse(relations.items[0]?.createDate ?? ''))).toBe(false)
  })

  test('an unknown relation type is a 404, and a type with nothing derived is an empty page', async () => {
    const { h } = await site()
    expect((await h.call(`${V1}/relation/type/${crypto.randomUUID()}`)).status).toBe(404)
    expect(
      await h.json<unknown>(`${V1}/relation/type/${keyOf('relateDocumentOnCopy')}?skip=0&take=10`),
    ).toEqual({ total: 0, items: [] })
  })
})

describe('the recycle bins warn what refers to what is in them', () => {
  test('a page in the bin that another page picks is reported, by the page that picks it', async () => {
    const { h, create } = await site()
    const target = await create('Target')
    await create('Pointer', target)
    const before = await h.json<{ total: number }>(
      `${V1}/recycle-bin/document/referenced-by?skip=0&take=20`,
    )
    expect(before.total).toBe(0)
    expect((await h.put(`${V1}/document/${target}/move-to-recycle-bin`, {})).status).toBe(200)
    const after = await h.json<{ total: number; items: Array<{ $type: string; name: string }> }>(
      `${V1}/recycle-bin/document/referenced-by?skip=0&take=20`,
    )
    expect(after.total).toBe(1)
    expect(after.items[0]).toMatchObject({
      $type: 'DocumentReferenceResponseModel',
      name: 'Pointer',
    })
  })

  test('the media and element bins answer in the same shape', async () => {
    const { h } = await site()
    for (const area of ['media', 'element'])
      expect(
        await h.json<unknown>(`${V1}/recycle-bin/${area}/referenced-by?skip=0&take=20`),
      ).toEqual({
        total: 0,
        items: [],
      })
  })
})
