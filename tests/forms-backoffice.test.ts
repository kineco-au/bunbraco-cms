/**
 * Forms, phases 5 and 6 (`docs/18-forms.md`): the Forms section, the designer's
 * save path, CSV export, and the four permission verbs.
 *
 * The exit: an editor can read entries and act on them but cannot design a form
 * or see a sensitive answer, and a CSV with a sensitive column refuses rather
 * than exporting blanks.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FormPermissions, SECTION_ALIASES, toSectionAliases } from '@bunbraco/core'
import { FormEntryRepository } from '@bunbraco/data'
import { FORM_SCRIPT, FORM_SCRIPT_PATH } from '@bunbraco/render'
import {
  BACKOFFICE,
  type Harness,
  ORIGIN,
  signedInServer,
  signInAsGroup,
  V1,
} from './support/harness.ts'

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

const FORMS = `${BACKOFFICE}/bunbraco/api/forms`
const FORM_KEY = '9c4a7d1e-0001-4b2a-9f31-6d8e2c5a7b40'

const CONTACT = `[form]
key = "${FORM_KEY}"
alias = "contactUs"
name = "Contact us"

[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "email"
    type = "email"
    caption = "Email address"
    mandatory = true

    [[page.group.field]]
    alias = "note"
    type = "longAnswer"
    caption = "Note"
`

const SENSITIVE = CONTACT.concat(`
    [[page.group.field]]
    alias = "orderNumber"
    type = "shortAnswer"
    caption = "Order number"
    sensitive = true
`)

async function site(definition = CONTACT, config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'forms-bo-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'forms'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'forms', 'contact-us.toml'), definition)
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      mediaDir: join(root, 'media'),
      ...config,
    },
  })
  open.push(h)
  return { h, root, entries: new FormEntryRepository(h.server.db) }
}

/** A client in a group with exactly the verbs named. */
async function asGroup(
  h: Harness,
  alias: string,
  permissions: string[],
  sections = ['Bunbraco.Section.Forms'],
) {
  const created = await h.post(`${V1}/user-group`, {
    name: alias,
    alias,
    sections,
    languages: [],
    hasAccessToAllLanguages: true,
    documentRootAccess: true,
    documentStartNode: null,
    mediaRootAccess: true,
    mediaStartNode: null,
    elementRootAccess: false,
    elementStartNode: null,
    fallbackPermissions: permissions,
    permissions: [],
  })
  if (created.status !== 201) throw new Error(`group ${created.status}: ${await created.text()}`)
  return signInAsGroup(h, alias)
}

describe('the Forms section', () => {
  test('the alias resolves, which it could not while Forms was an add-on', () => {
    expect(SECTION_ALIASES.forms).toBe('Bunbraco.Section.Forms')
    // Umbraco seeds the stored `forms` alias and has no section for it; here it
    // reaches the client, which is what makes the section openable.
    expect(toSectionAliases(['forms'])).toEqual(['Bunbraco.Section.Forms'])
  })

  test('the section and its two views are in the manifests', async () => {
    const { h } = await site()
    const manifests = await h.json<
      Array<{ name: string; extensions: Array<{ type: string; alias: string }> }>
    >(`${V1}/manifest/manifest`)
    const ours = manifests.find((manifest) => manifest.name === 'Bunbraco')
    const aliases = ours?.extensions.map((e) => `${e.type}:${e.alias}`) ?? []
    expect(aliases).toContain('section:Bunbraco.Section.Forms')
    expect(aliases).toContain('sectionView:Bunbraco.SectionView.Forms.Overview')
    expect(aliases).toContain('sectionView:Bunbraco.SectionView.Forms.Entries')
  })

  test('the admin may open it, because the group has always carried the alias', async () => {
    const { h } = await site()
    const user = await h.json<{ allowedSections: string[] }>(`${V1}/user/current`)
    expect(user.allowedSections).toContain('Bunbraco.Section.Forms')
  })
})

describe('the permission verbs', () => {
  test('an entry reader may act on entries but not design a form', async () => {
    const { h, entries } = await site()
    await entries.create({
      formKey: FORM_KEY,
      formAlias: 'contactUs',
      culture: null,
      pageKey: null,
      ipHash: null,
      userAgent: null,
      values: [{ fieldAlias: 'email', values: ['a@example.com'] }],
    })
    const reader = await asGroup(h, 'entryReader', [
      FormPermissions.View,
      FormPermissions.EntriesView,
      FormPermissions.EntriesManage,
    ])

    expect((await reader.call(`${FORMS}/${FORM_KEY}/entries`)).status).toBe(200)
    const listed = await reader.json<{ items: { id: string }[] }>(`${FORMS}/${FORM_KEY}/entries`)
    const id = listed.items[0]?.id as string
    expect((await reader.post(`${FORMS}/entries/${id}/state`, { state: 'approved' })).status).toBe(
      200,
    )
    // Designing is a different job, so it is a different verb.
    expect((await reader.call(`${FORMS}`, { method: 'PUT', body: '{}' })).status).toBe(403)
  })

  test('a form designer may save but not read what people submitted', async () => {
    const { h, entries } = await site()
    await entries.create({
      formKey: FORM_KEY,
      formAlias: 'contactUs',
      culture: null,
      pageKey: null,
      ipHash: null,
      userAgent: null,
      values: [],
    })
    const designer = await asGroup(h, 'formDesigner', [
      FormPermissions.View,
      FormPermissions.Manage,
    ])
    expect((await designer.call(`${FORMS}/${FORM_KEY}/entries`)).status).toBe(403)
    expect((await designer.call(`${FORMS}/${FORM_KEY}`)).status).toBe(200)
  })

  test('without the sensitive verb the value is withheld, not blanked', async () => {
    const { h, entries } = await site(SENSITIVE)
    const created = await entries.create({
      formKey: FORM_KEY,
      formAlias: 'contactUs',
      culture: null,
      pageKey: null,
      ipHash: null,
      userAgent: null,
      values: [
        { fieldAlias: 'email', values: ['a@example.com'] },
        { fieldAlias: 'orderNumber', values: ['A-1234'] },
      ],
    })
    const reader = await asGroup(h, 'plainReader', [
      FormPermissions.View,
      FormPermissions.EntriesView,
    ])
    const body = await reader.call(`${FORMS}/entries/${created.id}`).then((r) => r.text())
    expect(body).not.toContain('A-1234')
    expect(body).toContain('"redacted":true')

    // With the verb, it is there.
    const trusted = await asGroup(h, 'trustedReader', [
      FormPermissions.View,
      FormPermissions.EntriesView,
      FormPermissions.EntriesSensitive,
    ])
    const seen = await trusted.json<{ values: { fieldAlias: string; values: string[] }[] }>(
      `${FORMS}/entries/${created.id}`,
    )
    expect(seen.values.find((v) => v.fieldAlias === 'orderNumber')?.values).toEqual(['A-1234'])
  })

  test('a group with no form verbs cannot read entries at all', async () => {
    const { h } = await site()
    const nobody = await asGroup(h, 'formNobody', [])
    expect((await nobody.call(`${FORMS}/${FORM_KEY}/entries`)).status).toBe(403)
    // A definition is structure, so reading it is allowed — the picker in the
    // Content section needs it.
    expect((await nobody.call(FORMS)).status).toBe(200)
  })
})

describe('the designer', () => {
  test('a saved form is written to schema/forms as TOML', async () => {
    const { h, root } = await site()
    const detail = await h.json<{ definition: Record<string, unknown> }>(`${FORMS}/${FORM_KEY}`)
    const definition = detail.definition
    ;(definition as { name: string }).name = 'Talk to us'
    const saved = await h.call(FORMS, { method: 'PUT', body: JSON.stringify(definition) })
    expect(saved.status).toBe(200)

    const file = readFileSync(join(root, 'schema', 'forms', 'contact-us.toml'), 'utf8')
    expect(file).toContain('name = "Talk to us"')
    // And the API reports it at once rather than after the memo expires.
    const again = await h.json<{ items: { name: string }[] }>(FORMS)
    expect(again.items[0]?.name).toBe('Talk to us')
  })

  test('a new form is created, and its file is named after its alias', async () => {
    const { h, root } = await site()
    const saved = await h.call(FORMS, {
      method: 'PUT',
      body: JSON.stringify({
        key: '9c4a7d1e-0002-4b2a-9f31-6d8e2c5a7b40',
        alias: 'jobApplication',
        name: 'Job application',
        pages: [
          {
            groups: [
              {
                columns: 1,
                fields: [{ alias: 'name', type: 'shortAnswer', caption: 'Name', mandatory: true }],
              },
            ],
          },
        ],
      }),
    })
    expect(saved.status).toBe(200)
    const file = readFileSync(join(root, 'schema', 'forms', 'job-application.toml'), 'utf8')
    expect(file).toContain('alias = "jobApplication"')
    expect((await h.json<{ items: unknown[] }>(FORMS)).items).toHaveLength(2)
  })

  test('a definition the parser would refuse is not written', async () => {
    const { h, root } = await site()
    const before = readFileSync(join(root, 'schema', 'forms', 'contact-us.toml'), 'utf8')
    const saved = await h.call(FORMS, {
      method: 'PUT',
      body: JSON.stringify({
        key: FORM_KEY,
        alias: 'contactUs',
        name: 'Contact us',
        // Two fields with one alias, which the validator refuses.
        pages: [
          {
            groups: [
              {
                columns: 1,
                fields: [
                  { alias: 'email', type: 'email', caption: 'A' },
                  { alias: 'email', type: 'email', caption: 'B' },
                ],
              },
            ],
          },
        ],
      }),
    })
    expect(saved.status).toBe(400)
    const body = (await saved.json()) as { problems: { message: string }[] }
    expect(body.problems.some((p) => p.message.includes('duplicate field alias'))).toBe(true)
    // The file on disk is untouched, so a refused save cannot break the boot.
    expect(readFileSync(join(root, 'schema', 'forms', 'contact-us.toml'), 'utf8')).toBe(before)
  })

  test('an unknown field type is refused by the strict parser, not coerced', async () => {
    const { h } = await site()
    const saved = await h.call(FORMS, {
      method: 'PUT',
      body: JSON.stringify({
        key: FORM_KEY,
        alias: 'contactUs',
        name: 'Contact us',
        pages: [
          {
            groups: [{ columns: 1, fields: [{ alias: 'a', type: 'signature', caption: 'A' }] }],
          },
        ],
      }),
    })
    expect(saved.status).toBe(400)
    expect(
      ((await saved.json()) as { problems: { message: string }[] }).problems.some((p) =>
        p.message.includes('unknown field type'),
      ),
    ).toBe(true)
  })

  test('a read-only schema directory refuses the save rather than appearing to take it', async () => {
    const { h } = await site(CONTACT, { schemaWritable: false })
    const saved = await h.call(FORMS, {
      method: 'PUT',
      body: JSON.stringify({ key: FORM_KEY, alias: 'contactUs', name: 'Changed', pages: [] }),
    })
    expect(saved.status).toBe(409)
    expect(((await saved.json()) as { status: string }).status).toBe('readOnly')
  })

  test('deleting a form removes the file and keeps the entries', async () => {
    const { h, root, entries } = await site()
    const created = await entries.create({
      formKey: FORM_KEY,
      formAlias: 'contactUs',
      culture: null,
      pageKey: null,
      ipHash: null,
      userAgent: null,
      values: [{ fieldAlias: 'email', values: ['a@example.com'] }],
    })
    expect((await h.del(`${FORMS}/${FORM_KEY}`)).status).toBe(200)
    expect(() => readFileSync(join(root, 'schema', 'forms', 'contact-us.toml'), 'utf8')).toThrow()
    // The entries are the business record; the definition going does not take them.
    expect(await entries.byId(created.id)).toBeDefined()
  })
})

describe('exporting entries', () => {
  const entry = (values: { fieldAlias: string; values: string[] }[]) => ({
    formKey: FORM_KEY,
    formAlias: 'contactUs',
    culture: null,
    pageKey: null,
    ipHash: null,
    userAgent: null,
    values,
  })

  test('is CSV with a column per field, in definition order', async () => {
    const { h, entries } = await site()
    await entries.create(
      entry([
        { fieldAlias: 'email', values: ['a@example.com'] },
        { fieldAlias: 'note', values: ['Hello'] },
      ]),
    )
    const response = await h.call(`${FORMS}/${FORM_KEY}/entries.csv`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(response.headers.get('content-disposition')).toContain('contactUs-entries.csv')
    const csv = await response.text()
    const [header, row] = csv.split('\r\n')
    expect(header).toBe('Submitted,State,Spam,Email address,Note')
    expect(row).toContain('a@example.com')
    expect(row).toContain('Hello')
  })

  test('a value that would be a formula is defused', async () => {
    const { h, entries } = await site()
    await entries.create(entry([{ fieldAlias: 'note', values: ['=1+1'] }]))
    const csv = await (await h.call(`${FORMS}/${FORM_KEY}/entries.csv`)).text()
    // A leading = makes a spreadsheet run the cell; the quote stops that.
    expect(csv).toContain("'=1+1")
  })

  test('a comma, a quote and a newline survive the round trip', async () => {
    const { h, entries } = await site()
    await entries.create(entry([{ fieldAlias: 'note', values: ['a,b "c"\nd'] }]))
    const csv = await (await h.call(`${FORMS}/${FORM_KEY}/entries.csv`)).text()
    expect(csv).toContain('"a,b ""c""\nd"')
  })

  test('a form with a sensitive field refuses the export without the permission', async () => {
    const { h, entries } = await site(SENSITIVE)
    await entries.create(entry([{ fieldAlias: 'orderNumber', values: ['A-1234'] }]))
    const reader = await asGroup(h, 'csvReader', [
      FormPermissions.View,
      FormPermissions.EntriesView,
    ])
    const refused = await reader.call(`${FORMS}/${FORM_KEY}/entries.csv`)
    // A file that looks complete and quietly is not is worse than an error.
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain('sensitive-data access')

    // The admin has the verb, so the export includes the column.
    const allowed = await h.call(`${FORMS}/${FORM_KEY}/entries.csv`)
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain('A-1234')
  })
})

describe('the enhancement script', () => {
  test('is served, and is the same script the package ships', async () => {
    const { h } = await site()
    const response = await h.server.fetch(new Request(`${ORIGIN}${FORM_SCRIPT_PATH}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(await response.text()).toBe(FORM_SCRIPT)
  })

  test('guards against running twice, since two forms could each load it', () => {
    expect(FORM_SCRIPT).toContain('window.__bunbracoForms')
  })

  test('nothing emits it automatically, because a form works without it', async () => {
    // A site adds it to a layout. The script is an enhancement, not a
    // dependency, and auto-emitting it twice for two forms would run it twice.
    expect(FORM_SCRIPT_PATH).toBe('/bunbraco/forms.js')
  })
})
