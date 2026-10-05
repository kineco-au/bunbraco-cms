/**
 * Forms, phase 4 (`docs/18-forms.md`): the three workflows, and the queue they
 * run from.
 *
 * The exit: a submission is stored before any workflow runs, a workflow that
 * fails is retried without duplicating its effect, and two nodes polling the
 * same queue send one email rather than two.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SchemaForm } from '@bunbraco/core'
import {
  ComponentRepository,
  ContentTypeRepository,
  FormEntryRepository,
  FormWorkflowRepository,
} from '@bunbraco/data'
import {
  createWorkflowRunner,
  type EmailMessage,
  type EmailPort,
  MAX_WORKFLOW_ATTEMPTS,
  plainSummary,
  retryAfter,
  runWorkflow,
  substitute,
} from '@bunbraco/server'
import { BACKOFFICE, type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

const BACKOFFICE_FORMS = `${BACKOFFICE}/bunbraco/api/forms`

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

const FIELDS = `
[[page]]

  [[page.group]]

    [[page.group.field]]
    alias = "email"
    type = "email"
    caption = "Email address"
    mandatory = true

    [[page.group.field]]
    alias = "topic"
    type = "shortAnswer"
    caption = "Topic"
`

const definition = (workflows: string, head = '') => `[form]
key = "${FORM_KEY}"
alias = "contactUs"
name = "Contact us"
${head}${FIELDS}${workflows}`

const EMAIL_WORKFLOW = `
[[workflow]]
type = "sendEmail"
name = "Tell the team"

  [workflow.settings]
  to = "enquiries@example.com"
  subject = "Contact from {email} about {topic}"
`

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

const ENQUIRY_TYPE = `[document-type]
alias = "enquiry"
name = "Enquiry"
allow-at-root = true

[[property]]
alias = "fromAddress"
name = "From"
type = "textstring"
`

const VIEW = `import { Form } from 'bunbraco'
export default function Page({ model, submission }) {
  return <Form form={model.value('contactForm')} submission={submission} />
}
`

/** A port that records, and can be made to fail a set number of times. */
function recordingEmail(failures = 0): EmailPort & { sent: EmailMessage[]; attempts: number } {
  let left = failures
  const port = {
    sent: [] as EmailMessage[],
    attempts: 0,
    description: 'test',
    provider: 'custom' as const,
    async send(message: EmailMessage) {
      port.attempts++
      if (left > 0) {
        left--
        return { ok: false as const, error: 'the provider is down' }
      }
      port.sent.push(message)
      return { ok: true as const, id: 'test-1' }
    },
  }
  return port
}

async function site(options: { form?: string; extraTypes?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'forms-wf-'))
  dirs.push(root)
  for (const dir of ['schema/document-types', 'schema/forms', 'components'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE)
  for (const [name, content] of Object.entries(options.extraTypes ?? {}))
    writeFileSync(join(root, 'schema', 'document-types', name), content)
  writeFileSync(
    join(root, 'schema', 'forms', 'contact-us.toml'),
    options.form ?? definition(EMAIL_WORKFLOW),
  )
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
  await h.put(`${V1}/document/${created.headers.get('umb-generated-resource')}/publish`, {
    publishSchedules: [],
  })

  const post = async (values: Record<string, string>) => {
    const page = await h.server.fetch(new Request(`${ORIGIN}/`))
    const markup = await page.text()
    const token = /name="_bunbraco_token" value="([^"]+)"/.exec(markup)?.[1] as string
    const at = /name="_bunbraco_at" value="([^"]+)"/.exec(markup)?.[1] as string
    const body = new FormData()
    for (const [name, value] of Object.entries(values)) body.set(name, value)
    body.set('_bunbraco_token', token)
    body.set('_bunbraco_at', at)
    return h.server.fetch(
      new Request(`${ORIGIN}/bunbraco/forms/${FORM_KEY}`, {
        method: 'POST',
        body,
        headers: { referer: `${ORIGIN}/`, accept: 'application/json' },
      }),
    )
  }

  const forms = { byKey: (key: string) => (key === FORM_KEY ? current() : undefined) }
  const current = (): SchemaForm | undefined => {
    // Read through the same loader the server uses, so a test that rewrites the
    // file sees what the runner would.
    const { loadSchemaDirectory } = require('@bunbraco/schema') as typeof import('@bunbraco/schema')
    return loadSchemaDirectory(join(root, 'schema')).set.forms?.[0]
  }

  return {
    h,
    root,
    post,
    forms,
    runs: new FormWorkflowRepository(h.server.db),
    entries: new FormEntryRepository(h.server.db),
  }
}

describe('substitution', () => {
  const values = [
    { fieldAlias: 'email', values: ['a@example.com'] },
    { fieldAlias: 'tags', values: ['x', 'y'] },
  ]

  test('a field alias in braces becomes what was submitted', () => {
    expect(substitute('From {email}', values)).toBe('From a@example.com')
    expect(substitute('Tags: {tags}', values)).toBe('Tags: x, y')
  })

  test('an unknown alias is left as written, so a stray brace reads as itself', () => {
    expect(substitute('Hello {nobody}', values)).toBe('Hello {nobody}')
    expect(substitute('100% {of} it', values)).toBe('100% {of} it')
  })

  test('the default body lists every field by its caption', () => {
    const form = {
      alias: 'f',
      name: 'Contact us',
      storeEntries: true,
      requiresApproval: false,
      honeypot: true,
      workflows: [],
      pages: [
        {
          groups: [
            {
              columns: 1,
              fields: [
                {
                  alias: 'email',
                  type: 'email' as const,
                  caption: 'Email address',
                  mandatory: false,
                  sensitive: false,
                  values: [],
                  accept: [],
                },
              ],
            },
          ],
        },
      ],
    }
    const summary = plainSummary({
      form,
      values: [
        { fieldAlias: 'email', values: ['a@example.com'] },
        { fieldAlias: 'missing', values: [] },
      ],
      entryId: null,
    })
    expect(summary).toContain('Contact us')
    expect(summary).toContain('Email address: a@example.com')
    // An unanswered field says so rather than showing an empty line.
    expect(summary).toContain('missing: (not answered)')
  })
})

describe('the retry schedule', () => {
  test('backs off, then gives up so a person looks', () => {
    const now = new Date('2026-01-05T00:00:00Z')
    const first = retryAfter(1, now)
    const second = retryAfter(2, now)
    expect(first).toBeDefined()
    expect(second?.getTime()).toBeGreaterThan((first as Date).getTime())
    expect(retryAfter(MAX_WORKFLOW_ATTEMPTS, now)).toBeUndefined()
  })
})

describe('sendEmail', () => {
  test('sends with the subject substituted, and the body listing the answers', async () => {
    const { post, runs, forms, h } = await site()
    const email = recordingEmail()
    expect((await post({ email: 'a@example.com', topic: 'Sales' })).status).toBe(200)

    // Queued, not sent: the request returned before anything left the building.
    const counts = await runs.counts()
    expect(counts.pending).toBe(1)
    expect(email.sent).toHaveLength(0)

    const runner = createWorkflowRunner({ db: h.server.db, forms, email })
    expect(await runner.runDue()).toEqual({ claimed: 1, done: 1, retrying: 0, failed: 0 })
    expect(email.sent).toHaveLength(1)
    const sent = email.sent[0] as EmailMessage
    expect(sent.to).toEqual([{ email: 'enquiries@example.com' }])
    expect(sent.subject).toBe('Contact from a@example.com about Sales')
    expect(sent.text).toContain('Email address: a@example.com')
  })

  test('a site with no e-mail fails the run permanently, naming what to configure', async () => {
    const { post, runs, forms, h } = await site()
    await post({ email: 'a@example.com', topic: 'Sales' })
    // No `email` in the deps at all, which is a site that never configured one.
    const runner = createWorkflowRunner({ db: h.server.db, forms })
    expect(await runner.runDue()).toEqual({ claimed: 1, done: 0, retrying: 0, failed: 1 })
    const [run] = await runs.forForm(FORM_KEY)
    expect(run?.state).toBe('failed')
    expect(run?.lastError).toContain('BUNBRACO_EMAIL_PROVIDER')
  })

  test('a provider that is down is retried, and succeeds without sending twice', async () => {
    const { post, runs, forms, h } = await site()
    const email = recordingEmail(1)
    await post({ email: 'a@example.com', topic: 'Sales' })
    const runner = createWorkflowRunner({ db: h.server.db, forms, email })

    const first = await runner.runDue()
    expect(first.retrying).toBe(1)
    const [queued] = await runs.forForm(FORM_KEY)
    expect(queued?.state).toBe('pending')
    expect(queued?.attempts).toBe(1)
    expect(queued?.lastError).toContain('down')
    // Not due yet, so nothing happens on the next tick.
    expect((await runner.runDue()).claimed).toBe(0)

    const later = new Date(Date.now() + 10 * 60_000)
    expect(await runner.runDue(later)).toEqual({ claimed: 1, done: 1, retrying: 0, failed: 0 })
    // The point of all this: one email, not two.
    expect(email.sent).toHaveLength(1)
    expect(email.attempts).toBe(2)
  })

  test('a run gives up after enough attempts rather than retrying for ever', async () => {
    const { post, runs, forms, h } = await site()
    const email = recordingEmail(99)
    await post({ email: 'a@example.com', topic: 'Sales' })
    const runner = createWorkflowRunner({ db: h.server.db, forms, email })

    let at = Date.now()
    for (let i = 0; i < MAX_WORKFLOW_ATTEMPTS; i++) {
      at += 2 * 60 * 60_000
      await runner.runDue(new Date(at))
    }
    const [run] = await runs.forForm(FORM_KEY)
    expect(run?.state).toBe('failed')
    expect(run?.attempts).toBe(MAX_WORKFLOW_ATTEMPTS)
    expect(email.sent).toHaveLength(0)
  })
})

describe('sendToUrl', () => {
  const URL_WORKFLOW = `
[[workflow]]
type = "sendToUrl"
name = "Tell the API"

  [workflow.settings]
  url = "https://hooks.example.com/forms"
`

  test('posts the answers as JSON, with the standard fields', async () => {
    const { post, forms, h, entries } = await site({ form: definition(URL_WORKFLOW) })
    await post({ email: 'a@example.com', topic: 'Sales' })
    const calls: { url: string; body: unknown }[] = []
    const runner = createWorkflowRunner({
      db: h.server.db,
      forms,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect((await runner.runDue()).done).toBe(1)

    expect(calls[0]?.url).toBe('https://hooks.example.com/forms')
    const body = calls[0]?.body as Record<string, unknown>
    expect(body.form).toBe('contactUs')
    expect(body.fields).toEqual({ email: 'a@example.com', topic: 'Sales' })
    // The entry id ties the call to the record it came from.
    const stored = await entries.list({ formKey: FORM_KEY })
    expect(body.entryId).toBe(stored.items[0]?.id)
  })

  test('a 4xx is final and a 5xx is retried, because one of them might fix itself', async () => {
    for (const [status, expected] of [
      [400, 'failed'],
      [503, 'retrying'],
    ] as const) {
      const { post, forms, h } = await site({ form: definition(URL_WORKFLOW) })
      await post({ email: 'a@example.com', topic: 'Sales' })
      const runner = createWorkflowRunner({
        db: h.server.db,
        forms,
        fetch: (async () => new Response('no', { status })) as unknown as typeof fetch,
      })
      const report = await runner.runDue()
      expect(report[expected], `${status} is ${expected}`).toBe(1)
    }
  })

  test('a network that is gone is retried, not lost', async () => {
    const { post, forms, h } = await site({ form: definition(URL_WORKFLOW) })
    await post({ email: 'a@example.com', topic: 'Sales' })
    const runner = createWorkflowRunner({
      db: h.server.db,
      forms,
      fetch: (async () => {
        throw new Error('ENOTFOUND')
      }) as unknown as typeof fetch,
    })
    expect((await runner.runDue()).retrying).toBe(1)
  })
})

describe('saveAsContent', () => {
  const CONTENT_WORKFLOW = `
[[workflow]]
type = "saveAsContent"
name = "File it"

  [workflow.settings]
  document-type = "enquiry"
  parent = "root"
  publish = true
  name-field = "topic"

    [workflow.settings.map]
    email = "fromAddress"
`

  test('creates a document from the submission, named and published', async () => {
    const { post, h } = await site({
      form: definition(CONTENT_WORKFLOW),
      extraTypes: { 'enquiry.toml': ENQUIRY_TYPE },
    })
    await post({ email: 'a@example.com', topic: 'Pricing' })
    // Through the server's own runner: writing content needs the node's schema
    // state, and a hand-built runner without it is refused as a stale node.
    expect((await h.server.jobs.runFormWorkflows()).done).toBe(1)

    const tree = await h.json<{
      items: { id: string; hasChildren: boolean; variants: { name: string; state: string }[] }[]
    }>(`${V1}/tree/document/root?take=100`)
    // Named from `name-field`, which is the topic the visitor chose.
    const filed = tree.items.find((item) => item.variants[0]?.name === 'Pricing')
    expect(filed).toBeDefined()
    // `publish = true`, so it is live rather than a draft nobody sees.
    expect(filed?.variants[0]?.state).toBe('Published')
    const document = await h.json<{ values: { alias: string; value: unknown }[] }>(
      `${V1}/document/${filed?.id}`,
    )
    expect(document.values.find((v) => v.alias === 'fromAddress')?.value).toBe('a@example.com')
  })

  test('a workflow naming a document type that does not exist never reaches the queue', async () => {
    // The validator catches it at boot, which is the real protection: a site
    // does not start with a workflow that could never work. The runner's own
    // check stays as defence for a schema store that changes under a running
    // node, which is the only way to reach it.
    let message = ''
    try {
      await site({
        form: definition(CONTENT_WORKFLOW.replace('"enquiry"', '"nothingLikeThis"')),
        extraTypes: { 'enquiry.toml': ENQUIRY_TYPE },
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('unknown document type "nothingLikeThis"')
  })
})

describe('the queue', () => {
  test('a submission is stored before any workflow runs', async () => {
    const { post, entries, runs } = await site()
    await post({ email: 'a@example.com', topic: 'Sales' })
    // The entry exists and the workflow has not run: a mail server being down
    // can never cost the entry, which is the whole ordering.
    expect((await entries.list({ formKey: FORM_KEY })).total).toBe(1)
    expect((await runs.counts()).pending).toBe(1)
  })

  test('only one of two nodes polling the queue runs a row', async () => {
    const { post, forms, h } = await site()
    const email = recordingEmail()
    await post({ email: 'a@example.com', topic: 'Sales' })

    // Two runners over one database, as two nodes would be.
    const a = createWorkflowRunner({ db: h.server.db, forms, email })
    const b = createWorkflowRunner({ db: h.server.db, forms, email })
    const [first, second] = await Promise.all([a.runDue(), b.runDue()])
    expect(first.claimed + second.claimed).toBe(1)
    expect(email.sent).toHaveLength(1)
  })

  test('a spam submission queues nothing, so a form cannot be used as a relay', async () => {
    const { h, runs } = await site()
    const page = await h.server.fetch(new Request(`${ORIGIN}/`))
    const markup = await page.text()
    const body = new FormData()
    body.set('email', 'a@example.com')
    body.set('topic', 'Sales')
    body.set('_bunbraco_hp', 'i am a bot')
    body.set(
      '_bunbraco_token',
      /name="_bunbraco_token" value="([^"]+)"/.exec(markup)?.[1] as string,
    )
    body.set('_bunbraco_at', /name="_bunbraco_at" value="([^"]+)"/.exec(markup)?.[1] as string)
    const response = await h.server.fetch(
      new Request(`${ORIGIN}/bunbraco/forms/${FORM_KEY}`, {
        method: 'POST',
        body,
        headers: { referer: `${ORIGIN}/`, accept: 'application/json' },
      }),
    )
    expect(response.status).toBe(200)
    expect((await runs.counts()).pending).toBe(0)
  })

  test('a workflow removed from the file stops rather than erroring for ever', async () => {
    const { post, forms, h, root, runs } = await site()
    await post({ email: 'a@example.com', topic: 'Sales' })
    // The definition is a file, and somebody deleted the workflow from it.
    writeFileSync(join(root, 'schema', 'forms', 'contact-us.toml'), definition(''))
    const runner = createWorkflowRunner({ db: h.server.db, forms, email: recordingEmail() })
    expect((await runner.runDue()).failed).toBe(1)
    expect((await runs.forForm(FORM_KEY))[0]?.lastError).toContain('no longer a workflow')
  })

  test('nothing due is a quiet no-op, which is most ticks', async () => {
    const { forms, h } = await site()
    const runner = createWorkflowRunner({ db: h.server.db, forms })
    expect(await runner.runDue()).toEqual({ claimed: 0, done: 0, retrying: 0, failed: 0 })
  })

  test('the job runs it, and reports nothing when no runner is configured', async () => {
    const { h } = await site()
    // The server builds a runner, so the job is wired; a bare jobs object is
    // what a node that should not run them gets.
    expect(await h.server.jobs.runFormWorkflows()).toEqual({
      claimed: 0,
      done: 0,
      retrying: 0,
      failed: 0,
    })
  })
})

describe('approval', () => {
  const APPROVE_WORKFLOW = `
[[workflow]]
type = "sendEmail"
name = "Tell the team"
on = "approve"

  [workflow.settings]
  to = "enquiries@example.com"
  subject = "Approved: {topic}"
`

  test('an approve workflow waits for the approval, then runs', async () => {
    const { post, entries, runs, forms, h } = await site({
      form: definition(APPROVE_WORKFLOW, 'requires-approval = true\n'),
    })
    await post({ email: 'a@example.com', topic: 'Sales' })
    // Nothing on submit: the entry is waiting for somebody.
    expect((await runs.counts()).pending).toBe(0)
    const stored = await entries.list({ formKey: FORM_KEY })
    const id = stored.items[0]?.id as string
    expect(stored.items[0]?.state).toBe('submitted')

    const approved = await h.post(`${BACKOFFICE_FORMS}/entries/${id}/state`, { state: 'approved' })
    expect(approved.status).toBe(200)
    expect((await runs.counts()).pending).toBe(1)

    const email = recordingEmail()
    const runner = createWorkflowRunner({ db: h.server.db, forms, email })
    expect((await runner.runDue()).done).toBe(1)
    expect((email.sent[0] as EmailMessage).subject).toBe('Approved: Sales')
  })

  test('rejecting runs nothing', async () => {
    const { post, entries, runs, h } = await site({
      form: definition(APPROVE_WORKFLOW, 'requires-approval = true\n'),
    })
    await post({ email: 'a@example.com', topic: 'Sales' })
    const id = (await entries.list({ formKey: FORM_KEY })).items[0]?.id as string
    await h.post(`${BACKOFFICE_FORMS}/entries/${id}/state`, { state: 'rejected' })
    expect((await runs.counts()).pending).toBe(0)
  })
})

describe('running one workflow directly', () => {
  test('a type with no URL or recipient refuses without calling anything', async () => {
    const form = {
      alias: 'f',
      name: 'F',
      storeEntries: true,
      requiresApproval: false,
      honeypot: true,
      pages: [],
      workflows: [],
    }
    const context = { form, values: [], entryId: null }
    expect(
      await runWorkflow({ type: 'sendToUrl', name: 'w', on: 'submit', settings: {} }, context, {
        db: undefined as never,
      }),
    ).toEqual({ ok: false, retry: false, error: 'The workflow names no URL.' })
    expect(
      await runWorkflow({ type: 'sendEmail', name: 'w', on: 'submit', settings: {} }, context, {
        db: undefined as never,
        email: recordingEmail(),
      }),
    ).toEqual({ ok: false, retry: false, error: 'The workflow has no recipient.' })
  })
})
