/**
 * E-mail through an endpoint the site owns.
 *
 * The escape hatch, and the answer for providers whose API cannot be reached
 * with a key alone — SES wants a SigV4 signature, and signing by hand is code
 * that cannot be honestly verified without an AWS account. A small function in
 * front of it, or any internal mail relay with an HTTP face, works here instead.
 *
 * The body is this CMS's own shape rather than any provider's, because the
 * endpoint on the other end is being written for it:
 *
 *   { from, to: [{email, name}], cc, bcc, replyTo, subject, text, html,
 *     attachments: [{filename, contentType, content}] }   // content is base64
 *
 * Any 2xx is a success. A JSON body with an `id` is recorded, and no body is
 * fine.
 */
import {
  assertSecureEndpoint,
  base64,
  type EmailAdapterOptions,
  type EmailPort,
  postToProvider,
  validateMessage,
} from './email.ts'

export interface CustomEmailOptions extends EmailAdapterOptions {
  url: string
  /** Sent as `authorization: Bearer …` when set. */
  apiKey?: string
  /** Anything else the endpoint needs. */
  headers?: Record<string, string>
}

export function customEmail(options: CustomEmailOptions): EmailPort {
  if (!options.url) throw new Error('A custom e-mail adapter needs a URL.')
  assertSecureEndpoint(options.url, 'custom')
  const call = options.fetch ?? fetch

  return {
    description: `custom (${options.url})`,
    provider: 'custom',

    async send(message) {
      const from = message.from ?? options.from
      const invalid = validateMessage(message, from)
      if (invalid) return { ok: false, error: invalid }

      return postToProvider(
        call,
        options.url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...options.headers,
          },
          body: JSON.stringify({
            from,
            to: message.to,
            cc: message.cc,
            bcc: message.bcc,
            replyTo: message.replyTo,
            subject: message.subject,
            text: message.text,
            html: message.html,
            attachments: message.attachments?.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.contentType,
              content: base64(attachment.bytes),
            })),
          }),
        },
        (body) => (body as { id?: string }).id ?? null,
      )
    },
  }
}
