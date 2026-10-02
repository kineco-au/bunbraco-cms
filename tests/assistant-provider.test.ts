/**
 * The Bedrock provider and the agent loop.
 *
 * Signing and credential resolution belong to the AWS SDK now, so what is pinned
 * here is our side of it: the mapping to and from Converse, how a named profile is
 * chosen, and what `check()` reports when credentials will not resolve — the
 * expired-SSO case a developer meets most mornings.
 *
 * Everything runs against a local endpoint; nothing here reaches AWS.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  type AssistantProvider,
  bedrock,
  type ConverseResult,
  type ProviderMessage,
  runConversation,
  type ToolResult,
} from '@bunbraco/assistant'

const KEYS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG' }

/**
 * Sets environment variables and gives back an undo. A variable that was unset is
 * deleted rather than assigned back, because assigning `undefined` to `Bun.env`
 * stores the string "undefined" — which is truthy, and leaks into the next test.
 */
const AWS_VARIABLES = [
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]

/**
 * These tests are about what the provider reads from its environment, so the
 * environment has to be ours. Bun loads `.env` from the working directory and the
 * repository is mounted into the test container, so without this a developer with
 * `AWS_PROFILE` set for their own use — which is the documented way to run the
 * assistant — would see this file fail.
 */
let restoreAws: () => void
beforeAll(() => {
  restoreAws = withEnv(Object.fromEntries(AWS_VARIABLES.map((name) => [name, undefined])))
})
afterAll(() => restoreAws())

function withEnv(values: Record<string, string | undefined>): () => void {
  const before = new Map(Object.keys(values).map((name) => [name, Bun.env[name]]))
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete Bun.env[name]
    else Bun.env[name] = value
  }
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) delete Bun.env[name]
      else Bun.env[name] = value
    }
  }
}

describe('the Converse mapping', () => {
  const received: { path: string; body: Record<string, unknown>; auth: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        body: (await request.json()) as Record<string, unknown>,
        auth: request.headers.get('authorization'),
      })
      return Response.json({
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Looking that up.' },
              { toolUse: { toolUseId: 'u1', name: 'query', input: { operationId: 'GetServer' } } },
            ],
          },
        },
        stopReason: 'tool_use',
      })
    },
  })
  afterAll(() => server.stop(true))

  const provider = (model = 'apac.anthropic.claude-test:0') =>
    bedrock({ model, region: 'ap-southeast-2', endpoint: server.url.origin, ...KEYS })

  test('sends the system prompt, the messages and the tools, and reads a tool call back', async () => {
    received.length = 0
    const result = await provider().converse({
      system: 'be helpful',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'what version?' }] }],
      tools: [{ name: 'query', description: 'read', inputSchema: { type: 'object' } }],
    })

    const sent = received[0]
    expect(sent?.body.system).toEqual([{ text: 'be helpful' }])
    expect(sent?.body.messages).toEqual([{ role: 'user', content: [{ text: 'what version?' }] }])
    expect(sent?.body.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'query',
            description: 'read',
            inputSchema: { json: { type: 'object' } },
          },
        },
      ],
    })
    expect(sent?.auth).toContain('AWS4-HMAC-SHA256')

    expect(result.wantsTools).toBe(true)
    expect(result.message.parts).toEqual([
      { kind: 'text', text: 'Looking that up.' },
      { kind: 'tool-use', id: 'u1', name: 'query', input: { operationId: 'GetServer' } },
    ])
  })

  test('the model id is escaped into the path', async () => {
    received.length = 0
    await provider().converse({ system: '', messages: [], tools: [] })
    expect(received[0]?.path).toBe('/model/apac.anthropic.claude-test%3A0/converse')
  })

  test('tool results are sent back in the shape Converse wants', async () => {
    received.length = 0
    const messages: ProviderMessage[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'go' }] },
      { role: 'assistant', parts: [{ kind: 'tool-use', id: 'u1', name: 'query', input: {} }] },
      {
        role: 'user',
        parts: [{ kind: 'tool-result', id: 'u1', ok: false, content: { error: 'no' } }],
      },
    ]
    await provider().converse({ system: '', messages, tools: [] })
    const sent = received[0]?.body.messages as unknown[] | undefined
    expect(sent?.[2]).toEqual({
      role: 'user',
      content: [
        { toolResult: { toolUseId: 'u1', content: [{ json: { error: 'no' } }], status: 'error' } },
      ],
    })
  })

  test('a tool result that is not an object is wrapped, because Converse demands one', async () => {
    received.length = 0
    // list_operations answers with an array, and Converse refuses anything but a
    // JSON object here: "the format of the value … toolResult.content.0.json is
    // invalid". Wrapping is the difference between the assistant working and not.
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        parts: [{ kind: 'tool-use', id: 'u1', name: 'list_operations', input: {} }],
      },
      {
        role: 'user',
        parts: [
          { kind: 'tool-result', id: 'u1', ok: true, content: [{ operationId: 'GetServer' }] },
        ],
      },
    ]
    await provider().converse({ system: '', messages, tools: [] })
    const sent = received[0]?.body.messages as {
      content: { toolResult?: { content: { json: unknown }[] } }[]
    }[]
    expect(sent?.[1]?.content[0]?.toolResult?.content[0]?.json).toEqual({
      result: [{ operationId: 'GetServer' }],
    })
  })

  test('an object tool result is passed through unwrapped', async () => {
    received.length = 0
    const messages: ProviderMessage[] = [
      { role: 'assistant', parts: [{ kind: 'tool-use', id: 'u1', name: 'query', input: {} }] },
      {
        role: 'user',
        parts: [{ kind: 'tool-result', id: 'u1', ok: true, content: { status: 200 } }],
      },
    ]
    await provider().converse({ system: '', messages, tools: [] })
    const sent = received[0]?.body.messages as {
      content: { toolResult?: { content: { json: unknown }[] } }[]
    }[]
    expect(sent?.[1]?.content[0]?.toolResult?.content[0]?.json).toEqual({ status: 200 })
  })

  test('an error from Bedrock is reported, not swallowed', async () => {
    const refusing = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { message: 'You do not have access to the model with the specified model ID.' },
          { status: 403, headers: { 'x-amzn-errortype': 'AccessDeniedException' } },
        ),
    })
    const failing = bedrock({
      model: 'm',
      region: 'ap-southeast-2',
      endpoint: refusing.url.origin,
      ...KEYS,
    })
    await expect(failing.converse({ system: '', messages: [], tools: [] })).rejects.toThrow(
      /access to the model/,
    )
    refusing.stop(true)
  })
})

describe('credentials', () => {
  test('static keys are used as given, and reported as their own source', async () => {
    const status = await bedrock({ model: 'm', region: 'ap-southeast-2', ...KEYS }).check?.()
    expect(status?.ok).toBe(true)
    // Asserted directly rather than through `toMatchObject` with an asymmetric
    // matcher: in Bun 1.4.2 that replaces the matched property on the received
    // object, so anything read afterwards is the matcher and not the value.
    expect(status?.detail).toContain('static credentials')
    expect(status?.detail).toContain('ap-southeast-2')
  })

  test('a named profile that does not exist is reported, with what to do about it', async () => {
    const status = await bedrock({
      model: 'm',
      region: 'ap-southeast-2',
      profile: 'no-such-profile-here',
    }).check?.()
    expect(status?.ok).toBe(false)
    // The remedy is the point: an expired SSO session is the common case and the
    // message has to say how to fix it rather than just that it failed.
    expect(status?.remedy).toContain('aws sso login --profile no-such-profile-here')
    // Past bun's 5s default, because resolving a missing profile walks the chain
    // to the metadata endpoint and waits on the provider's own 10s bound.
  }, 30_000)

  test('the profile comes from AWS_PROFILE when none is passed', async () => {
    const restore = withEnv({
      AWS_PROFILE: 'another-missing-profile',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
    })
    try {
      const status = await bedrock({ model: 'm' }).check?.()
      expect(status?.ok).toBe(false)
      expect(status?.remedy).toContain('another-missing-profile')
    } finally {
      restore()
    }
  }, 30_000)

  test('an empty environment variable counts as unset, as a container passes one through', async () => {
    // Docker Compose renders an unset variable as "", which `??` would not skip:
    // the region would end up empty and the endpoint would be malformed.
    const restore = withEnv({ AWS_REGION: '', AWS_PROFILE: '' })
    try {
      const status = await bedrock({ model: 'm', ...KEYS }).check?.()
      expect(status?.ok).toBe(true)
      expect(status?.detail).toContain('us-east-1')
      expect(status?.detail).toContain('static credentials')
    } finally {
      restore()
    }
  })

  test('a broken credential chain is bounded, not waited on for ever', async () => {
    // A profile that cannot be resolved falls through to the instance metadata
    // endpoint, which took two and a half minutes to give up in a container.
    const started = Date.now()
    const status = await bedrock({ model: 'm', profile: 'no-such-profile-anywhere' }).check?.()
    expect(status?.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 30_000)

  test('a bad profile does not stop the provider being constructed', () => {
    // The client is built lazily so an expired session cannot fail a site's boot.
    expect(() => bedrock({ model: 'm', profile: 'missing' })).not.toThrow()
  })
})

describe('checking the model, not just the credentials', () => {
  const answering = (handler: (body: Record<string, unknown>) => Response) =>
    Bun.serve({
      port: 0,
      async fetch(request) {
        return handler((await request.json()) as Record<string, unknown>)
      },
    })

  test('a shallow check does not call Bedrock; a deep one does', async () => {
    let calls = 0
    const server = answering(() => {
      calls++
      return Response.json({
        output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
        stopReason: 'end_turn',
      })
    })
    const provider = bedrock({
      model: 'm',
      region: 'ap-southeast-2',
      endpoint: server.url.origin,
      ...KEYS,
    })
    try {
      expect(await provider.check?.()).toMatchObject({ ok: true, model: 'unchecked' })
      expect(calls).toBe(0)

      const deep = await provider.check?.(true)
      expect(deep).toMatchObject({ ok: true, model: 'ok' })
      expect(deep?.detail).toContain('model reachable')
      expect(calls).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test('the check asks for a handful of tokens: nearly free, but not so few a model refuses', async () => {
    let body: Record<string, unknown> | undefined
    const server = answering((sent) => {
      body = sent
      return Response.json({
        output: { message: { role: 'assistant', content: [{ text: 'o' }] } },
        stopReason: 'end_turn',
      })
    })
    try {
      await bedrock({
        model: 'm',
        region: 'ap-southeast-2',
        endpoint: server.url.origin,
        ...KEYS,
      }).check?.(true)
      // Not 1: global.xai.grok-4.7 rejects that as below its minimum, which would
      // report a perfectly usable model as broken.
      expect(body?.inferenceConfig).toEqual({ maxTokens: 16 })
      expect(body?.toolConfig).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })

  test('access not granted is reported as something to do in the console', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { message: "You don't have access to the model with the specified model ID." },
          { status: 403, headers: { 'x-amzn-errortype': 'AccessDeniedException' } },
        ),
    })
    try {
      const status = await bedrock({
        model: 'apac.anthropic.claude-x',
        region: 'ap-southeast-2',
        endpoint: server.url.origin,
        ...KEYS,
      }).check?.(true)
      expect(status?.ok).toBe(false)
      expect(status?.remedy).toContain('Grant this account access to apac.anthropic.claude-x')
      expect(status?.remedy).toContain('ap-southeast-2')
    } finally {
      server.stop(true)
    }
  })

  test('a model id that is wrong for the region points at inference profiles', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            message:
              'Invocation of model ID anthropic.claude-x with on-demand throughput is not supported.',
          },
          { status: 400, headers: { 'x-amzn-errortype': 'ValidationException' } },
        ),
    })
    try {
      const status = await bedrock({
        model: 'anthropic.claude-x',
        region: 'ap-southeast-2',
        endpoint: server.url.origin,
        ...KEYS,
      }).check?.(true)
      expect(status?.ok).toBe(false)
      expect(status?.remedy).toContain('inference profile')
    } finally {
      server.stop(true)
    }
  })

  test('being throttled still means the model is reachable', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { message: 'Too many requests' },
          { status: 429, headers: { 'x-amzn-errortype': 'ThrottlingException' } },
        ),
    })
    try {
      const status = await bedrock({
        model: 'm',
        region: 'ap-southeast-2',
        endpoint: server.url.origin,
        maxTokens: 1,
        ...KEYS,
      }).check?.(true)
      expect(status).toMatchObject({ ok: true, model: 'ok' })
    } finally {
      server.stop(true)
    }
  }, 20_000)
})

describe('the agent loop', () => {
  const tool = (result: ToolResult) => ({
    definitions: [{ name: 'query', description: 'read', inputSchema: { type: 'object' } }],
    execute: async () => result,
  })

  const provider = (...turns: ConverseResult[]): AssistantProvider => {
    let at = 0
    return {
      name: 'scripted',
      async converse() {
        const turn = turns[at++]
        if (!turn) throw new Error('out of turns')
        return turn
      },
    }
  }

  const uses = (): ConverseResult => ({
    message: {
      role: 'assistant',
      parts: [{ kind: 'tool-use', id: 'u1', name: 'query', input: {} }],
    },
    wantsTools: true,
  })
  const says = (text: string): ConverseResult => ({
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    wantsTools: false,
  })

  test('runs a tool, feeds the result back, and returns the closing text', async () => {
    const run = await runConversation({
      provider: provider(uses(), says('Version 1.')),
      tools: tool({ ok: true, content: { version: '1' } }),
      system: '',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'version?' }] }],
    })
    expect(run.text).toBe('Version 1.')
    expect(run.exhausted).toBe(false)
    expect(run.messages).toHaveLength(4)
    expect(run.messages[2]?.parts[0]).toEqual({
      kind: 'tool-result',
      id: 'u1',
      ok: true,
      content: { version: '1' },
    })
  })

  test('a tool that throws is handed back to the model, not thrown at the caller', async () => {
    const run = await runConversation({
      provider: provider(uses(), says('I could not read that.')),
      tools: {
        definitions: [{ name: 'query', description: 'read', inputSchema: { type: 'object' } }],
        execute: () => Promise.reject(new Error('the database is away')),
      },
      system: '',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'go' }] }],
    })
    expect(run.text).toBe('I could not read that.')
    expect(run.messages[2]?.parts[0]).toMatchObject({
      ok: false,
      content: { error: 'the database is away' },
    })
  })

  test('stops at maxTurns rather than looping for ever', async () => {
    const run = await runConversation({
      provider: provider(uses(), uses(), uses(), uses()),
      tools: tool({ ok: true, content: {} }),
      system: '',
      messages: [],
      maxTurns: 2,
    })
    expect(run.exhausted).toBe(true)
    expect(run.text).toContain('too many steps')
  })

  test('reports which tools ran, for the drawer', async () => {
    const calls: string[] = []
    await runConversation({
      provider: provider(uses(), says('done')),
      tools: tool({ ok: true, content: {} }),
      system: '',
      messages: [],
      onToolCall: (name) => calls.push(name),
    })
    expect(calls).toEqual(['query'])
  })
})
