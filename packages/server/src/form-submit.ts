/**
 * Taking a form submission. `docs/18-forms.md`.
 *
 * `POST /bunbraco/forms/<key>`, outside the Management API because a visitor is
 * not a backoffice user and there is no operation in the vendored contract for
 * this.
 *
 * Two answers, by what the client asked for. A `fetch` caller gets JSON, which
 * is the headless path. A plain browser form gets a **303 back to the page it
 * came from**, so the form reappears inside its own layout with either its
 * errors or its thank-you — which is what makes this work with no JavaScript at
 * all. That state travels in a short-lived signed cookie, because a redirect
 * cannot carry a body.
 *
 * Everything here signs synchronously, with `Bun.CryptoHasher` rather than
 * `crypto.subtle`: a template signs a token while it renders, and a view cannot
 * await.
 */
import {
  allFormFields,
  DEFAULT_UPLOAD_SETTINGS,
  FORM_HONEYPOT_FIELD,
  FORM_RENDERED_FIELD,
  FORM_RESERVED_FIELDS,
  FORM_TOKEN_FIELD,
  type FormFieldError,
  type FormSubmissionState,
  isUploadAllowed,
  type SchemaForm,
  type SubmittedValues,
  type UploadSettings,
  validateSubmission,
} from '@bunbraco/core'
import {
  type Db,
  ensureKeyValue,
  FormEntryRepository,
  FormWorkflowRepository,
} from '@bunbraco/data'
import { loadSchemaDirectory } from '@bunbraco/schema'
import { logger } from './logging.ts'
import type { MediaFileStore } from './media-files.ts'

const log = logger('forms')

/** The cookie a refused or accepted submission travels back in. */
export const FORM_FLASH_COOKIE = 'bunbraco-form'
/** Long enough to survive the redirect, short enough not to linger. */
const FLASH_SECONDS = 60
const SIGNING_KEY = 'bunbraco/formTokenKey'
/** A payload larger than this keeps the messages and drops the typed values. */
const MAX_FLASH_BYTES = 3500

// ------------------------------------------------------------------ the definitions

export interface FormRegistry {
  all(): readonly SchemaForm[]
  byKey(key: string): SchemaForm | undefined
  /** Drops the memo, for a test or after a schema write. */
  invalidate(): void
}

/**
 * The site's forms, re-read when they might have changed.
 *
 * Memoised for a moment rather than cached until told: form definitions are
 * files, and nothing signals a change to them the way a publish signals a
 * content change. A second of staleness is invisible to somebody editing one,
 * and it bounds the cost of re-parsing `schema/` on a page that renders a form.
 */
export function createFormRegistry(
  schemaDir: string,
  options: { ttlMs?: number } = {},
): FormRegistry {
  const ttl = options.ttlMs ?? 1000
  let at = 0
  let forms: readonly SchemaForm[] = []
  let byKey = new Map<string, SchemaForm>()

  const refresh = () => {
    if (at !== 0 && Date.now() - at < ttl) return
    try {
      forms = loadSchemaDirectory(schemaDir).set.forms ?? []
      byKey = new Map(forms.map((form) => [form.key ?? form.alias, form]))
    } catch (error) {
      // A broken schema directory fails the boot, so reaching here means it
      // broke afterwards. Keeping the last good set beats rendering every form
      // on the site as missing.
      log.warning('The forms could not be re-read: {detail}', {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    at = Date.now()
  }

  return {
    all() {
      refresh()
      return forms
    },
    byKey(key) {
      refresh()
      return byKey.get(key)
    },
    invalidate() {
      at = 0
    },
  }
}

// ------------------------------------------------------------------ signing

function hmac(secret: string, payload: string): string {
  const hasher = new Bun.CryptoHasher('sha256', secret)
  hasher.update(payload)
  return hasher.digest('base64url')
}

/** Constant-time comparison of two base64url digests of one size. */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

/**
 * Signs the form and the moment it was rendered.
 *
 * This is what makes the timing guard mean anything: without it a bot posts its
 * own `_bunbraco_at` and the elapsed time is whatever it claims. It is not a
 * CSRF token — a public form has no session to tie one to — and does not
 * pretend to be one.
 */
export function signFormToken(secret: string, formKey: string, renderedAt: number): string {
  return hmac(secret, `${formKey}|${renderedAt}`)
}

export function verifyFormToken(
  secret: string,
  formKey: string,
  renderedAt: number,
  token: string,
): boolean {
  if (!token) return false
  return sameSignature(signFormToken(secret, formKey, renderedAt), token)
}

/** The per-site signing key, created once and kept so it survives a restart. */
export async function formSigningSecret(db: Db): Promise<string> {
  return ensureKeyValue(db, SIGNING_KEY, () => crypto.randomUUID())
}

// ------------------------------------------------------------------ the flash cookie

interface Flash extends FormSubmissionState {
  /** When it was written, so a stale cookie is ignored rather than replayed. */
  at: number
}

export function writeFlash(secret: string, state: FormSubmissionState): string {
  const payload: Flash = { ...state, at: Date.now() }
  let json = JSON.stringify(payload)
  if (json.length > MAX_FLASH_BYTES)
    // The messages matter more than redisplaying what was typed, and a cookie
    // the browser silently drops would lose both.
    json = JSON.stringify({ ...payload, values: {} })
  const body = Buffer.from(json).toString('base64url')
  return `${body}.${hmac(secret, body)}`
}

export function readFlash(
  secret: string,
  cookie: string | undefined,
): FormSubmissionState | undefined {
  if (!cookie) return undefined
  const [body, signature] = cookie.split('.')
  if (!body || !signature) return undefined
  if (!sameSignature(hmac(secret, body), signature)) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Flash
    if (Date.now() - parsed.at > FLASH_SECONDS * 1000) return undefined
    return {
      formKey: parsed.formKey,
      formAlias: parsed.formAlias,
      values: parsed.values ?? {},
      errors: parsed.errors ?? [],
      message: parsed.message,
    }
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------ the submission

export interface FormSubmitDeps {
  db: Db
  forms: FormRegistry
  mediaFiles: MediaFileStore
  /**
   * What an upload may be, as the media library has it. Both lists matter: the
   * deny list keeps an `.aspx` out, and `allowedExtensions` is empty by
   * default — so checking only that would refuse everything.
   */
  uploads?: UploadSettings
  /** Resolves a document key to the URL to send the visitor to. */
  urlOf?: (key: string) => Promise<string | undefined>
}

export type FormSubmitOutcome =
  | { status: 'notFound' }
  | { status: 'badToken' }
  | { status: 'full'; form: SchemaForm }
  | { status: 'invalid'; form: SchemaForm; state: FormSubmissionState }
  | {
      status: 'ok'
      form: SchemaForm
      entryId: string | undefined
      spam: boolean
      /** How many workflows were queued to run after this. */
      queued: number
      state: FormSubmissionState
      /** Where to send a browser, when the form names a page. */
      redirectTo: string | undefined
    }

/** A salted hash, never an address: enough to rate-limit, not a liability. */
function hashIp(secret: string, ip: string | undefined): string | null {
  if (!ip) return null
  return hmac(secret, `ip|${ip}`).slice(0, 32)
}

/** The posted body as field alias to values, with the machinery left out. */
function readBody(data: FormData): SubmittedValues {
  const out: SubmittedValues = {}
  for (const [name, value] of data.entries()) {
    if (FORM_RESERVED_FIELDS.includes(name)) continue
    if (typeof value !== 'string') continue
    const values = out[name] ?? []
    values.push(value)
    out[name] = values
  }
  return out
}

const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
}

export async function submitForm(
  deps: FormSubmitDeps,
  request: Request,
  formKey: string,
  options: { ip?: string; now?: number } = {},
): Promise<FormSubmitOutcome> {
  const form = deps.forms.byKey(formKey)
  if (!form) return { status: 'notFound' }

  const secret = await formSigningSecret(deps.db)
  const data = await request.formData()
  const now = options.now ?? Date.now()

  const renderedAt = Number(data.get(FORM_RENDERED_FIELD) ?? 0)
  const token = String(data.get(FORM_TOKEN_FIELD) ?? '')
  // Always required: the renderer puts a token in every form it draws, so a
  // submission without a good one did not come from a page this site rendered.
  if (!verifyFormToken(secret, formKey, renderedAt, token)) return { status: 'badToken' }

  // Two guards, both silent. A bot is told the submission worked, because
  // telling it otherwise is how it learns to get past them.
  const honeypot = String(data.get(FORM_HONEYPOT_FIELD) ?? '').trim() !== ''
  const tooFast =
    form.minimumSubmitSeconds !== undefined &&
    renderedAt > 0 &&
    now - renderedAt < form.minimumSubmitSeconds * 1000
  const spam = honeypot || tooFast

  const entries = new FormEntryRepository(deps.db)
  const key = form.key ?? form.alias
  if (form.maxEntries !== undefined && (await entries.count(key)) >= form.maxEntries)
    return { status: 'full', form }

  const submitted = readBody(data)

  // Uploads take the same two steps a media upload takes, so the safe naming,
  // the type sniffing and the extension rules are the ones already tested.
  const refusedUploads: FormFieldError[] = []
  const uploads = allFormFields(form).filter((field) => field.type === 'fileUpload')
  for (const field of uploads) {
    const files = data.getAll(field.alias).filter((value): value is File => value instanceof File)
    const placed: string[] = []
    const name = field.caption || field.alias
    for (const file of files) {
      if (file.size === 0) continue
      // Refused before it is written anywhere.
      if (!isUploadAllowed(file.name, deps.uploads ?? DEFAULT_UPLOAD_SETTINGS)) {
        refusedUploads.push({
          field: field.alias,
          message: `${name} cannot be a ${extensionOf(file.name)} file`,
        })
        continue
      }
      if (field.maxSizeKb !== undefined && file.size > field.maxSizeKb * 1024) {
        refusedUploads.push({
          field: field.alias,
          message: `${name} must be smaller than ${field.maxSizeKb}KB`,
        })
        continue
      }
      const id = crypto.randomUUID()
      await deps.mediaFiles.saveTemporary(id, file)
      const result = await deps.mediaFiles.place(id)
      if (result) placed.push(result.src)
    }
    if (placed.length > 0) submitted[field.alias] = placed
  }

  const result = validateSubmission(form, submitted)
  // What the file rules refused, which core cannot know: it has no notion of a
  // file's bytes or of what a server could be made to execute.
  result.errors.push(...refusedUploads)

  if (result.errors.length > 0)
    return {
      status: 'invalid',
      form,
      state: { formKey: key, formAlias: form.alias, values: submitted, errors: result.errors },
    }

  let entryId: string | undefined
  if (form.storeEntries) {
    const entry = await entries.create({
      formKey: key,
      formAlias: form.alias,
      culture: null,
      pageKey: null,
      ipHash: hashIp(secret, options.ip),
      userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
      spam,
      values: result.values,
      // Approval holds an entry at `submitted` until somebody moves it; without
      // it the entry is final the moment it arrives.
      state: 'submitted',
    })
    entryId = entry.id
  }
  // Queued, not run: the entry is stored, and a workflow that fails must not
  // take the request with it. The job timer drains the queue.
  //
  // Spam is the exception — a workflow is an outbound effect, and firing one for
  // a submission already judged to be a bot is how a form becomes a relay.
  const triggered = spam ? [] : form.workflows.filter((workflow) => workflow.on === 'submit')
  if (triggered.length > 0)
    await new FormWorkflowRepository(deps.db).enqueue(
      triggered.map((workflow) => ({
        formKey: key,
        formAlias: form.alias,
        workflowName: workflow.name,
        workflowType: workflow.type,
        runOn: workflow.on,
        entryId: entryId ?? null,
        payload: result.values,
      })),
    )

  log.info('{form} received a submission{spam}', {
    form: form.alias,
    spam: spam ? ' (marked as spam)' : '',
  })

  const redirectTo = form.redirectTo ? await deps.urlOf?.(form.redirectTo) : undefined
  return {
    status: 'ok',
    form,
    entryId,
    spam,
    queued: triggered.length,
    redirectTo,
    state: {
      formKey: key,
      formAlias: form.alias,
      values: {},
      errors: [],
      message: form.messageOnSubmit ?? 'Thank you.',
    },
  }
}

/** Whether the caller wants JSON rather than a redirect back to the page. */
export function wantsJson(request: Request): boolean {
  if (request.headers.get('x-requested-with') === 'fetch') return true
  const accept = request.headers.get('accept') ?? ''
  // `text/html` anywhere means a browser navigation, whatever else it will take.
  return accept.includes('application/json') && !accept.includes('text/html')
}
