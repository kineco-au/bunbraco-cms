/**
 * Export and import of content types, in Umbraco's `.udt` XML, plus the JSON
 * Schema endpoints that describe what a type and a data type hold.
 *
 * Aliases are the currency in a `.udt`: keys differ between sites, so a
 * composition, an allowed child and a template all travel by alias.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readContentTypeUdt, writeContentTypeUdt } from '@bunbraco/server'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

const TEXTSTRING = '0cc0eba1-9960-42c9-bf9b-60e150b429ae'
const TEXTAREA = 'c6bac0dd-4ab9-45b1-8e30-e4b619ee5da3'

async function harness(): Promise<Harness> {
  const created = await signedInServer()
  open.push(created)
  return created
}

const TAB = 'b1a2c3d4-0000-4000-8000-00000000ab01'

function documentType(overrides: Record<string, unknown> = {}) {
  return {
    alias: 'article',
    name: 'Article',
    icon: 'icon-document',
    description: 'A page of prose',
    allowedAsRoot: true,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collection: null,
    cleanup: {
      preventCleanup: false,
      keepAllVersionsNewerThanDays: null,
      keepLatestVersionPerDayForDays: null,
    },
    containers: [{ id: TAB, parent: null, name: 'Content', type: 'Tab', sortOrder: 0 }],
    properties: [
      {
        id: 'b1a2c3d4-0000-4000-8000-00000000cd01',
        container: { id: TAB },
        alias: 'title',
        name: 'Title',
        description: 'The headline',
        dataType: { id: TEXTSTRING },
        variesByCulture: false,
        variesBySegment: false,
        sortOrder: 0,
        validation: { mandatory: true, mandatoryMessage: null, regEx: null, regExMessage: null },
        appearance: { labelOnTop: false },
      },
      {
        id: 'b1a2c3d4-0000-4000-8000-00000000cd02',
        container: { id: TAB },
        alias: 'summary',
        name: 'Summary',
        description: null,
        dataType: { id: TEXTAREA },
        variesByCulture: false,
        variesBySegment: false,
        sortOrder: 1,
        validation: { mandatory: false, mandatoryMessage: null, regEx: null, regExMessage: null },
        appearance: { labelOnTop: false },
      },
    ],
    compositions: [],
    allowedDocumentTypes: [],
    allowedTemplates: [],
    defaultTemplate: null,
    parent: null,
    ...overrides,
  }
}

async function upload(h: Harness, xml: string, name = 'article.udt'): Promise<string> {
  const id = crypto.randomUUID()
  const form = new FormData()
  form.set('Id', id)
  form.set('File', new File([xml], name))
  const response = await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
  if (response.status !== 201) throw new Error(`upload ${response.status}`)
  return id
}

describe(`content type export and import (${process.env.BUNBRACO_DB ?? 'sqlite'})`, () => {
  test('exports a document type as a .udt the reader understands again', async () => {
    const h = await harness()
    const key = (await h.post(`${V1}/document-type`, documentType())).headers.get(
      'umb-generated-resource',
    ) as string

    const response = await h.call(`${V1}/document-type/${key}/export`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('article.udt')

    const xml = await response.text()
    expect(xml).toContain('<DocumentType>')
    const parsed = readContentTypeUdt(xml)
    expect(parsed?.kind).toBe('document')
    expect(parsed?.alias).toBe('article')
    expect(parsed?.name).toBe('Article')
    expect(parsed?.allowedAsRoot).toBe(true)
    expect(parsed?.properties.map((p) => p.alias)).toEqual(['title', 'summary'])
    expect(parsed?.properties[0]?.mandatory).toBe(true)
    expect(parsed?.properties[0]?.description).toBe('The headline')
    expect(parsed?.properties[0]?.tabAlias).toBe(parsed?.containers[0]?.alias)
    expect(parsed?.containers.map((c) => c.name)).toEqual(['Content'])
  })

  test('analyses an uploaded file before anything is imported', async () => {
    const h = await harness()
    const key = (await h.post(`${V1}/document-type`, documentType())).headers.get(
      'umb-generated-resource',
    ) as string
    const xml = await (await h.call(`${V1}/document-type/${key}/export`)).text()

    const analysis = await h.json<{ entityType: string; alias: string; key: string }>(
      `${V1}/import/analyze?temporaryFileId=${await upload(h, xml)}`,
    )
    expect(analysis.entityType).toBe('document-type')
    expect(analysis.alias).toBe('article')
    expect(analysis.key).toBe(key)

    // Something that is not an export at all
    const notAnExport = await h.call(
      `${V1}/import/analyze?temporaryFileId=${await upload(h, '<html></html>', 'x.udt')}`,
    )
    expect(notAnExport.status).toBe(400)
    expect(
      (await h.call(`${V1}/import/analyze?temporaryFileId=${crypto.randomUUID()}`)).status,
    ).toBe(404)
  })

  test('imports a file as a new type, and refuses one whose alias is taken', async () => {
    const h = await harness()
    const key = (await h.post(`${V1}/document-type`, documentType())).headers.get(
      'umb-generated-resource',
    ) as string
    const xml = await (await h.call(`${V1}/document-type/${key}/export`)).text()

    // The same file again: the alias is in use.
    const clash = await h.post(`${V1}/document-type/import`, { file: { id: await upload(h, xml) } })
    expect(clash.status).toBe(400)

    // A file from another site: a new alias and key.
    const renamed = xml
      .replace('<Alias>article</Alias>', '<Alias>story</Alias>')
      .replace('<Name>Article</Name>', '<Name>Story</Name>')
      .replace(`<Key>${key}</Key>`, `<Key>${crypto.randomUUID()}</Key>`)
    const created = await h.post(`${V1}/document-type/import`, {
      file: { id: await upload(h, renamed) },
    })
    expect(created.status).toBe(201)
    const newKey = created.headers.get('umb-generated-resource') as string

    const loaded = await h.json<{
      alias: string
      name: string
      properties: Array<{ alias: string; validation: { mandatory: boolean } }>
      containers: Array<{ name: string }>
    }>(`${V1}/document-type/${newKey}`)
    expect([loaded.alias, loaded.name]).toEqual(['story', 'Story'])
    expect(loaded.properties.map((p) => p.alias).sort()).toEqual(['summary', 'title'])
    expect(loaded.properties.find((p) => p.alias === 'title')?.validation.mandatory).toBe(true)
    expect(loaded.containers.map((c) => c.name)).toEqual(['Content'])
  })

  test('imports over an existing type, and refuses a file describing another one', async () => {
    const h = await harness()
    const key = (await h.post(`${V1}/document-type`, documentType())).headers.get(
      'umb-generated-resource',
    ) as string
    const other = (
      await h.post(`${V1}/document-type`, documentType({ alias: 'other', name: 'Other' }))
    ).headers.get('umb-generated-resource') as string
    const xml = await (await h.call(`${V1}/document-type/${key}/export`)).text()

    // A third property arrives with the file.
    const grown = xml.replace(
      '</GenericProperties>',
      `  <GenericProperty>
      <Name>Standfirst</Name>
      <Alias>standfirst</Alias>
      <Definition>${TEXTSTRING}</Definition>
      <SortOrder>2</SortOrder>
      <Mandatory>False</Mandatory>
    </GenericProperty>
  </GenericProperties>`,
    )
    expect(
      (await h.put(`${V1}/document-type/${key}/import`, { file: { id: await upload(h, grown) } }))
        .status,
    ).toBe(200)
    const loaded = await h.json<{ properties: Array<{ alias: string }> }>(
      `${V1}/document-type/${key}`,
    )
    expect(loaded.properties.map((p) => p.alias).sort()).toEqual(['standfirst', 'summary', 'title'])

    // The same file aimed at a different type
    expect(
      (await h.put(`${V1}/document-type/${other}/import`, { file: { id: await upload(h, xml) } }))
        .status,
    ).toBe(400)
    // And a missing target
    expect(
      (
        await h.put(`${V1}/document-type/${crypto.randomUUID()}/import`, {
          file: { id: await upload(h, xml) },
        })
      ).status,
    ).toBe(404)
  })

  test('refuses a media type file aimed at document types', async () => {
    const h = await harness()
    const media = `<?xml version="1.0" encoding="utf-8"?>
<MediaType><Info><Name>Photo</Name><Alias>photo</Alias></Info></MediaType>`
    const response = await h.post(`${V1}/document-type/import`, {
      file: { id: await upload(h, media, 'photo.udt') },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ detail: expect.stringContaining('media') })
  })

  test('media and member types export and import through the same format', async () => {
    const h = await harness()
    for (const [area, root] of [
      ['media-type', 'MediaType'],
      ['member-type', 'MemberType'],
    ]) {
      const tree = await h.json<{ items: Array<{ id: string }> }>(
        `${V1}/tree/${area}/root?skip=0&take=1`,
      )
      const first = tree.items[0]
      if (!first) continue
      const loaded = await h.json<{ alias: string }>(`${V1}/${area}/${first.id}`)
      const xml = await (await h.call(`${V1}/${area}/${first.id}/export`)).text()
      expect(xml).toContain(`<${root}>`)
      expect(readContentTypeUdt(xml)?.alias).toBe(loaded.alias)
      expect(readContentTypeUdt(xml)?.kind).toBe(area === 'media-type' ? 'media' : 'member')
    }
  })
})

describe(`JSON schemas (${process.env.BUNBRACO_DB ?? 'sqlite'})`, () => {
  test('describe a document type as an object of its properties', async () => {
    const h = await harness()
    const key = (await h.post(`${V1}/document-type`, documentType())).headers.get(
      'umb-generated-resource',
    ) as string

    const schema = await h.json<{
      title: string
      type: string
      required?: string[]
      properties: Record<string, { type: string; title: string; description?: string }>
    }>(`${V1}/document-type/${key}/schema`)
    expect(schema.type).toBe('object')
    expect(schema.title).toBe('Article')
    expect(Object.keys(schema.properties).sort()).toEqual(['summary', 'title'])
    expect(schema.properties.title?.title).toBe('Title')
    expect(schema.properties.title?.description).toBe('The headline')
    // Only the mandatory one is required.
    expect(schema.required).toEqual(['title'])

    expect((await h.call(`${V1}/document-type/${crypto.randomUUID()}/schema`)).status).toBe(404)
  })

  test('describe what a data type stores, one at a time and in a batch', async () => {
    const h = await harness()
    const one = await h.json<{ valueTypeName: string; jsonSchema: { type: string } }>(
      `${V1}/data-type/${TEXTSTRING}/schema`,
    )
    expect(one.valueTypeName).toBe('System.String')
    expect(one.jsonSchema.type).toBe('string')

    const missing = crypto.randomUUID()
    const batch = await h.json<{
      total: number
      items: Array<{ id: string; valueTypeName: string | null; error: string | null }>
    }>(`${V1}/data-type/schemas/batch?id=${TEXTSTRING}&id=${missing}`)
    expect(batch.total).toBe(2)
    expect(batch.items.find((i) => i.id === TEXTSTRING)?.error).toBeNull()
    // A missing one is reported in its row rather than failing the batch.
    expect(batch.items.find((i) => i.id === missing)?.error).toBeTruthy()
    expect(batch.items.find((i) => i.id === missing)?.valueTypeName).toBeNull()
  })
})

describe('the udt writer and reader', () => {
  test('round-trip a type through XML without losing what it holds', () => {
    const aggregate = {
      key: 'aaaaaaaa-0000-4000-8000-000000000001',
      alias: 'page',
      name: 'Page',
      description: 'desc & <stuff>',
      icon: 'icon-document',
      allowedAsRoot: true,
      variesByCulture: true,
      variesBySegment: false,
      isElement: false,
      allowedInLibrary: true,
      collectionKey: null,
      cleanup: {
        preventCleanup: false,
        keepAllVersionsNewerThanDays: null,
        keepLatestVersionPerDayForDays: null,
      },
      properties: [
        {
          key: 'bbbbbbbb-0000-4000-8000-000000000001',
          alias: 'title',
          name: 'Title',
          description: null,
          dataTypeKey: TEXTSTRING,
          containerKey: 'cccccccc-0000-4000-8000-000000000001',
          sortOrder: 0,
          variesByCulture: true,
          variesBySegment: false,
          mandatory: true,
          mandatoryMessage: 'Needed',
          regEx: '^.+$',
          regExMessage: 'Nope',
          labelOnTop: true,
        },
      ],
      containers: [
        {
          key: 'cccccccc-0000-4000-8000-000000000001',
          name: 'Content',
          alias: 'content',
          type: 'Tab',
          sortOrder: 0,
          parentKey: null,
        },
      ],
      compositions: [
        {
          contentTypeKey: 'dddddddd-0000-4000-8000-000000000001',
          compositionType: 'Composition' as const,
        },
      ],
      allowedContentTypes: [
        { contentTypeKey: 'eeeeeeee-0000-4000-8000-000000000001', sortOrder: 0 },
      ],
      allowedComponentKeys: ['ffffffff-0000-4000-8000-000000000001'],
      defaultComponentKey: 'ffffffff-0000-4000-8000-000000000001',
      parentKey: null,
    }
    const xml = writeContentTypeUdt(aggregate as never, 'document', {
      aliasOf: (key: string) =>
        key.startsWith('dddd') ? 'base' : key.startsWith('eeee') ? 'child' : undefined,
      templateAliasOf: () => 'pageTemplate',
    })
    const read = readContentTypeUdt(xml)
    expect(read?.alias).toBe('page')
    // Escaping survives the round trip.
    expect(read?.description).toBe('desc & <stuff>')
    expect(read?.variesByCulture).toBe(true)
    expect(read?.allowedInLibrary).toBe(true)
    expect(read?.compositionAliases).toEqual(['base'])
    expect(read?.allowedAliases).toEqual(['child'])
    expect(read?.componentAliases).toEqual(['pageTemplate'])
    expect(read?.defaultTemplateAlias).toBe('pageTemplate')
    const property = read?.properties[0]
    expect(property?.mandatoryMessage).toBe('Needed')
    expect(property?.regEx).toBe('^.+$')
    expect(property?.labelOnTop).toBe(true)
    expect(property?.variesByCulture).toBe(true)
  })

  test('refuse anything that is not a content type export', () => {
    expect(readContentTypeUdt('not xml at all')).toBeUndefined()
    expect(readContentTypeUdt('<?xml version="1.0"?><Nonsense/>')).toBeUndefined()
    // A root we know, but nothing to identify the type by
    expect(readContentTypeUdt('<DocumentType><Info></Info></DocumentType>')).toBeUndefined()
  })
})
