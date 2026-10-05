/**
 * E-mail through Amazon SES v2, signed with Signature Version 4.
 *
 * SES authenticates with a signature rather than a key, so the signing is here
 * rather than in an SDK. It is verified two ways in `tests/email.test.ts`:
 * against AWS's published signing-key derivation example, and against Bun's own
 * SigV4 — `Bun.S3Client.presign` is an independent implementation, and a
 * canonical request signed by both must come out identical. That is what makes
 * hand-rolled signing honest here rather than hopeful.
 *
 * Attachments mean a raw MIME message: SES's Simple content carries a subject
 * and a body and nothing else, so anything with a file becomes
 * `multipart/mixed` and goes through `Content.Raw`. Bcc stays out of the MIME
 * headers and travels in `Destination`, where it cannot leak to a recipient.
 *
 * Credentials come from the options, else from the environment AWS tools already
 * read (`AWS_ACCESS_KEY_ID` and friends). Instance roles are not resolved — that
 * needs the metadata service — so a container wanting SES needs static keys or
 * a session token.
 */
import { createHash, createHmac } from 'node:crypto'
import {
  assertSecureEndpoint,
  base64,
  type EmailAdapterOptions,
  type EmailAttachment,
  type EmailMessage,
  type EmailPort,
  formatAddress,
  postToProvider,
  validateMessage,
} from './email.ts'

export interface SesOptions extends EmailAdapterOptions {
  region: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  /** For a VPC endpoint or a local fake; the regional SES host otherwise. */
  endpoint?: string
  /** SES's configuration set, when one governs sending. */
  configurationSetName?: string
}

// ------------------------------------------------------------------ signature v4

const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data, 'utf8').digest()

const sha256Hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex')

/**
 * The four-step key derivation. Exported so the suite can hold it against
 * AWS's published example, which is the only way to know it is right.
 */
export function sigv4SigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request')
}

/** `AWS4-HMAC-SHA256` over the canonical request. Exported for the same reason. */
export function sigv4Signature(
  canonicalRequest: string,
  amzDate: string,
  scope: string,
  key: Buffer,
): string {
  return hmac(
    key,
    ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n'),
  ).toString('hex')
}

/** `20260105T020404Z`, which is the only timestamp format SigV4 accepts. */
export function amzDate(now: Date): string {
  return `${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')}`
}

interface SignedRequest {
  headers: Record<string, string>
}

/**
 * A POST signed for one service. Only what this adapter sends: a JSON body, no
 * query string, and the handful of headers that go with it.
 */
export function signPost(options: {
  url: URL
  body: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  now: Date
}): SignedRequest {
  const stamp = amzDate(options.now)
  const day = stamp.slice(0, 8)
  const payloadHash = sha256Hex(options.body)

  // `host` is signed but never set on the request: fetch owns that header, and
  // setting it is forbidden. Signing the value from the URL is what AWS expects.
  const signed: Record<string, string> = {
    'content-type': 'application/json',
    host: options.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  }
  if (options.sessionToken) signed['x-amz-security-token'] = options.sessionToken

  const names = Object.keys(signed).sort()
  const canonicalRequest = [
    'POST',
    options.url.pathname,
    '',
    `${names.map((name) => `${name}:${signed[name]}`).join('\n')}\n`,
    names.join(';'),
    payloadHash,
  ].join('\n')

  const scope = `${day}/${options.region}/${options.service}/aws4_request`
  const signature = sigv4Signature(
    canonicalRequest,
    stamp,
    scope,
    sigv4SigningKey(options.secretAccessKey, day, options.region, options.service),
  )

  const { host: _host, ...sendable } = signed
  return {
    headers: {
      ...sendable,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
        `SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
  }
}

// ------------------------------------------------------------------ MIME, for attachments

/** Base64 at the 76 characters per line the encoding requires. */
function wrapped(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join('\r\n')
}

/** A header value with anything outside ASCII encoded, which keeps subjects intact. */
function headerValue(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function bodyPart(contentType: string, content: string): string[] {
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(Buffer.from(content, 'utf8').toString('base64')),
  ]
}

function attachmentPart(attachment: EmailAttachment): string[] {
  const name = headerValue(attachment.filename)
  return [
    `Content-Type: ${attachment.contentType}; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(base64(attachment.bytes)),
  ]
}

/**
 * The message as `multipart/mixed`. Bcc is deliberately absent: it is an
 * envelope instruction, and a header here would show every blind recipient to
 * all the others.
 */
export function rawMime(
  message: EmailMessage,
  from: EmailMessage['from'],
  boundary: string,
): string {
  const alternative = `${boundary}-alt`
  const lines: string[] = [
    `From: ${formatAddress(from as NonNullable<typeof from>)}`,
    `To: ${message.to.map(formatAddress).join(', ')}`,
  ]
  if (message.cc?.length) lines.push(`Cc: ${message.cc.map(formatAddress).join(', ')}`)
  if (message.replyTo) lines.push(`Reply-To: ${formatAddress(message.replyTo)}`)
  lines.push(
    `Subject: ${headerValue(message.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
  )

  if (message.text && message.html) {
    // Both bodies offered, so the client picks: the nested alternative is what
    // makes a plain-text reader see text rather than markup.
    lines.push(
      `Content-Type: multipart/alternative; boundary="${alternative}"`,
      '',
      `--${alternative}`,
      ...bodyPart('text/plain', message.text),
      `--${alternative}`,
      ...bodyPart('text/html', message.html),
      `--${alternative}--`,
    )
  } else if (message.html) lines.push(...bodyPart('text/html', message.html))
  else lines.push(...bodyPart('text/plain', message.text ?? ''))

  for (const attachment of message.attachments ?? [])
    lines.push(`--${boundary}`, ...attachmentPart(attachment))

  lines.push(`--${boundary}--`, '')
  return lines.join('\r\n')
}

// ------------------------------------------------------------------ the adapter

export function sesEmail(options: SesOptions): EmailPort {
  if (!options.region) throw new Error('An SES e-mail adapter needs a region.')
  const accessKeyId = options.accessKeyId ?? Bun.env.AWS_ACCESS_KEY_ID ?? ''
  const secretAccessKey = options.secretAccessKey ?? Bun.env.AWS_SECRET_ACCESS_KEY ?? ''
  if (!accessKeyId || !secretAccessKey)
    throw new Error(
      'An SES e-mail adapter needs credentials: pass accessKeyId and secretAccessKey, or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. Instance roles are not resolved.',
    )
  const sessionToken = options.sessionToken ?? Bun.env.AWS_SESSION_TOKEN ?? undefined
  const call = options.fetch ?? fetch
  const base = options.endpoint ?? `https://email.${options.region}.amazonaws.com`
  assertSecureEndpoint(base, 'SES')
  const endpoint = new URL(`${base}/v2/email/outbound-emails`)

  return {
    description: `ses (${options.region})`,
    provider: 'ses',

    async send(message) {
      const from = message.from ?? options.from
      const invalid = validateMessage(message, from)
      if (invalid) return { ok: false, error: invalid }

      const destination = {
        ToAddresses: message.to.map(formatAddress),
        CcAddresses: message.cc?.length ? message.cc.map(formatAddress) : undefined,
        BccAddresses: message.bcc?.length ? message.bcc.map(formatAddress) : undefined,
      }
      const content = message.attachments?.length
        ? {
            Raw: {
              Data: Buffer.from(
                rawMime(message, from, `----bunbraco-${crypto.randomUUID()}`),
                'utf8',
              ).toString('base64'),
            },
          }
        : {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Text: message.text ? { Data: message.text, Charset: 'UTF-8' } : undefined,
                Html: message.html ? { Data: message.html, Charset: 'UTF-8' } : undefined,
              },
            },
          }

      const body = JSON.stringify({
        FromEmailAddress: formatAddress(from),
        Destination: destination,
        // Raw content carries its own Reply-To header, so it is not repeated.
        ReplyToAddresses:
          message.replyTo && !message.attachments?.length
            ? [formatAddress(message.replyTo)]
            : undefined,
        ConfigurationSetName: options.configurationSetName,
        Content: content,
      })

      const signed = signPost({
        url: endpoint,
        body,
        region: options.region,
        service: 'ses',
        accessKeyId,
        secretAccessKey,
        sessionToken,
        now: new Date(),
      })

      return postToProvider(
        call,
        endpoint.toString(),
        { method: 'POST', headers: signed.headers, body },
        (payload) => (payload as { MessageId?: string }).MessageId ?? null,
      )
    },
  }
}
