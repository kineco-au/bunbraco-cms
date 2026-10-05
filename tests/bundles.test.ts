/**
 * Created packages: the definitions' CRUD, the two migration operations that
 * answer honestly, and the download — asserted by reading the zip back and
 * loading the bundle inside it through the importer that already exists, rather
 * than by inspecting bytes. docs/17-bundles.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { packageFileName } from '@bunbraco/api-management'
import { loadBundle } from '@bunbraco/transfer'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
const temporary: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (temporary.length > 0) rmSync(temporary.pop() as string, { recursive: true, force: true })
})

const PACKAGES = `${V1}/package`

/** Everything the contract requires, so a test names only what it cares about. */
const definition = (over: Record<string, unknown> = {}) => ({
  name: 'Starter kit',
  contentNodeId: null,
  contentLoadChildNodes: false,
  mediaIds: [],
  mediaLoadChildNodes: false,
  documentTypes: [],
  mediaTypes: [],
  dataTypes: [],
  components: [],
  partialViews: [],
  stylesheets: [],
  scripts: [],
  languages: [],
  dictionaryItems: [],
  ...over,
})

/** Umbraco's built-in Textstring, which every site has. */
const TEXTSTRING = '0cc0eba1-9960-42c9-bf9b-60e150b429ae'

async function site() {
  const h = await signedInServer()
  open.push(h)
  const create = async (over: Record<string, unknown> = {}) => {
    const response = await h.post(`${PACKAGES}/created`, definition(over))
    if (response.status !== 201)
      throw new Error(
        `Creating the package failed with ${response.status}: ${await response.text()}`,
      )
    return response.headers.get('umb-generated-resource') as string
  }
  /** A document type that may sit at the root, so content can be packaged. */
  const documentType = async (alias = 'packagedPage', name = 'Packaged Page') => {
    const response = await h.post(`${V1}/document-type`, {
      alias,
      name,
      icon: 'icon-document',
      description: null,
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
      properties: [
        {
          id: crypto.randomUUID(),
          container: null,
          alias: 'title',
          name: 'Title',
          description: null,
          dataType: { id: TEXTSTRING },
          variesByCulture: false,
          variesBySegment: false,
          sortOrder: 0,
          validation: { mandatory: false, mandatoryMessage: null, regEx: null, regExMessage: null },
          appearance: { labelOnTop: false },
        },
      ],
      containers: [],
      compositions: [],
      allowedDocumentTypes: [],
      allowedTemplates: [],
      defaultTemplate: null,
      parent: null,
    })
    if (response.status !== 201)
      throw new Error(
        `Creating the document type failed with ${response.status}: ${await response.text()}`,
      )
    return { id: response.headers.get('umb-generated-resource') as string, alias }
  }
  return { h, create, documentType }
}

/** The archive's entries, by path. */
function unzip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const decoder = new TextDecoder()
  let end = archive.length - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1
  if (end < 0) throw new Error('not a zip')
  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  const found = new Map<string, Uint8Array>()
  for (let index = 0; index < count; index += 1) {
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const path = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength))
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true)
    const stored = archive.subarray(dataStart, dataStart + compressedSize)
    found.set(path, method === 0 ? stored : new Uint8Array(inflateRawSync(stored)))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return found
}

const download = async (h: Harness, id: string): Promise<Map<string, Uint8Array>> => {
  const response = await h.call(`${PACKAGES}/created/${id}/download`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/zip')
  return unzip(new Uint8Array(await response.arrayBuffer()))
}

const text = (entries: Map<string, Uint8Array>, path: string): string => {
  const bytes = entries.get(path)
  if (!bytes) throw new Error(`${path} is not in the archive: ${[...entries.keys()].join(', ')}`)
  return new TextDecoder().decode(bytes)
}

describe('the Packages section loads', () => {
  test('configuration names where the marketplace is', async () => {
    const { h } = await site()
    const config = await h.json<{ marketplaceUrl: string }>(`${PACKAGES}/configuration`)
    expect(config.marketplaceUrl).toContain('bunbraco-bundle')
  })

  test('migration status is an empty page, not a 501', async () => {
    const { h } = await site()
    const response = await h.call(`${PACKAGES}/migration-status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ total: 0, items: [] })
  })

  test('migration status validates skip against take, as every page does', async () => {
    const { h } = await site()
    expect((await h.call(`${PACKAGES}/migration-status?skip=3&take=2`)).status).toBe(400)
  })

  test('running a package migration is a 404, because none can exist', async () => {
    const { h } = await site()
    const response = await h.call(`${PACKAGES}/Acme.Thing/run-migration`, { method: 'POST' })
    expect(response.status).toBe(404)
    const problem = (await response.json()) as { detail: string }
    expect(problem.detail).toContain('Package migrations do not exist')
  })

  test('the created list starts empty', async () => {
    const { h } = await site()
    expect(await h.json<unknown>(`${PACKAGES}/created`)).toEqual({ total: 0, items: [] })
  })
})

describe('created-package definitions', () => {
  test('round-trip through create, read, update and delete', async () => {
    const { h, create } = await site()
    const id = await create({ name: 'Blog' })

    const read = await h.json<{ id: string; name: string; packagePath: string }>(
      `${PACKAGES}/created/${id}`,
    )
    expect(read.id).toBe(id)
    expect(read.name).toBe('Blog')
    expect(read.packagePath).toBe('blog.zip')

    expect(
      (
        await h.put(
          `${PACKAGES}/created/${id}`,
          definition({ name: 'Blog renamed', packagePath: 'blog.zip' }),
        )
      ).status,
    ).toBe(200)
    const renamed = await h.json<{ name: string }>(`${PACKAGES}/created/${id}`)
    expect(renamed.name).toBe('Blog renamed')

    expect((await h.del(`${PACKAGES}/created/${id}`)).status).toBe(200)
    expect((await h.call(`${PACKAGES}/created/${id}`)).status).toBe(404)
  })

  test('lists by name and pages', async () => {
    const { h, create } = await site()
    await create({ name: 'Zebra' })
    await create({ name: 'Apple' })
    const list = await h.json<{ total: number; items: { name: string }[] }>(`${PACKAGES}/created`)
    expect(list.total).toBe(2)
    expect(list.items.map((item) => item.name)).toEqual(['Apple', 'Zebra'])

    const page = await h.json<{ total: number; items: { name: string }[] }>(
      `${PACKAGES}/created?skip=1&take=1`,
    )
    expect(page.total).toBe(2)
    expect(page.items.map((item) => item.name)).toEqual(['Zebra'])
  })

  test('refuses a duplicate name and an empty one', async () => {
    const { h, create } = await site()
    await create({ name: 'Only one' })
    const duplicate = await h.post(`${PACKAGES}/created`, definition({ name: 'Only one' }))
    expect(duplicate.status).toBe(400)
    const problem = (await duplicate.json()) as { operationStatus: string }
    expect(problem.operationStatus).toBe('DuplicateName')
    expect((await h.post(`${PACKAGES}/created`, definition({ name: '  ' }))).status).toBe(400)
  })

  test('renaming onto another package is refused, renaming itself is not', async () => {
    const { h, create } = await site()
    await create({ name: 'First' })
    const second = await create({ name: 'Second' })
    expect(
      (await h.put(`${PACKAGES}/created/${second}`, definition({ name: 'First' }))).status,
    ).toBe(400)
    expect(
      (await h.put(`${PACKAGES}/created/${second}`, definition({ name: 'Second' }))).status,
    ).toBe(200)
  })

  test('a missing definition is a 404 on every operation that names one', async () => {
    const { h } = await site()
    const missing = '11111111-1111-1111-1111-111111111111'
    expect((await h.call(`${PACKAGES}/created/${missing}`)).status).toBe(404)
    expect((await h.put(`${PACKAGES}/created/${missing}`, definition())).status).toBe(404)
    expect((await h.del(`${PACKAGES}/created/${missing}`)).status).toBe(404)
    expect((await h.call(`${PACKAGES}/created/${missing}/download`)).status).toBe(404)
  })

  test('the client may choose the id, as the contract allows', async () => {
    const { h } = await site()
    const id = '22222222-2222-2222-2222-222222222222'
    const response = await h.post(`${PACKAGES}/created`, definition({ id, name: 'Chosen' }))
    expect(response.status).toBe(201)
    expect(response.headers.get('umb-generated-resource')).toBe(id)
    expect((await h.json<{ id: string }>(`${PACKAGES}/created/${id}`)).id).toBe(id)
  })
})

describe('the download', () => {
  /**
   * Even with nothing picked, the artifact knows what it is: a manifest naming
   * the package, so two downloads are not distinguishable only by filename.
   */
  test('an empty definition still downloads a manifest that names it', async () => {
    const { h, create } = await site()
    const id = await create({ name: 'Nothing picked' })
    const response = await h.call(`${PACKAGES}/created/${id}/download`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="nothing-picked.zip"',
    )
    const entries = unzip(new Uint8Array(await response.arrayBuffer()))
    expect([...entries.keys()]).toEqual(['bundle.json'])
    const manifest = JSON.parse(text(entries, 'bundle.json')) as {
      label: string
      formatVersion: number
      integrity: string
    }
    expect(manifest.label).toBe('Nothing picked')
    // Content-only, so it stays readable by a node that predates sections.
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.integrity).toMatch(/^sha256-/)
  })

  test('a package carrying sections declares them and names itself', async () => {
    const { h, create } = await site()
    const entries = await download(h, await create({ name: 'Declared', languages: ['en-US'] }))
    const manifest = JSON.parse(text(entries, 'bundle.json')) as {
      label: string
      formatVersion: number
      carries: Record<string, string[]>
    }
    expect(manifest.label).toBe('Declared')
    expect(manifest.formatVersion).toBe(2)
    expect(manifest.carries.schema).toContain('schema/languages.toml')
  })

  test('carries the picked schema as the TOML files schema/ would hold', async () => {
    const { h, create, documentType } = await site()
    const type = await documentType()

    const entries = await download(
      h,
      await create({ name: 'Schema only', documentTypes: [type.id] }),
    )
    expect([...entries.keys()]).toContain('schema/schema.toml')
    const file = [...entries.keys()].find((path) => path.startsWith('schema/document-types/'))
    if (!file) throw new Error(`no document type in ${[...entries.keys()].join(', ')}`)
    expect(text(entries, file)).toContain(`alias = "${type.alias}"`)
  })

  test('picks a document type by alias as well as by key', async () => {
    const { h, create, documentType } = await site()
    const type = await documentType('byAlias', 'By Alias')
    const entries = await download(
      h,
      await create({ name: 'By alias', documentTypes: [type.alias] }),
    )
    expect([...entries.keys()]).toContain('schema/document-types/by-alias.toml')
  })

  test('leaves out a type that was not picked', async () => {
    const { h, create, documentType } = await site()
    const wanted = await documentType('wanted', 'Wanted')
    await documentType('unwanted', 'Unwanted')
    const entries = await download(
      h,
      await create({ name: 'One type', documentTypes: [wanted.id] }),
    )
    const files = [...entries.keys()].filter((path) => path.startsWith('schema/document-types/'))
    expect(files).toHaveLength(1)
    expect(text(entries, files[0] as string)).toContain('alias = "wanted"')
  })

  test('picks a data type by key and leaves the rest out', async () => {
    const { h, create } = await site()
    const made = await h.post(`${V1}/data-type`, {
      name: 'Big Text',
      editorAlias: 'Umbraco.TextArea',
      editorUiAlias: 'Umb.PropertyEditorUi.TextArea',
      values: [{ alias: 'maxChars', value: 500 }],
      parent: null,
    })
    expect(made.status).toBe(201)
    const key = made.headers.get('umb-generated-resource') as string

    const entries = await download(h, await create({ name: 'One data type', dataTypes: [key] }))
    const files = [...entries.keys()].filter((path) => path.startsWith('schema/data-types/'))
    expect(files).toHaveLength(1)
    expect(text(entries, files[0] as string)).toContain('Umbraco.TextArea')
    expect([...entries.keys()].some((path) => path.startsWith('schema/document-types/'))).toBe(
      false,
    )
  })

  /**
   * Built-ins are not written as schema files either (`09-schema-as-code.md`):
   * every site has them, so carrying one would ship a file the destination
   * already satisfies. Picking one is therefore allowed and carries nothing.
   */
  test('does not carry an unchanged built-in data type', async () => {
    const { h, create } = await site()
    const entries = await download(h, await create({ name: 'Built-in', dataTypes: [TEXTSTRING] }))
    expect([...entries.keys()].filter((path) => path.startsWith('schema/data-types/'))).toEqual([])
  })

  test('carries a picked language', async () => {
    const { h, create } = await site()
    const entries = await download(h, await create({ name: 'Languages', languages: ['en-US'] }))
    expect(text(entries, 'schema/languages.toml')).toContain('en-US')
  })

  test('carries picked dictionary items as a .udt', async () => {
    const { h, create } = await site()
    const made = await h.post(`${V1}/dictionary`, {
      name: 'Greeting',
      parent: null,
      translations: [{ isoCode: 'en-US', translation: 'Hello' }],
    })
    expect(made.status).toBe(201)
    const key = made.headers.get('umb-generated-resource') as string

    const entries = await download(h, await create({ name: 'Words', dictionaryItems: [key] }))
    const udt = text(entries, 'dictionary.udt')
    expect(udt).toContain('Greeting')
    expect(udt).toContain('Hello')
  })

  test('carries a picked content subtree as a loadable bundle', async () => {
    const { h, create, documentType } = await site()
    const type = await documentType()

    const made = await h.post(`${V1}/document`, {
      documentType: { id: type.id },
      template: null,
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Packaged page' }],
    })
    if (made.status !== 201)
      throw new Error(`creating the document failed ${made.status}: ${await made.text()}`)
    const document = made.headers.get('umb-generated-resource') as string

    const entries = await download(
      h,
      await create({ name: 'With content', contentNodeId: document, contentLoadChildNodes: true }),
    )
    expect([...entries.keys()]).toContain('bundle.json')

    // Write the bundle out and load it the way an import would, so the package
    // is proved to carry a real bundle rather than a file of the right name.
    const dir = mkdtempSync(join(tmpdir(), 'bunbraco-package-'))
    temporary.push(dir)
    for (const [path, bytes] of entries) {
      if (
        !path.startsWith('bundle.json') &&
        !path.startsWith('nodes/') &&
        !path.startsWith('blobs/')
      )
        continue
      await mkdir(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), bytes)
    }
    const loaded = loadBundle(dir)
    expect(loaded.problems).toEqual([])
    expect(
      loaded.set?.nodes.some((node) => node.key.toLowerCase() === document.toLowerCase()),
    ).toBe(true)
  })

  /**
   * The contract carries the two flags separately, so they have to be honoured
   * separately: picking a media item with its children must not drag a content
   * page's children in behind it.
   */
  test('honours contentLoadChildNodes and mediaLoadChildNodes independently', async () => {
    const { h, create, documentType } = await site()
    const type = await documentType()
    const page = async (name: string, parent: string | null) => {
      const made = await h.post(`${V1}/document`, {
        documentType: { id: type.id },
        template: null,
        parent: parent ? { id: parent } : null,
        values: [],
        variants: [{ culture: null, segment: null, name }],
      })
      if (made.status !== 201)
        throw new Error(`creating ${name} failed ${made.status}: ${await made.text()}`)
      return made.headers.get('umb-generated-resource') as string
    }
    const parent = await page('Parent', null)
    const child = await page('Child', parent)

    const keys = async (id: string) => {
      const entries = await download(h, id)
      return [...entries.keys()]
        .filter((path) => path.startsWith('nodes/'))
        .map((path) =>
          path
            .slice('nodes/'.length)
            .replace(/\.json$/, '')
            .toLowerCase(),
        )
        .sort()
    }

    // Children off: the root alone.
    const without = await create({
      name: 'Without children',
      contentNodeId: parent,
      contentLoadChildNodes: false,
    })
    expect(await keys(without)).toEqual([parent.toLowerCase()])

    // Children on: both.
    const with_ = await create({
      name: 'With children',
      contentNodeId: parent,
      contentLoadChildNodes: true,
    })
    expect(await keys(with_)).toEqual([child.toLowerCase(), parent.toLowerCase()].sort())

    // Media asking for its children does not turn the content flag on.
    const mixed = await create({
      name: 'Mixed flags',
      contentNodeId: parent,
      contentLoadChildNodes: false,
      mediaIds: [],
      mediaLoadChildNodes: true,
    })
    expect(await keys(mixed)).toEqual([parent.toLowerCase()])
  })

  test('counts what the merged bundle actually holds', async () => {
    const { h, create, documentType } = await site()
    const type = await documentType()
    const made = await h.post(`${V1}/document`, {
      documentType: { id: type.id },
      template: null,
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Only page' }],
    })
    const document = made.headers.get('umb-generated-resource') as string
    const entries = await download(
      h,
      await create({ name: 'Counted', contentNodeId: document, contentLoadChildNodes: false }),
    )
    const manifest = JSON.parse(text(entries, 'bundle.json')) as {
      counts: Record<string, number>
    }
    expect(manifest.counts.document).toBe(1)
  })

  test('is rebuilt on each download, so an edit after saving is carried', async () => {
    const { h, create } = await site()
    const id = await create({ name: 'Rebuilt', languages: ['en-US'] })
    const first = await download(h, id)
    expect(first.has('schema/languages.toml')).toBe(true)

    await h.put(`${PACKAGES}/created/${id}`, definition({ name: 'Rebuilt' }))
    const second = await download(h, id)
    expect(second.has('schema/languages.toml')).toBe(false)
  })
})

describe('the files half of a package', () => {
  /** Its own site: the file areas have to be writable directories under a temp root. */
  async function fileSite() {
    const root = mkdtempSync(join(tmpdir(), 'bunbraco-package-files-'))
    temporary.push(root)
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
    const create = async (over: Record<string, unknown> = {}) => {
      const response = await h.post(`${PACKAGES}/created`, definition(over))
      if (response.status !== 201)
        throw new Error(
          `Creating the package failed with ${response.status}: ${await response.text()}`,
        )
      return response.headers.get('umb-generated-resource') as string
    }
    return { h, create }
  }

  test('carries a picked stylesheet, script and partial view at their own paths', async () => {
    const { h, create } = await fileSite()
    const made = async (route: string, name: string, content: string) => {
      const response = await h.post(`${V1}/${route}`, { name, parent: null, content })
      expect(response.status).toBe(201)
      return decodeURIComponent(response.headers.get('umb-generated-resource') as string)
    }
    const stylesheet = await made('stylesheet', 'site.css', 'body { margin: 0 }')
    const script = await made('script', 'site.js', 'console.log(1)')
    const partial = await made('partial-view', 'nav.cshtml', 'export default () => <nav />')

    const entries = await download(
      h,
      await create({
        name: 'Files',
        stylesheets: [stylesheet],
        scripts: [script],
        partialViews: [partial],
      }),
    )
    expect(text(entries, 'styles/site.css')).toBe('body { margin: 0 }')
    expect(text(entries, 'scripts/site.js')).toBe('console.log(1)')
    // One section: a component picked either way lands in components/.
    expect(text(entries, 'components/nav.tsx')).toBe('export default () => <nav />')
  })

  test('keeps a file inside a folder at its folder path', async () => {
    const { h, create } = await fileSite()
    expect((await h.post(`${V1}/stylesheet/folder`, { name: 'shared', parent: null })).status).toBe(
      201,
    )
    const created = await h.post(`${V1}/stylesheet`, {
      name: 'theme.css',
      parent: { path: '/shared' },
      content: 'a { color: red }',
    })
    const path = decodeURIComponent(created.headers.get('umb-generated-resource') as string)

    const entries = await download(h, await create({ name: 'Nested', stylesheets: [path] }))
    expect(text(entries, 'styles/shared/theme.css')).toBe('a { color: red }')
  })

  test('carries a picked template as its view', async () => {
    const { h, create } = await fileSite()
    const made = await h.post(`${V1}/template`, {
      name: 'Home Page',
      alias: 'homePage',
      content: 'export default () => <h1>Home</h1>',
    })
    expect(made.status).toBe(201)
    const key = made.headers.get('umb-generated-resource') as string

    const entries = await download(h, await create({ name: 'Templates', templates: [key] }))
    expect(text(entries, 'components/homePage.tsx')).toContain('<h1>Home</h1>')
  })

  test('a file that has since been deleted is dropped, not an error', async () => {
    const { h, create } = await fileSite()
    const id = await create({ name: 'Gone', stylesheets: ['/never-existed.css'] })
    const entries = await download(h, id)
    expect([...entries.keys()].filter((path) => path.startsWith('styles/'))).toEqual([])
  })
})

describe('packageFileName', () => {
  test('slugs a name into something a browser will save', () => {
    expect(packageFileName('Starter Kit')).toBe('starter-kit.zip')
    expect(packageFileName('  Blog/2024  ')).toBe('blog-2024.zip')
    expect(packageFileName('***')).toBe('package.zip')
  })
})
