/**
 * Story 043: backoffice search over what items say, not only their names — the
 * index, the queue that keeps it current, who may see a result, and the Examine
 * dashboard's indexers and searchers. docs/search.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEDIA_TYPE_KEYS } from '@crombolo/core'
import {
  ComponentRepository,
  ContentTypeRepository,
  queueForSearch,
  SearchIndex,
  searchTerms,
  searchWords,
  valueText,
} from '@crombolo/data'
import { parseContentType, writeContentType } from '@crombolo/schema'
import { type Harness, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

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

const PAGE = `[content-type]
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

[[property]]
alias = "bodyText"
name = "Body"
type = "textarea"

[[property]]
alias = "internalNotes"
name = "Internal notes"
type = "textarea"
searchable = false
`

const PHOTO = `[media-type]
alias = "photo"
name = "Photo"
allow-at-root = true

[[property]]
alias = "caption"
name = "Caption"
type = "textstring"
`

const CUSTOMER = `[member-type]
key = "7b0f1c3d-0043-4a2b-8c4d-000000000001"
alias = "customer"
name = "Customer"

[[property]]
alias = "nickname"
name = "Nickname"
type = "textstring"

[[property]]
alias = "secretWord"
name = "Secret word"
type = "textstring"
sensitive = true
`

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'search-'))
  dirs.push(root)
  for (const dir of ['content-types', 'media-types', 'member-types'])
    mkdirSync(join(root, 'schema', dir), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE)
  writeFileSync(join(root, 'schema', 'media-types', 'photo.toml'), PHOTO)
  writeFileSync(join(root, 'schema', 'member-types', 'customer.toml'), CUSTOMER)
  writeFileSync(
    join(root, 'components', 'page.tsx'),
    'export default function Page({ model }) { return <h1>{model.name}</h1> }\n',
  )
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  // The tests run the indexer themselves, so nothing indexes behind their back.
  h.server.jobs.stop()
  const types = new ContentTypeRepository(h.server.db)
  const typeKey = (await types.byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string

  const page = async (
    name: string,
    values: Record<string, string> = {},
    parent: string | null = null,
  ) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: parent ? { id: parent } : null,
      values: Object.entries(values).map(([alias, value]) => ({
        alias,
        value,
        culture: null,
        segment: null,
      })),
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  const search = async (query: string, client = h, extra = '') =>
    (
      await client.json<{ total: number; items: Array<{ id: string }> }>(
        `${V1}/item/document/search?query=${encodeURIComponent(query)}&skip=0&take=50${extra}`,
      )
    ).items.map((item) => item.id)
  const index = () => h.server.jobs.runSearchIndexing()
  return { h, page, search, index, typeKey }
}

describe('the words of a value', () => {
  test('are folded to lowercase without diacritics, split on anything not a letter or digit', () => {
    expect(searchWords('Café-Society, 2024! Ærø')).toEqual(['cafe', 'society', '2024', 'ærø'])
    expect(searchTerms('the THE The cat')).toEqual(['the', 'cat'])
  })

  test('are read out of markup, blocks and pickers, leaving their structure behind', () => {
    expect(valueText('<p>Deep &amp; <b>calm</b></p><script>x()</script>')).toEqual(['Deep & calm'])
    const blocks = JSON.stringify({
      layout: { 'Umbraco.BlockList': [{ contentKey: '6b1c1c49-4f6a-4b8a-9d1e-0c2b6e1e0f11' }] },
      contentData: [
        {
          key: '6b1c1c49-4f6a-4b8a-9d1e-0c2b6e1e0f11',
          contentTypeKey: '0d4e8f3a-1b2c-4d5e-8f9a-0b1c2d3e4f50',
          values: [{ alias: 'heading', editorAlias: 'Umbraco.TextBox', value: 'Lighthouse' }],
        },
      ],
    })
    expect(valueText(blocks)).toEqual(['Lighthouse'])
    expect(valueText('umb://document/0d4e8f3a1b2c4d5e8f9a0b1c2d3e4f50')).toEqual([])
    // A block property marked `searchable = false` on its element type is skipped.
    expect(
      valueText(
        blocks,
        (type, alias) => type.toLowerCase().startsWith('0d4e8f3a') && alias === 'heading',
      ),
    ).toEqual([])
    expect(valueText('[not json')).toEqual(['[not json'])
  })
})

describe(`backoffice search (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('finds a page by the words in its body, by prefix, every word required', async () => {
    const { h, page, search, index } = await site()
    const news = await page('Harbour News', { bodyText: 'Tides this week' })
    const about = await page('About', { bodyText: '<p>Our harbour has <b>deep</b> water</p>' })
    const contact = await page('Contact', { title: 'Café opening hours' })

    // Queued with the save, and found once the indexer has run.
    expect(await search('deep')).toEqual([])
    const internal = await h.json<{ healthStatus: { status: string }; documentCount: number }>(
      `${V1}/indexer/InternalIndex`,
    )
    expect(internal.healthStatus.status).toBe('Rebuilding')
    expect(await index()).toBeGreaterThanOrEqual(3)

    expect(await search('deep')).toEqual([about])
    // A name match comes first, then the best match on the body.
    expect(await search('harb')).toEqual([news, about])
    expect(await search('harbour water')).toEqual([about])
    expect(await search('cafe')).toEqual([contact])
    expect(await search('CAFÉ OPEN')).toEqual([contact])
    expect(await search('lighthouse')).toEqual([])
    // A name still matches anywhere inside it, as it did before the index.
    expect(await search('bout')).toEqual([about])
  })

  test('stays current across save, publish, delete and a change of schema', async () => {
    const { h, page, search, index } = await site()
    const key = await page('Notes', { title: 'Plain', bodyText: 'anchovy' })
    await index()
    expect(await search('anchovy')).toEqual([key])

    const document = await h.json<{ values: unknown[]; variants: unknown[] }>(
      `${V1}/document/${key}`,
    )
    const saved = await h.put(`${V1}/document/${key}`, {
      ...document,
      values: [
        { alias: 'title', value: 'Plain', culture: null, segment: null },
        { alias: 'bodyText', value: 'barracuda', culture: null, segment: null },
      ],
      variants: [{ culture: null, segment: null, name: 'Notes' }],
    })
    expect(saved.status).toBe(200)
    await index()
    expect(await search('anchovy')).toEqual([])
    expect(await search('barracuda')).toEqual([key])

    expect((await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    await index()
    expect(await search('barracuda')).toEqual([key])

    // A property taken off the type takes its words out of the index with it.
    const types = new ContentTypeRepository(h.server.db)
    const type = await types.byAlias('page')
    if (!type) throw new Error('no page type')
    await types.save({
      ...type,
      properties: type.properties.filter((property) => property.alias !== 'bodyText'),
    })
    await index()
    expect(await search('barracuda')).toEqual([])
    expect(await search('plain')).toEqual([key])

    // In the bin it is found only when the bin is searched; deleted, it is gone.
    expect((await h.put(`${V1}/document/${key}/move-to-recycle-bin`, {})).status).toBe(200)
    expect(await search('plain')).toEqual([])
    expect(await search('plain', h, '&trashed=true')).toEqual([key])
    expect((await h.del(`${V1}/recycle-bin/document/${key}`)).status).toBe(200)
    const rows = await h.server.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM search_document')
    expect(Number(rows[0]?.n)).toBe(0)
  })

  test('shows an editor only what lies under their start node and what they may browse', async () => {
    const { h, page, search, index } = await site()
    const harbour = await page('Harbour')
    const inside = await page('Pier', { bodyText: 'gull' }, harbour)
    const outside = await page('Town', { bodyText: 'gull' })
    const hidden = await page('Vault', { bodyText: 'gull' }, harbour)
    await index()
    expect((await search('gull')).sort()).toEqual([inside, outside, hidden].sort())

    const group = async (alias: string, body: Record<string, unknown>) =>
      h.post(`${V1}/user-group`, {
        name: alias,
        alias,
        sections: ['Umb.Section.Content'],
        languages: [],
        hasAccessToAllLanguages: true,
        documentRootAccess: false,
        documentStartNode: null,
        mediaRootAccess: true,
        mediaStartNode: null,
        elementRootAccess: false,
        elementStartNode: null,
        fallbackPermissions: ['Umb.Document.Read'],
        permissions: [],
        ...body,
      })
    expect((await group('harbourEditors', { documentStartNode: { id: harbour } })).status).toBe(201)
    const scoped = await signInAsGroup(h, 'harbourEditors')
    expect((await search('gull', scoped)).sort()).toEqual([inside, hidden].sort())

    expect(
      (
        await group('noVault', {
          documentRootAccess: true,
          permissions: [
            { $type: 'DocumentPermissionPresentationModel', document: { id: hidden }, verbs: [] },
          ],
        })
      ).status,
    ).toBe(201)
    const limited = await signInAsGroup(h, 'noVault')
    expect((await search('gull', limited)).sort()).toEqual([inside, outside].sort())
  })

  test('finds media by what it says, and members by their properties but not their secrets', async () => {
    const { h, index } = await site()
    const photo = (await new ContentTypeRepository(h.server.db, { kind: 'media' }).byAlias('photo'))
      ?.key as string
    const created = await h.post(`${V1}/media`, {
      mediaType: { id: photo },
      parent: null,
      values: [
        { alias: 'caption', value: 'Sunrise over the breakwater', culture: null, segment: null },
      ],
      variants: [{ culture: null, segment: null, name: 'IMG_0042' }],
    })
    expect(created.status).toBe(201)
    const media = created.headers.get('umb-generated-resource') as string
    expect(SYSTEM_MEDIA_TYPE_KEYS.Image).not.toBe(photo)

    const member = await h.post(`${V1}/member`, {
      memberType: { id: '7b0f1c3d-0043-4a2b-8c4d-000000000001' },
      email: 'ada@example.test',
      username: 'ada',
      password: 'correct-horse-battery',
      isApproved: true,
      values: [
        { alias: 'nickname', value: 'Countess', culture: null, segment: null },
        { alias: 'secretWord', value: 'xylophone', culture: null, segment: null },
      ],
      variants: [{ culture: null, segment: null, name: 'Ada' }],
    })
    expect(member.status).toBe(201)
    const ada = member.headers.get('umb-generated-resource') as string
    await index()

    const found = async (path: string) =>
      (await h.json<{ items: Array<{ id: string }> }>(path)).items.map((item) => item.id)
    expect(await found(`${V1}/item/media/search?query=breakwater&skip=0&take=10`)).toEqual([media])
    expect(await found(`${V1}/item/member/search?query=countess&skip=0&take=10`)).toEqual([ada])
    expect(await found(`${V1}/item/member/search?query=xylophone&skip=0&take=10`)).toEqual([])
    const hits = await h.json<{ items: Array<{ fields: Array<{ name: string }> }> }>(
      `${V1}/searcher/MembersSearcher/query?term=countess&skip=0&take=10`,
    )
    expect(hits.items[0]?.fields.map((field) => field.name)).not.toContain('secretWord')
  })
})

describe(`the Examine dashboard (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('lists the indexes and searchers, rebuilds one, and searches it', async () => {
    const { h, page, index } = await site()
    const key = await page('Lighthouse', { bodyText: 'Beam and lens' })
    await index()

    const indexes = await h.json<{
      total: number
      items: Array<{ name: string; healthStatus: { status: string }; documentCount: number }>
    }>(`${V1}/indexer?skip=0&take=10`)
    expect(indexes.items.map((item) => item.name)).toEqual(['InternalIndex', 'MembersIndex'])
    expect(indexes.items[0]).toMatchObject({
      healthStatus: { status: 'Healthy' },
      documentCount: 1,
      canRebuild: true,
      searcherName: 'InternalSearcher',
    })

    expect((await h.post(`${V1}/indexer/InternalIndex/rebuild`, {})).status).toBe(200)
    expect(
      (
        await h.json<{ healthStatus: { status: string; message: string } }>(
          `${V1}/indexer/InternalIndex`,
        )
      ).healthStatus,
    ).toEqual({ status: 'Rebuilding', message: '1 item is waiting to be indexed' })
    await index()
    expect(
      (await h.json<{ healthStatus: { status: string } }>(`${V1}/indexer/InternalIndex`))
        .healthStatus.status,
    ).toBe('Healthy')

    expect(
      (await h.json<{ items: Array<{ name: string }> }>(`${V1}/searcher?skip=0&take=10`)).items,
    ).toEqual([{ name: 'InternalSearcher' }, { name: 'MembersSearcher' }])
    const results = await h.json<{
      total: number
      items: Array<{ id: string; fields: Array<{ name: string; values: string[] }> }>
    }>(`${V1}/searcher/InternalSearcher/query?term=lens&skip=0&take=10`)
    expect(results.total).toBe(1)
    expect(results.items[0]?.id).toBe(key)
    expect(results.items[0]?.fields).toContainEqual({ name: 'nodeName', values: ['Lighthouse'] })
    expect(results.items[0]?.fields).toContainEqual({ name: 'bodyText', values: ['Beam and lens'] })

    expect((await h.call(`${V1}/indexer/ExternalIndex`)).status).toBe(400)
    expect((await h.post(`${V1}/indexer/ExternalIndex/rebuild`, {})).status).toBe(400)
    expect((await h.call(`${V1}/searcher/Nope/query?term=x`)).status).toBe(404)
    const writer = await signInAsGroup(h, 'writer')
    expect((await writer.call(`${V1}/indexer?skip=0&take=10`)).status).toBe(403)
  })
})

describe(`the queue (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('holds one row per item, and two indexers never index it twice', async () => {
    const { h, page, index } = await site()
    await index()
    const keys = [await page('One'), await page('Two'), await page('Three')]
    const ids = (
      await h.server.db.query<{ id: number }>(
        `SELECT id FROM node WHERE unique_id IN (?, ?, ?)`,
        keys,
      )
    ).map((row) => Number(row.id))
    await queueForSearch(h.server.db, ids)
    const queued = await h.server.db.query<{ node_id: number; generation: number }>(
      'SELECT node_id, generation FROM search_index_queue ORDER BY node_id',
    )
    expect(queued.map((row) => Number(row.generation))).toEqual([2, 2, 2])

    const [a, b] = await Promise.all([
      new SearchIndex(h.server.db).indexQueued(),
      new SearchIndex(h.server.db).indexQueued(),
    ])
    expect((a ?? 0) + (b ?? 0)).toBe(3)
    const rows = await h.server.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM search_document')
    expect(Number(rows[0]?.n)).toBe(3)
  })
})

describe(`a property kept out of search (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('reads and writes as searchable = false, and only when false', () => {
    const parsed = parseContentType('page.toml', PAGE)
    expect(parsed.problems).toEqual([])
    const type = parsed.value
    if (!type) throw new Error('no type')
    const notes = type.properties.find((property) => property.alias === 'internalNotes')
    expect(notes?.searchable).toBe(false)
    expect(type.properties.find((property) => property.alias === 'title')?.searchable).toBe(
      undefined,
    )
    const written = writeContentType(type)
    expect(written.match(/searchable/g)).toEqual(['searchable'])
    expect(written).toContain('searchable = false')
  })

  test('is not indexed, survives a save that does not mention it, and is indexed once allowed', async () => {
    const { h, page, search, index } = await site()
    const key = await page('Memo', { bodyText: 'public words', internalNotes: 'confidential' })
    await index()
    expect(await search('public')).toEqual([key])
    expect(await search('confidential')).toEqual([])
    const hits = await h.json<{ items: Array<{ fields: Array<{ name: string }> }> }>(
      `${V1}/searcher/InternalSearcher/query?term=public&skip=0&take=10`,
    )
    expect(hits.items[0]?.fields.map((field) => field.name)).not.toContain('internalNotes')

    // A backoffice save carries no such flag; the property keeps it.
    const types = new ContentTypeRepository(h.server.db)
    const type = await types.byAlias('page')
    if (!type) throw new Error('no page type')
    const { searchable: _, ...withoutFlag } = type.properties.find(
      (property) => property.alias === 'internalNotes',
    ) as (typeof type.properties)[number]
    await types.save({
      ...type,
      name: 'Page (renamed)',
      properties: type.properties.map((property) =>
        property.alias === 'internalNotes' ? withoutFlag : property,
      ),
    })
    const kept = (await types.byAlias('page'))?.properties.find(
      (property) => property.alias === 'internalNotes',
    )
    expect(kept?.searchable).toBe(false)
    await index()
    expect(await search('confidential')).toEqual([])

    // Allowing it is a change to the type's properties, so its pages are indexed again.
    const saved = await types.byAlias('page')
    if (!saved) throw new Error('no page type')
    await types.save({
      ...saved,
      properties: saved.properties.map((property) =>
        property.alias === 'internalNotes' ? { ...property, searchable: true } : property,
      ),
    })
    await index()
    expect(await search('confidential')).toEqual([key])
  })
})
