/** Webhooks, shaped for the Management API: secrets masked, logs as Umbraco's client reads them. */
import type { WebhookPort, WebhookPortView } from '@crombolo/api-management'
import { nameBasedUuid, type WebhookLogEntry } from '@crombolo/data'
import { envReference } from '../webhook-files.ts'
import { MASKED, type WebhookService, type WebhookView } from '../webhooks.ts'

/** A typed-in secret never leaves the server; an `env:` reference is not a secret. */
const masked = (headers: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, envReference(value) ? value : MASKED]),
  )

function toView(webhook: WebhookView): WebhookPortView {
  return {
    id: webhook.key,
    name: webhook.name,
    description: webhook.description,
    url: webhook.url,
    enabled: webhook.enabled,
    events: webhook.events,
    contentTypeKeys: webhook.contentTypeKeys,
    headers: masked(webhook.headers),
  }
}

/** A bundle's handler has no webhook key, so its log rows take a stable one of their own. */
const subscriberKey = (subscriber: string) =>
  subscriber.startsWith('bundle:') ? nameBasedUuid(subscriber) : subscriber

function toLog(entry: WebhookLogEntry) {
  return {
    key: entry.key,
    webhookKey: subscriberKey(entry.subscriber),
    statusCode: entry.exception
      ? 'Exception'
      : entry.statusCode === null
        ? entry.success
          ? 'Handled'
          : 'Failed'
        : String(entry.statusCode),
    httpStatusCode: entry.statusCode,
    isSuccessStatusCode: entry.success,
    date: entry.date.toISOString(),
    eventAlias: entry.eventAlias,
    url: entry.url,
    retryCount: entry.retryCount,
    requestHeaders: entry.requestHeaders,
    requestBody: entry.requestBody,
    responseHeaders: entry.responseHeaders,
    responseBody: entry.responseBody,
    exceptionOccured: entry.exception,
  }
}

export function createWebhookPort(service: WebhookService): WebhookPort {
  return {
    list: async () => (await service.list()).map(toView),
    async get(id) {
      const webhook = await service.get(id)
      return webhook ? toView(webhook) : undefined
    },
    async create(input) {
      const result = await service.create({ ...input, key: input.id ?? crypto.randomUUID() })
      return result.ok ? { ok: true, id: result.key } : result
    },
    async update(id, input) {
      const result = await service.update(id, { ...input, key: id })
      return result.ok ? { ok: true, id: result.key } : result
    },
    remove: (id) => service.remove(id),
    async logs(id, paging) {
      const result = await service.logs(id?.toLowerCase(), paging)
      return { total: result.total, items: result.items.map(toLog) }
    },
  }
}
