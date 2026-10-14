/**
 * Story 048: the rest of the contract — dynamic roots, document patches,
 * is-used, object types, help, the static-file picker and leaving preview —
 * and a coverage report that accounts for every operation still answering 501.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createManagementApiRouter,
  DELIBERATE_DIVERGENCES,
  PLANNED_AREAS,
  PLANNED_OPERATIONS,
} from '@crombolo/api-management'
import { createBackOfficePaths, createExtensionRegistry } from '@crombolo/backoffice-host'
import { applyJsonPatch } from '@crombolo/core'
import {
  ComponentRepository,
  ContentTypeRepository,
  connect,
  cromboloPlan,
  migrate,
} from '@crombolo/data'
import { PublishedCache } from '@crombolo/render'
import { createDeps, createPublishedContentSource, loadConfig } from '@crombolo/server'
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

const VIEW = 'export default function View({ model }) { return <main>{model.name}</main> }\n'

const type = (alias: string, name: string) => `[content-type]
alias = "${alias}"
name = "${name}"
allow-at-root = true
allow-children = ["site", "section"]
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"

[[property]]
alias = "summary"
name = "Summary"
type = "textarea"
`

async function scaffold() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'crombolo-rest-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  mkdirSync(join(root, 'css', 'theme'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'site.toml'), type('site', 'Site'))
  writeFileSync(join(root, 'schema', 'content-types', 'section.toml'), type('section', 'Section'))
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  writeFileSync(join(root, 'css', 'theme', 'grid.css'), '.grid {}')
  writeFileSync(join(root, 'css', 'notes.txt'), 'not served')
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      stylesheetsDir: join(root, 'css'),
      scriptsDir: join(root, 'scripts'),
    },
  })
  open.push(h)
  const types = new ContentTypeRepository(h.server.db)
  const site = (await types.byAlias('site'))?.key as string
  const section = (await types.byAlias('section'))?.key as string
  const component = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const create = async (
    typeKey: string,
    name: string,
    parent: string | null = null,
    values: Array<{ alias: string; value: unknown }> = [],
  ) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: component },
      parent: parent ? { id: parent } : null,
      values: values.map((value) => ({ culture: null, segment: null, ...value })),
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  return { h, site, section, create }
}

describe('JSON Patch with filter segments', () => {
  const doc = {
    values: [
      { alias: 'title', culture: 'en-US', segment: null, value: 'Hello' },
      { alias: 'title', culture: 'da-DK', segment: null, value: 'Hej' },
    ],
    variants: [{ culture: 'en-US', segment: null, name: 'Home' }],
  }

  test('replaces, adds and removes through filters, indexes and appends', () => {
    const result = applyJsonPatch(doc, [
      {
        op: 'replace',
        path: '/values[alias=title,culture=da-DK,segment=null]/value',
        value: 'Hej!',
      },
      {
        op: 'add',
        path: '/values/-',
        value: { alias: 'summary', culture: null, segment: null, value: 'x' },
      },
      { op: 'remove', path: '/values/0' },
      { op: 'replace', path: '/variants[culture=en-US,segment=NULL]/name', value: 'Start' },
    ])
    expect(result).toEqual({
      ok: true,
      value: {
        values: [
          { alias: 'title', culture: 'da-DK', segment: null, value: 'Hej!' },
          { alias: 'summary', culture: null, segment: null, value: 'x' },
        ],
        variants: [{ culture: 'en-US', segment: null, name: 'Start' }],
      },
    })
    expect(doc.values[1]?.value).toBe('Hej')
  })

  test('refuses a bad path, an unmatched filter, a missing value and an unknown op', () => {
    const reasons = [
      { op: 'replace', path: 'values', value: 1 },
      { op: 'replace', path: '/values[alias=title,culture=en-us,segment=null]/value', value: 1 },
      { op: 'replace', path: '/values[alias=title/value', value: 1 },
      { op: 'replace', path: '/values/9', value: 1 },
      { op: 'replace', path: '/values/-', value: 1 },
      { op: 'replace', path: '/variants/0/name' },
      { op: 'move', path: '/variants/0/name', value: 1 },
    ].map((operation) => applyJsonPatch(doc, [operation]))
    expect(reasons.every((result) => !result.ok)).toBe(true)
  })
})

describe('the rest of the contract', () => {
  test('a document patch changes one value and the name, and saves as a PUT would', async () => {
    const { h, site, create } = await scaffold()
    const key = await create(site, 'Home', null, [
      { alias: 'title', value: 'Welcome' },
      { alias: 'summary', value: 'Kept' },
    ])
    const patch = (operations: unknown[]) =>
      h.call(`${V1}/document/${key}/patch`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json-patch+json' },
        body: JSON.stringify({ operations }),
      })
    expect(
      (
        await patch([
          {
            op: 'replace',
            path: '/values[alias=title,culture=null,segment=null]/value',
            value: 'Hi',
          },
          { op: 'replace', path: '/variants[culture=null,segment=null]/name', value: 'Start' },
        ])
      ).status,
    ).toBe(200)
    const after = await h.json<{
      values: Array<{ alias: string; value: unknown }>
      variants: Array<{ name: string }>
    }>(`${V1}/document/${key}`)
    expect(Object.fromEntries(after.values.map((v) => [v.alias, v.value]))).toEqual({
      title: 'Hi',
      summary: 'Kept',
    })
    expect(after.variants[0]?.name).toBe('Start')

    const unmatched = await patch([
      { op: 'replace', path: '/values[alias=nothing,culture=null,segment=null]/value', value: 1 },
    ])
    expect(unmatched.status).toBe(400)
    const unknown = await patch([
      {
        op: 'add',
        path: '/values/-',
        value: { alias: 'nothing', culture: null, segment: null, value: 1 },
      },
    ])
    expect(unknown.status).toBe(422)
    expect((await patch([])).status).toBe(400)
    const missing = await h.call(`${V1}/document/${crypto.randomUUID()}/patch`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json-patch+json' },
      body: JSON.stringify({ operations: [{ op: 'remove', path: '/template' }] }),
    })
    expect(missing.status).toBe(404)
  })

  test('dynamic roots resolve a start node from an origin and steps', async () => {
    const { h, site, section, create } = await scaffold()
    const home = await create(site, 'Home')
    const news = await create(section, 'News', home)
    const sub = await create(site, 'Microsite', news)
    const deep = await create(section, 'Deep', sub)
    const other = await create(site, 'Other')
    expect(await h.json<unknown>(`${V1}/dynamic-root/steps`)).toEqual([
      'NearestAncestorOrSelf',
      'FurthestAncestorOrSelf',
      'NearestDescendantOrSelf',
      'FurthestDescendantOrSelf',
    ])
    const roots = async (
      origin: { alias: string; id?: string },
      steps: Array<{ alias: string; documentTypeIds: string[] }> = [],
      context: { id: string | null; parent: string } = { id: deep, parent: sub },
    ) => {
      const response = await h.post(`${V1}/dynamic-root/query`, {
        context: { id: context.id, parent: { id: context.parent } },
        query: { origin, steps },
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { roots: string[] }).roots
    }
    expect(await roots({ alias: 'Root' })).toEqual([home])
    expect(await roots({ alias: 'Parent' })).toEqual([sub])
    expect(await roots({ alias: 'Current' })).toEqual([deep])
    expect(await roots({ alias: 'ByKey', id: other })).toEqual([other])
    // Being created: no current node, so the parent stands in for it.
    expect(await roots({ alias: 'Current' }, [], { id: null, parent: sub })).toEqual([])
    expect(await roots({ alias: 'Root' }, [], { id: null, parent: sub })).toEqual([home])

    expect(
      await roots({ alias: 'Current' }, [
        { alias: 'NearestAncestorOrSelf', documentTypeIds: [site] },
      ]),
    ).toEqual([sub])
    expect(
      await roots({ alias: 'Current' }, [
        { alias: 'FurthestAncestorOrSelf', documentTypeIds: [site] },
      ]),
    ).toEqual([home])
    expect(
      await roots({ alias: 'Root' }, [
        { alias: 'NearestDescendantOrSelf', documentTypeIds: [section] },
      ]),
    ).toEqual([news])
    expect(
      await roots({ alias: 'Root' }, [
        { alias: 'FurthestDescendantOrSelf', documentTypeIds: [section] },
      ]),
    ).toEqual([deep])
    expect(
      await roots({ alias: 'ContentRoot' }, [
        { alias: 'NearestDescendantOrSelf', documentTypeIds: [site] },
      ]),
    ).toEqual([home, other])
    expect(
      await roots({ alias: 'Current' }, [
        { alias: 'NearestAncestorOrSelf', documentTypeIds: [crypto.randomUUID()] },
      ]),
    ).toEqual([])

    // A hostname makes the microsite its own site; without one, Site is the root.
    expect(await roots({ alias: 'Site' })).toEqual([home])
    const domains = await h.put(`${V1}/document/${sub}/domains`, {
      defaultIsoCode: null,
      domains: [{ domainName: 'micro.example.com', isoCode: 'en-US' }],
    })
    expect(domains.status).toBe(200)
    expect(await roots({ alias: 'Site' })).toEqual([sub])

    expect((await h.post(`${V1}/dynamic-root/query`, { context: {} })).status).toBe(400)
  })

  test('is-used answers from saved values, not from the schema', async () => {
    const { h, site, create } = await scaffold()
    const detail = await h.json<{
      properties: Array<{ alias: string; dataType: { id: string } }>
    }>(`${V1}/document-type/${site}`)
    const dataTypeOf = (alias: string) =>
      detail.properties.find((property) => property.alias === alias)?.dataType.id as string
    const used = (path: string) => h.json<boolean>(`${V1}/${path}`)

    expect(await used(`data-type/${dataTypeOf('summary')}/is-used`)).toBe(false)
    expect(await used(`property-type/is-used?contentTypeId=${site}&propertyAlias=summary`)).toBe(
      false,
    )
    await create(site, 'Home', null, [
      { alias: 'summary', value: 'Something' },
      { alias: 'title', value: '' },
    ])
    expect(await used(`data-type/${dataTypeOf('summary')}/is-used`)).toBe(true)
    expect(await used(`property-type/is-used?contentTypeId=${site}&propertyAlias=summary`)).toBe(
      true,
    )
    expect(await used(`property-type/is-used?contentTypeId=${site}&propertyAlias=title`)).toBe(
      false,
    )

    expect((await h.call(`${V1}/data-type/${crypto.randomUUID()}/is-used`)).status).toBe(404)
    expect(
      (await h.call(`${V1}/property-type/is-used?contentTypeId=${site}&propertyAlias=nothing`))
        .status,
    ).toBe(400)
  })

  test('the static-file picker offers the served stylesheets and scripts, by their URLs', async () => {
    const { h } = await scaffold()
    const tree = (path: string) =>
      h.json<{ total: number; items: Array<{ path: string; isFolder: boolean }> }>(`${V1}/${path}`)
    expect((await tree('tree/static-file/root?skip=0&take=10')).items).toEqual([
      expect.objectContaining({ name: 'css', path: '/css', parent: null, isFolder: true }),
    ])
    expect(
      (await tree('tree/static-file/children?parentPath=%2Fcss&skip=0&take=10')).items.map(
        (i) => i.path,
      ),
    ).toEqual(['/css/theme'])
    expect(
      (await tree('tree/static-file/children?parentPath=%2Fcss%2Ftheme&skip=0&take=10')).items,
    ).toEqual([
      expect.objectContaining({
        name: 'grid.css',
        path: '/css/theme/grid.css',
        parent: { path: '/css/theme' },
      }),
    ])
    expect(
      (
        await h.json<Array<{ path: string }>>(
          `${V1}/tree/static-file/ancestors?descendantPath=%2Fcss%2Ftheme%2Fgrid.css`,
        )
      ).map((item) => item.path),
    ).toEqual(['/css', '/css/theme', '/css/theme/grid.css'])
    expect(
      await h.json<unknown>(
        `${V1}/item/static-file?path=%2Fcss%2Ftheme%2Fgrid.css&path=%2Fcss%2Fnotes.txt&path=%2Fnowhere`,
      ),
    ).toEqual([
      {
        isFolder: false,
        name: 'grid.css',
        parent: { path: '/css/theme' },
        path: '/css/theme/grid.css',
      },
    ])
    // What it offers is what the site serves.
    expect((await h.call('/css/theme/grid.css')).status).toBe(200)
  })

  test('object types, help, template configuration and leaving preview', async () => {
    const { h } = await scaffold()
    const types = await h.json<{ total: number; items: Array<{ id: string; name: string }> }>(
      `${V1}/object-types?skip=0&take=100`,
    )
    expect(types.items).toContainEqual({
      id: 'c66ba18e-eaf3-4cff-8a22-41b16d66a972',
      name: 'Document',
    })
    expect(types.items).toContainEqual({
      id: 'a2cb7800-f571-4787-9638-bc48539a0efb',
      name: 'Document Type',
    })
    expect(types.items.some((item) => item.name === 'Lock Object')).toBe(false)
    expect(types.total).toBe(types.items.length)
    expect(await h.json<unknown>(`${V1}/help?section=content&skip=0&take=100`)).toEqual({
      total: 0,
      items: [],
    })
    expect(await h.json<unknown>(`${V1}/template/configuration`)).toEqual({ disabled: false })
    const leave = await h.del(`${V1}/preview`)
    expect(leave.status).toBe(200)
    expect(leave.headers.get('set-cookie')).toContain('UMB_PREVIEW=;')
  })

  test('every operation still answering 501 is a deliberate divergence or planned in a story', async () => {
    // As `coverage:api` builds it: the real composition root over a throwaway database.
    const db = await connect({ dialect: 'sqlite', file: ':memory:' })
    await migrate(db, cromboloPlan)
    const router = createManagementApiRouter({
      deps: createDeps({
        config: loadConfig(),
        paths: createBackOfficePaths(),
        extensions: createExtensionRegistry(join(process.cwd(), 'apps/site')),
        db,
        cache: new PublishedCache(createPublishedContentSource(db)),
      }),
    })
    await db.close()
    for (const id of Object.keys(DELIBERATE_DIVERGENCES)) expect(router.has(id)).toBe(false)
    const unaccounted = router.operations
      .filter(
        (op) =>
          !router.has(op.operationId) &&
          !DELIBERATE_DIVERGENCES[op.operationId] &&
          !PLANNED_OPERATIONS[op.operationId] &&
          !PLANNED_AREAS[op.area ?? ''],
      )
      .map((op) => op.operationId)
    expect(unaccounted).toEqual([])
  })
})
