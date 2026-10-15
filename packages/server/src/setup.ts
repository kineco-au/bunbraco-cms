/**
 * "Set up your new site": the first administrator, created from the browser on a
 * production install that was given no password. Guarded by `CROMBOLO_SETUP_CODE`,
 * which the owner chooses and which nothing here ever prints, logs or echoes.
 * docs/operations.md.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { hashPassword, passwordConfigJson } from '@crombolo/auth'
import {
  DEFAULT_PASSWORD_CONFIGURATION,
  isValidEmail,
  isValidPassword,
  type PasswordConfiguration,
} from '@crombolo/core'
import { completeSetup, type Db, readSetupState } from '@crombolo/data'

export const MIN_SETUP_CODE_LENGTH = 16
export const SETUP_CODE_VARIABLE = 'CROMBOLO_SETUP_CODE'

export type CodeCheck = 'unavailable' | 'accepted' | 'refused'

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Compared as digests, so neither the length nor the content leaks through timing. */
export function checkSetupCode(configured: string | undefined, given: string): CodeCheck {
  if (!configured || configured.length < MIN_SETUP_CODE_LENGTH) return 'unavailable'
  return timingSafeEqual(digest(configured), digest(given)) ? 'accepted' : 'refused'
}

export interface SetupForm {
  name: string
  email: string
  password: string
  confirm: string
  code: string
}

export type SetupErrors = Partial<Record<keyof SetupForm, string>>

export function validateSetupForm(
  form: SetupForm,
  passwords: PasswordConfiguration = DEFAULT_PASSWORD_CONFIGURATION,
): SetupErrors {
  const errors: SetupErrors = {}
  if (!form.name.trim()) errors.name = 'Enter your name.'
  if (!isValidEmail(form.email.trim())) errors.email = 'Enter an e-mail address.'
  if (!isValidPassword(form.password, passwords))
    errors.password = `Use at least ${passwords.minimumPasswordLength} characters.`
  else if (form.password !== form.confirm) errors.confirm = 'The passwords do not match.'
  if (!form.code) errors.code = 'Enter the setup code.'
  return errors
}

/** Failed attempts per caller within a window, and across all callers. */
export class AttemptLimiter {
  #failures = new Map<string, number[]>()
  #all: number[] = []
  readonly #max: number
  readonly #maxAll: number
  readonly #windowMs: number
  readonly #now: () => number

  constructor(
    options: { max?: number; maxAll?: number; windowMs?: number; now?: () => number } = {},
  ) {
    this.#max = options.max ?? 5
    this.#maxAll = options.maxAll ?? 50
    this.#windowMs = options.windowMs ?? 15 * 60_000
    this.#now = options.now ?? Date.now
  }

  #recent(times: number[]): number[] {
    const since = this.#now() - this.#windowMs
    return times.filter((t) => t > since)
  }

  blocked(key: string): boolean {
    this.#all = this.#recent(this.#all)
    const mine = this.#recent(this.#failures.get(key) ?? [])
    this.#failures.set(key, mine)
    return mine.length >= this.#max || this.#all.length >= this.#maxAll
  }

  fail(key: string): void {
    const now = this.#now()
    this.#failures.set(key, [...(this.#failures.get(key) ?? []), now])
    this.#all.push(now)
  }
}

export type SetupView =
  | { kind: 'unavailable' }
  | { kind: 'form'; errors: SetupErrors; name: string; email: string; limited?: boolean }
  | { kind: 'done'; backOfficePath: string }

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

function field(
  label: string,
  name: keyof SetupForm,
  type: string,
  errors: SetupErrors,
  value = '',
  autocomplete = 'off',
): string {
  const error = errors[name]
  return `<label for="${name}">${label}</label>
  <input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="${autocomplete}" required${error ? ` aria-invalid="true" aria-describedby="${name}-error"` : ''}>
  ${error ? `<p class="error" id="${name}-error">${escapeHtml(error)}</p>` : ''}`
}

/** The page itself: plain HTML, no script, so it works before anything else does. */
export function setupPage(view: SetupView, siteName: string): string {
  const site = escapeHtml(siteName)
  let body: string
  if (view.kind === 'unavailable') {
    body = `<h1>Set up your new site</h1>
  <p>${site} is running, and is ready for its first administrator.</p>
  <p>To protect this page, add a setting named <code>${SETUP_CODE_VARIABLE}</code> to the server, with a value of at least ${MIN_SETUP_CODE_LENGTH} characters that only you know. Restart the server, then come back to this page and enter it.</p>
  <p class="fine">Where you add settings depends on where the site runs: in your hosting provider's console it is usually called environment variables.</p>`
  } else if (view.kind === 'done') {
    body = `<h1>Your site is ready</h1>
  <p>Your administrator account has been created.</p>
  <p><a class="cta" href="${escapeHtml(view.backOfficePath)}">Sign in</a></p>
  <p class="fine">You can now remove the <code>${SETUP_CODE_VARIABLE}</code> setting from the server: it is not needed again.</p>`
  } else {
    const { errors } = view
    body = `<h1>Set up your new site</h1>
  <p>Create the administrator account for ${site}.</p>
  ${view.limited ? '<p class="error" role="alert">Too many attempts. Wait a few minutes and try again.</p>' : ''}
  <form method="post">
  ${field('Your name', 'name', 'text', errors, view.name, 'name')}
  ${field('E-mail', 'email', 'email', errors, view.email, 'email')}
  ${field('Password', 'password', 'password', errors, '', 'new-password')}
  ${field('Confirm password', 'confirm', 'password', errors, '', 'new-password')}
  ${field('Setup code', 'code', 'password', errors)}
  <p class="fine">The setup code is the value of the <code>${SETUP_CODE_VARIABLE}</code> setting on the server.</p>
  <button type="submit">Create the account</button>
  </form>`
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Set up your new site</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f6f5f3; color: #1b1b1b; }
  main { width: 100%; max-width: 30rem; padding: 2.5rem 1rem; box-sizing: border-box; }
  h1 { font-size: 1.6rem; margin: 0 0 .75rem; }
  p { margin: 0 0 1rem; }
  label { display: block; font-weight: 600; margin: 1rem 0 .25rem; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; border: 1px solid #b9b6ae; border-radius: 4px; }
  button, a.cta { display: inline-block; margin-top: 1.25rem; padding: .55rem 1rem; border: 0; border-radius: 4px;
    background: #1b1b1b; color: #fff; font: inherit; text-decoration: none; cursor: pointer; }
  code { font-size: .9em; background: #e9e7e2; padding: .1em .35em; border-radius: 3px; }
  .error { color: #a3261b; margin: .25rem 0 0; }
  .fine { font-size: .85rem; color: #6b6b63; }
  @media (prefers-color-scheme: dark) {
    body { background: #16171a; color: #e8e6e3; }
    input { background: #1f2124; color: inherit; border-color: #45474b; }
    code { background: #26282c; }
    button, a.cta { background: #e8e6e3; color: #16171a; }
    .error { color: #f08a7e; }
    .fine { color: #9a9a93; }
  }
</style>
</head>
<body>
<main>
  ${body}
</main>
</body>
</html>
`
}

export interface SetupRoutesOptions {
  db: Db
  setupCode: string | undefined
  siteName: string
  backOfficePath: string
  /** Who is asking, for the attempt limit. */
  clientKey: (request: Request) => string
  limiter?: AttemptLimiter
  passwords?: PasswordConfiguration
}

export interface SetupRoutes {
  readonly path: string
  /** True until the first administrator exists; read from the database until then. */
  pending(): Promise<boolean>
  handle(request: Request): Promise<Response>
}

const page = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  })

export function createSetupRoutes(options: SetupRoutesOptions): SetupRoutes {
  const path = `${options.backOfficePath}/setup`
  const limiter = options.limiter ?? new AttemptLimiter()
  let closed = false

  const pending = async () => {
    if (closed) return false
    const state = await readSetupState(options.db)
    if (state !== 'pending') closed = true
    return state === 'pending'
  }

  const render = (view: SetupView, status = 200) => page(setupPage(view, options.siteName), status)
  const formView = (
    errors: SetupErrors,
    form?: Partial<SetupForm>,
    limited = false,
  ): SetupView => ({
    kind: 'form',
    errors,
    name: form?.name ?? '',
    email: form?.email ?? '',
    limited,
  })

  return {
    path,
    pending,
    async handle(request) {
      if (!(await pending()))
        return new Response(null, { status: 303, headers: { location: options.backOfficePath } })
      const configured = checkSetupCode(options.setupCode, '')
      if (configured === 'unavailable') return render({ kind: 'unavailable' })
      if (request.method === 'GET') return render(formView({}))
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

      const origin = request.headers.get('origin')
      if (origin && origin !== new URL(request.url).origin)
        return new Response('Forbidden', { status: 403 })

      const key = options.clientKey(request)
      const data = await request.formData().catch(() => new FormData())
      const value = (name: string) => {
        const entry = data.get(name)
        return typeof entry === 'string' ? entry : ''
      }
      const form: SetupForm = {
        name: value('name'),
        email: value('email'),
        password: value('password'),
        confirm: value('confirm'),
        code: value('code'),
      }
      if (limiter.blocked(key)) return render(formView({}, form, true), 429)
      const errors = validateSetupForm(form, options.passwords)
      if (Object.keys(errors).length > 0) return render(formView(errors, form), 400)
      if (checkSetupCode(options.setupCode, form.code) !== 'accepted') {
        limiter.fail(key)
        return render(formView({ code: 'That is not the setup code.' }, form), 400)
      }

      const email = form.email.trim()
      const result = await completeSetup(
        options.db,
        { name: form.name.trim(), login: email, email, password: form.password },
        { hashPassword, passwordConfig: passwordConfigJson() },
      )
      closed = true
      if (result === 'closed')
        return new Response(null, { status: 303, headers: { location: options.backOfficePath } })
      return render({ kind: 'done', backOfficePath: options.backOfficePath })
    },
  }
}
