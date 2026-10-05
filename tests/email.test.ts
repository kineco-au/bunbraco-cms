/**
 * Phase 0 of Forms (`docs/18-forms.md`): e-mail as a port, opt-in, and the
 * features that need it unavailable-with-a-reason when there is none.
 *
 * The exit: a site with no provider boots, says what it cannot do, and refuses
 * to offer a password reset or an invitation that could never arrive.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  assertSecureEndpoint,
  customEmail,
  type EmailAddress,
  type EmailMessage,
  type EmailPort,
  emailAvailability,
  emailFromEnvironment,
  formatAddress,
  logEmail,
  noticeAboutEmail,
  postmarkEmail,
  rawMime,
  resendEmail,
  resolveEmailPort,
  sesEmail,
  signPost,
  sigv4Signature,
  sigv4SigningKey,
  validateMessage,
} from '@bunbraco/server'
import { BACKOFFICE, type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

const FROM: EmailAddress = { email: 'no-reply@example.com', name: 'Example' }
const TO: EmailAddress[] = [{ email: 'someone@example.com', name: 'Someone' }]
/** The built-in Writers group, which an invitation has to name. */
const WRITER = '9fc2a16f-528c-46d6-a014-75bf4ec2480c'

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: TO,
  subject: 'Hello',
  text: 'Body',
  ...overrides,
})

/** A fetch that records what it was asked and answers what the test wants. */
function recorder(responses: Response[] | (() => Promise<Response>)) {
  const calls: { url: string; init: RequestInit }[] = []
  const queue = Array.isArray(responses) ? [...responses] : undefined
  const call = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    if (queue) return queue.shift() ?? new Response('{}', { status: 200 })
    return (responses as () => Promise<Response>)()
  }) as unknown as typeof fetch
  const body = (index = 0) =>
    JSON.parse(String(calls[index]?.init.body ?? '{}')) as Record<string, unknown>
  const headers = (index = 0) => (calls[index]?.init.headers ?? {}) as Record<string, string>
  return { calls, call, body, headers }
}

const ok = (payload: unknown = {}) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** A port that records, for the server-level tests. */
function capturingPort(result: 'ok' | 'fail' = 'ok'): EmailPort & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = []
  return {
    sent,
    description: 'test',
    provider: 'custom',
    async send(outgoing) {
      sent.push(outgoing)
      return result === 'ok' ? { ok: true, id: 'test-1' } : { ok: false, error: 'the test said no' }
    },
  }
}

const warnings: { message: string; properties?: Record<string, unknown> }[] = []
const collectingLog = {
  warning(message: string, properties?: Record<string, unknown>) {
    warnings.push({ message, properties })
  },
}

describe('addresses and validation', () => {
  test('an address formats bare, with a name, and with a name that would break the header', () => {
    expect(formatAddress({ email: 'a@example.com' })).toBe('a@example.com')
    expect(formatAddress({ email: 'a@example.com', name: 'Ada' })).toBe('"Ada" <a@example.com>')
    // A comma would split the header and a quote would end the phrase; both are
    // data to carry, not input to reject.
    expect(formatAddress({ email: 'a@example.com', name: 'Lovelace, Ada' })).toBe(
      '"Lovelace, Ada" <a@example.com>',
    )
    expect(formatAddress({ email: 'a@example.com', name: 'Ada "A" L' })).toBe(
      '"Ada \\"A\\" L" <a@example.com>',
    )
  })

  test('a message with nothing to send never reaches a provider', () => {
    expect(validateMessage(message({ to: [] }), FROM)).toBe('the message has no recipient')
    expect(validateMessage(message({ subject: '   ' }), FROM)).toBe('the message has no subject')
    expect(validateMessage(message({ text: undefined }), FROM)).toBe('the message has no body')
    expect(validateMessage(message({ to: [{ email: 'not-an-address' }] }), FROM)).toContain(
      'not a valid e-mail address',
    )
    expect(validateMessage(message(), { email: 'bad' })).toContain("the sender 'bad'")
    expect(validateMessage(message(), FROM)).toBeUndefined()
    // html alone is a body too
    expect(validateMessage(message({ text: undefined, html: '<p>hi</p>' }), FROM)).toBeUndefined()
    // a bcc-only message has a recipient
    expect(validateMessage(message({ to: [], bcc: TO }), FROM)).toBeUndefined()
  })
})

describe('cleartext endpoints', () => {
  test('https is required, because every adapter sends a credential', () => {
    expect(() => assertSecureEndpoint('https://api.example.com/send', 'test')).not.toThrow()
    expect(() => assertSecureEndpoint('http://mail.internal/send', 'test')).toThrow(
      'credentials would travel in cleartext',
    )
  })

  test('loopback over http is allowed: a sidecar relay is never on a wire', () => {
    for (const url of [
      'http://localhost:8025/send',
      'http://127.0.0.1:8025/send',
      'http://127.0.0.2/send',
      'http://[::1]:8025/send',
    ])
      expect(() => assertSecureEndpoint(url, 'test')).not.toThrow()
  })

  test('a host that merely looks local still crosses a boundary, so it is refused', () => {
    // A service name inside a cluster leaves the pod; only loopback does not.
    for (const url of ['http://mail-relay/send', 'http://localhost.example.com/send'])
      expect(() => assertSecureEndpoint(url, 'test')).toThrow('cleartext')
  })

  test('something that is not a URL is named as such, not reported as insecure', () => {
    expect(() => assertSecureEndpoint('mail.internal/send', 'test')).toThrow('is not one')
  })

  test('every adapter refuses one at construction, before a credential can leak', () => {
    expect(() =>
      resendEmail({ from: FROM, apiKey: 'k', endpoint: 'http://api.example.com/send' }),
    ).toThrow('cleartext')
    expect(() =>
      postmarkEmail({ from: FROM, apiKey: 'k', endpoint: 'http://api.example.com/send' }),
    ).toThrow('cleartext')
    expect(() =>
      sesEmail({
        from: FROM,
        region: 'us-east-1',
        accessKeyId: 'a',
        secretAccessKey: 'b',
        endpoint: 'http://ses.internal',
      }),
    ).toThrow('cleartext')
    expect(() => customEmail({ from: FROM, url: 'http://mail.internal/send' })).toThrow('cleartext')
  })
})

describe('the resend adapter', () => {
  test('sends one POST with a bearer token and returns the provider id', async () => {
    const fake = recorder([ok({ id: 'resend-1' })])
    const port = resendEmail({ from: FROM, apiKey: 'key', fetch: fake.call })
    expect(port.provider).toBe('resend')
    const result = await port.send(message({ cc: [{ email: 'c@example.com' }], replyTo: FROM }))

    expect(result).toEqual({ ok: true, id: 'resend-1' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.headers().authorization).toBe('Bearer key')
    expect(fake.body().from).toBe('"Example" <no-reply@example.com>')
    expect(fake.body().to).toEqual(['"Someone" <someone@example.com>'])
    expect(fake.body().cc).toEqual(['c@example.com'])
    expect(fake.body().reply_to).toBe('"Example" <no-reply@example.com>')
  })

  test('an attachment travels as base64', async () => {
    const fake = recorder([ok({ id: 'x' })])
    const port = resendEmail({ from: FROM, apiKey: 'key', fetch: fake.call })
    await port.send(
      message({
        attachments: [
          { filename: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('hi') },
        ],
      }),
    )
    expect(fake.body().attachments).toEqual([
      { filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' },
    ])
  })

  test("the provider's own refusal is the error, because it names the cause", async () => {
    const fake = recorder([new Response('{"message":"domain is not verified"}', { status: 403 })])
    const port = resendEmail({ from: FROM, apiKey: 'key', fetch: fake.call })
    const result = await port.send(message())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('403')
    expect(result.ok === false && result.error).toContain('domain is not verified')
  })

  test('a network that is gone is a failed send, not a thrown exception', async () => {
    const port = resendEmail({
      from: FROM,
      apiKey: 'key',
      fetch: (async () => {
        throw new Error('getaddrinfo ENOTFOUND api.resend.com')
      }) as unknown as typeof fetch,
    })
    const result = await port.send(message())
    expect(result).toEqual({ ok: false, error: 'getaddrinfo ENOTFOUND api.resend.com' })
  })

  test('accepted but unparseable is still accepted; the id is the only loss', async () => {
    const fake = recorder([new Response('OK', { status: 202 })])
    const port = resendEmail({ from: FROM, apiKey: 'key', fetch: fake.call })
    expect(await port.send(message())).toEqual({ ok: true, id: null })
  })

  test('an invalid message is refused before any request is made', async () => {
    const fake = recorder([ok()])
    const port = resendEmail({ from: FROM, apiKey: 'key', fetch: fake.call })
    expect((await port.send(message({ to: [] }))).ok).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  test('an adapter with no key is a configuration error at construction', () => {
    expect(() => resendEmail({ from: FROM, apiKey: '' })).toThrow('needs an API key')
  })
})

describe('the postmark adapter', () => {
  test('uses the server-token header and one comma-separated recipient list', async () => {
    const fake = recorder([ok({ MessageID: 'pm-1' })])
    const port = postmarkEmail({ from: FROM, apiKey: 'token', fetch: fake.call })
    const result = await port.send(
      message({ to: [{ email: 'a@example.com' }, { email: 'b@example.com', name: 'B' }] }),
    )
    expect(result).toEqual({ ok: true, id: 'pm-1' })
    expect(fake.headers()['x-postmark-server-token']).toBe('token')
    expect(fake.body().To).toBe('a@example.com, "B" <b@example.com>')
    expect(fake.body().MessageStream).toBe('outbound')
    expect(fake.body().TextBody).toBe('Body')
  })

  test('an absent cc is absent rather than an empty string', async () => {
    const fake = recorder([ok({ MessageID: 'x' })])
    await postmarkEmail({ from: FROM, apiKey: 't', fetch: fake.call }).send(message())
    expect('Cc' in fake.body()).toBe(false)
  })

  test('a non-default message stream is named in the description, so logs say which', () => {
    expect(postmarkEmail({ from: FROM, apiKey: 't' }).description).toBe('postmark')
    expect(postmarkEmail({ from: FROM, apiKey: 't', messageStream: 'broadcast' }).description).toBe(
      'postmark (broadcast)',
    )
  })
})

describe('signature version 4', () => {
  test("derives the signing key as AWS's own published example does", () => {
    // From AWS's "Examples of how to derive a signing key for Signature
    // Version 4". Hand-rolled signing is only defensible against a known
    // answer, and this is the known answer.
    expect(
      sigv4SigningKey(
        'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        '20120215',
        'us-east-1',
        'iam',
      ).toString('hex'),
    ).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d')
  })

  test("signs a canonical request identically to Bun's own SigV4", () => {
    // A second, independent implementation: `Bun.S3Client.presign` signs with
    // SigV4 too. Signing the same canonical request must give the same bytes,
    // which checks the canonicalisation and the string-to-sign as well as the
    // key — the parts a derivation vector alone does not reach.
    const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
    const client = new Bun.S3Client({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: secret,
      region: 'us-east-1',
      bucket: 'examplebucket',
    })
    const url = new URL(client.presign('test.txt', { expiresIn: 86400, method: 'GET' }))
    const theirs = url.searchParams.get('X-Amz-Signature') as string
    const stamp = url.searchParams.get('X-Amz-Date') as string
    const day = stamp.slice(0, 8)

    const encode = (value: string) =>
      encodeURIComponent(value).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      )
    const query = [...url.searchParams]
      .filter(([name]) => name !== 'X-Amz-Signature')
      .map(([name, value]) => [encode(name), encode(value)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('&')
    const canonical = [
      'GET',
      url.pathname,
      query,
      `host:${url.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')

    const mine = sigv4Signature(
      canonical,
      stamp,
      `${day}/us-east-1/s3/aws4_request`,
      sigv4SigningKey(secret, day, 'us-east-1', 's3'),
    )
    expect(mine).toBe(theirs)
  })

  test('a signed POST carries the headers it signed, and never sets host', () => {
    const signed = signPost({
      url: new URL('https://email.ap-southeast-2.amazonaws.com/v2/email/outbound-emails'),
      body: '{"a":1}',
      region: 'ap-southeast-2',
      service: 'ses',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      now: new Date('2026-01-05T02:04:04.000Z'),
    })
    expect(signed.headers.authorization).toContain(
      'Credential=AKID/20260105/ap-southeast-2/ses/aws4_request',
    )
    expect(signed.headers.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date',
    )
    expect(signed.headers['x-amz-date']).toBe('20260105T020404Z')
    // fetch owns Host; setting it is forbidden, so it is signed and not sent.
    expect('host' in signed.headers).toBe(false)
    expect(signed.headers['x-amz-security-token']).toBeUndefined()
  })

  test('a session token joins the signed headers, or a temporary key is rejected', () => {
    const signed = signPost({
      url: new URL('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails'),
      body: '{}',
      region: 'us-east-1',
      service: 'ses',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      sessionToken: 'token',
      now: new Date('2026-01-05T02:04:04.000Z'),
    })
    expect(signed.headers['x-amz-security-token']).toBe('token')
    expect(signed.headers.authorization).toContain('x-amz-security-token')
  })

  test('the same request signed twice at the same instant is the same signature', () => {
    const now = new Date('2026-01-05T02:04:04.000Z')
    const once = signPost({
      url: new URL('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails'),
      body: '{"a":1}',
      region: 'us-east-1',
      service: 'ses',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      now,
    })
    const twice = signPost({
      url: new URL('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails'),
      body: '{"a":1}',
      region: 'us-east-1',
      service: 'ses',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      now,
    })
    expect(once.headers.authorization).toBe(twice.headers.authorization)
  })
})

describe('the ses adapter', () => {
  const CREDENTIALS = { accessKeyId: 'AKID', secretAccessKey: 'SECRET' }

  test('posts SES v2 simple content to the regional endpoint, signed', async () => {
    const fake = recorder([ok({ MessageId: 'ses-1' })])
    const port = sesEmail({
      from: FROM,
      region: 'ap-southeast-2',
      ...CREDENTIALS,
      fetch: fake.call,
    })
    expect(port.provider).toBe('ses')
    expect(port.description).toBe('ses (ap-southeast-2)')

    const result = await port.send(message({ cc: [{ email: 'c@example.com' }], bcc: TO }))
    expect(result).toEqual({ ok: true, id: 'ses-1' })
    expect(fake.calls[0]?.url).toBe(
      'https://email.ap-southeast-2.amazonaws.com/v2/email/outbound-emails',
    )
    expect(fake.headers().authorization).toContain('AWS4-HMAC-SHA256 Credential=AKID/')
    const body = fake.body() as {
      FromEmailAddress: string
      Destination: Record<string, string[]>
      Content: { Simple: { Subject: { Data: string }; Body: Record<string, unknown> } }
    }
    expect(body.FromEmailAddress).toBe('"Example" <no-reply@example.com>')
    expect(body.Destination.ToAddresses).toEqual(['"Someone" <someone@example.com>'])
    expect(body.Destination.CcAddresses).toEqual(['c@example.com'])
    expect(body.Destination.BccAddresses).toEqual(['"Someone" <someone@example.com>'])
    expect(body.Content.Simple.Subject.Data).toBe('Hello')
    expect(body.Content.Simple.Body.Text).toEqual({ Data: 'Body', Charset: 'UTF-8' })
    expect(body.Content.Simple.Body.Html).toBeUndefined()
  })

  test('a configuration set is sent when one governs sending', async () => {
    const fake = recorder([ok({ MessageId: 'x' })])
    await sesEmail({
      from: FROM,
      region: 'us-east-1',
      ...CREDENTIALS,
      configurationSetName: 'transactional',
      fetch: fake.call,
    }).send(message())
    expect(fake.body().ConfigurationSetName).toBe('transactional')
  })

  test('an attachment switches to raw MIME, because simple content cannot carry one', async () => {
    const fake = recorder([ok({ MessageId: 'x' })])
    await sesEmail({ from: FROM, region: 'us-east-1', ...CREDENTIALS, fetch: fake.call }).send(
      message({
        bcc: [{ email: 'hidden@example.com' }],
        attachments: [
          { filename: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('hi') },
        ],
      }),
    )
    const body = fake.body() as {
      Content: { Raw: { Data: string } }
      Destination: Record<string, string[]>
    }
    expect(body.Content.Raw).toBeDefined()
    const mime = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8')
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="')
    expect(mime).toContain('Content-Disposition: attachment; filename="a.txt"')
    expect(mime).toContain('aGk=')
    // Bcc is an envelope instruction: in Destination, never in the headers,
    // or every blind recipient is shown to all the others.
    expect(body.Destination.BccAddresses).toEqual(['hidden@example.com'])
    expect(mime).not.toContain('hidden@example.com')
  })

  test('a raw message with both bodies nests an alternative so text readers see text', () => {
    const mime = rawMime(
      message({ html: '<p>hi</p>', replyTo: { email: 'reply@example.com' } }),
      FROM,
      'BOUND',
    )
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="BOUND"')
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="BOUND-alt"')
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8')
    expect(mime).toContain('Reply-To: reply@example.com')
    expect(mime.endsWith('--BOUND--\r\n')).toBe(true)
    // CRLF throughout: a bare newline makes some servers reject the message.
    expect(mime.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true)
  })

  test('a subject outside ASCII is encoded rather than sent raw', () => {
    expect(rawMime(message({ subject: 'Rückfrage' }), FROM, 'B')).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Rückfrage', 'utf8').toString('base64')}?=`,
    )
    expect(rawMime(message({ subject: 'Plain' }), FROM, 'B')).toContain('Subject: Plain')
  })

  test('base64 in a MIME part is wrapped, which the encoding requires', () => {
    const mime = rawMime(
      message({
        attachments: [
          {
            filename: 'big.bin',
            contentType: 'application/octet-stream',
            bytes: new Uint8Array(300).fill(65),
          },
        ],
      }),
      FROM,
      'B',
    )
    const longest = Math.max(...mime.split('\r\n').map((line) => line.length))
    expect(longest).toBeLessThanOrEqual(76)
  })

  test("the provider's refusal is the error, and a dead network is not an exception", async () => {
    const refused = recorder([
      new Response('{"message":"Email address is not verified"}', { status: 400 }),
    ])
    const port = sesEmail({ from: FROM, region: 'us-east-1', ...CREDENTIALS, fetch: refused.call })
    const result = await port.send(message())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('not verified')

    const dead = sesEmail({
      from: FROM,
      region: 'us-east-1',
      ...CREDENTIALS,
      fetch: (async () => {
        throw new Error('ENOTFOUND')
      }) as unknown as typeof fetch,
    })
    expect(await dead.send(message())).toEqual({ ok: false, error: 'ENOTFOUND' })
  })

  test('no region and no credentials are configuration errors at construction', () => {
    expect(() => sesEmail({ from: FROM, region: '', ...CREDENTIALS })).toThrow('needs a region')
    expect(() =>
      sesEmail({ from: FROM, region: 'us-east-1', accessKeyId: 'a', secretAccessKey: '' }),
    ).toThrow('needs credentials')
  })

  test('a custom endpoint is used as given, for a VPC endpoint or a fake', async () => {
    const fake = recorder([ok({ MessageId: 'x' })])
    await sesEmail({
      from: FROM,
      region: 'us-east-1',
      ...CREDENTIALS,
      endpoint: 'https://ses.internal',
      fetch: fake.call,
    }).send(message())
    expect(fake.calls[0]?.url).toBe('https://ses.internal/v2/email/outbound-emails')
  })
})

describe('the custom adapter', () => {
  test("posts this CMS's own shape, with the key as a bearer token", async () => {
    const fake = recorder([ok({ id: 'mine-1' })])
    const port = customEmail({
      from: FROM,
      url: 'https://mail.internal/send',
      apiKey: 'k',
      headers: { 'x-tenant': 'site' },
      fetch: fake.call,
    })
    const result = await port.send(message())
    expect(result).toEqual({ ok: true, id: 'mine-1' })
    expect(fake.calls[0]?.url).toBe('https://mail.internal/send')
    expect(fake.headers().authorization).toBe('Bearer k')
    expect(fake.headers()['x-tenant']).toBe('site')
    expect(fake.body().to).toEqual([{ email: 'someone@example.com', name: 'Someone' }])
    expect(fake.body().from).toEqual({ email: 'no-reply@example.com', name: 'Example' })
  })

  test('the URL is in the description, which is why it is not in the API response', () => {
    expect(customEmail({ from: FROM, url: 'https://mail.internal/send' }).description).toBe(
      'custom (https://mail.internal/send)',
    )
  })

  test('no URL is a configuration error at construction', () => {
    expect(() => customEmail({ from: FROM, url: '' })).toThrow('needs a URL')
  })
})

describe('the log adapter', () => {
  test('accepts everything and reports as the stand-in it is', async () => {
    const port = logEmail()
    expect(port.provider).toBe('log')
    expect(await port.send(message())).toEqual({ ok: true, id: null })
    const availability = emailAvailability(port)
    expect(availability.available).toBe(false)
    expect(availability.reason).toContain('console')
    // Nothing is listed as blocked: the links do reach the developer.
    expect(availability.affects).toEqual([])
  })
})

describe('availability', () => {
  test('no provider names the reason and everything it costs', () => {
    const availability = emailAvailability(undefined)
    expect(availability.available).toBe(false)
    expect(availability.provider).toBeNull()
    expect(availability.reason).toContain('BUNBRACO_EMAIL_PROVIDER')
    expect(availability.affects).toEqual([
      'Inviting backoffice users',
      'Password reset by e-mail',
      "Forms' Send email workflow",
    ])
  })

  test('a real provider is available, with nothing blocked', () => {
    const availability = emailAvailability(resendEmail({ from: FROM, apiKey: 'k' }))
    expect(availability).toEqual({
      available: true,
      provider: 'resend',
      description: 'resend',
      reason: null,
      affects: [],
    })
  })
})

describe('from the environment', () => {
  afterEach(() => {
    warnings.length = 0
  })

  test('unset and none are both no e-mail, and neither complains', () => {
    expect(emailFromEnvironment({}, collectingLog)).toBeUndefined()
    expect(emailFromEnvironment({ BUNBRACO_EMAIL_PROVIDER: 'none' }, collectingLog)).toBeUndefined()
    expect(warnings).toHaveLength(0)
  })

  test('a provider that is configured is built', () => {
    const port = emailFromEnvironment(
      {
        BUNBRACO_EMAIL_PROVIDER: 'resend',
        BUNBRACO_EMAIL_API_KEY: 're_x',
        BUNBRACO_EMAIL_FROM: 'no-reply@example.com',
        BUNBRACO_EMAIL_FROM_NAME: 'Example',
      },
      collectingLog,
    )
    expect(port?.provider).toBe('resend')
    expect(warnings).toHaveLength(0)
  })

  test('postmark reads its stream, custom reads its URL', () => {
    expect(
      emailFromEnvironment(
        {
          BUNBRACO_EMAIL_PROVIDER: 'postmark',
          BUNBRACO_EMAIL_API_KEY: 't',
          BUNBRACO_EMAIL_FROM: 'a@example.com',
          BUNBRACO_EMAIL_POSTMARK_STREAM: 'broadcast',
        },
        collectingLog,
      )?.description,
    ).toBe('postmark (broadcast)')
    expect(
      emailFromEnvironment(
        {
          BUNBRACO_EMAIL_PROVIDER: 'custom',
          BUNBRACO_EMAIL_FROM: 'a@example.com',
          BUNBRACO_EMAIL_URL: 'https://mail.internal/send',
        },
        collectingLog,
      )?.provider,
    ).toBe('custom')
  })

  test('ses reads its region and the standard AWS credentials', () => {
    const port = emailFromEnvironment(
      {
        BUNBRACO_EMAIL_PROVIDER: 'ses',
        BUNBRACO_EMAIL_FROM: 'a@example.com',
        BUNBRACO_EMAIL_SES_REGION: 'ap-southeast-2',
        AWS_ACCESS_KEY_ID: 'AKID',
        AWS_SECRET_ACCESS_KEY: 'SECRET',
      },
      collectingLog,
    )
    expect(port?.description).toBe('ses (ap-southeast-2)')
    expect(warnings).toHaveLength(0)
  })

  test('ses without a region, or without credentials, is no e-mail and a reason', () => {
    expect(
      emailFromEnvironment(
        { BUNBRACO_EMAIL_PROVIDER: 'ses', BUNBRACO_EMAIL_FROM: 'a@example.com' },
        collectingLog,
      ),
    ).toBeUndefined()
    expect(warnings[0]?.message).toContain('no region is set')

    warnings.length = 0
    // Credentials missing throws inside the adapter; from the environment that
    // has to be a warning, not a failed boot.
    expect(
      emailFromEnvironment(
        {
          BUNBRACO_EMAIL_PROVIDER: 'ses',
          BUNBRACO_EMAIL_FROM: 'a@example.com',
          BUNBRACO_EMAIL_SES_REGION: 'us-east-1',
          BUNBRACO_EMAIL_SES_ACCESS_KEY_ID: 'only-the-id',
        },
        collectingLog,
      ),
    ).toBeUndefined()
    expect(warnings[0]?.properties?.detail).toContain('needs credentials')
  })

  test('a cleartext endpoint is no e-mail and a warning, not a failed boot', () => {
    expect(
      emailFromEnvironment(
        {
          BUNBRACO_EMAIL_PROVIDER: 'custom',
          BUNBRACO_EMAIL_FROM: 'a@example.com',
          BUNBRACO_EMAIL_URL: 'http://mail.internal/send',
        },
        collectingLog,
      ),
    ).toBeUndefined()
    expect(warnings[0]?.properties?.detail).toContain('cleartext')

    warnings.length = 0
    expect(
      emailFromEnvironment(
        {
          BUNBRACO_EMAIL_PROVIDER: 'ses',
          BUNBRACO_EMAIL_FROM: 'a@example.com',
          BUNBRACO_EMAIL_SES_REGION: 'us-east-1',
          BUNBRACO_EMAIL_SES_ACCESS_KEY_ID: 'a',
          BUNBRACO_EMAIL_SES_SECRET_ACCESS_KEY: 'b',
          BUNBRACO_EMAIL_SES_ENDPOINT: 'http://ses.internal',
        },
        collectingLog,
      ),
    ).toBeUndefined()
    expect(warnings[0]?.properties?.detail).toContain('cleartext')
  })

  test('a relay on loopback is configurable from the environment', () => {
    expect(
      emailFromEnvironment(
        {
          BUNBRACO_EMAIL_PROVIDER: 'custom',
          BUNBRACO_EMAIL_FROM: 'a@example.com',
          BUNBRACO_EMAIL_URL: 'http://localhost:8025/send',
        },
        collectingLog,
      )?.provider,
    ).toBe('custom')
    expect(warnings).toHaveLength(0)
  })

  test('a typo is no e-mail and a warning naming what to use, never a failed boot', () => {
    expect(
      emailFromEnvironment({ BUNBRACO_EMAIL_PROVIDER: 'resned' }, collectingLog),
    ).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.properties?.known).toContain('resend, postmark, ses, custom or none')
  })

  test('a provider missing its sender or its key is no e-mail, with the gap named', () => {
    expect(
      emailFromEnvironment(
        { BUNBRACO_EMAIL_PROVIDER: 'resend', BUNBRACO_EMAIL_API_KEY: 'k' },
        collectingLog,
      ),
    ).toBeUndefined()
    expect(warnings[0]?.properties?.missing).toContain('BUNBRACO_EMAIL_FROM is not set')

    warnings.length = 0
    expect(
      emailFromEnvironment(
        {
          BUNBRACO_EMAIL_PROVIDER: 'resend',
          BUNBRACO_EMAIL_API_KEY: 'k',
          BUNBRACO_EMAIL_FROM: 'not-an-address',
        },
        collectingLog,
      ),
    ).toBeUndefined()
    expect(warnings[0]?.properties?.missing).toContain('is not a valid address')

    warnings.length = 0
    expect(
      emailFromEnvironment(
        { BUNBRACO_EMAIL_PROVIDER: 'resend', BUNBRACO_EMAIL_FROM: 'a@example.com' },
        collectingLog,
      ),
    ).toBeUndefined()
    expect(warnings[0]?.message).toContain('BUNBRACO_EMAIL_API_KEY is not set')

    warnings.length = 0
    expect(
      emailFromEnvironment(
        { BUNBRACO_EMAIL_PROVIDER: 'custom', BUNBRACO_EMAIL_FROM: 'a@example.com' },
        collectingLog,
      ),
    ).toBeUndefined()
    expect(warnings[0]?.message).toContain('BUNBRACO_EMAIL_URL is not set')
  })
})

describe('the boot notice', () => {
  const lines: { level: 'info' | 'warning'; message: string }[] = []
  const log = {
    info: (message: string) => {
      lines.push({ level: 'info', message })
    },
    warning: (message: string) => {
      lines.push({ level: 'warning', message })
    },
  }
  afterEach(() => {
    lines.length = 0
  })

  test('a production site with no provider is warned, and told what it costs', () => {
    noticeAboutEmail(emailAvailability(undefined), log, { development: false })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('warning')
    expect(lines[0]?.message).toContain('No e-mail provider is configured')
  })

  test('in development the same state is told, not warned', () => {
    noticeAboutEmail(emailAvailability(undefined), log, { development: true })
    expect(lines[0]?.level).toBe('info')
  })

  test('the console stand-in says nothing, because it is the expected state', () => {
    noticeAboutEmail(emailAvailability(logEmail()), log, { development: true })
    expect(lines).toEqual([])
  })

  test('a configured provider is named once, so a boot log says which', () => {
    noticeAboutEmail(emailAvailability(postmarkEmail({ from: FROM, apiKey: 't' })), log)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('info')
    expect(lines[0]?.message).toContain('{provider}')
  })
})

describe('resolving the port', () => {
  const env = {}

  test('a configured port is used as it is', () => {
    const port = capturingPort()
    expect(resolveEmailPort({ email: port, development: false }, env)).toBe(port)
  })

  test('nothing configured is the console in development and nothing in production', () => {
    expect(resolveEmailPort({ development: true }, env)?.provider).toBe('log')
    expect(resolveEmailPort({ development: false }, env)).toBeUndefined()
  })

  test('null is off outright, console included', () => {
    expect(resolveEmailPort({ email: null, development: true }, env)).toBeUndefined()
  })
})

describe('what a site without e-mail will not offer', () => {
  const EMAIL_API = `${BACKOFFICE}/bunbraco/api/email`

  test('no password reset is offered, even when the site asked for one', async () => {
    const h = await signedInServer({ config: { email: null, allowPasswordReset: true } })
    open.push(h)
    // The site said yes; the capability says no, and the capability wins —
    // a reset link that cannot be sent is a dead end that looks like a bug.
    expect(
      (await h.json<{ allowPasswordReset: boolean }>(`${V1}/server/configuration`))
        .allowPasswordReset,
    ).toBe(false)
  })

  test('nobody can be invited, and the refusal says what to configure', async () => {
    const h = await signedInServer({ config: { email: null } })
    open.push(h)
    expect(
      (await h.json<{ canInviteUsers: boolean }>(`${V1}/user/configuration`)).canInviteUsers,
    ).toBe(false)
    const invite = await h.post(`${V1}/user/invite`, {
      email: 'guest@example.com',
      userName: 'guest@example.com',
      name: 'Guest',
      userGroupIds: [{ id: WRITER }],
    })
    expect(invite.status).toBe(500)
    const problem = (await invite.json()) as { operationStatus: string; detail: string }
    expect(problem.operationStatus).toBe('CannotInvite')
    expect(problem.detail).toContain('BUNBRACO_EMAIL_PROVIDER')
  })

  test('the status endpoint explains it, and needs a session', async () => {
    const h = await signedInServer({ config: { email: null } })
    open.push(h)
    // No cookie jar: the route is for a signed-in backoffice, not the public.
    const anonymous = await h.server.fetch(new Request(`${ORIGIN}${EMAIL_API}`))
    expect(anonymous.status).toBe(401)
    const status = await h.json<{
      available: boolean
      provider: string | null
      reason: string
      affects: string[]
      canSendUserLinks: boolean
    }>(EMAIL_API)
    expect(status.available).toBe(false)
    expect(status.provider).toBeNull()
    expect(status.reason).toContain('No e-mail provider is configured')
    expect(status.affects).toContain('Inviting backoffice users')
    expect(status.canSendUserLinks).toBe(false)
  })

  test('the provider URL is never in the response, because it can be internal', async () => {
    const h = await signedInServer({
      config: { email: customEmail({ from: FROM, url: 'https://mail.internal/send' }) },
    })
    open.push(h)
    const body = await h.call(EMAIL_API).then((response) => response.text())
    expect(body).not.toContain('mail.internal')
    expect(JSON.parse(body).provider).toBe('custom')
  })
})

describe('what a site with e-mail does', () => {
  test('an invitation goes through the port, as one plain-text message with the link', async () => {
    const port = capturingPort()
    const h = await signedInServer({
      config: { email: port, applicationUrl: 'https://cms.example.com' },
    })
    open.push(h)
    expect(
      (await h.json<{ canInviteUsers: boolean }>(`${V1}/user/configuration`)).canInviteUsers,
    ).toBe(true)

    const invite = await h.post(`${V1}/user/invite`, {
      email: 'guest@example.com',
      userName: 'guest@example.com',
      name: 'Guest',
      userGroupIds: [{ id: WRITER }],
      message: 'Welcome aboard',
    })
    expect(invite.status).toBe(201)
    expect(port.sent).toHaveLength(1)
    const sent = port.sent[0] as EmailMessage
    expect(sent.to).toEqual([{ email: 'guest@example.com', name: 'Guest' }])
    expect(sent.subject).toContain('invited')
    expect(sent.text).toContain('https://cms.example.com')
    expect(sent.text).toContain('Welcome aboard')
    // Plain text only: these two messages are a sentence and a link.
    expect(sent.html).toBeUndefined()
  })

  test('a provider that refuses leaves the user created rather than failing the request', async () => {
    const port = capturingPort('fail')
    const h = await signedInServer({
      config: { email: port, applicationUrl: 'https://cms.example.com' },
    })
    open.push(h)
    const invite = await h.post(`${V1}/user/invite`, {
      email: 'guest@example.com',
      userName: 'guest@example.com',
      name: 'Guest',
      userGroupIds: [{ id: WRITER }],
    })
    // Deliberate: the account exists and the token is saved, so the invitation
    // can be resent. A 500 here would leave a user nobody knows about.
    expect(invite.status).toBe(201)
    const key = invite.headers.get('umb-generated-resource') as string
    expect((await h.json<{ state: string }>(`${V1}/user/${key}`)).state).toBe('Invited')
    // Resending is where the failure becomes visible.
    const resent = await h.post(`${V1}/user/invite/resend`, { user: { id: key } })
    expect(resent.status).toBe(500)
    expect(((await resent.json()) as { operationStatus: string }).operationStatus).toBe(
      'CannotInvite',
    )
  })
})
