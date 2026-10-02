/**
 * Schema-as-code end to end: boot syncs `schema/`, the backoffice writes files,
 * a removed type with content refuses to boot, and two nodes on one Postgres
 * database stay coherent. docs/09-schema-as-code.md; the 5b exit criteria in
 * docs/07-roadmap.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, TemplateRepository } from '@bunbraco/data'
import { parseDocumentType } from '@bunbraco/schema'
import { createServer, loadConfig, SchemaBootError } from '@bunbraco/server'
import { dialectUnderTest } from './support/db.ts'
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

const VIEW = `export default function Article({ model }) {
  return <main><h1>{model.text('title')}</h1><p>{model.text('summary')}</p></main>
}
`

const ARTICLE = (version: string, withSummary: boolean) => `[document-type]
alias = "article"
name = "Article"
allow-at-root = true
templates = ["article"]
default-template = "article"
${version ? `since = "${version}"\n` : ''}
[[property]]
alias = "title"
name = "Title"
type = "textstring"
${
  withSummary
    ? `
[[property]]
alias = "summary"
name = "Summary"
type = "textarea"
`
    : ''
}`

interface Site {
  root: string
  schemaDir: string
  viewsDir: string
  sqliteFile: string
}

function site(version: string, files: Record<string, string> = {}): Site {
  const root = mkdtempSync(join(process.cwd(), 'output', 'bunbraco-site-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'Views'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), `[schema]\nversion = "${version}"\n`)
  writeFileSync(join(root, 'Views', 'article.tsx'), VIEW)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  return {
    root,
    schemaDir: join(root, 'schema'),
    viewsDir: join(root, 'Views'),
    sqliteFile: join(root, 'site.sqlite'),
  }
}

/** Boots a signed-in server on a site; `db` says which database it joins. */
async function boot(
  s: Site,
  options: {
    revision?: string
    nodeId?: string
    keepDatabase?: boolean
    development?: boolean
    sqliteFile?: string
  } = {},
): Promise<Harness> {
  const h = await signedInServer({
    keepDatabase: options.keepDatabase,
    config: {
      schemaDir: s.schemaDir,
      viewsDir: s.viewsDir,
      sqliteFile: options.sqliteFile ?? s.sqliteFile,
      schemaRevision: options.revision ?? '1',
      nodeId: options.nodeId ?? 'test-node',
      development: options.development ?? true,
      schemaWritable: options.development ?? true,
    },
  })
  open.push(h)
  return h
}

async function createArticle(
  h: Harness,
  typeKey: string,
  name: string,
  values: Record<string, string>,
) {
  const template = await new TemplateRepository(h.server.db).byAlias('article')
  const response = await h.post(`${V1}/document`, {
    documentType: { id: typeKey },
    template: template ? { id: template.key } : null,
    parent: null,
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

describe(`schema at boot (${dialectUnderTest})`, () => {
  test('boot syncs the files: the type exists, and a page renders through its template', async () => {
    const s = site('1.0.0', { 'schema/document-types/article.toml': ARTICLE('', true) })
    const h = await boot(s)
    expect(h.server.schema.report?.action).toBe('applied')
    expect(h.server.schema.nodeState).toEqual({ version: '1.0.0', revision: '1' })

    const type = await new ContentTypeRepository(h.server.db).byAlias('article')
    expect(type?.properties.map((p) => p.alias)).toEqual(['title', 'summary'])
    // The template row was created for the view; the view's content is on disk.
    const template = await new TemplateRepository(h.server.db).byAlias('article')
    expect(template?.key).toBe(type?.defaultTemplateKey as string)

    // Keys were written back into the file (development).
    const written = parseDocumentType(
      'article',
      readFileSync(join(s.schemaDir, 'document-types', 'article.toml'), 'utf8'),
    )
    expect(written.value?.key).toBe(type?.key)
    expect(written.value?.properties.map((p) => p.key)).toEqual(type?.properties.map((p) => p.key))

    const key = await createArticle(h, type?.key as string, 'Hello', {
      title: 'Hi',
      summary: 'there',
    })
    expect(
      (await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [{ culture: null }] }))
        .status,
    ).toBe(200)
    const page = await h.call('/')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<h1>Hi</h1>')
  })

  test('a document type created in the backoffice appears as a file, and is refused when read-only', async () => {
    const s = site('1.0.0', { 'schema/document-types/article.toml': ARTICLE('', false) })
    const h = await boot(s)
    const textstring = '0cc0eba1-9960-42c9-bf9b-60e150b429ae'
    const body = {
      alias: 'landingPage',
      name: 'Landing Page',
      icon: 'icon-home',
      description: 'From the backoffice',
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
          sortOrder: 0,
          alias: 'heading',
          name: 'Heading',
          description: null,
          dataType: { id: textstring },
          variesByCulture: false,
          variesBySegment: false,
          validation: { mandatory: true, mandatoryMessage: null, regEx: null, regExMessage: null },
          appearance: { labelOnTop: false },
        },
      ],
      containers: [],
      compositions: [],
      allowedDocumentTypes: [
        { documentType: { id: undefined as string | undefined }, sortOrder: 0 },
      ],
      allowedTemplates: [],
      defaultTemplate: null,
      parent: null,
    }
    const article = await new ContentTypeRepository(h.server.db).byAlias('article')
    body.allowedDocumentTypes[0] = { documentType: { id: article?.key }, sortOrder: 0 }
    const created = await h.post(`${V1}/document-type`, body)
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string

    const file = join(s.schemaDir, 'document-types', 'landing-page.toml')
    expect(existsSync(file)).toBe(true)
    const parsed = parseDocumentType('landing-page', readFileSync(file, 'utf8'))
    expect(parsed.problems).toEqual([])
    expect(parsed.value).toMatchObject({
      key,
      alias: 'landingPage',
      description: 'From the backoffice',
      allowChildren: ['article'],
    })
    expect(parsed.value?.properties[0]).toMatchObject({
      alias: 'heading',
      type: 'textstring',
      mandatory: true,
    })

    // Deleting it removes the file
    expect((await h.del(`${V1}/document-type/${key}`)).status).toBe(200)
    expect(existsSync(file)).toBe(false)

    // A read-only environment refuses with 409 and points at the file
    const prod = await boot(s, { development: false, keepDatabase: true, nodeId: 'prod-node' })
    const refused = await prod.post(`${V1}/document-type`, body)
    expect(refused.status).toBe(409)
    expect(await refused.text()).toContain('source control')
  })

  test('removing a type file while documents of it exist refuses to boot', async () => {
    const s = site('1.0.0', { 'schema/document-types/article.toml': ARTICLE('', false) })
    const h = await boot(s)
    const type = await new ContentTypeRepository(h.server.db).byAlias('article')
    await createArticle(h, type?.key as string, 'Kept', { title: 'x' })
    await h.db.close()
    open.pop()

    rmSync(join(s.schemaDir, 'document-types', 'article.toml'))
    writeFileSync(join(s.schemaDir, 'schema.toml'), '[schema]\nversion = "1.1.0"\n')
    const config = loadConfig({
      schemaDir: s.schemaDir,
      viewsDir: s.viewsDir,
      sqliteFile: s.sqliteFile,
      nodeId: 'test-node',
    })
    let failure: unknown
    try {
      const server = await createServer(config)
      await server.close()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SchemaBootError)
    expect((failure as Error).message).toContain('1 document(s)')
  })

  test('a broken file refuses to boot with its location', async () => {
    const s = site('1.0.0', {
      'schema/document-types/article.toml': ARTICLE('', false).replace('textstring', 'nope'),
    })
    let failure: unknown
    try {
      const server = await createServer(
        loadConfig({ schemaDir: s.schemaDir, viewsDir: s.viewsDir, sqliteFile: s.sqliteFile }),
      )
      await server.close()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SchemaBootError)
    expect((failure as Error).message).toContain('document-types/article')
    expect((failure as Error).message).toContain('unknown data type "nope"')
  })

  test.skipIf(dialectUnderTest !== 'postgres')(
    'two nodes on one database: newer files win, the older node reads, refuses writes, and sees publishes',
    async () => {
      const older = site('1.0.0', { 'schema/document-types/article.toml': ARTICLE('', false) })
      const a = await boot(older, { nodeId: 'node-a', revision: '1' })
      const typeKey = (await new ContentTypeRepository(a.server.db).byAlias('article'))
        ?.key as string
      const key = await createArticle(a, typeKey, 'Shared', { title: 'v1' })
      expect(
        (await a.put(`${V1}/document/${key}/publish`, { publishSchedules: [{ culture: null }] }))
          .status,
      ).toBe(200)
      expect(await (await a.call('/')).text()).toContain('v1')

      // Node B deploys newer files onto the same database
      const newer = site('1.1.0', { 'schema/document-types/article.toml': ARTICLE('', true) })
      const b = await boot(newer, { nodeId: 'node-b', revision: '1', keepDatabase: true })
      expect(b.server.schema.report?.action).toBe('applied')
      expect(b.server.schema.compatibilityMode).toBe(false)

      // Node A still reads every page it did, but may not write
      expect((await a.call(`${V1}/document/${key}`)).status).toBe(200)
      expect((await a.call('/')).status).toBe(200)
      const template = await new TemplateRepository(a.server.db).byAlias('article')
      const rejected = await a.put(`${V1}/document/${key}`, {
        template: { id: template?.key },
        values: [{ alias: 'title', culture: null, segment: null, value: 'from a' }],
        variants: [{ culture: null, segment: null, name: 'Shared' }],
      })
      expect(rejected.status).toBe(409)

      // Node B edits and publishes; node A's cache is stale until it polls
      const updated = await b.put(`${V1}/document/${key}`, {
        template: { id: template?.key },
        values: [
          { alias: 'title', culture: null, segment: null, value: 'v2' },
          { alias: 'summary', culture: null, segment: null, value: 'new field' },
        ],
        variants: [{ culture: null, segment: null, name: 'Shared' }],
      })
      expect(updated.status).toBe(200)
      expect(
        (await b.put(`${V1}/document/${key}/publish`, { publishSchedules: [{ culture: null }] }))
          .status,
      ).toBe(200)
      expect(await (await a.call('/')).text()).toContain('v1')
      expect(await a.server.poll()).toBeGreaterThan(0)
      expect(await (await a.call('/')).text()).toContain('v2')

      // A restarted node A with the same old files runs in compatibility mode
      const a2 = await boot(older, { nodeId: 'node-a', revision: '1', keepDatabase: true })
      expect(a2.server.schema.report?.action).toBe('skipped-older')
      expect(a2.server.schema.compatibilityMode).toBe(true)
    },
  )
})
