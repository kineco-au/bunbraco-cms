/**
 * Forms, phase 2 (`docs/18-forms.md`): entries in the database, keyed by the
 * form's UUID because the definition is a file.
 *
 * The exit: an entry survives the deletion of the form that produced it, and a
 * sensitive field's value never leaves the server for a reader without the
 * permission.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FormEntryRepository } from '@bunbraco/data'
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

const FORM_KEY = '9c4a7d1e-0001-4b2a-9f31-6d8e2c5a7b40'
const OTHER_KEY = '9c4a7d1e-00ff-4b2a-9f31-6d8e2c5a7b40'
const FORMS_API = `${BACKOFFICE}/bunbraco/api/forms`

const CONTACT = `[form]
key = "${FORM_KEY}"
alias = "contactUs"
name = "Contact us"

[[page]]
caption = "Your details"

  [[page.group]]

    [[page.group.field]]
    alias = "email"
    type = "email"
    caption = "Email address"
    mandatory = true

    [[page.group.field]]
    alias = "topics"
    type = "multipleChoice"
    caption = "Topics"
    values = ["Sales", "Support"]

    [[page.group.field]]
    alias = "orderNumber"
    type = "shortAnswer"
    caption = "Order number"
    sensitive = true
`

/** A site with a forms directory, so the routes read real definitions. */
async function site(forms: Record<string, string> = { 'contact-us.toml': CONTACT }) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'forms-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'forms'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  for (const [name, source] of Object.entries(forms))
    writeFileSync(join(root, 'schema', 'forms', name), source)
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      mediaDir: join(root, 'media'),
    },
  })
  open.push(h)
  return { h, root }
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  formKey: FORM_KEY,
  formAlias: 'contactUs',
  culture: 'en-US',
  pageKey: null,
  ipHash: 'hashed',
  userAgent: 'test',
  values: [
    { fieldAlias: 'email', values: ['someone@example.com'] },
    { fieldAlias: 'topics', values: ['Sales', 'Support'] },
    { fieldAlias: 'orderNumber', values: ['A-1234'] },
  ],
  ...overrides,
})

describe('the entry repository (sqlite and postgres)', () => {
  test('an entry round trips, with a multi-value field kept in order', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())

    expect(created.state).toBe('submitted')
    expect(created.spam).toBe(false)
    const read = await entries.byId(created.id)
    expect(read?.formAlias).toBe('contactUs')
    expect(read?.culture).toBe('en-US')
    expect(read?.values.find((v) => v.fieldAlias === 'topics')?.values).toEqual([
      'Sales',
      'Support',
    ])
  })

  test('an answered-with-nothing field is recorded, which is not the same as absent', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry({ values: [{ fieldAlias: 'email', values: [] }] }))
    const read = await entries.byId(created.id)
    expect(read?.values).toEqual([{ fieldAlias: 'email', values: [''] }])
  })

  test('the list is newest first, filtered by state and by date', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const first = await entries.create(entry())
    const second = await entries.create(entry())
    await entries.setState(first.id, 'approved')

    const all = await entries.list({ formKey: FORM_KEY })
    expect(all.total).toBe(2)
    const approved = await entries.list({ formKey: FORM_KEY, state: 'approved' })
    expect(approved.items.map((e) => e.id)).toEqual([first.id])
    const submitted = await entries.list({ formKey: FORM_KEY, state: 'submitted' })
    expect(submitted.items.map((e) => e.id)).toEqual([second.id])

    const future = await entries.list({ formKey: FORM_KEY, from: new Date(Date.now() + 60_000) })
    expect(future.total).toBe(0)
    const past = await entries.list({ formKey: FORM_KEY, to: new Date(Date.now() + 60_000) })
    expect(past.total).toBe(2)
  })

  test('entries of another form are not in this one, even on the same site', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    await entries.create(entry())
    await entries.create(entry({ formKey: OTHER_KEY, formAlias: 'other' }))
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(1)
    expect((await entries.list({ formKey: OTHER_KEY })).total).toBe(1)
  })

  test('the search box matches any value', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    await entries.create(entry())
    await entries.create(
      entry({ values: [{ fieldAlias: 'email', values: ['someone-else@example.com'] }] }),
    )
    expect((await entries.list({ formKey: FORM_KEY, search: 'A-1234' })).total).toBe(1)
    expect((await entries.list({ formKey: FORM_KEY, search: 'example.com' })).total).toBe(2)
    expect((await entries.list({ formKey: FORM_KEY, search: 'nothing' })).total).toBe(0)
  })

  test('spam is kept and flagged, and hidden from the list rather than dropped', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry({ spam: true }))
    // A false positive that silently discarded an enquiry would be worse than
    // one to review, so the row is there to find.
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(0)
    expect((await entries.list({ formKey: FORM_KEY, includeSpam: true })).total).toBe(1)
    expect(await entries.count(FORM_KEY)).toBe(0)
    expect(await entries.count(FORM_KEY, { includeSpam: true })).toBe(1)

    await entries.setSpam(created.id, false)
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(1)
  })

  test('paging reports the whole total, not the page', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    for (let i = 0; i < 3; i++) await entries.create(entry())
    const page = await entries.list({ formKey: FORM_KEY, take: 2 })
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(2)
    const second = await entries.list({ formKey: FORM_KEY, skip: 2, take: 2 })
    expect(second.items).toHaveLength(1)
  })

  test('approving and rejecting move the state and the update date', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())
    const approved = await entries.setState(created.id, 'approved')
    expect(approved?.state).toBe('approved')
    const rejected = await entries.setState(created.id, 'rejected')
    expect(rejected?.state).toBe('rejected')
    expect(rejected?.updateDate.getTime()).toBeGreaterThanOrEqual(created.createDate.getTime())
  })

  test('a state change or delete on an entry that is gone says so', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    expect(
      await entries.setState('11111111-1111-1111-1111-111111111111', 'approved'),
    ).toBeUndefined()
    expect(await entries.setSpam('11111111-1111-1111-1111-111111111111', true)).toBeUndefined()
    expect(await entries.remove('11111111-1111-1111-1111-111111111111')).toBe(false)
  })

  test('editing an entry replaces its values rather than adding to them', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())
    const updated = await entries.setValues(created.id, [
      { fieldAlias: 'email', values: ['corrected@example.com'] },
    ])
    expect(updated?.values).toEqual([{ fieldAlias: 'email', values: ['corrected@example.com'] }])
  })

  test('deleting an entry takes its values with it', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())
    expect(await entries.remove(created.id)).toBe(true)
    expect(await entries.byId(created.id)).toBeUndefined()
    const orphans = await h.server.db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM form_entry_value WHERE entry_id = ?',
      [created.id],
    )
    expect(Number(orphans[0]?.n)).toBe(0)
  })

  test('an entry outlives the form file, because it is the business record', async () => {
    const { h, root } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())
    // The definition is a file; removing it must not take the submissions.
    rmSync(join(root, 'schema', 'forms', 'contact-us.toml'))
    const read = await entries.byId(created.id)
    expect(read?.formKey).toBe(FORM_KEY)
    expect(read?.formAlias).toBe('contactUs')
    const forms = await entries.forms()
    expect(forms).toEqual([{ formKey: FORM_KEY, formAlias: 'contactUs', total: 1 }])
  })
})

describe('the forms endpoints', () => {
  test('the list is what the picker reads, summarised', async () => {
    const { h } = await site()
    const body = await h.json<{ items: Record<string, unknown>[] }>(FORMS_API)
    expect(body.items).toEqual([
      {
        key: FORM_KEY,
        alias: 'contactUs',
        name: 'Contact us',
        fieldCount: 3,
        pageCount: 1,
        storeEntries: true,
        requiresApproval: false,
        workflowCount: 0,
      },
    ])
  })

  test('a definition is read by key, and an unknown one is a 404', async () => {
    const { h } = await site()
    const detail = await h.json<{ alias: string; fields: Array<{ alias: string }> }>(
      `${FORMS_API}/${FORM_KEY}`,
    )
    expect(detail.alias).toBe('contactUs')
    expect(detail.fields.map((f) => f.alias)).toEqual(['email', 'topics', 'orderNumber'])
    expect((await h.call(`${FORMS_API}/${OTHER_KEY}`)).status).toBe(404)
  })

  test('the endpoints need a session', async () => {
    const { h } = await site()
    const anonymous = await h.server.fetch(new Request(`${ORIGIN}${FORMS_API}`))
    expect(anonymous.status).toBe(401)
  })

  test('entries are listed, and the list reflects a state change made through the API', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())

    const listed = await h.json<{ total: number; items: Array<{ id: string; state: string }> }>(
      `${FORMS_API}/${FORM_KEY}/entries`,
    )
    expect(listed.total).toBe(1)
    expect(listed.items[0]?.state).toBe('submitted')

    const changed = await h.post(`${FORMS_API}/entries/${created.id}/state`, {
      state: 'approved',
    })
    expect(changed.status).toBe(200)
    const again = await h.json<{ items: Array<{ state: string }> }>(
      `${FORMS_API}/${FORM_KEY}/entries?state=approved`,
    )
    expect(again.items[0]?.state).toBe('approved')
  })

  test('a state that is not one of the three is refused', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())
    const response = await h.post(`${FORMS_API}/entries/${created.id}/state`, { state: 'maybe' })
    expect(response.status).toBe(400)
  })

  test('an entry can be deleted through the API, and deleting it twice is a 404', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())
    expect((await h.del(`${FORMS_API}/entries/${created.id}`)).status).toBe(200)
    expect((await h.del(`${FORMS_API}/entries/${created.id}`)).status).toBe(404)
  })

  test('a sensitive value never leaves the server for a reader without the permission', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())

    // The admin is in the sensitive-data group, so they see it.
    const asAdmin = await h.json<{
      values: Array<{ fieldAlias: string; values: string[]; redacted: boolean }>
    }>(`${FORMS_API}/entries/${created.id}`)
    const order = asAdmin.values.find((v) => v.fieldAlias === 'orderNumber')
    expect(order?.values).toEqual(['A-1234'])
    expect(order?.redacted).toBe(false)

    // A reader who may see entries but not sensitive ones: the entry verbs
    // without `Bunbraco.FormEntry.Sensitive`. No built-in group is that — the seeded
    // admin carries every form verb — so the group is made here, as a real site
    // would.
    const group = await h.post(`${V1}/user-group`, {
      name: 'Entry readers',
      alias: 'entryReaders',
      sections: ['Bunbraco.Section.Forms'],
      languages: [],
      hasAccessToAllLanguages: true,
      documentRootAccess: true,
      documentStartNode: null,
      mediaRootAccess: true,
      mediaStartNode: null,
      elementRootAccess: false,
      elementStartNode: null,
      fallbackPermissions: ['Bunbraco.Form.Read', 'Bunbraco.FormEntry.Read'],
      permissions: [],
    })
    expect(group.status).toBe(201)
    const editor = await signInAsGroup(h, 'entryReaders')
    const asEditor = await editor.json<{
      values: Array<{ fieldAlias: string; values: string[]; redacted: boolean }>
    }>(`${FORMS_API}/entries/${created.id}`)
    const hidden = asEditor.values.find((v) => v.fieldAlias === 'orderNumber')
    expect(hidden?.redacted).toBe(true)
    expect(hidden?.values).toEqual([])
    const body = await editor.call(`${FORMS_API}/entries/${created.id}`).then((r) => r.text())
    expect(body).not.toContain('A-1234')
    // The rest of the entry is still readable.
    expect(asEditor.values.find((v) => v.fieldAlias === 'email')?.values).toEqual([
      'someone@example.com',
    ])
  })

  test('reading entries asks for more than a session', async () => {
    const { h } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())
    // `writer` holds Content and not Settings; submissions are personal data.
    const writer = await signInAsGroup(h, 'writer')
    expect((await writer.call(`${FORMS_API}/${FORM_KEY}/entries`)).status).toBe(403)
    expect((await writer.call(`${FORMS_API}/entries/${created.id}`)).status).toBe(403)
    expect((await writer.del(`${FORMS_API}/entries/${created.id}`)).status).toBe(403)
    // The definitions are structure, so any backoffice user may read them.
    expect((await writer.call(FORMS_API)).status).toBe(200)
  })

  test('an entry of a form that is gone still reads, with its values', async () => {
    const { h, root } = await site()
    const entries = new FormEntryRepository(h.server.db)
    const created = await entries.create(entry())
    rmSync(join(root, 'schema', 'forms', 'contact-us.toml'))

    const read = await h.json<{
      formAlias: string
      values: Array<{ fieldAlias: string; values: string[]; redacted: boolean }>
    }>(`${FORMS_API}/entries/${created.id}`)
    expect(read.formAlias).toBe('contactUs')
    // With no definition there is nothing marked sensitive, so nothing is
    // redacted — the reader here is an admin who may see it either way.
    expect(read.values.find((v) => v.fieldAlias === 'orderNumber')?.values).toEqual(['A-1234'])
  })

  test('a broken form file fails the boot, as any other broken schema file does', async () => {
    // Deliberate, and the same rule as a malformed document type: the files are
    // the schema, so a site does not start half-configured. The message names
    // the file and the key, which is what makes it fixable.
    let message = ''
    try {
      await site({ 'broken.toml': '[form]\nalias = "b"\n' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('schema/ has problems')
    expect(message).toContain('schema/forms/broken.toml: form.name: is required')
  })
})
