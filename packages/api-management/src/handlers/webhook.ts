/**
 * The webhook operations: definitions, the events they may name, and the
 * delivery log. docs/webhooks.md.
 */
import {
  invalidSkipTake,
  notFound,
  paged,
  parseSkipTake,
  problemDetails,
  problemResponse,
} from '@crombolo/core'
import type {
  WebhookInput,
  WebhookPort,
  WebhookPortResult,
  WebhookPortView,
} from '../ports-webhooks.ts'
import type { ManagementApiRouter, RequestContext } from '../router.ts'
import { WEBHOOK_EVENTS } from '../webhook-events.ts'
import { created } from './content-type.ts'

const V1 = '/umbraco/management/api/v1'

const EVENTS = new Map(WEBHOOK_EVENTS.map((event) => [event.alias, event]))

/** Umbraco names each event in the response, not just by alias. */
function toResponse(webhook: WebhookPortView) {
  return {
    ...webhook,
    events: webhook.events.map(
      (alias) => EVENTS.get(alias) ?? { alias, eventName: alias, eventType: 'Other' },
    ),
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** The request body as a webhook; what is not there reads as empty, for the validator to refuse. */
async function inputOf(ctx: RequestContext): Promise<WebhookInput> {
  const body = ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null)
  const headers: Record<string, string> = {}
  if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers))
    for (const [name, value] of Object.entries(body.headers as Record<string, unknown>))
      if (typeof value === 'string') headers[name] = value
  return {
    id: text('id') ?? undefined,
    name: text('name'),
    description: text('description'),
    url: text('url') ?? '',
    enabled: body.enabled !== false,
    events: strings(body.events),
    contentTypeKeys: strings(body.contentTypeKeys).map((key) => key.toLowerCase()),
    headers,
  }
}

function refused(result: Exclude<WebhookPortResult, { ok: true }>): Response {
  if (result.status === 404) return problemResponse(notFound('The webhook could not be found'))
  return problemResponse(
    problemDetails({
      title: result.reason,
      status: result.status,
      detail: result.problems?.join(' '),
      ...(result.problems ? { errors: { webhook: result.problems } } : {}),
    }),
  )
}

export function registerWebhookHandlers(router: ManagementApiRouter, port: WebhookPort): void {
  router.handle('GetWebhook', async (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const all = await port.list()
    const { skip, take } = page.value
    return Response.json(paged(all.slice(skip, skip + take).map(toResponse), all.length))
  })

  router.handle('GetWebhookById', async (ctx) => {
    const webhook = await port.get(ctx.params.id as string)
    return webhook
      ? Response.json(toResponse(webhook))
      : problemResponse(notFound('The webhook could not be found'))
  })

  router.handle('GetItemWebhook', async (ctx) => {
    const ids = new Set(ctx.url.searchParams.getAll('id').map((id) => id.toLowerCase()))
    const all = await port.list()
    return Response.json(
      all
        .filter((webhook) => ids.has(webhook.id))
        .map((webhook) => ({
          id: webhook.id,
          name: webhook.name ?? webhook.url,
          enabled: webhook.enabled,
          url: webhook.url,
          events: webhook.events.map((alias) => EVENTS.get(alias)?.eventName ?? alias).join(', '),
          types: webhook.contentTypeKeys.join(', '),
          flags: [],
        })),
    )
  })

  router.handle('PostWebhook', async (ctx) => {
    const input = await inputOf(ctx)
    const result = await port.create({ ...input, id: input.id ?? crypto.randomUUID() })
    if (!result.ok) return refused(result)
    return created(`${ctx.url.origin}${V1}/webhook/${result.id}`, result.id)
  })

  router.handle('PutWebhookById', async (ctx) => {
    const result = await port.update(ctx.params.id as string, await inputOf(ctx))
    return result.ok ? new Response(null, { status: 200 }) : refused(result)
  })

  router.handle('DeleteWebhookById', async (ctx) =>
    (await port.remove(ctx.params.id as string))
      ? new Response(null, { status: 200 })
      : problemResponse(notFound('The webhook could not be found')),
  )

  router.handle('GetWebhookEvents', (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const { skip, take } = page.value
    return Response.json(paged(WEBHOOK_EVENTS.slice(skip, skip + take), WEBHOOK_EVENTS.length))
  })

  router.handle('GetWebhookLogs', async (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    const result = await port.logs(undefined, page.value)
    return Response.json(paged(result.items, result.total))
  })

  router.handle('GetWebhookByIdLogs', async (ctx) => {
    const page = parseSkipTake(ctx.url.searchParams)
    if (!page.ok) return problemResponse(invalidSkipTake())
    if (!(await port.get(ctx.params.id as string)))
      return problemResponse(notFound('The webhook could not be found'))
    const result = await port.logs(ctx.params.id as string, page.value)
    return Response.json(paged(result.items, result.total))
  })
}
