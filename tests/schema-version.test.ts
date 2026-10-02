/**
 * The site's schema version, moved by what a change costs the content.
 *
 * It is not decoration: `compareStates` reads the version first, so it is how
 * other nodes learn they are behind, and a production sync refuses a changed hash
 * at an unchanged version. A major means content had to be converted to get here.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository, DataTypeRepository } from '@bunbraco/data'
import { nextSchemaVersion } from '@bunbraco/schema'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const dirs: string[] = []
const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('what a classification does to the version', () => {
  test('breaking is a major, and resets what is below it', () => {
    expect(nextSchemaVersion('1.4.2', 'breaking')).toBe('2.0.0')
  })

  test('additive and data-requiring are minors', () => {
    expect(nextSchemaVersion('1.4.2', 'additive')).toBe('1.5.0')
    expect(nextSchemaVersion('1.4.2', 'data-requiring')).toBe('1.5.0')
  })

  test('nothing to apply moves nothing', () => {
    expect(nextSchemaVersion('1.4.2', 'none')).toBe('1.4.2')
  })

  test('a short or malformed version still yields a whole one', () => {
    expect(nextSchemaVersion('1', 'additive')).toBe('1.1.0')
    expect(nextSchemaVersion('', 'breaking')).toBe('1.0.0')
  })
})

const TYPE = {
  alias: 'article',
  name: 'Article',
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
  properties: [] as unknown[],
  containers: [] as unknown[],
  compositions: [],
  allowedDocumentTypes: [],
  allowedTemplates: [],
  defaultTemplate: null,
  parent: null,
}

/** A writable schema directory and a server over it. */
async function site() {
  const schemaDir = mkdtempSync(join(process.cwd(), 'output', 'schema-version-'))
  dirs.push(schemaDir)
  mkdirSync(join(schemaDir, 'document-types'), { recursive: true })
  writeFileSync(join(schemaDir, 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  const h = await signedInServer({ config: { schemaDir, schemaWritable: true } })
  open.push(h)
  return { h, schemaDir }
}

const version = (schemaDir: string) =>
  /version = "([^"]+)"/.exec(readFileSync(join(schemaDir, 'schema.toml'), 'utf8'))?.[1]

describe('a change made through the backoffice', () => {
  test('creating a type is a minor', async () => {
    const { h, schemaDir } = await site()
    expect((await h.post(`${V1}/document-type`, TYPE)).status).toBe(201)
    expect(version(schemaDir)).toBe('1.1.0')
  })

  test('changing a property editor under live content is a major', async () => {
    const { h, schemaDir } = await site()
    const dataTypes = new DataTypeRepository(h.server.db)
    const textstring = await dataTypes.byAlias('textstring')
    const textarea = await dataTypes.byAlias('textarea')
    expect(textstring && textarea).toBeTruthy()

    const property = {
      id: crypto.randomUUID(),
      container: null,
      alias: 'body',
      name: 'Body',
      description: null,
      dataType: { id: textstring?.key },
      variesByCulture: false,
      variesBySegment: false,
      sortOrder: 0,
      validation: { mandatory: false, mandatoryMessage: null, regEx: null, regExMessage: null },
      appearance: { labelOnTop: false },
    }
    const created = await h.post(`${V1}/document-type`, { ...TYPE, properties: [property] })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    const after = version(schemaDir)

    // Content using the property is what makes the editor change breaking.
    const made = await h.post(`${V1}/document`, {
      documentType: { id: key },
      template: null,
      parent: null,
      values: [{ culture: null, segment: null, alias: 'body', value: 'Something' }],
      variants: [{ culture: null, segment: null, name: 'An article' }],
    })
    expect(made.status).toBe(201)

    const changed = await h.put(`${V1}/document-type/${key}`, {
      ...TYPE,
      properties: [{ ...property, dataType: { id: textarea?.key } }],
    })
    expect(changed.status).toBe(200)

    expect(version(schemaDir)).toBe('2.0.0')
    expect(after).toBe('1.1.0')
  })

  test('the same change with no content is only a minor', async () => {
    const { h, schemaDir } = await site()
    const dataTypes = new DataTypeRepository(h.server.db)
    const textstring = await dataTypes.byAlias('textstring')
    const textarea = await dataTypes.byAlias('textarea')

    const property = {
      id: crypto.randomUUID(),
      container: null,
      alias: 'body',
      name: 'Body',
      description: null,
      dataType: { id: textstring?.key },
      variesByCulture: false,
      variesBySegment: false,
      sortOrder: 0,
      validation: { mandatory: false, mandatoryMessage: null, regEx: null, regExMessage: null },
      appearance: { labelOnTop: false },
    }
    const created = await h.post(`${V1}/document-type`, { ...TYPE, properties: [property] })
    const key = created.headers.get('umb-generated-resource') as string

    const changed = await h.put(`${V1}/document-type/${key}`, {
      ...TYPE,
      properties: [{ ...property, dataType: { id: textarea?.key } }],
    })
    expect(changed.status).toBe(200)

    // Nothing to convert, so nothing breaking: 1.1.0 for the create, 1.2.0 here.
    expect(version(schemaDir)).toBe('1.2.0')
    expect((await new ContentTypeRepository(h.server.db).byAlias('article'))?.key).toBe(key)
  })

  test('saving a type unchanged moves nothing', async () => {
    const { h, schemaDir } = await site()
    const created = await h.post(`${V1}/document-type`, TYPE)
    const key = created.headers.get('umb-generated-resource') as string
    expect(version(schemaDir)).toBe('1.1.0')

    expect((await h.put(`${V1}/document-type/${key}`, TYPE)).status).toBe(200)
    expect(version(schemaDir)).toBe('1.1.0')
  })
})
