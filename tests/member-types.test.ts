/**
 * Member types: the same table, rules and files as document and media types —
 * `schema/member-types/*.toml` under `[member-type]` — with no templates,
 * cleanup or allowed children, and per-property visibility and sensitivity.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_MEMBER_TYPE } from '@bunbraco/data'
import { parseDocumentType, parseMemberType, validateSchemaSet } from '@bunbraco/schema'
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

async function site(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'member-types-'))
  dirs.push(root)
  for (const dir of ['document-types', 'member-types'])
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

function property(
  alias: string,
  name: string,
  visibility: { memberCanView: boolean; memberCanEdit: boolean },
  isSensitive = false,
) {
  return {
    id: crypto.randomUUID(),
    container: null,
    sortOrder: 0,
    alias,
    name,
    description: null,
    dataType: { id: TEXTSTRING },
    variesByCulture: false,
    variesBySegment: false,
    validation: { mandatory: false, mandatoryMessage: null, regEx: null, regExMessage: null },
    appearance: { labelOnTop: false },
    isSensitive,
    visibility,
  }
}

/** What the member-type workspace posts. */
function memberType(alias: string, overrides: Record<string, unknown> = {}) {
  return {
    alias,
    name: alias.charAt(0).toUpperCase() + alias.slice(1),
    icon: 'icon-user',
    description: null,
    allowedAsRoot: false,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collection: null,
    properties: [] as unknown[],
    containers: [],
    compositions: [] as unknown[],
    parent: null as { id: string } | null,
    ...overrides,
  }
}

async function create(h: Harness, body: Record<string, unknown>): Promise<string> {
  const response = await h.post(`${V1}/member-type`, body)
  if (response.status !== 201)
    throw new Error(`member type: ${response.status} ${await response.text()}`)
  return response.headers.get('umb-generated-resource') as string
}

type MemberTypeResponse = {
  alias: string
  name: string
  compositions: Array<{ memberType: { id: string }; compositionType: string }>
  properties: Array<{
    alias: string
    isSensitive: boolean
    visibility: { memberCanView: boolean; memberCanEdit: boolean }
  }>
}

describe('member types', () => {
  test("saving one keeps each property's visibility and sensitivity, and writes its file", async () => {
    const { h, schemaDir } = await site()
    const key = await create(
      h,
      memberType('customer', {
        properties: [
          property('nickname', 'Nickname', { memberCanView: true, memberCanEdit: true }),
          property(
            'creditLimit',
            'Credit limit',
            { memberCanView: true, memberCanEdit: false },
            true,
          ),
          property('notes', 'Notes', { memberCanView: false, memberCanEdit: false }),
        ],
      }),
    )
    const read = await h.json<MemberTypeResponse & Record<string, unknown>>(
      `${V1}/member-type/${key}`,
    )
    expect(read).toMatchObject({ alias: 'customer', name: 'Customer' })
    for (const absent of [
      'allowedTemplates',
      'cleanup',
      'allowedDocumentTypes',
      'allowedMediaTypes',
    ])
      expect(read).not.toHaveProperty(absent)
    expect(read.properties.map((p) => [p.alias, p.visibility, p.isSensitive])).toEqual([
      ['nickname', { memberCanView: true, memberCanEdit: true }, false],
      ['creditLimit', { memberCanView: true, memberCanEdit: false }, true],
      ['notes', { memberCanView: false, memberCanEdit: false }, false],
    ])

    const file = join(schemaDir, 'member-types', 'customer.toml')
    const source = readFileSync(file, 'utf8')
    expect(source.startsWith('[member-type]\n')).toBe(true)
    const parsed = parseMemberType('customer', source)
    expect(parsed.problems).toEqual([])
    expect(
      parsed.value?.properties.map((p) => [
        p.alias,
        p.memberCanView === true,
        p.memberCanEdit === true,
        p.sensitive === true,
      ]),
    ).toEqual([
      ['nickname', true, true, false],
      ['creditLimit', true, false, true],
      ['notes', false, false, false],
    ])

    // Update changes a flag; delete removes the file
    const updated = await h.put(
      `${V1}/member-type/${key}`,
      memberType('customer', {
        properties: [
          property('nickname', 'Nickname', { memberCanView: true, memberCanEdit: false }),
        ],
      }),
    )
    expect(updated.status).toBe(200)
    const after = await h.json<MemberTypeResponse>(`${V1}/member-type/${key}`)
    expect(after.properties.map((p) => p.visibility)).toEqual([
      { memberCanView: true, memberCanEdit: false },
    ])
    expect((await h.del(`${V1}/member-type/${key}`)).status).toBe(200)
    expect(existsSync(file)).toBe(false)
  })

  test('compositions, tree, items, search, folders and configuration; apart from other kinds', async () => {
    const { h, schemaDir } = await site()
    const contact = await create(
      h,
      memberType('contactDetails', {
        properties: [property('phone', 'Phone', { memberCanView: true, memberCanEdit: true })],
      }),
    )
    const customer = await create(
      h,
      memberType('customer', {
        compositions: [{ memberType: { id: contact }, compositionType: 'Composition' }],
      }),
    )
    expect(
      (await h.json<MemberTypeResponse>(`${V1}/member-type/${customer}`)).compositions,
    ).toEqual([{ memberType: { id: contact }, compositionType: 'Composition' }])
    expect(
      (
        await h.json<Array<{ id: string }>>(`${V1}/member-type/${contact}/composition-references`)
      ).map((r) => r.id),
    ).toEqual([customer])

    const tree = await h.json<{ items: Array<{ id: string; isFolder: boolean }> }>(
      `${V1}/tree/member-type/root?skip=0&take=10`,
    )
    // The framework's own "Member" type is always there, alongside the site's.
    expect(tree.items.map((i) => i.id).sort()).toEqual(
      [contact, customer, SYSTEM_MEMBER_TYPE.key].sort(),
    )
    expect(
      await h.json<Array<Record<string, unknown>>>(`${V1}/item/member-type?id=${customer}`),
    ).toEqual([{ id: customer, name: 'Customer', icon: 'icon-user', flags: [] }])
    const search = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/item/member-type/search?query=cust&skip=0&take=10`,
    )
    expect(search.items.map((i) => i.id)).toEqual([customer])
    expect(await h.json<Record<string, unknown>>(`${V1}/member-type/configuration`)).toEqual({
      reservedFieldNames: expect.any(Array),
    })

    const folder = await h.post(`${V1}/member-type/folder`, { name: 'Shop', parent: null })
    expect(folder.status).toBe(201)
    const shop = folder.headers.get('umb-generated-resource') as string
    expect(
      (await h.put(`${V1}/member-type/${customer}/move`, { target: { id: shop } })).status,
    ).toBe(200)
    expect(
      parseMemberType('x', readFileSync(join(schemaDir, 'member-types', 'customer.toml'), 'utf8'))
        .value?.folder,
    ).toBe('Shop')

    // Not a document type, and the member-type contract has no allowed children
    expect((await h.call(`${V1}/document-type/${customer}`)).status).toBe(404)
    expect((await h.call(`${V1}/member-type/${customer}/allowed-children`)).status).toBe(404)
  })

  test('a member type defined in a file syncs at boot; visibility keys belong to member types only', async () => {
    const { h } = await site({
      'schema/member-types/partner.toml':
        '[member-type]\nkey = "0b1c8e3a-8888-4a5b-9c1d-000000000001"\nalias = "partner"\nname = "Partner"\nicon = "icon-user"\n\n[[property]]\nkey = "0b1c8e3a-8888-4a5b-9c1d-000000000002"\nalias = "company"\nname = "Company"\ntype = "textstring"\nmember-can-view = true\nsensitive = true\n',
    })
    const read = await h.json<MemberTypeResponse>(
      `${V1}/member-type/0b1c8e3a-8888-4a5b-9c1d-000000000001`,
    )
    expect(read.properties.map((p) => [p.alias, p.visibility, p.isSensitive])).toEqual([
      ['company', { memberCanView: true, memberCanEdit: false }, true],
    ])

    expect(
      parseMemberType(
        'x',
        '[member-type]\nalias = "x"\nname = "X"\nallow-children = ["y"]\n',
      ).problems.map((p) => p.message),
    ).toEqual([expect.stringContaining('unknown key')])
    const onDocument = parseDocumentType(
      'page',
      '[document-type]\nalias = "page"\nname = "Page"\n\n[[property]]\nalias = "t"\nname = "T"\ntype = "textstring"\nsensitive = true\n',
    )
    expect(onDocument.problems).toEqual([])
    const problems = validateSchemaSet({
      version: '1.0.0',
      documentTypes: [onDocument.value as NonNullable<typeof onDocument.value>],
      dataTypes: [],
      languages: [],
    })
    expect(problems.map((p) => p.message)).toEqual([
      'member-can-view, member-can-edit and sensitive belong to member types',
    ])
  })
})
