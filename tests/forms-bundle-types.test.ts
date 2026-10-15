/**
 * Story 095: a form field type and a workflow type from a server bundle, end to
 * end — the file, the designer, the render, the submission, the entry and the
 * workflow run — with the built-in types unaffected.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILT_IN_FORM_TYPES,
  FORM_RENDERED_FIELD,
  FORM_TOKEN_FIELD,
  formTypesWith,
  settingsProblems,
} from '@crombolo/core'
import {
  ComponentRepository,
  ContentTypeRepository,
  FormEntryRepository,
  FormWorkflowRepository,
} from '@crombolo/data'
import { parseForm, validateForms } from '@crombolo/schema'
import { collectFormTypes } from '@crombolo/server'
import { siteDeclaring } from './support/bundles.ts'
import { dialectUnderTest } from './support/db.ts'
import {
  crmHandoff,
  FORMS_BUNDLE_ID,
  FORMS_PACKAGE,
  formsBundle,
  postcodeField,
} from './support/form-types-bundle.ts'
import {
  BACKOFFICE,
  bootServer,
  type Harness,
  ORIGIN,
  signedInServer,
  V1,
} from './support/harness.ts'

const FORMS = `${BACKOFFICE}/crombolo/api/forms`

const open: Harness[] = []
const dirs: string[] = []
const listeners: Array<{ stop(force?: boolean): void }> = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (listeners.length > 0) listeners.pop()?.stop(true)
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const types = collectFormTypes([formsBundle()]).types

describe('adding types to the registry', () => {
  test("a bundle's types join the built-ins, which are unchanged", () => {
    expect(types.fields.get('postcode')?.bundle).toBe(FORMS_BUNDLE_ID)
    expect(types.workflows.get('crmHandoff')?.bundle).toBe(FORMS_BUNDLE_ID)
    expect(types.fields.get('shortAnswer')).toBe(BUILT_IN_FORM_TYPES.fields.get('shortAnswer'))
    expect(BUILT_IN_FORM_TYPES.fields.has('postcode')).toBe(false)
  })

  test('a name already taken is refused, by whoever holds it', () => {
    const clash = formTypesWith(types, 'other', {
      fields: [{ ...postcodeField, declared: [], presentational: false, choices: false }],
      workflows: [{ type: 'sendEmail', label: 'Mine', declared: [] }],
    })
    expect(clash.problems).toEqual([
      'The bundle "other" adds the field type "postcode", which the bundle "acme-forms" already provides.',
      'The bundle "other" adds the workflow type "sendEmail", which is built in.',
    ])
  })

  test('a name that is not camelCase, and a setting declared twice, are refused', () => {
    const { problems } = formTypesWith(BUILT_IN_FORM_TYPES, 'x', {
      workflows: [
        { type: 'Bad-Name', label: 'B', declared: [] },
        {
          type: 'twice',
          label: 'T',
          declared: [
            { key: 'a', label: 'A', kind: 'text' },
            { key: 'a', label: 'A', kind: 'text' },
          ],
        },
      ],
    })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('"Bad-Name"')
    expect(problems[1]).toContain('declares the setting "a" twice')
  })

  test('a field type with no renderer is refused when the bundles are collected', () => {
    const { problems } = collectFormTypes([
      formsBundle({
        forms: { fields: [{ ...postcodeField, render: undefined as never }] },
      }),
    ])
    expect(problems[0]).toContain('needs a render function')
  })
})

describe('declared settings', () => {
  const declared = postcodeField.settings ?? []

  test('are held to what is declared: unknown, missing and mistyped are named', () => {
    expect(settingsProblems(declared, { country: 'AU' }, 'a postcode field')).toEqual([])
    expect(
      settingsProblems(declared, { lookup: 'yes', colour: 'red' }, 'a postcode field'),
    ).toEqual([
      'a postcode field has the setting "colour", which it does not take; it takes country, lookup.',
      'a postcode field needs the setting "country".',
      'a postcode field has the setting "lookup" as "yes", which is not true or false.',
    ])
  })
})

const FORM_KEY = '9c4a7d1e-0095-4b2a-9f31-6d8e2c5a7b95'

const formFile = (endpoint: string, extra = '') => `[form]
key = "${FORM_KEY}"
alias = "signUp"
name = "Sign up"
message-on-submit = "Thanks."

[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "email"
    type = "email"
    caption = "Email"
    mandatory = true

    [[page.group.field]]
    alias = "postcode"
    type = "postcode"
    caption = "Postcode"
    mandatory = true
    settings = { country = "AU", lookup = true }
${extra}
[[workflow]]
type = "crmHandoff"
name = "To the CRM"

[workflow.settings]
endpoint = "${endpoint}"
list = "newsletter"
`

describe('the file', () => {
  test('a bundle type parses with its settings, and validates against its declarations', () => {
    const parsed = parseForm('schema/forms/sign-up.toml', formFile('https://crm.example/in'), types)
    expect(parsed.problems).toEqual([])
    const field = parsed.value?.pages[0]?.groups[0]?.fields[1]
    expect(field).toMatchObject({ type: 'postcode', settings: { country: 'AU', lookup: true } })
    expect(validateForms(parsed.value ? [parsed.value] : [], { types })).toEqual([])
  })

  test('without the bundle wired, both types are refused by name', () => {
    const parsed = parseForm('schema/forms/sign-up.toml', formFile('https://crm.example/in'))
    const messages = parsed.problems.map((problem) => problem.message)
    expect(messages.some((m) => m.startsWith('the field type "postcode" is not built in'))).toBe(
      true,
    )
    expect(
      messages.some((m) => m.startsWith('the workflow type "crmHandoff" is not built in')),
    ).toBe(true)
  })

  test("a bundle's own checks run: a missing setting and a bad endpoint", () => {
    const parsed = parseForm(
      'schema/forms/sign-up.toml',
      formFile('ftp://nope').replace('settings = { country = "AU", lookup = true }', ''),
      types,
    )
    const problems = validateForms(parsed.value ? [parsed.value] : [], { types }).map(
      (problem) => problem.message,
    )
    expect(problems).toContain('a postcode field needs the setting "country".')
    expect(problems).toContain('the endpoint must be a web address')
  })

  test('a built-in type still refuses unknown settings, and a settings table', () => {
    const parsed = parseForm(
      'schema/forms/sign-up.toml',
      formFile('https://crm.example/in').replace(
        'alias = "email"\n    type = "email"',
        'alias = "email"\n    type = "email"\n    rows = 3\n    settings = { country = "AU" }',
      ),
      types,
    )
    const problems = validateForms(parsed.value ? [parsed.value] : [], { types }).map(
      (problem) => `${problem.path}: ${problem.message}`,
    )
    expect(problems.some((p) => p.endsWith('rows: does not apply to a email field'))).toBe(true)
    expect(problems.some((p) => p.includes('is built in and takes no settings table'))).toBe(true)
  })
})

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

/** A CRM that records what it is sent and answers with the next status in line. */
function crm(statuses: number[] = [200]) {
  const received: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push(await request.json())
      return new Response(null, { status: statuses.shift() ?? 200 })
    },
  })
  listeners.push(server)
  return { url: `${server.url}in`, received }
}

async function site(endpoint: string) {
  const root = siteDeclaring('forms-bundle-types', FORMS_PACKAGE)
  dirs.push(root)
  for (const dir of ['schema/content-types', 'schema/forms'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), TYPE)
  writeFileSync(join(root, 'schema', 'forms', 'sign-up.toml'), formFile(endpoint))
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: {
      siteDir: root,
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      bundles: [formsBundle()],
    },
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
  if (created.status !== 201) throw new Error(`create ${created.status}: ${await created.text()}`)
  await h.put(`${V1}/document/${created.headers.get('umb-generated-resource')}/publish`, {
    publishSchedules: [],
  })

  const rendered = async () => {
    const markup = await (await h.server.fetch(new Request(`${ORIGIN}/`))).text()
    return {
      markup,
      token: /name="_crombolo_token" value="([^"]+)"/.exec(markup)?.[1] as string,
      at: /name="_crombolo_at" value="([^"]+)"/.exec(markup)?.[1] as string,
    }
  }
  const submit = async (values: Record<string, string>) => {
    const page = await rendered()
    const body = new FormData()
    for (const [name, value] of Object.entries(values)) body.append(name, value)
    body.set(FORM_TOKEN_FIELD, page.token)
    body.set(FORM_RENDERED_FIELD, page.at)
    return h.server.fetch(
      new Request(`${ORIGIN}/crombolo/forms/${FORM_KEY}`, {
        method: 'POST',
        body,
        headers: { referer: `${ORIGIN}/`, accept: 'application/json' },
      }),
    )
  }
  return { h, root, rendered, submit }
}

describe('a bundle field type and workflow type on a real site', () => {
  test('the designer offers the type with its declared settings', async () => {
    const { h } = await site(crm().url)
    const offered = await h.json<{
      fields: Array<{ type: string; label: string; builtIn: boolean; settings: unknown[] }>
      workflows: Array<{ type: string; builtIn: boolean }>
    }>(`${FORMS}/available-types`)
    const postcode = offered.fields.find((field) => field.type === 'postcode')
    expect(postcode).toMatchObject({ label: 'Postcode', builtIn: false })
    expect(postcode?.settings).toEqual(postcodeField.settings as unknown[])
    expect(offered.fields.find((field) => field.type === 'longAnswer')?.builtIn).toBe(true)
    expect(offered.workflows.map((w) => w.type)).toContain('crmHandoff')
  })

  test('the designer saves a bundle field with its settings, and refuses a bad one', async () => {
    const { h } = await site(crm().url)
    const form = (await h.json<{ definition: Record<string, unknown> }>(`${FORMS}/${FORM_KEY}`))
      .definition
    const fields = (
      form as { pages: Array<{ groups: Array<{ fields: Record<string, unknown>[] }> }> }
    ).pages[0]?.groups[0]?.fields as Record<string, unknown>[]
    const postcode = fields[1] as Record<string, unknown>
    postcode.settings = { country: 'GB' }
    const save = () => h.call(FORMS, { method: 'PUT', body: JSON.stringify(form) })
    const saved = await save()
    expect(saved.status).toBe(200)
    postcode.settings = { country: 'GB', colour: 'red' }
    const refused = await save()
    expect(refused.status).toBe(400)
    const problems = ((await refused.json()) as { problems: { message: string }[] }).problems
    expect(problems.map((p) => p.message)).toContain(
      'a postcode field has the setting "colour", which it does not take; it takes country, lookup.',
    )
  })

  test('renders through the bundle, validates through it, stores the entry and hands it off', async () => {
    const remote = crm()
    const { h, rendered, submit } = await site(remote.url)
    const { markup } = await rendered()
    expect(markup).toContain('data-country="AU"')
    expect(markup).toContain('autocomplete="postal-code"')
    expect(markup).toContain('crombolo-form__field--postcode')

    const refused = await submit({ email: 'a@example.com', postcode: 'SW1A 1AA' })
    expect(refused.status).toBe(422)
    expect(await refused.text()).toContain('That is not a AU postcode')

    const accepted = await submit({ email: 'a@example.com', postcode: '2000' })
    expect(accepted.status).toBe(200)
    const entries = await new FormEntryRepository(h.server.db).list({ formKey: FORM_KEY, take: 10 })
    expect(entries.items[0]?.values.find((v) => v.fieldAlias === 'postcode')?.values).toEqual([
      '2000',
    ])

    expect((await h.server.jobs.runFormWorkflows()).done).toBe(1)
    expect(remote.received).toEqual([
      {
        form: 'signUp',
        list: 'newsletter',
        attempt: 1,
        values: { email: ['a@example.com'], postcode: ['2000'] },
      },
    ])
  })

  test('a failure the handler calls retryable is retried; one it does not is not', async () => {
    const remote = crm([503, 200])
    const { h, submit } = await site(remote.url)
    expect((await submit({ email: 'a@example.com', postcode: '2000' })).status).toBe(200)
    expect((await h.server.jobs.runFormWorkflows()).retrying).toBe(1)
    expect((await h.server.jobs.runFormWorkflows(new Date(Date.now() + 2 * 60_000))).done).toBe(1)
    expect((remote.received as Array<{ attempt: number }>).map((body) => body.attempt)).toEqual([
      1, 2,
    ])

    const refusing = crm([422])
    const second = await site(refusing.url)
    expect((await second.submit({ email: 'b@example.com', postcode: '2000' })).status).toBe(200)
    expect((await second.h.server.jobs.runFormWorkflows()).failed).toBe(1)
    const runs = await new FormWorkflowRepository(second.h.server.db).forForm(FORM_KEY)
    expect(runs[0]).toMatchObject({ state: 'failed', lastError: 'The CRM answered 422' })
  })
})

test.skipIf(dialectUnderTest !== 'postgres')(
  'a web node, which serves no backoffice, still renders the bundle type',
  async () => {
    const { root } = await site(crm().url)
    const web = await bootServer({
      keepDatabase: true,
      config: {
        siteDir: root,
        schemaDir: join(root, 'schema'),
        componentsDir: join(root, 'components'),
        bundles: [formsBundle()],
        role: 'web',
        nodeId: 'web-node',
      },
    })
    try {
      const markup = await (await web.fetch(new Request(`${ORIGIN}/`))).text()
      expect(markup).toContain('data-country="AU"')
    } finally {
      await web.close()
    }
  },
)

test('a workflow type nobody provides fails its run at once, by name', async () => {
  const { runWorkflow } = await import('@crombolo/server')
  const result = await runWorkflow(
    { type: 'nobodys', name: 'N', on: 'submit', settings: {} },
    { form: { alias: 'f', name: 'F' } as never, values: [], entryId: null },
    { db: undefined as never },
  )
  expect(result).toEqual({
    ok: false,
    retry: false,
    error: 'No wired bundle provides the workflow type "nobodys".',
  })
  expect(crmHandoff.type).toBe('crmHandoff')
})
