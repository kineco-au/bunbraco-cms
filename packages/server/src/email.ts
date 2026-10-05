/**
 * Sending e-mail: a port, HTTP adapters, and an honest answer when there is none.
 *
 * Strictly opt-in. A site that configures no provider has no e-mail, which is
 * the default — and the features that need it (user invitations, password
 * resets, and the Forms `sendEmail` workflow) must become *unavailable* rather
 * than fail when someone presses the button. `emailAvailability` is what they
 * ask, and it carries the reason so the answer can be shown to a person instead
 * of logged and lost.
 *
 * `send` never throws. A provider that is down, a key that is wrong and a
 * network that is gone all come back as `{ ok: false, error }`, because the
 * callers are a job runner and an invitation flow: both need to record a failure
 * and carry on, and neither can usefully catch.
 *
 * No SMTP. Outbound 25/587 is blocked on most container hosts, so a hand-rolled
 * SMTP client would be protocol risk in exchange for a path that often cannot be
 * used. These adapters are plain `fetch` against a provider's HTTPS API, so this
 * file adds no dependency.
 */
import { isValidEmail } from '@bunbraco/core'
import { customEmail } from './email-http.ts'
import { postmarkEmail } from './email-postmark.ts'
import { resendEmail } from './email-resend.ts'
import { sesEmail } from './email-ses.ts'
import { logger } from './logging.ts'

export interface EmailAddress {
  email: string
  name?: string
}

export interface EmailAttachment {
  filename: string
  contentType: string
  bytes: Uint8Array
}

export interface EmailMessage {
  to: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  replyTo?: EmailAddress
  /** Overrides the adapter's configured sender, which is the usual case. */
  from?: EmailAddress
  subject: string
  text?: string
  html?: string
  attachments?: EmailAttachment[]
}

export type EmailResult = { ok: true; id: string | null } | { ok: false; error: string }

/** Which adapter is in play; named in logs and in the availability report. */
export type EmailProvider = 'resend' | 'postmark' | 'ses' | 'custom' | 'log'

export interface EmailPort {
  /** Named in the boot banner and in logs: `resend`, `postmark (broadcast)`, … */
  readonly description: string
  readonly provider: EmailProvider
  send(message: EmailMessage): Promise<EmailResult>
}

/** What an adapter needs from every site that configures it. */
export interface EmailAdapterOptions {
  /** The sender a message uses when it names none. Providers verify this domain. */
  from: EmailAddress
  /** Overridden by tests; nothing here keeps a client of its own. */
  fetch?: typeof fetch

  apiKey?: string
}

// ------------------------------------------------------------------ shared helpers

/** `Name <addr@example.com>`, or the bare address when there is no name. */
export function formatAddress(address: EmailAddress): string {
  // A name with a comma or a quote would break the header it lands in, so it is
  // quoted and escaped rather than rejected: a person's name is not input to
  // validate, it is data to carry.
  if (!address.name) return address.email
  return `"${address.name.replace(/[\\"]/g, '\\$&')}" <${address.email}>`
}

/**
 * Hosts where plain HTTP cannot leave the machine.
 *
 * A mail relay in a sidecar, reached on `http://localhost:8025`, is a real
 * deployment and nothing about it is on a wire. Anything else is not: a
 * service name inside a cluster still crosses the pod boundary, so it is held
 * to HTTPS like everything else.
 */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

/**
 * Refuses an endpoint that would carry credentials in cleartext.
 *
 * Every adapter authenticates with something worth stealing — a bearer token,
 * a server token, a SigV4 `Authorization` header — so an `http://` endpoint is
 * a configuration error, not a preference. Checked at construction: a site that
 * gets this wrong fails at boot rather than leaking on its first send.
 */
export function assertSecureEndpoint(endpoint: string, adapter: string): void {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`The ${adapter} e-mail adapter needs a valid URL; '${endpoint}' is not one.`)
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return
  throw new Error(
    `The ${adapter} e-mail adapter refuses '${endpoint}': credentials would travel in cleartext. Use https, or http on localhost for a relay on this machine.`,
  )
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * The checks every adapter would otherwise repeat. A message with no recipient
 * or no body is a programming error that must not reach a provider, where it
 * would be charged for and rejected.
 */
export function validateMessage(message: EmailMessage, from: EmailAddress): string | undefined {
  const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]
  if (recipients.length === 0) return 'the message has no recipient'
  const bad = recipients.find((address) => !isValidEmail(address.email))
  if (bad) return `'${bad.email}' is not a valid e-mail address`
  if (!isValidEmail(from.email)) return `the sender '${from.email}' is not a valid e-mail address`
  if (!message.subject.trim()) return 'the message has no subject'
  if (!message.text && !message.html) return 'the message has no body'
  return undefined
}

/**
 * A provider call, with every failure mode flattened into `EmailResult`.
 *
 * `fetch` throws on DNS and TLS failures, `response.json()` throws on a provider
 * returning an error page, and a 4xx is neither. All three are the same thing to
 * a caller: the mail did not go.
 */
export async function postToProvider(
  call: typeof fetch,
  url: string,
  init: RequestInit,
  readId: (body: unknown) => string | null,
): Promise<EmailResult> {
  let response: Response
  try {
    response = await call(url, init)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const body = await response.text()
  if (!response.ok) {
    // The provider's own message is the useful part; it names the wrong key or
    // the unverified domain. Truncated, because some return an HTML page.
    const detail = body.trim().slice(0, 500)
    return {
      ok: false,
      error: `the provider answered ${response.status}${detail ? `: ${detail}` : ''}`,
    }
  }
  try {
    return { ok: true, id: readId(body ? JSON.parse(body) : {}) }
  } catch {
    // Accepted but unparseable: the mail went, and the id is the only loss.
    return { ok: true, id: null }
  }
}

// ------------------------------------------------------------------ the log adapter

/**
 * Development's stand-in: the message on the console, in full.
 *
 * This is a real port, so invitations and resets work locally with nothing
 * configured — but `emailAvailability` reports it as `log`, so a site cannot
 * mistake it for delivery.
 */
export function logEmail(): EmailPort {
  const log = logger('email')
  return {
    description: 'log (nothing is sent)',
    provider: 'log',
    async send(message) {
      log.info('E-mail to {to}: {subject}', {
        to: message.to.map((address) => address.email).join(', '),
        subject: message.subject,
        body: message.text ?? message.html ?? '',
      })
      return { ok: true, id: null }
    },
  }
}

// ------------------------------------------------------------------ availability

/** Why e-mail is unavailable, and what that costs — shown to a person, not logged. */
export interface EmailAvailability {
  /** Whether a message would actually leave this site. */
  available: boolean
  provider: EmailProvider | null
  description: string | null
  /** Present when `available` is false: one sentence someone can act on. */
  reason: string | null
  /** What is turned off because of it, by name. */
  affects: string[]
}

/** The features that need e-mail, named the way the backoffice names them. */
export const EMAIL_DEPENDENT_FEATURES = [
  'Inviting backoffice users',
  'Password reset by e-mail',
  "Forms' Send email workflow",
]

export const EMAIL_SETUP_HINT =
  'Set BUNBRACO_EMAIL_PROVIDER to resend, postmark or custom with its key and BUNBRACO_EMAIL_FROM, or pass `email` in bunbraco.config.ts. See docs/14-configuration.md.'

export function emailAvailability(port: EmailPort | undefined): EmailAvailability {
  if (!port)
    return {
      available: false,
      provider: null,
      description: null,
      reason: `No e-mail provider is configured. ${EMAIL_SETUP_HINT}`,
      affects: [...EMAIL_DEPENDENT_FEATURES],
    }
  if (port.provider === 'log')
    return {
      available: false,
      provider: 'log',
      description: port.description,
      reason:
        'E-mail is written to the console in development, not sent. Configure a provider before relying on it.',
      affects: [],
    }
  return {
    available: true,
    provider: port.provider,
    description: port.description,
    reason: null,
    affects: [],
  }
}

// ------------------------------------------------------------------ from the environment

export type EmailProviderKind = 'none' | 'resend' | 'postmark' | 'ses' | 'custom'

/**
 * The provider the environment asks for. `BUNBRACO_EMAIL_PROVIDER` picks it and
 * each kind reads its own variables:
 *
 *   BUNBRACO_EMAIL_PROVIDER=resend
 *   BUNBRACO_EMAIL_API_KEY=re_…
 *   BUNBRACO_EMAIL_FROM=no-reply@example.com
 *   BUNBRACO_EMAIL_FROM_NAME=Example           (optional)
 *
 *   BUNBRACO_EMAIL_PROVIDER=postmark
 *   BUNBRACO_EMAIL_API_KEY=…                   (server token)
 *   BUNBRACO_EMAIL_POSTMARK_STREAM=outbound    (optional)
 *
 *   BUNBRACO_EMAIL_PROVIDER=ses
 *   BUNBRACO_EMAIL_SES_REGION=ap-southeast-2
 *   AWS_ACCESS_KEY_ID=… / AWS_SECRET_ACCESS_KEY=…   (or the BUNBRACO_EMAIL_SES_* pair)
 *
 *   BUNBRACO_EMAIL_PROVIDER=custom
 *   BUNBRACO_EMAIL_URL=https://…               (your endpoint)
 *   BUNBRACO_EMAIL_API_KEY=…                   (sent as a bearer token)
 *
 * Unset, or `none`, means no e-mail — the default. An unrecognised value or a
 * provider missing its key is *also* no e-mail, with a warning naming what is
 * wrong: a typo must leave the site bootable, not half-configured.
 */
/**
 * An adapter built from the environment, where a configuration error has to be
 * a warning rather than a crash: a site must still boot and report e-mail as
 * unavailable, which is the whole contract of this being opt-in.
 */
function built(
  kind: string,
  log: { warning(message: string, properties?: Record<string, unknown>): void },
  make: () => EmailPort,
): EmailPort | undefined {
  try {
    return make()
  } catch (error) {
    log.warning('BUNBRACO_EMAIL_PROVIDER is {kind} but {detail} E-mail is off.', {
      kind,
      detail: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

export function emailFromEnvironment(
  env: Record<string, string | undefined> = Bun.env,
  log: { warning(message: string, properties?: Record<string, unknown>): void } = logger('email'),
): EmailPort | undefined {
  const kind = (env.BUNBRACO_EMAIL_PROVIDER ?? 'none').toLowerCase()
  if (kind === 'none' || kind === '') return undefined

  if (kind !== 'resend' && kind !== 'postmark' && kind !== 'ses' && kind !== 'custom') {
    log.warning('BUNBRACO_EMAIL_PROVIDER is {kind}, which is not a provider. {known}', {
      kind,
      known: 'Use resend, postmark, ses, custom or none. E-mail is off.',
    })
    return undefined
  }

  const address = env.BUNBRACO_EMAIL_FROM ?? ''
  if (!isValidEmail(address)) {
    log.warning('BUNBRACO_EMAIL_PROVIDER is {kind} but {missing}. E-mail is off.', {
      kind,
      missing: address
        ? `BUNBRACO_EMAIL_FROM ('${address}') is not a valid address`
        : 'BUNBRACO_EMAIL_FROM is not set',
    })
    return undefined
  }
  const from: EmailAddress = { email: address, name: env.BUNBRACO_EMAIL_FROM_NAME || undefined }
  const apiKey = env.BUNBRACO_EMAIL_API_KEY ?? ''

  if (kind === 'ses') {
    const region = env.BUNBRACO_EMAIL_SES_REGION ?? env.AWS_REGION ?? ''
    if (!region) {
      log.warning('BUNBRACO_EMAIL_PROVIDER is ses but no region is set. {off}', {
        off: 'Set BUNBRACO_EMAIL_SES_REGION or AWS_REGION. E-mail is off.',
      })
      return undefined
    }
    return built(kind, log, () =>
      sesEmail({
        from,
        region,
        // Defaulted to empty rather than left undefined, so what the environment
        // holds is the whole answer: the adapter's own fallback to `Bun.env`
        // would otherwise make this depend on variables not passed in here.
        accessKeyId: env.BUNBRACO_EMAIL_SES_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey:
          env.BUNBRACO_EMAIL_SES_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? '',
        sessionToken: env.AWS_SESSION_TOKEN,
        endpoint: env.BUNBRACO_EMAIL_SES_ENDPOINT,
        configurationSetName: env.BUNBRACO_EMAIL_SES_CONFIGURATION_SET,
      }),
    )
  }

  if (kind === 'custom') {
    const url = env.BUNBRACO_EMAIL_URL ?? ''
    if (!url) {
      log.warning('BUNBRACO_EMAIL_PROVIDER is custom but BUNBRACO_EMAIL_URL is not set. {off}', {
        off: 'E-mail is off.',
      })
      return undefined
    }
    return built(kind, log, () => customEmail({ from, url, apiKey }))
  }

  if (!apiKey) {
    log.warning('BUNBRACO_EMAIL_PROVIDER is {kind} but BUNBRACO_EMAIL_API_KEY is not set. {off}', {
      kind,
      off: 'E-mail is off.',
    })
    return undefined
  }

  return built(kind, log, () =>
    kind === 'resend'
      ? resendEmail({ from, apiKey, endpoint: env.BUNBRACO_EMAIL_URL })
      : postmarkEmail({
          from,
          apiKey,
          endpoint: env.BUNBRACO_EMAIL_URL,
          messageStream: env.BUNBRACO_EMAIL_POSTMARK_STREAM,
        }),
  )
}

/**
 * The port a site ends up with, from the three states of `config.email`.
 *
 * Structural rather than taking `BunbracoConfig`, so this file stays free of
 * the config module and can be used from anywhere that knows those two fields.
 */
export function resolveEmailPort(
  config: { email?: EmailPort | null; development?: boolean },
  env?: Record<string, string | undefined>,
): EmailPort | undefined {
  if (config.email === null) return undefined
  if (config.email) return config.email
  // The console stand-in is development only: a production node with nothing
  // configured must report e-mail as unavailable, not quietly swallow messages.
  return emailFromEnvironment(env) ?? (config.development ? logEmail() : undefined)
}
