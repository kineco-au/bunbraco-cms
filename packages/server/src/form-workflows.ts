/**
 * Running a form's workflows. `docs/forms.md`.
 *
 * The submission is already stored by the time anything here runs: these are
 * the side effects, and a side effect that fails must never cost the entry.
 * Each run is a queue row, claimed by one node and retried with a backoff, so
 * a mail server that is down for ten minutes delays an email rather than
 * losing it — and a multi-node site sends it once.
 *
 * Three types. The XSLT ones Umbraco has are gone (`docs/forms.md` says
 * why), and Slack is `sendToUrl` with a webhook URL rather than a type of its
 * own.
 */
import {
  allFormFields,
  type FormValueToStore,
  formFieldType,
  type SchemaForm,
  type SchemaFormWorkflow,
} from '@crombolo/core'
import {
  ContentTypeRepository,
  type Db,
  DocumentRepository,
  FormWorkflowRepository,
  type FormWorkflowRun,
  type NodeSchemaState,
} from '@crombolo/data'
import type { EmailField, EmailProps, EmailRenderResult } from '@crombolo/render'
import type { EmailAttachment, EmailPort } from './email.ts'
import { htmlToText } from './email-text.ts'
import type { FormWorkflowTypeDefinition } from './form-types.ts'
import { logger } from './logging.ts'
import type { MediaFileStore } from './media-files.ts'

const log = logger('forms')

/** Attempts before a run is left for a person to look at. */
export const MAX_WORKFLOW_ATTEMPTS = 5
/** How long after each failed attempt to try again. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

export interface WorkflowContext {
  form: SchemaForm
  values: readonly FormValueToStore[]
  entryId: string | null
  /** Which attempt this is, from 1. */
  attempt?: number
  /** When the run was queued; now when absent. */
  submittedAt?: Date
}

/** What an e-mail template is rendered from: its props, less the signal the renderer adds. */
export type EmailTemplateProps = Omit<EmailProps, 'signal'>

/** How long a bundle's workflow may run before its signal aborts. */
const BUNDLE_WORKFLOW_TIMEOUT_MS = 60_000

export interface WorkflowDeps {
  db: Db
  /** Absent when the site has no e-mail; a `sendEmail` workflow then says so. */
  email?: EmailPort
  mediaFiles?: MediaFileStore
  fetch?: typeof fetch
  nodeState?: NodeSchemaState
  nodeId?: string
  /** Told when a workflow published something, so the cache is dropped. */
  onContentChanged?: () => void
  /** The workflow types wired bundles add, by type. */
  bundleWorkflows?: ReadonlyMap<string, FormWorkflowTypeDefinition>
  /** Renders a `template` component to HTML; absent, a workflow naming one cannot send. */
  renderEmail?: (alias: string, props: EmailTemplateProps) => Promise<EmailRenderResult>
  /** The site's name and address, for an e-mail template. */
  site?: () => Promise<{ name: string; url: string }>
}

export type WorkflowResult =
  | { ok: true; detail?: string }
  /** `retry` false means trying again cannot help until something changes. */
  | { ok: false; error: string; retry: boolean }

// ------------------------------------------------------------------ substitution

/** What a person reads for a value: the label a visitor chose, for a choice from a source. */
const shown = (value: FormValueToStore): string[] => value.labels ?? value.values

const firstValue = (values: readonly FormValueToStore[], alias: string): string => {
  const found = values.find((value) => value.fieldAlias.toLowerCase() === alias.toLowerCase())
  return found ? shown(found).join(', ') : ''
}

/**
 * `{fieldAlias}` in a workflow setting becomes what was submitted for it.
 *
 * This is all that is left of Umbraco Forms' magic strings, and deliberately:
 * there the seven syntaxes exist because Razor cannot reach into the record. A
 * view here is TSX and reads the model directly, so the only place substitution
 * is needed is a workflow's own settings.
 */
export function substitute(text: string, values: readonly FormValueToStore[]): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, alias: string) => {
    const found = values.find((value) => value.fieldAlias.toLowerCase() === alias.toLowerCase())
    // An unknown alias is left as it was written, so a stray brace in a subject
    // line reads as itself rather than vanishing.
    return found ? shown(found).join(', ') : whole
  })
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const asList = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : []

/**
 * The submission as a reader sees it: caption, then what was entered. A field
 * in `leftOut` (lower-cased aliases) says it was left out rather than showing
 * its answer.
 */
export function plainSummary(
  context: WorkflowContext,
  leftOut: ReadonlySet<string> = new Set(),
): string {
  const captions = new Map(
    allFormFields(context.form).map((field) => [field.alias, field.caption || field.alias]),
  )
  const lines = context.values.map(
    (value) =>
      `${captions.get(value.fieldAlias) ?? value.fieldAlias}: ${
        leftOut.has(value.fieldAlias.toLowerCase())
          ? '(sensitive, not included)'
          : value.values.length > 0
            ? shown(value).join(', ')
            : '(not answered)'
      }`,
  )
  return [`${context.form.name}`, '', ...lines].join('\n')
}

/**
 * The sensitive fields a workflow leaves out, lower-cased: all of them unless it
 * sets `include-sensitive = true`.
 */
export function leftOutFields(form: SchemaForm, workflow: SchemaFormWorkflow): Set<string> {
  if (workflow.settings['include-sensitive'] === true) return new Set()
  return new Set(
    allFormFields(form)
      .filter((field) => field.sensitive)
      .map((field) => field.alias.toLowerCase()),
  )
}

/** The values with every left-out field emptied, so substitution shows nothing for it. */
const withoutLeftOut = (
  values: readonly FormValueToStore[],
  leftOut: ReadonlySet<string>,
): FormValueToStore[] =>
  values.map((value) =>
    leftOut.has(value.fieldAlias.toLowerCase())
      ? { fieldAlias: value.fieldAlias, values: [] }
      : value,
  )

/** An e-mail template's props: the form, its fields in order, and where it came from. */
export function emailTemplateProps(
  context: WorkflowContext,
  leftOut: ReadonlySet<string>,
  subject: string,
  site: { name: string; url: string },
): EmailTemplateProps {
  const sent = withoutLeftOut(context.values, leftOut)
  const byAlias = new Map(sent.map((value) => [value.fieldAlias.toLowerCase(), value]))
  const fields: EmailField[] = allFormFields(context.form)
    // A heading or a paragraph collects nothing; a bundle's type is kept, since
    // only its own declaration could say it is presentational.
    .filter((field) => formFieldType(field.type)?.presentational !== true)
    .map((field) => {
      const found = byAlias.get(field.alias.toLowerCase())
      const values = found ? shown(found) : []
      return {
        alias: field.alias,
        caption: field.caption || field.alias,
        type: field.type,
        values,
        answered: values.length > 0,
        sensitive: field.sensitive,
        leftOut: leftOut.has(field.alias.toLowerCase()),
      }
    })
  return {
    form: context.form,
    fields,
    value: (alias) => {
      const found = byAlias.get(alias.toLowerCase())
      return found ? shown(found).join(', ') : ''
    },
    entry: { id: context.entryId, submittedAt: context.submittedAt ?? new Date() },
    site,
    subject,
  }
}

// ------------------------------------------------------------------ send email

async function sendEmail(
  workflow: SchemaFormWorkflow,
  context: WorkflowContext,
  deps: WorkflowDeps,
): Promise<WorkflowResult> {
  if (!deps.email)
    return {
      ok: false,
      // Retrying cannot help: this is configuration, not weather.
      retry: false,
      error:
        'This site has no e-mail provider, so the workflow cannot send. Configure CROMBOLO_EMAIL_PROVIDER, or `email` in crombolo.config.ts.',
    }

  const settings = workflow.settings
  // Sensitive answers stay out of every part of the e-mail unless the workflow
  // asks for them: an inbox is not covered by the sensitive-data permission.
  const leftOut = leftOutFields(context.form, workflow)
  const values = withoutLeftOut(context.values, leftOut)
  const to = asList(substitute(asString(settings.to) ?? '', values))
  if (to.length === 0) return { ok: false, retry: false, error: 'The workflow has no recipient.' }
  const subject = substitute(asString(settings.subject) ?? context.form.name, values).trim()

  let html: string | undefined
  let text: string
  const template = asString(settings.template)
  if (template) {
    const rendered = await renderTemplate(template, context, leftOut, subject, deps)
    if (!rendered.ok) return rendered
    html = rendered.html
    text = htmlToText(html)
  } else
    text = settings.body
      ? substitute(String(settings.body), values)
      : plainSummary(context, leftOut)

  const attachments: EmailAttachment[] = []
  if (settings['attach-uploads'] === true && deps.mediaFiles) {
    const uploadAliases = new Set(
      allFormFields(context.form)
        .filter((field) => field.type === 'fileUpload')
        .map((field) => field.alias),
    )
    for (const value of values) {
      if (!uploadAliases.has(value.fieldAlias)) continue
      for (const src of value.values) {
        const file = await deps.mediaFiles.open(src)
        if (!file) continue
        attachments.push({
          filename: src.split('/').pop() ?? 'attachment',
          contentType: file.contentType,
          bytes: await file.bytes(),
        })
      }
    }
  }

  const result = await deps.email.send({
    to: to.map((email) => ({ email })),
    cc: asList(asString(settings.cc) ?? '').map((email) => ({ email })),
    bcc: asList(asString(settings.bcc) ?? '').map((email) => ({ email })),
    replyTo: (() => {
      const replyTo = asString(settings['reply-to'])
      const resolved = replyTo ? substitute(replyTo, values) : undefined
      return resolved ? { email: resolved } : undefined
    })(),
    from: (() => {
      const from = asString(settings.from)
      return from ? { email: from } : undefined
    })(),
    subject,
    text,
    ...(html === undefined ? {} : { html }),
    attachments: attachments.length > 0 ? attachments : undefined,
  })
  // A provider that refused is worth another go: a 500 or a timeout is weather.
  return result.ok ? { ok: true } : { ok: false, retry: true, error: result.error }
}

/**
 * The HTML of a workflow's e-mail template, or why there is none.
 *
 * Both failures are retried. A template missing now may be one a node has not
 * caught up with after a deploy; one that throws may be reading something that
 * is briefly unavailable. After the last attempt the run is left failed, with
 * the reason a person can act on.
 */
async function renderTemplate(
  template: string,
  context: WorkflowContext,
  leftOut: ReadonlySet<string>,
  subject: string,
  deps: WorkflowDeps,
): Promise<{ ok: true; html: string } | (WorkflowResult & { ok: false })> {
  if (!deps.renderEmail)
    return {
      ok: false,
      retry: false,
      error: `The e-mail template '${template}' cannot be rendered here: this server renders no templates.`,
    }
  try {
    const site = (await deps.site?.()) ?? { name: '', url: '' }
    const rendered = await deps.renderEmail(
      template,
      emailTemplateProps(context, leftOut, subject, site),
    )
    if (rendered.status === 'ok') return { ok: true, html: rendered.html }
    return {
      ok: false,
      retry: true,
      error:
        rendered.status === 'missing'
          ? `There is no e-mail template '${template}': no components/${template}.tsx in the views this node serves.`
          : rendered.message,
    }
  } catch (error) {
    return {
      ok: false,
      retry: true,
      error: `The e-mail template '${template}' failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// ------------------------------------------------------------------ save as content

async function saveAsContent(
  workflow: SchemaFormWorkflow,
  context: WorkflowContext,
  deps: WorkflowDeps,
): Promise<WorkflowResult> {
  const settings = workflow.settings
  const alias = asString(settings['content-type'])
  if (!alias) return { ok: false, retry: false, error: 'The workflow names no content type.' }

  const types = new ContentTypeRepository(deps.db)
  const type = await types.byAlias(alias)
  if (!type) return { ok: false, retry: false, error: `There is no content type '${alias}'.` }

  const parent = asString(settings.parent)
  const map = (
    settings.map && typeof settings.map === 'object' && !Array.isArray(settings.map)
      ? (settings.map as Record<string, unknown>)
      : {}
  ) as Record<string, string>

  const nameField = asString(settings['name-field'])
  const name =
    (nameField ? firstValue(context.values, nameField) : '') ||
    `${context.form.name} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

  const documents = new DocumentRepository(deps.db, {
    nodeState: deps.nodeState,
    nodeId: deps.nodeId,
  })
  try {
    const created = await documents.create({
      key: crypto.randomUUID(),
      contentTypeKey: type.key,
      componentKey: null,
      // `root` or nothing both mean the top of the tree.
      parentKey: parent && parent !== 'root' ? parent : null,
      values: Object.entries(map).map(([fieldAlias, propertyAlias]) => ({
        alias: propertyAlias,
        culture: null,
        segment: null,
        value: firstValue(context.values, fieldAlias),
      })),
      variants: [{ culture: null, segment: null, name }],
    })
    if (settings.publish === true) {
      await documents.publish(created.key, null)
      deps.onContentChanged?.()
    }
    return { ok: true, detail: created.key }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A node behind the schema cannot write; that resolves on its own when the
    // deploy finishes, so it is worth retrying. Anything else is not.
    const retry = message.includes('may not write') || message.includes('not published')
    return { ok: false, retry, error: message }
  }
}

// ------------------------------------------------------------------ send to url

async function sendToUrl(
  workflow: SchemaFormWorkflow,
  context: WorkflowContext,
  deps: WorkflowDeps,
): Promise<WorkflowResult> {
  const settings = workflow.settings
  const url = asString(settings.url)
  if (!url) return { ok: false, retry: false, error: 'The workflow names no URL.' }
  const method = settings.method === 'PUT' ? 'PUT' : 'POST'
  const headers =
    settings.headers && typeof settings.headers === 'object' && !Array.isArray(settings.headers)
      ? (settings.headers as Record<string, string>)
      : {}

  const fields: Record<string, string | string[]> = {}
  for (const value of context.values)
    fields[value.fieldAlias] =
      value.values.length === 1 ? (value.values[0] as string) : value.values

  const body: Record<string, unknown> = { fields }
  if (settings['include-standard-fields'] !== false) {
    body.form = context.form.alias
    body.formName = context.form.name
    body.entryId = context.entryId
    body.submittedAt = new Date().toISOString()
  }

  const call = deps.fetch ?? fetch
  try {
    const response = await call(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    if (response.ok) return { ok: true, detail: String(response.status) }
    const detail = (await response.text().catch(() => '')).trim().slice(0, 300)
    // A 4xx will not fix itself; a 5xx might.
    return {
      ok: false,
      retry: response.status >= 500,
      error: `the endpoint answered ${response.status}${detail ? `: ${detail}` : ''}`,
    }
  } catch (error) {
    return {
      ok: false,
      retry: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ------------------------------------------------------------------ the runner

export async function runWorkflow(
  workflow: SchemaFormWorkflow,
  context: WorkflowContext,
  deps: WorkflowDeps,
): Promise<WorkflowResult> {
  switch (workflow.type) {
    case 'sendEmail':
      return sendEmail(workflow, context, deps)
    case 'saveAsContent':
      return saveAsContent(workflow, context, deps)
    case 'sendToUrl':
      return sendToUrl(workflow, context, deps)
  }
  const bundled = deps.bundleWorkflows?.get(workflow.type)
  if (!bundled)
    return {
      ok: false,
      retry: false,
      error: `No wired bundle provides the workflow type "${workflow.type}".`,
    }
  return runBundleWorkflow(bundled, workflow, context, deps)
}

/** A bundle's handler, given the submission and narrow capabilities rather than the deps. */
async function runBundleWorkflow(
  definition: FormWorkflowTypeDefinition,
  workflow: SchemaFormWorkflow,
  context: WorkflowContext,
  deps: WorkflowDeps,
): Promise<WorkflowResult> {
  const values: Record<string, readonly string[]> = {}
  const labels: Record<string, readonly string[]> = {}
  for (const value of context.values) {
    values[value.fieldAlias] = value.values
    if (value.labels) labels[value.fieldAlias] = value.labels
  }
  const named = logger('forms', workflow.type)
  const signal = AbortSignal.timeout(BUNDLE_WORKFLOW_TIMEOUT_MS)
  return definition.run({
    form: {
      key: context.form.key ?? context.form.alias,
      alias: context.form.alias,
      name: context.form.name,
    },
    values,
    labels,
    entryId: context.entryId,
    settings: workflow.settings,
    attempt: context.attempt ?? 1,
    fetch: (input, init) => (deps.fetch ?? fetch)(input, { signal, ...init }),
    sendEmail: async (message) =>
      deps.email
        ? deps.email.send(message)
        : { ok: false, error: 'This site has no e-mail set up.' },
    log: {
      info: (message, properties) => named.info(message, properties),
      warn: (message, properties) => named.warn(message, properties),
      error: (message, properties) => named.error(message, properties),
    },
    signal,
  })
}

export interface WorkflowRunReport {
  claimed: number
  done: number
  retrying: number
  failed: number
}

export interface WorkflowRunner {
  /** Runs what is due. Called by the job timer, and directly by tests. */
  runDue(now?: Date, limit?: number): Promise<WorkflowRunReport>
}

/** When to try again after this many attempts, or undefined to give up. */
export function retryAfter(attempts: number, now: Date): Date | undefined {
  if (attempts >= MAX_WORKFLOW_ATTEMPTS) return undefined
  const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 60_000
  return new Date(now.getTime() + delay)
}

export function createWorkflowRunner(
  deps: WorkflowDeps & { forms: { byKey(key: string): SchemaForm | undefined } },
): WorkflowRunner {
  const runs = new FormWorkflowRepository(deps.db)

  const execute = async (run: FormWorkflowRun, now: Date): Promise<keyof WorkflowRunReport> => {
    const form = deps.forms.byKey(run.formKey)
    if (!form) {
      // The definition is a file, and it is gone. There is nothing to run and
      // nothing to retry, so the row records why rather than sitting pending.
      await runs.fail(run.id, `The form '${run.formAlias}' is no longer in schema/forms/.`)
      return 'failed'
    }
    const workflow = form.workflows.find(
      (candidate) => candidate.name.toLowerCase() === run.workflowName.toLowerCase(),
    )
    if (!workflow) {
      await runs.fail(run.id, `'${run.workflowName}' is no longer a workflow on this form.`)
      return 'failed'
    }

    const context: WorkflowContext = {
      form,
      values: run.payload,
      entryId: run.entryId,
      attempt: run.attempts,
      submittedAt: run.createDate,
    }
    let result: WorkflowResult
    try {
      result = await runWorkflow(workflow, context, deps)
    } catch (error) {
      // A workflow that throws is a bug, not a refusal; it is still retried,
      // because the usual cause is something transient underneath it.
      result = {
        ok: false,
        retry: true,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      }
    }

    if (result.ok) {
      await runs.succeed(run.id)
      return 'done'
    }
    const again = result.retry ? retryAfter(run.attempts, now) : undefined
    await runs.fail(run.id, result.error, again)
    if (again) {
      log.warning("'{workflow}' on {form} failed and will be retried: {detail}", {
        workflow: run.workflowName,
        form: run.formAlias,
        detail: result.error,
      })
      return 'retrying'
    }
    log.error("'{workflow}' on {form} failed: {detail}", {
      workflow: run.workflowName,
      form: run.formAlias,
      detail: result.error,
    })
    return 'failed'
  }

  return {
    async runDue(now = new Date(), limit = 25) {
      const report: WorkflowRunReport = { claimed: 0, done: 0, retrying: 0, failed: 0 }
      for (const due of await runs.due(now, limit)) {
        // Another node may have taken it between the read and here, which is
        // exactly what the claim is for.
        const claimed = await runs.claim(due.id)
        if (!claimed) continue
        report.claimed++
        report[await execute(claimed, now)]++
      }
      return report
    },
  }
}
