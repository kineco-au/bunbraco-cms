/**
 * Media types (the Settings half of WP-6.4): the same table, rules and files
 * as document types — `schema/media-types/*.toml` under `[media-type]` — with
 * no templates or cleanup, and references keyed `mediaType`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMediaType } from '@bunbraco/schema'
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

const TEXTSTRING = '0cc0eba1-9960-42c9-bf9b-60e150b429ae'
const UPLOAD = '84c6b441-31df-4ffe-b67e-67d5bc3ae65a'

async function site(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'media-types-'))
  dirs.push(root)
  for (const dir of ['document-types', 'media-types', 'data-types'])
    mkdirSync(join(root, 'schema', dir), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), viewsDir: join(root, 'Views') },
  })
  open.push(h)
  return { h, schemaDir: join(root, 'schema') }
}

function property(alias: string, name: string, dataTypeId: string) {
  return {
    id: crypto.randomUUID(),
    container: null,
    sortOrder: 0,
    alias,
    name,
    description: null,
    dataType: { id: dataTypeId },
    variesByCulture: false,
    variesBySegment: false,
    validation: { mandatory: false, mandatoryMessage: null, regEx: null, regExMessage: null },
    appearance: { labelOnTop: false },
  }
}

/** What the media-type workspace posts. */
function mediaType(alias: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    name: alias.charAt(0).toUpperCase() + alias.slice(1),
    icon: 'icon-picture',
    description: null,
    allowedAsRoot: true,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collection: null,
    properties: [] as unknown[],
    containers: [],
    compositions: [] as unknown[],
    allowedMediaTypes: [] as unknown[],
    parent: null as { id: string } | null,
    ...overrides,
  }
}

async function create(h: Harness, body: Record<string, unknown>): Promise<string> {
  const response = await h.post(`${V1}/media-type`, body)
  if (response.status !== 201)
    throw new Error(`media type: ${response.status} ${await response.text()}`)
  return response.headers.get('umb-generated-resource') as string
}

describe('media types', () => {
  test('saving one creates it, reads it back in the media-type shape, and writes its file', async () => {
    const { h, schemaDir } = await site()
    const key = await create(
      h,
      mediaType('photo', {
        properties: [
          property('umbracoFile', 'File', UPLOAD),
          property('caption', 'Caption', TEXTSTRING),
        ],
      }),
    )
    const read = await h.json<Record<string, unknown>>(`${V1}/media-type/${key}`)
    expect(read).toMatchObject({
      id: key,
      alias: 'photo',
      name: 'Photo',
      icon: 'icon-picture',
      isDeletable: true,
      aliasCanBeChanged: true,
      allowedMediaTypes: [],
    })
    expect(read).not.toHaveProperty('allowedTemplates')
    expect(read).not.toHaveProperty('cleanup')
    expect((read.properties as Array<{ alias: string }>).map((p) => p.alias)).toEqual([
      'umbracoFile',
      'caption',
    ])

    const file = join(schemaDir, 'media-types', 'photo.toml')
    const source = readFileSync(file, 'utf8')
    expect(source.startsWith('[media-type]\n')).toBe(true)
    expect(source).not.toContain('templates')
    const parsed = parseMediaType('photo', source)
    expect(parsed.problems).toEqual([])
    expect(parsed.value).toMatchObject({ key, alias: 'photo', name: 'Photo' })
    expect(parsed.value?.properties.map((p) => [p.alias, p.type])).toEqual([
      ['umbracoFile', 'upload'],
      ['caption', 'textstring'],
    ])

    // Update, then delete removes the file
    const updated = await h.put(
      `${V1}/media-type/${key}`,
      mediaType('photo', { name: 'Photograph' }),
    )
    expect(updated.status).toBe(200)
    expect(parseMediaType('photo', readFileSync(file, 'utf8')).value?.name).toBe('Photograph')
    expect((await h.del(`${V1}/media-type/${key}`)).status).toBe(200)
    expect(existsSync(file)).toBe(false)
    expect((await h.call(`${V1}/media-type/${key}`)).status).toBe(404)
  })

  test('allowed children, compositions, tree, items, search, folders and configuration', async () => {
    const { h, schemaDir } = await site()
    const seo = await create(
      h,
      mediaType('mediaMeta', {
        allowedAsRoot: false,
        properties: [property('altText', 'Alt text', TEXTSTRING)],
      }),
    )
    const image = await create(
      h,
      mediaType('photo', {
        allowedAsRoot: false,
        compositions: [{ mediaType: { id: seo }, compositionType: 'Composition' }],
      }),
    )
    const folderKey = await create(
      h,
      mediaType('mediaFolder', { allowedMediaTypes: [{ mediaType: { id: image }, sortOrder: 0 }] }),
    )

    const folderType = await h.json<{
      allowedMediaTypes: Array<{ mediaType: { id: string }; sortOrder: number }>
    }>(`${V1}/media-type/${folderKey}`)
    expect(folderType.allowedMediaTypes).toEqual([{ mediaType: { id: image }, sortOrder: 0 }])
    const imageType = await h.json<{
      compositions: Array<{ mediaType: { id: string }; compositionType: string }>
    }>(`${V1}/media-type/${image}`)
    expect(imageType.compositions).toEqual([
      { mediaType: { id: seo }, compositionType: 'Composition' },
    ])
    expect(readFileSync(join(schemaDir, 'media-types', 'media-folder.toml'), 'utf8')).toContain(
      'allow-children = ["photo"]',
    )

    const atRoot = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/media-type/allowed-at-root?skip=0&take=10`,
    )
    // The site's one, plus the system types (Folder, Image, File are allowed at the root)
    expect(
      atRoot.items.map((i) => i.id).filter((id) => [folderKey, image, seo].includes(id)),
    ).toEqual([folderKey])
    const children = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/media-type/${folderKey}/allowed-children?skip=0&take=10`,
    )
    expect(children.items.map((i) => i.id)).toEqual([image])
    expect(
      await h.json<Record<string, unknown>>(`${V1}/media-type/${image}/allowed-parents`),
    ).toEqual({ allowedParentIds: [{ id: folderKey }] })
    expect(
      (await h.json<Array<{ id: string }>>(`${V1}/media-type/${seo}/composition-references`)).map(
        (r) => r.id,
      ),
    ).toEqual([image])

    const tree = await h.json<{
      items: Array<{ id: string; isDeletable: boolean; isFolder: boolean }>
    }>(`${V1}/tree/media-type/root?skip=0&take=10`)
    // The site's three, alongside the system media types every site has
    const ours = tree.items.filter((i) => [folderKey, image, seo].includes(i.id))
    expect(ours.map((i) => i.id).sort()).toEqual([folderKey, image, seo].sort())
    expect(ours.every((i) => i.isDeletable && !i.isFolder)).toBe(true)
    const items = await h.json<Array<Record<string, unknown>>>(`${V1}/item/media-type?id=${image}`)
    expect(items).toEqual([{ id: image, name: 'Photo', icon: 'icon-picture', flags: [] }])
    const search = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/item/media-type/search?query=pho&skip=0&take=10`,
    )
    expect(search.items.map((i) => i.id)).toEqual([image])
    expect(await h.json<Record<string, unknown>>(`${V1}/media-type/configuration`)).toEqual({
      reservedFieldNames: expect.any(Array),
    })

    const folder = await h.post(`${V1}/media-type/folder`, { name: 'Assets', parent: null })
    expect(folder.status).toBe(201)
    const assets = folder.headers.get('umb-generated-resource') as string
    expect((await h.put(`${V1}/media-type/${image}/move`, { target: { id: assets } })).status).toBe(
      200,
    )
    expect(
      parseMediaType('x', readFileSync(join(schemaDir, 'media-types', 'photo.toml'), 'utf8')).value
        ?.folder,
    ).toBe('Assets')
    const inside = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/tree/media-type/children?parentId=${assets}&skip=0&take=10`,
    )
    expect(inside.items.map((i) => i.id)).toEqual([image])
  })

  test('media types and document types stay apart, but share one alias space', async () => {
    const { h } = await site()
    const media = await create(h, mediaType('asset'))
    expect((await h.call(`${V1}/document-type/${media}`)).status).toBe(404)
    const docTree = await h.json<{ total: number }>(`${V1}/tree/document-type/root?skip=0&take=10`)
    expect(docTree.total).toBe(0)
    // Umbraco's content_type alias is unique across both kinds
    const clash = await h.post(`${V1}/document-type`, {
      ...mediaType('asset'),
      allowedMediaTypes: undefined,
      allowedDocumentTypes: [],
      allowedTemplates: [],
      defaultTemplate: null,
      cleanup: {
        preventCleanup: false,
        keepAllVersionsNewerThanDays: null,
        keepLatestVersionPerDayForDays: null,
      },
    })
    expect(clash.status).toBe(400)
  })

  test('a media type defined in a file syncs at boot, and templates are not part of the vocabulary', async () => {
    const { h } = await site({
      'schema/media-types/file.toml':
        '[media-type]\nkey = "0b1c8e3a-6666-4a5b-9c1d-000000000001"\nalias = "pdfDocument"\nname = "PDF document"\nicon = "icon-document"\nallow-at-root = true\nfolder = "System"\n\n[[property]]\nkey = "0b1c8e3a-6666-4a5b-9c1d-000000000002"\nalias = "umbracoFile"\nname = "File"\ntype = "upload"\n',
    })
    expect(h.server.schema.report?.created.types).toBe(1)
    const read = await h.json<{ alias: string; properties: Array<{ alias: string }> }>(
      `${V1}/media-type/0b1c8e3a-6666-4a5b-9c1d-000000000001`,
    )
    expect(read.alias).toBe('pdfDocument')
    const root = await h.json<{ items: Array<{ name: string; isFolder: boolean }> }>(
      `${V1}/tree/media-type/root?skip=0&take=10`,
    )
    // Folders first, then the system types, which live at the root
    expect(root.items[0]).toMatchObject({ name: 'System', isFolder: true })

    const withTemplates = parseMediaType(
      'bad',
      '[media-type]\nalias = "bad"\nname = "Bad"\ntemplates = ["x"]\n',
    )
    expect(withTemplates.problems.map((p) => p.message)).toEqual([
      expect.stringContaining('unknown key'),
    ])
  })
})
