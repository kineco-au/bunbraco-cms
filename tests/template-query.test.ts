/**
 * The template editor's query builder.
 *
 * Two endpoints Umbraco's client calls and this server used to answer 501 to.
 * What they return is this CMS's own language: the snippet is **TypeScript over
 * the render model**, not the Razor and LINQ upstream writes, because what it
 * gets pasted into is a `.tsx`.
 *
 * The count and the sample come from running the query, so a snippet that
 * promises three items is a snippet whose three items were counted.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { queryExpression } from '@bunbraco/api-management'
import { ContentTypeRepository } from '@bunbraco/data'
import { signedInServer, V1 } from './support/harness.ts'

const TYPES = `[document-type]
key = "7c1f0a62-0001-4a7e-8f21-5b2c9d4e6a01"
alias = "homePage"
name = "Home Page"
allow-at-root = true
allow-children = ["article"]
components = ["homePage"]
default-component = "homePage"

[[property]]
key = "7c1f0a62-0002-4a7e-8f21-5b2c9d4e6a01"
alias = "title"
name = "Title"
type = "textstring"
`

const ARTICLE = `[document-type]
key = "7c1f0a62-0003-4a7e-8f21-5b2c9d4e6a01"
alias = "article"
name = "Article"
components = ["article"]
default-component = "article"

[[property]]
key = "7c1f0a62-0004-4a7e-8f21-5b2c9d4e6a01"
alias = "title"
name = "Title"
type = "textstring"
`

const ELEMENT = `[document-type]
key = "7c1f0a62-0005-4a7e-8f21-5b2c9d4e6a01"
alias = "pullQuote"
name = "Pull Quote"
is-element = true
allow-in-library = true

[[property]]
key = "7c1f0a62-0006-4a7e-8f21-5b2c9d4e6a01"
alias = "quote"
name = "Quote"
type = "textstring"
`

const VIEW = `export default function View({ model }) {
  return <main>{model.name}</main>
}
`

/** A key the picker might send that no longer resolves. */
const MISSING = '7c1f0a62-1000-4a7e-8f21-5b2c9d4e6a01'

describe('the query builder', () => {
  const open: Array<{ db: { close(): Promise<void> } }> = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const h of open.splice(0)) await h.db.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function site() {
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    const root = mkdtempSync(join(process.cwd(), 'output', 'template-query-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(root, 'components'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(join(root, 'schema', 'document-types', 'home-page.toml'), TYPES)
    writeFileSync(join(root, 'schema', 'document-types', 'article.toml'), ARTICLE)
    writeFileSync(join(root, 'schema', 'document-types', 'pull-quote.toml'), ELEMENT)
    writeFileSync(join(root, 'components', 'homePage.tsx'), VIEW)
    writeFileSync(join(root, 'components', 'article.tsx'), VIEW)
    const h = await signedInServer({
      config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
    })
    open.push(h)
    return h
  }

  /** A home page with three published articles under it. */
  async function content(h: Awaited<ReturnType<typeof site>>) {
    const types = new ContentTypeRepository(h.server.db)
    const keyOf = async (alias: string) => (await types.byAlias(alias))?.key as string
    const create = async (typeAlias: string, name: string, parent: string | null) => {
      const response = await h.post(`${V1}/document`, {
        documentType: { id: await keyOf(typeAlias) },
        template: null,
        parent: parent ? { id: parent } : null,
        values: [{ culture: null, segment: null, alias: 'title', value: name }],
        variants: [{ culture: null, segment: null, name }],
      })
      if (response.status !== 201) throw new Error(`create failed ${response.status}`)
      const key = response.headers.get('umb-generated-resource') as string
      const published = await h.put(`${V1}/document/${key}/publish`, {
        publishSchedules: [{ culture: null }],
      })
      if (published.status !== 200) throw new Error(`publish failed ${published.status}`)
      return key
    }

    const home = await create('homePage', 'Home', null)
    for (const name of ['Alpha', 'Beta news', 'Gamma news']) await create('article', name, home)
    h.server.cache?.invalidate()
    return home
  }

  describe('what it offers to build with', () => {
    test('lists the routable types, the model’s fields and the operators', async () => {
      const h = await site()
      const settings = await h.json<{
        documentTypeAliases: string[]
        properties: Array<{ alias: string; type: string }>
        operators: Array<{ operator: string; applicableTypes: string[] }>
      }>(`${V1}/template/query/settings`)

      expect(settings.documentTypeAliases).toContain('homePage')
      expect(settings.documentTypeAliases).toContain('article')
      // An element type is never routed to, so a query cannot return one.
      expect(settings.documentTypeAliases).not.toContain('pullQuote')

      // The fields the render model actually exposes, not Umbraco's Razor set.
      expect(settings.properties.map((p) => p.alias)).toEqual([
        'Id',
        'Name',
        'CreateDate',
        'UpdateDate',
      ])
      const contains = settings.operators.find((o) => o.operator === 'Contains')
      expect(contains?.applicableTypes).toEqual(['String'])
      const lessThan = settings.operators.find((o) => o.operator === 'LessThan')
      expect(lessThan?.applicableTypes).toEqual(['DateTime', 'Integer'])
    })
  })

  describe('the snippet it writes', () => {
    test('is TypeScript against the render model, with no C# in it', () => {
      const expression = queryExpression({
        rootKey: null,
        documentTypeAlias: 'article',
        filters: [{ propertyAlias: 'Name', constraintValue: 'news', operator: 'Contains' }],
        sort: { propertyAlias: 'CreateDate', direction: 'descending' },
        take: 5,
      })
      expect(expression).toBe(
        [
          'const selection = nav.children(model)',
          "  .filter((item) => item.contentType.alias === 'article')",
          "  .filter((item) => item.name.includes('news'))",
          '  .sort((a, b) => b.createDate.getTime() - a.createDate.getTime())',
          '  .slice(0, 5)',
        ].join('\n'),
      )
      // The things Umbraco's builder would have written.
      expect(expression).not.toContain('Umbraco.')
      expect(expression).not.toContain('@{')
      expect(expression).not.toContain('var ')
    })

    test('starts at the document somebody picked, falling back to the page', () => {
      // `?? model` rather than a guard: a key that no longer resolves still
      // compiles and still renders something.
      const expression = queryExpression({
        rootKey: MISSING,
        documentTypeAlias: null,
        filters: [],
        sort: null,
        take: 10,
      })
      expect(expression).toContain(`nav.children(nav.byKey('${MISSING}') ?? model)`)
    })

    test('quotes a value that would otherwise end the string', () => {
      const expression = queryExpression({
        rootKey: null,
        documentTypeAlias: null,
        filters: [{ propertyAlias: 'Name', constraintValue: "O'Brien", operator: 'Equals' }],
        sort: null,
        take: 1,
      })
      expect(expression).toContain("item.name === 'O\\'Brien'")
    })

    test('compares a date as a number, which is how the model compares one', () => {
      const expression = queryExpression({
        rootKey: null,
        documentTypeAlias: null,
        filters: [
          {
            propertyAlias: 'CreateDate',
            constraintValue: '2026-01-01',
            operator: 'GreaterThan',
          },
        ],
        sort: null,
        take: 1,
      })
      expect(expression).toContain("item.createDate.getTime() > new Date('2026-01-01').getTime()")
    })
  })

  describe('running it', () => {
    test('counts what the snippet would return, and samples it', async () => {
      const h = await site()
      const home = await content(h)

      const response = await h.post(`${V1}/template/query/execute`, {
        rootDocument: { id: home },
        documentTypeAlias: 'article',
        filters: [{ propertyAlias: 'Name', constraintValue: 'news', operator: 'Contains' }],
        sort: { propertyAlias: 'Name', direction: 'ascending' },
        take: 10,
      })
      expect(response.status).toBe(200)
      const result = (await response.json()) as {
        queryExpression: string
        sampleResults: Array<{ icon: string; name: string }>
        resultCount: number
        executionTime: number
      }

      // Two of the three articles match, in the order the snippet sorts them.
      expect(result.resultCount).toBe(2)
      expect(result.sampleResults.map((s) => s.name)).toEqual(['Beta news', 'Gamma news'])
      expect(result.sampleResults.every((s) => s.icon.length > 0)).toBe(true)
      expect(result.executionTime).toBeGreaterThanOrEqual(0)
      expect(result.queryExpression).toContain('nav.children')
    })

    test('take limits the sample without hiding the count', async () => {
      const h = await site()
      const home = await content(h)
      const response = await h.post(`${V1}/template/query/execute`, {
        rootDocument: { id: home },
        documentTypeAlias: null,
        filters: [],
        sort: null,
        take: 1,
      })
      const result = (await response.json()) as {
        sampleResults: unknown[]
        resultCount: number
      }
      expect(result.sampleResults).toHaveLength(1)
      expect(result.resultCount).toBe(3)
    })

    test('a half-typed constraint filters nothing out rather than everything', async () => {
      const h = await site()
      const home = await content(h)
      const response = await h.post(`${V1}/template/query/execute`, {
        rootDocument: { id: home },
        documentTypeAlias: null,
        // What the builder sends while somebody is still typing the date.
        filters: [
          { propertyAlias: 'CreateDate', constraintValue: '2026-', operator: 'GreaterThan' },
        ],
        sort: null,
        take: 10,
      })
      expect(((await response.json()) as { resultCount: number }).resultCount).toBe(3)
    })
  })
})
