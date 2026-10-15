/**
 * Story 093: a `step-pages` form shows one page at a time in the browser and
 * checks each on the server before the next. Answers stay in the form until the
 * one submission; without JavaScript every page shows together, as before.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORM_PAGE_FIELD, FORM_RENDERED_FIELD, FORM_TOKEN_FIELD } from '@crombolo/core'
import { ComponentRepository, ContentTypeRepository, FormEntryRepository } from '@crombolo/data'
import { FORM_SCRIPT } from '@crombolo/render'
import { parseForm, writeForm } from '@crombolo/schema'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

interface Stepper {
  layout(form: unknown): void
  neighbour(form: unknown, from: number, step: number): number
}

const stepper = (() => {
  const window: Record<string, unknown> = {}
  new Function('window', 'document', FORM_SCRIPT)(window, { querySelectorAll: () => [] })
  return window.__cromboloForms as Stepper
})()

/** The slice of a rendered stepped form the stepper touches. */
function fakeForm(pages: number, closed: number[] = []) {
  const attrs = new Map<string, string>([['data-step-pages', 'true']])
  const page = (index: number) => {
    const own = new Map<string, string>()
    if (closed.includes(index)) own.set('data-condition-hidden', 'true')
    return {
      hidden: false,
      getAttribute: (name: string) => own.get(name) ?? null,
      setAttribute: (name: string, value: string) => own.set(name, value),
    }
  }
  const list = Array.from({ length: pages }, (_, i) => page(i))
  const buttons: Record<string, { hidden: boolean }> = {
    '[data-step="back"]': { hidden: true },
    '[data-step="next"]': { hidden: true },
    '.crombolo-form__submit': { hidden: false },
  }
  return {
    pages: list,
    buttons,
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    querySelectorAll: (selector: string) => (selector === '.crombolo-form__page' ? list : []),
    querySelector: (selector: string) => buttons[selector] ?? null,
    at(index: number) {
      attrs.set('data-step-current', String(index))
      this.layout()
    },
    layout() {
      stepper.layout(this)
    },
    shown: () => list.map((p) => !p.hidden),
  }
}

describe('the stepper', () => {
  test('shows the first page, with next and no back or submit', () => {
    const form = fakeForm(3)
    form.layout()
    expect(form.shown()).toEqual([true, false, false])
    expect(form.buttons['[data-step="back"]']?.hidden).toBe(true)
    expect(form.buttons['[data-step="next"]']?.hidden).toBe(false)
    expect(form.buttons['.crombolo-form__submit']?.hidden).toBe(true)
  })

  test('on the last page it offers back and submit, not next', () => {
    const form = fakeForm(3)
    form.at(2)
    expect(form.shown()).toEqual([false, false, true])
    expect(form.buttons['[data-step="back"]']?.hidden).toBe(false)
    expect(form.buttons['[data-step="next"]']?.hidden).toBe(true)
    expect(form.buttons['.crombolo-form__submit']?.hidden).toBe(false)
  })

  test('skips a page whose condition hides it, both ways', () => {
    const form = fakeForm(3, [1])
    expect(stepper.neighbour(form, 0, 1)).toBe(2)
    expect(stepper.neighbour(form, 2, -1)).toBe(0)
    form.at(0)
    // Page 1 is closed, so page 0 is followed by the last page: next, not submit.
    expect(form.buttons['[data-step="next"]']?.hidden).toBe(false)
  })

  test('a page a condition closes while the visitor is on it steps back to an open one', () => {
    const form = fakeForm(3)
    form.at(2)
    form.pages[2]?.setAttribute('data-condition-hidden', 'true')
    form.layout()
    expect(form.shown()).toEqual([false, true, false])
  })
})

const FORM_KEY = '9c4a7d1e-0093-4b2a-9f31-6d8e2c5a7b93'

const STEPPED = (step = true) => `[form]
key = "${FORM_KEY}"
alias = "application"
name = "Application"
${step ? 'step-pages = true\n' : ''}next-label = "Continue"
message-on-submit = "Received."

[[page]]
caption = "About you"

  [[page.group]]

    [[page.group.field]]
    alias = "name"
    type = "shortAnswer"
    caption = "Name"
    mandatory = true

    [[page.group.field]]
    alias = "role"
    type = "dropdown"
    caption = "Role"
    values = ["Student", "Staff"]

    [[page.group.field]]
    alias = "cv"
    type = "fileUpload"
    caption = "CV"
    accept = [".pdf"]

[[page]]
caption = "Details"

  [[page.group]]

    [[page.group.field]]
    alias = "studentId"
    type = "shortAnswer"
    caption = "Student number"
    mandatory = true

      [page.group.field.condition]
      action = "show"
      match = "all"
      rule = [{ field = "role", operator = "is", value = "Student" }]
`

const TYPE = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
components = ["page"]
default-component = "page"

[[property]]
alias = "form"
name = "Form"
type = "formPicker"
`

const VIEW = `import { Form } from '@crombolo/crombolo'
export default function Page({ model, submission }) {
  return <main><Form form={model.value('form')} submission={submission} /></main>
}
`

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

async function site(definition = STEPPED()) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'forms-steps-'))
  dirs.push(root)
  for (const dir of ['schema/content-types', 'schema/forms', 'components'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), TYPE)
  writeFileSync(join(root, 'schema', 'forms', 'application.toml'), definition)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  const mediaDir = join(root, 'media')
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components'), mediaDir },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const created = await h.post(`${V1}/document`, {
    documentType: { id: typeKey },
    template: { id: componentKey },
    parent: null,
    values: [{ alias: 'form', culture: null, segment: null, value: FORM_KEY }],
    variants: [{ culture: null, segment: null, name: 'Home' }],
  })
  await h.put(`${V1}/document/${created.headers.get('umb-generated-resource')}/publish`, {
    publishSchedules: [],
  })
  const markup = async () => (await h.server.fetch(new Request(`${ORIGIN}/`))).text()
  const post = async (values: Record<string, string | File>, page?: number) => {
    const html = await markup()
    const body = new FormData()
    for (const [name, value] of Object.entries(values)) body.append(name, value)
    body.set(FORM_TOKEN_FIELD, /name="_crombolo_token" value="([^"]+)"/.exec(html)?.[1] as string)
    body.set(FORM_RENDERED_FIELD, /name="_crombolo_at" value="([^"]+)"/.exec(html)?.[1] as string)
    if (page !== undefined) body.set(FORM_PAGE_FIELD, String(page))
    return h.server.fetch(
      new Request(`${ORIGIN}/crombolo/forms/${FORM_KEY}`, {
        method: 'POST',
        body,
        headers: { referer: `${ORIGIN}/`, accept: 'application/json' },
      }),
    )
  }
  return { h, markup, post, mediaDir, entries: new FormEntryRepository(h.server.db) }
}

describe('the file', () => {
  test('step-pages round-trips, and is left out when off', () => {
    const on = parseForm('schema/forms/a.toml', STEPPED()).value
    expect(on?.stepPages).toBe(true)
    expect(writeForm(on as never)).toContain('step-pages = true')
    const off = parseForm('schema/forms/a.toml', STEPPED(false)).value
    expect(off?.stepPages).toBeUndefined()
    expect(writeForm(off as never)).not.toContain('step-pages')
  })
})

describe('a stepped form on a page', () => {
  test('renders every page, marked for the stepper, with its buttons hidden until it runs', async () => {
    const { markup } = await site()
    const html = await markup()
    expect(html).toContain('data-step-pages="true"')
    expect(html).toContain('data-page="0"')
    expect(html).toContain('data-page="1"')
    expect(html).toMatch(
      /<button type="button" class="crombolo-form__next" data-step="next" hidden[^>]*>Continue<\/button>/,
    )
    expect(html).toMatch(/data-step="back" hidden/)
  })

  test('without step-pages nothing changes: no marker and no step buttons', async () => {
    const { markup } = await site(STEPPED(false))
    const html = await markup()
    expect(html).not.toContain('data-step-pages')
    expect(html).not.toContain('data-step=')
  })

  test('checking a page names only that page’s problems, and keeps nothing', async () => {
    const { post, entries, mediaDir } = await site()
    const refused = await post({ role: 'Student' }, 0)
    expect(refused.status).toBe(422)
    expect(
      ((await refused.json()) as { errors: Array<{ field: string }> }).errors.map((e) => e.field),
    ).toEqual(['name'])

    const cv = new File(['%PDF-1.4 cv'], 'cv.pdf', { type: 'application/pdf' })
    const passed = await post({ name: 'Ada', role: 'Student', cv }, 0)
    expect(passed.status).toBe(200)
    expect(await passed.json()).toEqual({ ok: true })
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(0)
    const written = (() => {
      try {
        return readdirSync(mediaDir, { recursive: true })
      } catch {
        return []
      }
    })()
    expect(written).toEqual([])
  })

  test('an upload of the wrong kind is refused at its page, before anything is written', async () => {
    const { post } = await site()
    const bad = new File(['x'], 'cv.exe')
    const refused = await post({ name: 'Ada', cv: bad }, 0)
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { errors: Array<{ field: string }> }).errors[0]?.field).toBe(
      'cv',
    )
  })

  test('a later page is checked against the answers from earlier ones', async () => {
    const { post } = await site()
    // The student number is only asked of a student, which page one decides.
    expect((await post({ name: 'Ada', role: 'Staff' }, 1)).status).toBe(200)
    const missing = await post({ name: 'Ada', role: 'Student' }, 1)
    expect(missing.status).toBe(422)
    expect(
      ((await missing.json()) as { errors: Array<{ field: string }> }).errors.map((e) => e.field),
    ).toEqual(['studentId'])
  })

  test('the final submission checks every page and stores the entry, as before', async () => {
    const { post, entries } = await site()
    expect((await post({ role: 'Student' })).status).toBe(422)
    expect((await post({ name: 'Ada', role: 'Student', studentId: 'S1' })).status).toBe(200)
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(1)
  })
})
