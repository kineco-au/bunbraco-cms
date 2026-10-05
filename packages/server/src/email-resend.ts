/**
 * E-mail through Resend's HTTPS API.
 *
 * One POST, a bearer token, no SDK. Resend verifies the sending domain, so a
 * `from` outside a verified domain comes back as a 403 the caller can show.
 */
import {
  assertSecureEndpoint,
  base64,
  type EmailAdapterOptions,
  type EmailPort,
  formatAddress,
  postToProvider,
  validateMessage,
} from './email.ts'

const ENDPOINT = 'https://api.resend.com/emails'

export interface ResendOptions extends EmailAdapterOptions {
  apiKey: string
  /** For a self-hosted or proxied Resend-compatible endpoint. */
  endpoint?: string
}

export function resendEmail(options: ResendOptions): EmailPort {
  if (!options.apiKey) throw new Error('A Resend e-mail adapter needs an API key.')
  const call = options.fetch ?? fetch
  const endpoint = options.endpoint ?? ENDPOINT
  assertSecureEndpoint(endpoint, 'Resend')

  return {
    description: 'resend',
    provider: 'resend',

    async send(message) {
      const from = message.from ?? options.from
      const invalid = validateMessage(message, from)
      if (invalid) return { ok: false, error: invalid }

      return postToProvider(
        call,
        endpoint,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: formatAddress(from),
            to: message.to.map(formatAddress),
            cc: message.cc?.map(formatAddress),
            bcc: message.bcc?.map(formatAddress),
            reply_to: message.replyTo ? formatAddress(message.replyTo) : undefined,
            subject: message.subject,
            text: message.text,
            html: message.html,
            attachments: message.attachments?.map((attachment) => ({
              filename: attachment.filename,
              content: base64(attachment.bytes),
              content_type: attachment.contentType,
            })),
          }),
        },
        (body) => (body as { id?: string }).id ?? null,
      )
    },
  }
}
