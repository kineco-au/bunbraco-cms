/**
 * The model seam: messages and tool definitions in, one assistant turn out.
 *
 * Narrow on purpose, so the agent loop knows nothing about any vendor and the
 * tests can drive the whole feature with a scripted provider and no network.
 */
import type { ToolDefinition } from './tools.ts'

export interface TextPart {
  kind: 'text'
  text: string
}

export interface ToolUsePart {
  kind: 'tool-use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultPart {
  kind: 'tool-result'
  id: string
  ok: boolean
  content: unknown
}

export type MessagePart = TextPart | ToolUsePart | ToolResultPart

export interface ProviderMessage {
  role: 'user' | 'assistant'
  parts: MessagePart[]
}

export interface ConverseInput {
  system: string
  messages: readonly ProviderMessage[]
  tools: readonly ToolDefinition[]
  maxTokens?: number
}

export interface ConverseResult {
  /** The assistant's turn, text and tool calls together. */
  message: ProviderMessage
  /** True when the model is waiting on tool results. */
  wantsTools: boolean
}

/** Whether the provider is usable, and what to do about it when it is not. */
export interface ProviderStatus {
  ok: boolean
  /** One line: the model and where its credentials came from, or what went wrong. */
  detail: string
  /** The action that would fix it, e.g. an `aws sso login` command. */
  remedy?: string | undefined
  /** When temporary credentials run out, so the drawer can say so before they do. */
  expires?: string | undefined
  /**
   * Whether the model itself was asked. `'ok'` means a real call came back, so
   * access is granted and the id is right for the region; `'unchecked'` means
   * only the credentials were looked at.
   */
  model?: 'ok' | 'unchecked' | undefined
}

export interface AssistantProvider {
  readonly name: string
  converse(input: ConverseInput): Promise<ConverseResult>
  /**
   * Checked at boot and by the drawer. Optional: a provider that cannot fail
   * ahead of time, such as a scripted one in a test, simply omits it.
   *
   * `deep` also confirms the model itself answers, which costs a token or two, so
   * it is asked for at boot and on an explicit refresh rather than on every read.
   */
  check?(deep?: boolean): Promise<ProviderStatus>
}
