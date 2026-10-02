/**
 * Bedrock, through the Converse API.
 *
 * The AWS SDK does the signing and the credential resolution. That is a
 * dependency this package otherwise does without, and it is here for one reason:
 * credentials. A developer's AWS access is an SSO profile rather than a pair of
 * long-lived keys, and resolving one means the shared config file,
 * `source_profile` chains, the SSO token cache and its refresh — most of why the
 * SDK is large, and not something to reimplement. Resolving credentials alone
 * costs 13 MB against the full client's 14 MB, so the client comes too and the
 * hand-rolled SigV4 goes.
 *
 * `AWS_PROFILE` and the rest of the chain then work as they do for every other AWS
 * tool: options first, then the environment, the shared config, SSO, and finally
 * an instance or task role.
 */
import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { DocumentType } from '@smithy/types'
import type {
  AssistantProvider,
  ConverseInput,
  ConverseResult,
  MessagePart,
  ProviderMessage,
  ProviderStatus,
} from '../provider.ts'

export interface BedrockOptions {
  /** A model id or inference profile id, e.g. `apac.anthropic.claude-…`. */
  model: string
  region?: string
  /** A named profile from the shared config, as `AWS_PROFILE` would select. */
  profile?: string
  /** Static credentials, for a site that holds them somewhere of its own. */
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  /** Overrides the endpoint, for a VPC endpoint or a test double. */
  endpoint?: string
  maxTokens?: number
}

/** An option or variable that was given; a container passes an unset one as `''`. */
const given = (...values: (string | undefined)[]): string | undefined =>
  values.find((value) => value !== undefined && value !== '')

/**
 * The credential chain ends at the instance metadata endpoint, which does not
 * answer on a laptop or in a container that has no route to it — and waits a long
 * time about it: a profile that cannot be resolved took two and a half minutes to
 * say so. A check that reports late is a check nobody waits for, so it is bounded.
 */
const CHECK_TIMEOUT_MS = 10_000

/** Small enough to be nearly free, large enough that no model calls it invalid. */
const CHECK_MAX_TOKENS = 16

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Turns a Bedrock refusal into something worth acting on. */
function modelRemedy(error: Error, model: string, region: string): string {
  const name = error.name
  if (name === 'AccessDeniedException') {
    return `Grant this account access to ${model} in the Bedrock console for ${region}.`
  }
  if (name === 'ValidationException' || name === 'ResourceNotFoundException') {
    return `Check the model id: ${model} may not exist in ${region}, and most models need a regional or global inference profile id — au.…, apac.… or global.… — rather than a bare id.`
  }
  return `Check that ${model} is available to this account in ${region}.`
}

function toContent(part: MessagePart): ContentBlock {
  if (part.kind === 'text') return { text: part.text }
  if (part.kind === 'tool-use') {
    // Both sides came from JSON, which is what a smithy document is.
    return { toolUse: { toolUseId: part.id, name: part.name, input: part.input as DocumentType } }
  }
  return {
    toolResult: {
      toolUseId: part.id,
      content: [{ json: asJsonObject(part.content) }],
      status: part.ok ? 'success' : 'error',
    },
  }
}

/**
 * Converse requires `toolResult.content[].json` to be a JSON *object*, and
 * refuses an array or a scalar with "the format of the value … is invalid".
 * Tools are free to answer with a list — `list_operations` does — so anything
 * that is not an object is wrapped rather than rejected.
 */
function asJsonObject(value: unknown): DocumentType {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
  return (isObject ? value : { result: value ?? null }) as DocumentType
}

const toMessage = (message: ProviderMessage): Message => ({
  role: message.role,
  content: message.parts.map(toContent),
})

export function bedrock(options: BedrockOptions): AssistantProvider {
  const region = given(options.region, Bun.env.AWS_REGION) ?? 'us-east-1'
  const profile = given(options.profile, Bun.env.AWS_PROFILE)
  const accessKeyId = given(options.accessKeyId, Bun.env.AWS_ACCESS_KEY_ID)
  const secretAccessKey = given(options.secretAccessKey, Bun.env.AWS_SECRET_ACCESS_KEY)

  /**
   * Static credentials when the site holds them, otherwise the standard chain.
   * Built once, so a resolved SSO token is cached and refreshed rather than read
   * from disk on every request.
   */
  const credentials =
    accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey, sessionToken: given(options.sessionToken) }
      : defaultProvider(profile ? { profile } : {})

  /**
   * Built lazily, so a missing or expired profile can never stop the site
   * booting: the assistant is optional and reports its own state instead.
   */
  let client: BedrockRuntimeClient | undefined
  const connection = () => {
    client ??= new BedrockRuntimeClient({
      region,
      credentials,
      ...(given(options.endpoint) ? { endpoint: options.endpoint } : {}),
      // HTTP/1.1. The client defaults to HTTP/2 for the streaming operations and
      // Converse does not stream, so this keeps it off Bun's h2 client entirely.
      requestHandler: new NodeHttpHandler(),
    })
    return client
  }

  // Follows the precedence above rather than guessing it: static keys win over a
  // profile for the credentials, so they must win for the label too, or a status
  // line names a profile that had nothing to do with the call.
  const source =
    typeof credentials === 'function'
      ? profile
        ? `profile ${profile}`
        : 'the environment'
      : 'static credentials'

  return {
    name: `bedrock:${options.model}`,

    /**
     * Whether credentials resolve — not whether the model is reachable or access
     * to it has been granted, which only a real call would show and which would
     * cost tokens to ask on every boot.
     */
    async check(deep = false): Promise<ProviderStatus> {
      const where = `${options.model} in ${region}, using ${source}`
      let expires: string | undefined
      try {
        const resolved = await withTimeout(
          typeof credentials === 'function' ? credentials() : Promise.resolve(credentials),
          CHECK_TIMEOUT_MS,
          'Timed out resolving AWS credentials.',
        )
        const expiration = (resolved as { expiration?: Date }).expiration
        expires = expiration ? expiration.toISOString() : undefined
      } catch (error) {
        return {
          ok: false,
          detail: (error as Error).message,
          remedy: profile
            ? `Run \`aws sso login --profile ${profile}\`, or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.`
            : 'Set AWS_PROFILE, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.',
        }
      }

      if (!deep) return { ok: true, detail: where, expires, model: 'unchecked' }

      // Credentials resolving says nothing about whether this account may invoke
      // this model in this region. Only a real call does, so it makes close to the
      // smallest one there is: a word in, a few tokens out.
      //
      // Not one token out: some models refuse a `maxTokens` that low —
      // `global.xai.grok-4.7` answers `integer_below_min_value` — and a check that
      // reports a working model as broken is worse than one that costs a token or
      // two more.
      try {
        await withTimeout(
          connection().send(
            new ConverseCommand({
              modelId: options.model,
              messages: [{ role: 'user', content: [{ text: 'ping' }] }],
              inferenceConfig: { maxTokens: CHECK_MAX_TOKENS },
            }),
          ),
          CHECK_TIMEOUT_MS,
          `Timed out asking Bedrock for ${options.model}.`,
        )
        return { ok: true, detail: `${where}, model reachable`, expires, model: 'ok' }
      } catch (error) {
        const failure = error as Error
        // Being throttled means the call got through: credentials and access are
        // both fine, which is what this is asking.
        if (failure.name === 'ThrottlingException') {
          return { ok: true, detail: `${where}, throttled but reachable`, expires, model: 'ok' }
        }
        return {
          ok: false,
          detail: `${options.model} did not answer: ${failure.message}`,
          remedy: modelRemedy(failure, options.model, region),
          expires,
        }
      }
    },

    async converse(input: ConverseInput): Promise<ConverseResult> {
      const response = await connection().send(
        new ConverseCommand({
          modelId: options.model,
          system: input.system === '' ? undefined : [{ text: input.system }],
          messages: input.messages.map(toMessage),
          inferenceConfig: { maxTokens: input.maxTokens ?? options.maxTokens ?? 4096 },
          toolConfig:
            input.tools.length === 0
              ? undefined
              : {
                  tools: input.tools.map((tool) => ({
                    toolSpec: {
                      name: tool.name,
                      description: tool.description,
                      inputSchema: { json: tool.inputSchema as DocumentType },
                    },
                  })),
                },
        }),
      )

      const parts: MessagePart[] = []
      for (const item of response.output?.message?.content ?? []) {
        if (typeof item.text === 'string' && item.text !== '') {
          parts.push({ kind: 'text', text: item.text })
        }
        if (item.toolUse?.toolUseId && item.toolUse.name) {
          parts.push({
            kind: 'tool-use',
            id: item.toolUse.toolUseId,
            name: item.toolUse.name,
            input: (item.toolUse.input as Record<string, unknown>) ?? {},
          })
        }
      }
      return {
        message: { role: 'assistant', parts },
        wantsTools: response.stopReason === 'tool_use',
      }
    },
  }
}
