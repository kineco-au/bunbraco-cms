/**
 * The agent loop: ask the model, run the tools it asks for, ask again.
 *
 * Bounded by `maxTurns`, because a model that keeps calling tools without
 * concluding would otherwise hold a request open indefinitely. Tool failures are
 * returned to the model rather than thrown, so it can correct a wrong alias
 * instead of the conversation ending.
 */
import type { AssistantProvider, MessagePart, ProviderMessage } from './provider.ts'
import type { ToolDefinition, ToolResult } from './tools.ts'

export interface ConversationTools {
  definitions: readonly ToolDefinition[]
  execute(name: string, input: Record<string, unknown>): Promise<ToolResult>
}

export interface RunOptions {
  provider: AssistantProvider
  tools: ConversationTools
  system: string
  messages: readonly ProviderMessage[]
  /** Model calls before the loop gives up; each one may run several tools. */
  maxTurns?: number
  /** Told about each tool as it runs, for the drawer's activity line. */
  onToolCall?: (name: string, input: Record<string, unknown>) => void
}

export interface RunResult {
  /** The conversation including everything this run added. */
  messages: ProviderMessage[]
  /** The assistant's closing text, which is what the drawer shows. */
  text: string
  /** True when the loop stopped because it ran out of turns. */
  exhausted: boolean
}

const textOf = (message: ProviderMessage): string =>
  message.parts
    .filter((part): part is Extract<MessagePart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()

export async function runConversation(options: RunOptions): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? 12
  const messages: ProviderMessage[] = [...options.messages]

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await options.provider.converse({
      system: options.system,
      messages,
      tools: options.tools.definitions,
    })
    messages.push(result.message)

    const calls = result.message.parts.filter(
      (part): part is Extract<MessagePart, { kind: 'tool-use' }> => part.kind === 'tool-use',
    )
    if (calls.length === 0 || !result.wantsTools) {
      return { messages, text: textOf(result.message), exhausted: false }
    }

    const parts: MessagePart[] = []
    for (const call of calls) {
      options.onToolCall?.(call.name, call.input)
      // A thrown tool is a bug, not a conversation ending: hand the model the
      // message so it can try something else, and keep the loop alive.
      const outcome = await options.tools
        .execute(call.name, call.input)
        .catch((error: Error): ToolResult => ({ ok: false, content: { error: error.message } }))
      parts.push({ kind: 'tool-result', id: call.id, ok: outcome.ok, content: outcome.content })
    }
    messages.push({ role: 'user', parts })
  }

  return {
    messages,
    text: 'I stopped before finishing — there were too many steps. Ask me for a smaller piece of it.',
    exhausted: true,
  }
}
