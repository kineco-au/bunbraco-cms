/** Webhooks, as the Management API's eight operations and the item lookup need them. */
import type { Page, SkipTake } from '@crombolo/core'

/** One webhook as the backoffice edits it; a typed-in secret comes back masked. */
export interface WebhookInput {
  id?: string
  name: string | null
  description: string | null
  url: string
  enabled: boolean
  events: string[]
  contentTypeKeys: string[]
  headers: Record<string, string>
}

export interface WebhookPortView extends WebhookInput {
  id: string
}

export type WebhookPortResult =
  | { ok: true; id: string }
  | { ok: false; status: 400 | 404 | 409; reason: string; problems?: string[] }

export interface WebhookPort {
  list(): Promise<WebhookPortView[]>
  get(id: string): Promise<WebhookPortView | undefined>
  create(input: WebhookInput): Promise<WebhookPortResult>
  update(id: string, input: WebhookInput): Promise<WebhookPortResult>
  remove(id: string): Promise<boolean>
  /** Already in the wire's `WebhookLogResponseModel` shape; one webhook's when `id` is given. */
  logs(id: string | undefined, paging: SkipTake): Promise<Page<unknown>>
}
