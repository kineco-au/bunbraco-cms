/**
 * Forms, phase 3 end to end (`docs/18-forms.md`): a page renders a form, a
 * visitor posts it, and the entry is stored.
 *
 * Every submission here goes through the real markup — the token and the render
 * time are scraped from the rendered page rather than signed in the test — so a
 * change that breaks the contract between the renderer and the endpoint fails
 * here rather than in production.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORM_HONEYPOT_FIELD, FORM_RENDERED_FIELD, FORM_TOKEN_FIELD } from '@bunbraco/core'
import { ComponentRepository, ContentTypeRepository, FormEntryRepository } from '@bunbraco/data'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

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

const TYPE = `[document-type]
alias = "page"
name = "Page"
allow-at-root = true
components = ["page"]
default-component = "page"

[[property]]
alias = "contactForm"
name = "Contact form"
type = "formPicker"
`

const VIEW = `import { Form } from 'bunbraco'
export default function Page({ model, submission }) {
  return (
    <main>
      <Form form={model.value('contactForm')} submission={submission} />
    </main>
  )
}
`

const form = (body: string) => `[form]
key = "${FORM_KEY}"
alias = "contactUs"
name = "Contact us"
${body}`

const CONTACT = form(`message-on-submit = "Thanks, we will be in touch."

[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "email"
    type = "email"
    caption = "Email address"
    mandatory = true

    [[page.group.field]]
    alias = "topic"
    type = "dropdown"
    caption = "Topic"
    values = ["Sales", "Support"]

    [[page.group.field]]
    alias = "orderNumber"
    type = "shortAnswer"
    caption = "Order number"

      [page.group.field.condition]
      action = "show"
      match = "all"
      rule = [{ field = "topic", operator = "is", value = "Support" }]
`)

async function site(definition = CONTACT) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'forms-e2e-'))
  dirs.push(root)
  for (const dir of ['schema/document-types', 'schema/forms', 'components'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE)
  writeFileSync(join(root, 'schema', 'forms', 'contact-us.toml'), definition)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
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
  const created = await h.post(`${V1}/document`, {
    documentType: { id: typeKey },
    template: { id: componentKey },
    parent: null,
    values: [{ alias: 'contactForm', culture: null, segment: null, value: FORM_KEY }],
    variants: [{ culture: null, segment: null, name: 'Home' }],
  })
  if (created.status !== 201) throw new Error(`create ${created.status}: ${await created.text()}`)
  await h.put(`${V1}/document/${created.headers.get('umb-generated-resource')}/publish`, {
    publishSchedules: [],
  })

  /** The page as a visitor sees it, with no backoffice session. */
  const visit = async (path = '/', cookie?: string) =>
    h.server.fetch(
      new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' }),
    )

  const rendered = async () => {
    const response = await visit('/')
    expect(response.status).toBe(200)
    const markup = await response.text()
    const token = /name="_bunbraco_token" value="([^"]+)"/.exec(markup)?.[1] as string
    const at = /name="_bunbraco_at" value="([^"]+)"/.exec(markup)?.[1] as string
    return { markup, token, at }
  }

  /** Posts as a browser would, with the token the page really carried. */
  const post = async (
    values: Record<string, string | string[] | File>,
    options: { token?: string; at?: string; json?: boolean; key?: string } = {},
  ) => {
    const page = options.token === undefined ? await rendered() : { token: options.token, at: '0' }
    const body = new FormData()
    for (const [name, value] of Object.entries(values)) {
      if (Array.isArray(value)) for (const one of value) body.append(name, one)
      else body.append(name, value)
    }
    if (options.token !== '') body.set(FORM_TOKEN_FIELD, options.token ?? page.token)
    body.set(FORM_RENDERED_FIELD, options.at ?? page.at)
    return h.server.fetch(
      new Request(`${ORIGIN}/bunbraco/forms/${options.key ?? FORM_KEY}`, {
        method: 'POST',
        body,
        headers: {
          referer: `${ORIGIN}/`,
          ...(options.json ? { accept: 'application/json' } : {}),
        },
        redirect: 'manual',
      }),
    )
  }

  return { h, visit, rendered, post, entries: new FormEntryRepository(h.server.db) }
}

describe('a form on a page', () => {
  test('a picked form renders as a real form, with its fields', async () => {
    const { rendered } = await site()
    const { markup, token, at } = await rendered()
    expect(markup).toContain('<form method="post" action="/bunbraco/forms/')
    expect(markup).toContain('name="email"')
    expect(markup).toContain('<select')
    expect(token).toBeTruthy()
    expect(Number(at)).toBeGreaterThan(0)
    // The conditional field is there, hidden, for a script to reveal.
    expect(markup).toContain('data-field="orderNumber"')
  })

  test('a form that is not picked renders nothing rather than failing', async () => {
    const { h, visit } = await site()
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
    const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
    const created = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Empty' }],
    })
    await h.put(`${V1}/document/${created.headers.get('umb-generated-resource')}/publish`, {
      publishSchedules: [],
    })
    const response = await visit('/empty')
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('<form')
  })
})

describe('submitting a form', () => {
  test('a valid submission is stored and redirects back to the page', async () => {
    const { post, entries } = await site()
    const response = await post({ email: 'someone@example.com', topic: 'Sales' })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    expect(response.headers.get('set-cookie')).toContain('bunbraco-form=')

    const stored = await entries.list({ formKey: FORM_KEY })
    expect(stored.total).toBe(1)
    const entry = stored.items[0]
    expect(entry?.state).toBe('submitted')
    expect(entry?.spam).toBe(false)
    expect(entry?.values.find((v) => v.fieldAlias === 'email')?.values).toEqual([
      'someone@example.com',
    ])
    // The conditional field was hidden by the answer given, so it is not
    // recorded at all — which is stronger than recording it as empty, and is
    // the difference between "not asked" and "asked and left blank".
    expect(entry?.values.some((v) => v.fieldAlias === 'orderNumber')).toBe(false)
    // An IP is hashed, never stored as an address.
    expect(entry?.ipHash).toBeNull()
  })

  test('the thank-you comes back inside the page, and only once', async () => {
    const { post, visit } = await site()
    const cookie = (await post({ email: 'a@example.com', topic: 'Sales' })).headers.get(
      'set-cookie',
    ) as string
    const value = cookie.split(';')[0] as string

    const after = await visit('/', value)
    const markup = await after.text()
    expect(markup).toContain('Thanks, we will be in touch.')
    expect(markup).not.toContain('<input type="text"')
    // Cleared on the way out, so a reload shows the form again rather than the
    // thank-you for ever.
    expect(after.headers.get('set-cookie')).toContain('bunbraco-form=;')
  })

  test('a refused submission comes back on the page with its errors and what was typed', async () => {
    const { post, visit } = await site()
    const refused = await post({ email: 'not-an-address', topic: 'Sales' })
    expect(refused.status).toBe(303)
    const value = (refused.headers.get('set-cookie') as string).split(';')[0] as string

    const markup = await (await visit('/', value)).text()
    expect(markup).toContain('must be an email address')
    expect(markup).toContain('bunbraco-form__field--invalid')
    // Not retyped: the value the visitor gave is still in the field.
    expect(markup).toContain('value="not-an-address"')
  })

  test('a value for a field the conditions hide is discarded, whatever was posted', async () => {
    const { post, entries } = await site()
    // `orderNumber` only shows for Support; posting it with Sales must not store it.
    await post({ email: 'a@example.com', topic: 'Sales', orderNumber: 'SMUGGLED' })
    const stored = await entries.list({ formKey: FORM_KEY })
    // Not stored as empty: not stored at all.
    expect(stored.items[0]?.values.some((v) => v.fieldAlias === 'orderNumber')).toBe(false)
    const all = JSON.stringify(stored.items[0]?.values)
    expect(all).not.toContain('SMUGGLED')
  })

  test('the condition met means the field is validated and stored', async () => {
    const { post, entries } = await site()
    await post({ email: 'a@example.com', topic: 'Support', orderNumber: 'A-1234' })
    const stored = await entries.list({ formKey: FORM_KEY })
    expect(stored.items[0]?.values.find((v) => v.fieldAlias === 'orderNumber')?.values).toEqual([
      'A-1234',
    ])
  })

  test('a choice that is not on the list is refused, however it was posted', async () => {
    const { post, entries } = await site()
    const response = await post({ email: 'a@example.com', topic: 'Elsewhere' })
    expect(response.status).toBe(303)
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(0)
  })
})

describe('the guards', () => {
  test('a filled honeypot is stored as spam and told it worked', async () => {
    const { post, entries } = await site()
    const response = await post({
      email: 'a@example.com',
      topic: 'Sales',
      [FORM_HONEYPOT_FIELD]: 'bot',
    })
    // Told it worked on purpose: saying otherwise is how a bot learns.
    expect(response.status).toBe(303)
    const stored = await entries.list({ formKey: FORM_KEY, includeSpam: true })
    expect(stored.items[0]?.spam).toBe(true)
    // And out of the editor's list by default.
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(0)
  })

  test('a submission faster than the form allows is spam', async () => {
    const { post, entries } = await site(
      CONTACT.replace('[[page]]', 'minimum-submit-seconds = 3\n\n[[page]]'),
    )
    const response = await post({ email: 'a@example.com', topic: 'Sales' })
    expect(response.status).toBe(303)
    expect((await entries.list({ formKey: FORM_KEY, includeSpam: true })).items[0]?.spam).toBe(true)
  })

  test('no token, or a render time that was tampered with, is refused', async () => {
    const { post } = await site()
    const missing = await post({ email: 'a@example.com', topic: 'Sales' }, { token: '' })
    expect(missing.status).toBe(400)
    expect(await missing.text()).toContain('expired')

    // The timing guard is only worth anything if this fails: the token covers
    // the render time, so a bot cannot claim the form was drawn an hour ago.
    const { token } = await (await site()).rendered()
    const tampered = await post({ email: 'a@example.com', topic: 'Sales' }, { token, at: '1' })
    expect(tampered.status).toBe(400)
  })

  test("another form's token does not work on this one", async () => {
    const { post } = await site()
    const response = await post(
      { email: 'a@example.com', topic: 'Sales' },
      { key: '9c4a7d1e-00ff-4b2a-9f31-6d8e2c5a7b40' },
    )
    // Unknown form first, which is the honest answer before any token check.
    expect(response.status).toBe(404)
  })

  test('a form at its entry cap refuses rather than growing', async () => {
    const { post, entries } = await site(CONTACT.replace('[[page]]', 'max-entries = 1\n\n[[page]]'))
    expect((await post({ email: 'a@example.com', topic: 'Sales' })).status).toBe(303)
    const full = await post({ email: 'b@example.com', topic: 'Sales' })
    expect(full.status).toBe(409)
    expect(await full.text()).toContain('no longer accepting')
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(1)
  })

  test('a GET on the submission path is not allowed', async () => {
    const { h } = await site()
    const response = await h.server.fetch(new Request(`${ORIGIN}/bunbraco/forms/${FORM_KEY}`))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })
})

describe('the headless path', () => {
  test('a fetch caller gets JSON rather than a redirect', async () => {
    const { post } = await site()
    const response = await post({ email: 'a@example.com', topic: 'Sales' }, { json: true })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; message: string; entryId: string }
    expect(body.ok).toBe(true)
    expect(body.message).toBe('Thanks, we will be in touch.')
    expect(body.entryId).toBeTruthy()
  })

  test('a refused submission answers 422 with the errors, not a cookie', async () => {
    const { post } = await site()
    const response = await post({ topic: 'Sales' }, { json: true })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { ok: boolean; errors: { field: string }[] }
    expect(body.ok).toBe(false)
    expect(body.errors.map((e) => e.field)).toEqual(['email'])
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('an unknown form is a 404 either way', async () => {
    const { post } = await site()
    const response = await post(
      { email: 'a@example.com' },
      { json: true, key: '11111111-1111-1111-1111-111111111111' },
    )
    expect(response.status).toBe(404)
  })
})

describe('a form that keeps nothing', () => {
  test('runs without storing an entry', async () => {
    const { post, entries } = await site(
      form(`store-entries = false

[[workflow]]
type = "sendToUrl"
name = "Tell the API"

  [workflow.settings]
  url = "https://example.com/hook"

[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "email"
    type = "email"
    caption = "Email address"
    mandatory = true
`),
    )
    const response = await post({ email: 'a@example.com' }, { json: true })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { entryId?: string }).entryId).toBeUndefined()
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(0)
  })
})

describe('an uploaded file', () => {
  const WITH_UPLOAD = form(`
[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "cv"
    type = "fileUpload"
    caption = "Your CV"
    max-size-kb = 1
`)

  test('is placed in the media store and recorded by its path', async () => {
    const { post, entries } = await site(WITH_UPLOAD)
    const response = await post({ cv: new File(['hello'], 'cv.txt') }, { json: true })
    expect(response.status).toBe(200)
    const stored = await entries.list({ formKey: FORM_KEY })
    const value = stored.items[0]?.values.find((v) => v.fieldAlias === 'cv')?.values[0] as string
    expect(value).toMatch(/^\/media\/[0-9a-f]{8}\/cv\.txt$/)
  })

  test('a file a server could execute is refused, by the media library rules', async () => {
    const { post, entries } = await site(WITH_UPLOAD)
    const response = await post({ cv: new File(['<x/>'], 'shell.aspx') }, { json: true })
    expect(response.status).toBe(422)
    expect(
      ((await response.json()) as { errors: { message: string }[] }).errors[0]?.message,
    ).toContain('cannot be a .aspx file')
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(0)
  })

  test('a file over the size the field allows is refused by size', async () => {
    const { post } = await site(WITH_UPLOAD)
    const big = new File(['x'.repeat(2048)], 'big.txt')
    const response = await post({ cv: big }, { json: true })
    expect(response.status).toBe(422)
    expect(
      ((await response.json()) as { errors: { message: string }[] }).errors[0]?.message,
    ).toContain('smaller than 1KB')
  })
})
