/**
 * E-mail through Postmark's HTTPS API.
 *
 * Postmark separates transactional and broadcast traffic into message streams
 * and rejects a send to the wrong one, so `messageStream` is configurable and
 * defaults to the transactional stream every account has.
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

const ENDPOINT = 'https://api.postmarkapp.com/email'

export interface PostmarkOptions extends EmailAdapterOptions {
  /** Postmark calls it a server token; it is per-server, not per-account. */
  apiKey: string
  messageStream?: string
  endpoint?: string
}

export function postmarkEmail(options: PostmarkOptions): EmailPort {
  if (!options.apiKey) throw new Error('A Postmark e-mail adapter needs a server token.')
  const call = options.fetch ?? fetch
  const endpoint = options.endpoint ?? ENDPOINT
  assertSecureEndpoint(endpoint, 'Postmark')
  const stream = options.messageStream || 'outbound'

  return {
    description: stream === 'outbound' ? 'postmark' : `postmark (${stream})`,
    provider: 'postmark',

    async send(message) {
      const from = message.from ?? options.from
      const invalid = validateMessage(message, from)
      if (invalid) return { ok: false, error: invalid }

      // Postmark takes recipients as one comma-separated header value, not a list.
      const list = (addresses: typeof message.to | undefined) =>
        addresses && addresses.length > 0 ? addresses.map(formatAddress).join(', ') : undefined

      return postToProvider(
        call,
        endpoint,
        {
          method: 'POST',
          headers: {
            'x-postmark-server-token': options.apiKey,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            From: formatAddress(from),
            To: list(message.to),
            Cc: list(message.cc),
            Bcc: list(message.bcc),
            ReplyTo: message.replyTo ? formatAddress(message.replyTo) : undefined,
            Subject: message.subject,
            TextBody: message.text,
            HtmlBody: message.html,
            MessageStream: stream,
            Attachments: message.attachments?.map((attachment) => ({
              Name: attachment.filename,
              Content: base64(attachment.bytes),
              ContentType: attachment.contentType,
            })),
          }),
        },
        (body) => (body as { MessageID?: string }).MessageID ?? null,
      )
    },
  }
}
