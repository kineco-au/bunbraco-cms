/**
 * Story 044: webhooks kept with the site's files or in this environment, raised
 * by changes, delivered by a background job with retries, every attempt logged,
 * delivered once across a cluster — and a bundle's handlers on the same queue.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { webhookEventFor } from '@crombolo/api-management'
import {
  bundleEventProblems,
  eventHappened,
  MASKED,
  openSecret,
  parseWebhookFile,
  type ServerBundle,
  sealSecret,
  subscribersFor,
  usableSecretKey,
  type WebhookDefinition,
  webhookProblems,
  webhookStoreView,
  writeWebhookFile,
} from '@crombolo/server'
import { siteDeclaring } from './support/bundles.ts'
import {
  createPage,
  type TreeSite,
  treeOps,
  treeSite,
  writeTreeSchema,
} from './support/content-tree.ts'
import { dialectUnderTest } from './support/db.ts'
import { BACKOFFICE, V1 } from './support/harness.ts'

const KEY = 'a-secret-key-that-is-long-enough-to-use-0123'

const sites: TreeSite[] = []
const listeners: Array<{ stop(force?: boolean): void }> = []
afterEach(async () => {
  while (sites.length > 0) await sites.pop()?.close()
  while (listeners.length > 0) listeners.pop()?.stop(true)
  delete Bun.env.WEBHOOK_TEST_TOKEN
})

const definition = (over: Partial<WebhookDefinition> = {}): WebhookDefinition => ({
  key: '5d3c1a2b-0044-4c1a-9e7d-3a5b8c2d4e44',
  name: 'Search index',
  description: null,
  url: 'https://search.example/hook',
  enabled: true,
  events: ['Umbraco.ContentPublish'],
  contentTypeKeys: [],
  headers: {},
  ...over,
})

describe('which operation raises which event', () => {
  const ok = (generated?: string) => ({
    status: 200,
    headers: new Headers(generated ? { 'umb-generated-resource': generated } : {}),
  })
  test.each([
    ['PutDocumentByIdPublish', 'Umbraco.ContentPublish'],
    ['PutDocumentByIdUnpublish', 'Umbraco.ContentUnpublish'],
    ['PutDocumentById', 'Umbraco.ContentSaved'],
    ['DeleteRecycleBinDocumentById', 'Umbraco.ContentDelete'],
    ['PutDocumentByIdMoveToRecycleBin', 'Umbraco.ContentMovedToRecycleBin'],
    ['PutMediaById', 'Umbraco.MediaSave'],
  ])('%s raises %s, about the item it names', (operation, alias) => {
    expect(webhookEventFor(operation, { id: 'ABC' }, ok())).toEqual({ alias, key: 'abc' })
  })

  test('a create names the item it made', () => {
    expect(webhookEventFor('PostDocument', {}, ok('NEW'))).toEqual({
      alias: 'Umbraco.ContentSaved',
      key: 'new',
    })
  })

  test('a refused operation, or one that is not a change, raises nothing', () => {
    expect(
      webhookEventFor(
        'PutDocumentByIdPublish',
        { id: 'a' },
        { status: 400, headers: new Headers() },
      ),
    ).toBeUndefined()
    expect(webhookEventFor('GetDocumentById', { id: 'a' }, ok())).toBeUndefined()
  })
})

describe('the rules a webhook is held to', () => {
  test('a good one has no problems, in either store', () => {
    expect(webhookProblems(definition(), 'files')).toEqual([])
    expect(
      webhookProblems(definition({ headers: { Authorization: 'Bearer x' } }), 'database'),
    ).toEqual([])
  })

  test('the URL, the events and the headers are each named when wrong', () => {
    expect(
      webhookProblems(
        definition({
          url: 'ftp://nope',
          events: ['Umbraco.Nothing'],
          headers: { 'Webhook-Event': 'x', 'bad name': 'y' },
        }),
        'database',
      ),
    ).toEqual([
      'The URL must be a web address starting http:// or https://.',
      '"Umbraco.Nothing" is not an event this site raises.',
      'The header "Webhook-Event" is set on every delivery, so it cannot be set here.',
      '"bad name" is not a header name.',
    ])
  })

  test("a typed-in header value cannot go in the site's files; an env reference can", () => {
    expect(
      webhookProblems(definition({ headers: { Authorization: 'Bearer x' } }), 'files'),
    ).toEqual([
      'The header "Authorization" would put its value in the site\'s files. Give it as env:NAME and set NAME on the server.',
    ])
    expect(
      webhookProblems(definition({ headers: { Authorization: 'env:TOKEN' } }), 'files'),
    ).toEqual([])
  })
})

describe('a webhook as a file', () => {
  test('writes and reads back unchanged', () => {
    const webhook = definition({
      description: 'For the search index',
      enabled: false,
      contentTypeKeys: ['0c1d2e3f-4a5b-4c6d-8e7f-001122334455'],
      headers: { Authorization: 'env:SEARCH_TOKEN' },
    })
    expect(parseWebhookFile('w.toml', writeWebhookFile(webhook))).toEqual({ webhook, problems: [] })
  })

  test('an unknown key and a typed-in secret are refused, with the file named', () => {
    const source = `${writeWebhookFile(definition())}colour = "red"\n`.replace(
      'events =',
      'colour2 = 1\nevents =',
    )
    const parsed = parseWebhookFile('schema/webhooks/w.toml', source)
    expect(parsed.webhook).toBeUndefined()
    expect(
      parsed.problems.some((p) => p.includes('webhook.colour2 is not a webhook setting')),
    ).toBe(true)
  })
})

describe('sealing secrets', () => {
  test('opens with its key, and not with another', () => {
    const sealed = sealSecret('Bearer hunter2', KEY)
    expect(sealed).not.toContain('hunter2')
    expect(openSecret(sealed, KEY)).toBe('Bearer hunter2')
    expect(() => openSecret(sealed, `${KEY}-other`)).toThrow()
  })

  test('a key shorter than 32 characters is not used', () => {
    expect(usableSecretKey('short')).toBeUndefined()
    expect(usableSecretKey(KEY)).toBe(KEY)
  })
})

describe('who hears about an event', () => {
  const event = { alias: 'Umbraco.ContentPublish', key: 'k' }
  const page = 'type-page'

  test('enabled webhooks naming the event, of the item’s type or of any; then bundles', () => {
    const webhooks = [
      definition({ key: 'all' }),
      definition({ key: 'pages', contentTypeKeys: [page] }),
      definition({ key: 'other-type', contentTypeKeys: ['type-other'] }),
      definition({ key: 'off', enabled: false }),
      definition({ key: 'unpublish-only', events: ['Umbraco.ContentUnpublish'] }),
    ]
    const bundles = [
      { id: 'acme', events: { 'Umbraco.ContentPublish': () => ({ ok: true as const }) } },
    ]
    expect(subscribersFor(event, page, webhooks, bundles)).toEqual(['all', 'pages', 'bundle:acme'])
  })

  test('an item whose type cannot be read is not filtered out', () => {
    expect(
      subscribersFor(event, undefined, [definition({ key: 'pages', contentTypeKeys: [page] })], []),
    ).toEqual(['pages'])
  })

  test('a bundle handling an event that does not exist is refused at boot', () => {
    expect(
      bundleEventProblems([{ id: 'acme', events: { 'Umbraco.Nope': () => ({ ok: true }) } }]),
    ).toEqual(['The bundle "acme" handles "Umbraco.Nope", which is not an event this site raises.'])
  })

  test('a publish that only scheduled one, or an unpublish that left it live, raises nothing', () => {
    expect(eventHappened('Umbraco.ContentPublish', false)).toBe(false)
    expect(eventHappened('Umbraco.ContentPublish', true)).toBe(true)
    expect(eventHappened('Umbraco.ContentUnpublish', true)).toBe(false)
    expect(eventHappened('Umbraco.ContentDelete', undefined)).toBe(true)
  })

  test('the panel says why a store is unavailable', () => {
    expect(webhookStoreView('files', { files: true, database: false })).toEqual({
      store: 'files',
      available: { files: true, database: false },
      unavailable: {
        files: null,
        database: 'Keeping it in this environment needs CROMBOLO_SECRET_KEY set on the server.',
      },
    })
  })
})

/** A receiver that records what it is sent and answers with the next status in line. */
function receiver(statuses: number[] = []) {
  const received: Array<{ headers: Record<string, string>; body: unknown }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        headers: Object.fromEntries(request.headers),
        body: await request.json(),
      })
      return new Response('thanks', { status: statuses.shift() ?? 200 })
    },
  })
  listeners.push(server)
  return { url: `${server.url}hook`, received }
}

async function site(config: Record<string, unknown> = {}) {
  const s = await treeSite({ config: { secretKey: KEY, ...config } })
  sites.push(s)
  return s
}

const create = (s: TreeSite, body: Record<string, unknown>) =>
  s.h.post(`${V1}/webhook`, {
    enabled: true,
    contentTypeKeys: [],
    headers: {},
    events: ['Umbraco.ContentPublish'],
    ...body,
  })

describe('webhooks through the API', () => {
  test('are created, listed, read, edited and deleted; a typed-in secret never comes back', async () => {
    const s = await site()
    const created = await create(s, {
      name: 'Search',
      url: 'https://search.example/hook',
      headers: { Authorization: 'Bearer hunter2', 'X-Env': 'env:WEBHOOK_TEST_TOKEN' },
    })
    expect(created.status).toBe(201)
    const id = created.headers.get('umb-generated-resource') as string

    const read = await s.h.json<{
      headers: Record<string, string>
      events: Array<{ alias: string; eventName: string; eventType: string }>
    }>(`${V1}/webhook/${id}`)
    expect(read.headers).toEqual({ Authorization: MASKED, 'X-Env': 'env:WEBHOOK_TEST_TOKEN' })
    expect(read.events).toEqual([
      { alias: 'Umbraco.ContentPublish', eventName: 'Content Published', eventType: 'Content' },
    ])
    expect(JSON.stringify(await s.h.json(`${V1}/webhook?skip=0&take=10`))).not.toContain('hunter2')
    const rows = await s.h.server.db.query<{ headers: string }>('SELECT headers FROM webhook')
    expect(rows[0]?.headers).not.toContain('hunter2')

    // Sending the mask back keeps the secret; the rest changes.
    expect(
      (
        await s.h.put(`${V1}/webhook/${id}`, {
          ...read,
          events: ['Umbraco.ContentPublish', 'Umbraco.ContentUnpublish'],
          contentTypeKeys: [],
          enabled: true,
        })
      ).status,
    ).toBe(200)
    expect((await s.h.json<{ events: unknown[] }>(`${V1}/webhook/${id}`)).events).toHaveLength(2)

    const items = await s.h.json<Array<{ name: string; events: string }>>(
      `${V1}/item/webhook?id=${id}`,
    )
    expect(items[0]).toMatchObject({
      name: 'Search',
      events: 'Content Published, Content Unpublished',
    })

    expect((await s.h.del(`${V1}/webhook/${id}`)).status).toBe(200)
    expect((await s.h.call(`${V1}/webhook/${id}`)).status).toBe(404)
  })

  test('an invalid one is refused with what is wrong', async () => {
    const s = await site()
    const refused = await create(s, { url: 'nope', events: [] })
    expect(refused.status).toBe(400)
    const problem = (await refused.json()) as { detail: string }
    expect(problem.detail).toContain('The URL must be a web address')
    expect(problem.detail).toContain('Choose at least one event.')
  })

  test('the events it may name are listed', async () => {
    const s = await site()
    const events = await s.h.json<{ total: number; items: Array<{ alias: string }> }>(
      `${V1}/webhook/events?skip=0&take=100`,
    )
    expect(events.items.map((e) => e.alias)).toContain('Umbraco.ContentPublish')
    expect(events.total).toBe(events.items.length)
  })
})

describe('delivery', () => {
  test('a publish is delivered after the request, with the headers, the payload and a log entry', async () => {
    Bun.env.WEBHOOK_TEST_TOKEN = 'from-the-environment'
    const remote = receiver()
    const s = await site()
    const id = (
      await create(s, {
        url: remote.url,
        headers: { Authorization: 'Bearer hunter2', 'X-Env': 'env:WEBHOOK_TEST_TOKEN' },
      })
    ).headers.get('umb-generated-resource') as string
    const page = await createPage(s, 'Home')
    expect((await treeOps(s).publish(page)).status).toBe(200)
    // Nothing has been sent yet: delivery is the job's, not the request's.
    expect(remote.received).toEqual([])
    await Bun.sleep(20)
    expect(await s.h.server.jobs.runWebhooks()).toEqual({
      claimed: 1,
      done: 1,
      retrying: 0,
      failed: 0,
    })
    expect(remote.received).toHaveLength(1)
    const [delivered] = remote.received
    expect(delivered?.body).toEqual({ Id: page })
    expect(delivered?.headers).toMatchObject({
      'content-type': 'application/json',
      'webhook-event': 'Umbraco.ContentPublish',
      'webhook-retry-count': '0',
      'webhook-id': id,
      authorization: 'Bearer hunter2',
      'x-env': 'from-the-environment',
    })
    expect(delivered?.headers['umb-webhook-event']).toBeUndefined()

    const logs = await s.h.json<{
      total: number
      items: Array<{
        statusCode: string
        isSuccessStatusCode: boolean
        requestHeaders: string
        responseBody: string
        webhookKey: string
      }>
    }>(`${V1}/webhook/${id}/logs?skip=0&take=10`)
    expect(logs.total).toBe(1)
    expect(logs.items[0]).toMatchObject({
      statusCode: '200',
      isSuccessStatusCode: true,
      responseBody: 'thanks',
      webhookKey: id,
    })
    expect(logs.items[0]?.requestHeaders).not.toContain('hunter2')
    expect(logs.items[0]?.requestHeaders).not.toContain('from-the-environment')
    expect((await s.h.json<{ total: number }>(`${V1}/webhook/logs?skip=0&take=10`)).total).toBe(1)
  })

  test('a receiver at fault is retried on the back-off; one that refuses is not', async () => {
    const flaky = receiver([503, 200])
    const s = await site()
    await create(s, { url: flaky.url })
    const page = await createPage(s, 'Home')
    await treeOps(s).publish(page)
    await Bun.sleep(20)
    expect((await s.h.server.jobs.runWebhooks()).retrying).toBe(1)
    expect((await s.h.server.jobs.runWebhooks()).claimed).toBe(0)
    expect((await s.h.server.jobs.runWebhooks(new Date(Date.now() + 2 * 60_000))).done).toBe(1)
    expect(flaky.received.map((r) => r.headers['webhook-retry-count'])).toEqual(['0', '1'])

    const refusing = receiver([422])
    const other = await site()
    await create(other, { url: refusing.url })
    await treeOps(other).publish(await createPage(other, 'Home'))
    await Bun.sleep(20)
    expect((await other.h.server.jobs.runWebhooks()).failed).toBe(1)
  })

  test('a webhook for another content type hears nothing', async () => {
    const remote = receiver()
    const s = await site()
    await create(s, { url: remote.url, contentTypeKeys: [crypto.randomUUID()] })
    await treeOps(s).publish(await createPage(s, 'Home'))
    await Bun.sleep(20)
    expect((await s.h.server.jobs.runWebhooks()).claimed).toBe(0)
  })

  test('a scheduled publish raises the same event as one by hand', async () => {
    const remote = receiver()
    const s = await site()
    await create(s, { url: remote.url })
    const page = await createPage(s, 'Home')
    await s.h.put(`${V1}/document/${page}/publish`, {
      publishSchedules: [
        { culture: null, schedule: { publishTime: new Date(Date.now() + 60_000).toISOString() } },
      ],
    })
    await s.h.server.jobs.runScheduledPublishing(new Date(Date.now() + 2 * 60_000))
    await s.h.server.jobs.runWebhooks()
    expect(remote.received.map((r) => r.body)).toEqual([{ Id: page }])
  })
})

describe('where a webhook is kept', () => {
  const store = (_s: TreeSite, id: string) => `${BACKOFFICE}/crombolo/api/webhooks/${id}/store`

  test('without a secret key a new webhook goes to the files, and may not hold a typed-in secret', async () => {
    const s = await site({ secretKey: undefined })
    const refused = await create(s, {
      url: 'https://x.example/',
      headers: { Authorization: 'Bearer x' },
    })
    expect(refused.status).toBe(400)
    const created = await create(s, {
      url: 'https://x.example/',
      headers: { Authorization: 'env:TOKEN' },
    })
    expect(created.status).toBe(201)
    const id = created.headers.get('umb-generated-resource') as string
    const file = join(s.root, 'schema', 'webhooks', `${id}.toml`)
    expect(readFileSync(file, 'utf8')).toContain('Authorization = "env:TOKEN"')
    const view = await s.h.json<{ store: string; available: { database: boolean } }>(store(s, id))
    expect(view).toMatchObject({ store: 'files', available: { database: false } })
    expect((await s.h.put(store(s, id), { store: 'database' })).status).toBe(400)
  })

  test('with a key it starts in the environment, and moves to the files once it holds no typed-in secret', async () => {
    const s = await site()
    const id = (
      await create(s, { url: 'https://x.example/', headers: { Authorization: 'Bearer x' } })
    ).headers.get('umb-generated-resource') as string
    expect((await s.h.json<{ store: string }>(store(s, id))).store).toBe('database')
    const blocked = await s.h.put(store(s, id), { store: 'files' })
    expect(blocked.status).toBe(400)
    expect(((await blocked.json()) as { problems: string[] }).problems[0]).toContain('env:NAME')

    await s.h.put(`${V1}/webhook/${id}`, {
      url: 'https://x.example/',
      events: ['Umbraco.ContentPublish'],
      enabled: true,
      contentTypeKeys: [],
      headers: { Authorization: 'env:TOKEN' },
    })
    expect((await s.h.put(store(s, id), { store: 'files' })).status).toBe(200)
    expect(existsSync(join(s.root, 'schema', 'webhooks', `${id}.toml`))).toBe(true)
    expect(await s.h.server.db.query('SELECT key FROM webhook')).toEqual([])
    expect((await s.h.json<{ store: string }>(store(s, id))).store).toBe('files')
  })

  test('a node that can write neither refuses to add one, and says what to set', async () => {
    const s = await site({ secretKey: undefined, schemaWritable: false })
    const refused = await create(s, { url: 'https://x.example/' })
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { title: string }).title).toContain('CROMBOLO_SECRET_KEY')
  })
})

describe('a bundle handles the events', () => {
  test('its handler runs from the queue, once, with the payload; a failure is retried', async () => {
    const calls: Array<{ event: string; payload: unknown; attempt: number }> = []
    const bundle: ServerBundle = {
      id: 'acme-hooks',
      section: 'settings',
      capabilities: [],
      routes: [],
      events: {
        'Umbraco.ContentPublish': ({ event, payload, attempt }) => {
          calls.push({ event, payload, attempt })
          return attempt === 1 ? { ok: false, error: 'not yet', retry: true } : { ok: true }
        },
      },
    }
    const root = writeTreeSchema(
      siteDeclaring('webhook-bundle', {
        '@acme/hooks': { json: { crombolo: { id: 'acme-hooks', server: 'hooks' } } },
      }),
    )
    const s = await treeSite({ root, config: { siteDir: root, bundles: [bundle] } })
    sites.push(s)
    const page = await createPage(s, 'Home')
    await treeOps(s).publish(page)
    await Bun.sleep(20)
    expect(calls).toEqual([])
    expect((await s.h.server.jobs.runWebhooks()).retrying).toBe(1)
    expect((await s.h.server.jobs.runWebhooks(new Date(Date.now() + 2 * 60_000))).done).toBe(1)
    expect(calls).toEqual([
      { event: 'Umbraco.ContentPublish', payload: { Id: page }, attempt: 1 },
      { event: 'Umbraco.ContentPublish', payload: { Id: page }, attempt: 2 },
    ])
    const logs = await s.h.json<{ items: Array<{ url: string; isSuccessStatusCode: boolean }> }>(
      `${V1}/webhook/logs?skip=0&take=10`,
    )
    expect(logs.items.map((l) => [l.url, l.isSuccessStatusCode])).toEqual([
      ['bundle:acme-hooks', true],
      ['bundle:acme-hooks', false],
    ])
  })
})

test.skipIf(dialectUnderTest !== 'postgres')(
  'two nodes draining the queue at once deliver each event once',
  async () => {
    const remote = receiver()
    const a = await site({ nodeId: 'node-a' })
    const b = await treeSite({
      root: a.root,
      keepDatabase: true,
      config: { secretKey: KEY, nodeId: 'node-b' },
    })
    sites.push(b)
    await create(a, { url: remote.url })
    for (const name of ['One', 'Two', 'Three']) await treeOps(a).publish(await createPage(a, name))
    await Bun.sleep(50)
    const [first, second] = await Promise.all([
      a.h.server.jobs.runWebhooks(),
      b.h.server.jobs.runWebhooks(),
    ])
    expect((first?.done ?? 0) + (second?.done ?? 0)).toBe(3)
    expect(remote.received).toHaveLength(3)
  },
)
