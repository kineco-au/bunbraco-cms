/**
 * Story 090: a choice field's options drawn from a list kept once — a page's
 * children, or a dictionary item's — resolved the same way at render, at
 * submission and in the designer. docs/forms.md, "Choices from a source".
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  choiceOptions,
  FORM_RENDERED_FIELD,
  FORM_TOKEN_FIELD,
  type SchemaForm,
  type SchemaFormField,
  validateSubmission,
  withResolvedChoices,
} from '@crombolo/core'
import { ComponentRepository, ContentTypeRepository, FormEntryRepository } from '@crombolo/data'
import { Form } from '@crombolo/render'
import { parseForm, validateForms, writeForm } from '@crombolo/schema'
import { BACKOFFICE, type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

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

const FORM_KEY = '9c4a7d1e-0090-4b2a-9f31-6d8e2c5a7b90'
const DEPARTMENTS = '6f1d4a8e-0090-4c1a-9e7d-0000000000d0'

const field = (overrides: Partial<SchemaFormField> & { alias: string }): SchemaFormField => ({
  type: 'dropdown',
  caption: overrides.alias,
  mandatory: false,
  sensitive: false,
  values: [],
  accept: [],
  ...overrides,
})

const formOf = (fields: SchemaFormField[]): SchemaForm => ({
  key: FORM_KEY,
  alias: 'enquiry',
  name: 'Enquiry',
  storeEntries: true,
  requiresApproval: false,
  honeypot: true,
  pages: [{ groups: [{ columns: 1, fields }] }],
  workflows: [],
})

const DEFINITION = `[form]
key = "${FORM_KEY}"
alias = "enquiry"
name = "Enquiry"

[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "department"
    type = "dropdown"
    caption = "Department"
    source = { kind = "content", parent = "${DEPARTMENTS}" }

    [[page.group.field]]
    alias = "region"
    type = "multipleChoice"
    caption = "Region"
    source = { kind = "dictionary", parent = "Regions" }
`

describe('a source in the file', () => {
  test('round-trips, and stands in for values', () => {
    const parsed = parseForm('schema/forms/enquiry.toml', DEFINITION)
    expect(parsed.problems).toEqual([])
    const definition = parsed.value as SchemaForm
    expect(definition.pages[0]?.groups[0]?.fields.map((f) => f.source)).toEqual([
      { kind: 'content', parent: DEPARTMENTS },
      { kind: 'dictionary', parent: 'Regions' },
    ])
    const written = writeForm(definition)
    expect(written).toContain(`source = { kind = "content", parent = "${DEPARTMENTS}" }`)
    expect(parseForm('x', written).value).toEqual(definition)
    expect(validateForms([definition])).toEqual([])
  })

  test('the validator refuses a source with values, an unknown kind by name, and a bad parent', () => {
    const problems = (subject: SchemaFormField) =>
      validateForms([formOf([subject])]).map((problem) => problem.message)
    expect(
      problems(
        field({ alias: 'a', values: ['x'], source: { kind: 'dictionary', parent: 'Regions' } }),
      ),
    ).toContain('a field takes its choices from values or from a source, not both')
    expect(
      problems(field({ alias: 'a', source: { kind: 'url' as never, parent: 'https://x' } })),
    ).toContain('"url" is not a kind of source; expected one of content, dictionary')
    expect(problems(field({ alias: 'a', source: { kind: 'content', parent: 'News' } }))).toContain(
      'a content source names its parent page by key',
    )
    expect(
      problems(
        field({
          alias: 'a',
          type: 'shortAnswer',
          source: { kind: 'content', parent: DEPARTMENTS },
        }),
      ),
    ).toContain('a shortAnswer field has nothing to choose from')
    expect(problems(field({ alias: 'a' }))).toContain(
      'a dropdown field needs values to choose from',
    )
  })

  test('a typo in the source table is refused by name', () => {
    const parsed = parseForm(
      'x',
      DEFINITION.replace('parent = "Regions"', 'parent = "Regions", sort = "name"'),
    )
    expect(JSON.stringify(parsed.problems)).toContain('source.sort')
  })
})

describe('resolved options', () => {
  const sourced = formOf([
    field({ alias: 'department', source: { kind: 'content', parent: DEPARTMENTS } }),
  ])
  const resolved = withResolvedChoices(sourced, () => [
    { value: 'k-sales', label: 'Sales' },
    { value: 'k-support', label: 'Support' },
  ])

  test('render a key as the value and the name as the label', () => {
    const markup = String(Form({ form: resolved, token: 'T', renderedAt: 1 }).value)
    expect(markup).toContain('<option value="k-sales">Sales</option>')
    expect(markup).toContain('<option value="k-support">Support</option>')
    // Unresolved, a source offers nothing rather than guessing.
    expect(choiceOptions(sourced.pages[0]?.groups[0]?.fields[0] as SchemaFormField)).toEqual([])
  })

  test('validate against the current list, and keep what the visitor saw', () => {
    const ok = validateSubmission(resolved, { department: ['k-support'] })
    expect(ok.errors).toEqual([])
    expect(ok.values).toEqual([
      { fieldAlias: 'department', values: ['k-support'], labels: ['Support'] },
    ])
    const outside = validateSubmission(resolved, { department: ['Support'] })
    expect(outside.errors.map((error) => error.message)).toEqual([
      'department is not one of the choices',
    ])
  })
})

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'forms-sources-'))
  dirs.push(root)
  for (const dir of ['schema/content-types', 'schema/forms', 'components'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(
    join(root, 'schema', 'content-types', 'page.toml'),
    `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "form"
name = "Form"
type = "formPicker"
`,
  )
  writeFileSync(join(root, 'schema', 'forms', 'enquiry.toml'), DEFINITION)
  writeFileSync(
    join(root, 'components', 'page.tsx'),
    `import { Form } from '@crombolo/crombolo'
export default function Page({ model, submission }) {
  const form = model.value('form')
  return <main>{form ? <Form form={form} submission={submission} /> : model.name}</main>
}
`,
  )
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      mediaDir: join(root, 'media'),
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const page = async (
    name: string,
    options: { id?: string; parent?: string; form?: boolean } = {},
  ) => {
    const created = await h.post(`${V1}/document`, {
      ...(options.id ? { id: options.id } : {}),
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: options.parent ? { id: options.parent } : null,
      values: options.form
        ? [{ alias: 'form', culture: null, segment: null, value: FORM_KEY }]
        : [],
      variants: [{ culture: null, segment: null, name }],
    })
    if (created.status !== 201) throw new Error(`create ${created.status}: ${await created.text()}`)
    const key = created.headers.get('umb-generated-resource') as string
    await h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
    return key
  }
  const dictionary = async (name: string, translation: string, parent?: string) => {
    const created = await h.post(`${V1}/dictionary`, {
      name,
      parent: parent ? { id: parent } : null,
      translations: translation ? [{ isoCode: 'en-US', translation }] : [],
    })
    if (created.status !== 201)
      throw new Error(`dictionary ${created.status}: ${await created.text()}`)
    return created.headers.get('umb-generated-resource') as string
  }

  const contact = await page('Contact', { form: true })
  await page('Departments', { id: DEPARTMENTS })
  const sales = await page('Sales', { parent: DEPARTMENTS })
  const support = await page('Support', { parent: DEPARTMENTS })
  const regions = await dictionary('Regions', '')
  const north = await dictionary('Regions.North', 'The North', regions)
  const south = await dictionary('Regions.South', '', regions)

  const rendered = async () => {
    const response = await h.server.fetch(new Request(`${ORIGIN}/`))
    expect(response.status).toBe(200)
    const markup = await response.text()
    return {
      markup,
      token: /name="_crombolo_token" value="([^"]+)"/.exec(markup)?.[1] as string,
      at: /name="_crombolo_at" value="([^"]+)"/.exec(markup)?.[1] as string,
    }
  }
  const post = async (values: Record<string, string[]>) => {
    const { token, at } = await rendered()
    const body = new FormData()
    for (const [name, list] of Object.entries(values))
      for (const one of list) body.append(name, one)
    body.set(FORM_TOKEN_FIELD, token)
    body.set(FORM_RENDERED_FIELD, at)
    return h.server.fetch(
      new Request(`${ORIGIN}/crombolo/forms/${FORM_KEY}`, {
        method: 'POST',
        body,
        headers: { referer: `${ORIGIN}/`, accept: 'application/json' },
      }),
    )
  }
  return { h, contact, sales, support, north, south, rendered, post }
}

describe('a form whose choices come from the site', () => {
  test('renders, validates and stores the current list, and an entry outlives a rename', async () => {
    const { h, sales, support, north, south, rendered, post } = await site()
    const { markup } = await rendered()
    expect(markup).toContain(`<option value="${sales}">Sales</option>`)
    expect(markup).toContain(`<option value="${support}">Support</option>`)
    expect(markup).toContain(`value="${north}"`)
    expect(markup).toContain('The North')
    // An item with no translation is shown by its name.
    expect(markup).toContain('Regions.South')

    expect((await post({ department: ['Sales'] })).status).toBe(422)
    const accepted = await post({ department: [support], region: [north, south] })
    expect(accepted.status).toBe(200)

    const entries = new FormEntryRepository(h.server.db)
    const [entry] = (await entries.list({ formKey: FORM_KEY })).items
    expect(entry?.values).toEqual([
      { fieldAlias: 'department', values: [support], labels: ['Support'] },
      { fieldAlias: 'region', values: [north, south], labels: ['The North', 'Regions.South'] },
    ])

    // Renamed: the next visitor sees the new name; the entry keeps what was chosen.
    const detail = await h.json<{ values: unknown[]; variants: Array<{ name: string }> }>(
      `${V1}/document/${support}`,
    )
    await h.put(`${V1}/document/${support}`, {
      ...detail,
      variants: [{ culture: null, segment: null, name: 'Customer care' }],
    })
    await h.put(`${V1}/document/${support}/publish`, { publishSchedules: [] })
    expect((await rendered()).markup).toContain(`<option value="${support}">Customer care</option>`)
    const again = await entries.byId(entry?.id as string)
    expect(again?.values[0]?.labels).toEqual(['Support'])
    expect(await entries.list({ formKey: FORM_KEY, search: 'support' })).toMatchObject({ total: 1 })

    const csv = await h.call(`${BACKOFFICE}/crombolo/api/forms/${FORM_KEY}/entries.csv`)
    expect(await csv.text()).toContain('Support')
  })

  test('the designer edits a source and shows what it offers now', async () => {
    const { h, sales, support } = await site()
    const preview = await h.post(`${BACKOFFICE}/crombolo/api/forms/choices`, {
      source: { kind: 'content', parent: DEPARTMENTS },
    })
    expect(await preview.json()).toEqual({
      options: [
        { value: sales, label: 'Sales' },
        { value: support, label: 'Support' },
      ],
    })
    expect(
      (
        await h.post(`${BACKOFFICE}/crombolo/api/forms/choices`, {
          source: { kind: 'url', parent: 'https://x' },
        })
      ).status,
    ).toBe(400)

    const { definition } = await h.json<{ definition: SchemaForm }>(
      `${BACKOFFICE}/crombolo/api/forms/${FORM_KEY}`,
    )
    const region = definition.pages[0]?.groups[0]?.fields[1] as SchemaFormField
    region.source = { kind: 'dictionary', parent: 'Nowhere' }
    expect((await h.put(`${BACKOFFICE}/crombolo/api/forms`, definition)).status).toBe(200)
    const saved = await h.json<{ definition: SchemaForm }>(
      `${BACKOFFICE}/crombolo/api/forms/${FORM_KEY}`,
    )
    expect(saved.definition.pages[0]?.groups[0]?.fields[1]?.source).toEqual({
      kind: 'dictionary',
      parent: 'Nowhere',
    })
    region.values = ['North']
    const both = await h.put(`${BACKOFFICE}/crombolo/api/forms`, definition)
    expect(both.status).toBe(400)
    expect(JSON.stringify(await both.json())).toContain('not both')
  })
})
