/**
 * The live-update channel the backoffice opens at `/umbraco/serverEventHub`:
 * SignalR's JSON hub protocol over a plain WebSocket, signed-in only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { serverEventFor } from '@bunbraco/api-management'
import { listOperations, loadSpec } from '@bunbraco/contracts'
import type { Server } from 'bun'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const RS = '\u001e'
const open: Array<{ h: Harness; server: Server<unknown> }> = []
afterEach(async () => {
  while (open.length > 0) {
    const entry = open.pop()
    entry?.server.stop(true)
    await entry?.h.db.close().catch(() => {})
  }
})

async function listening() {
  const h = await signedInServer()
  const server = Bun.serve({ ...h.server.serveOptions, port: 0 })
  open.push({ h, server: server as Server<unknown> })
  return { h, url: `ws://localhost:${server.port}/umbraco/serverEventHub` }
}

/** Resolves with the next text frame, or rejects on close. */
function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => resolve(String(event.data)), { once: true })
    ws.addEventListener('close', (event) => reject(new Error(`closed ${event.code}`)), {
      once: true,
    })
  })
}

describe('server event hub', () => {
  test('a signed-in client completes the handshake, receives invocations, and can close', async () => {
    const { h, url } = await listening()
    const ws = new WebSocket(`${url}?access_token=%5Bredacted%5D`, {
      headers: { cookie: h.cookie() },
    } as unknown as string[])
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const handshake = nextMessage(ws)
    ws.send(`${JSON.stringify({ protocol: 'json', version: 1 })}${RS}`)
    expect(await handshake).toBe(`{}${RS}`)
    expect(h.server.events.connections()).toBe(1)

    const invocation = nextMessage(ws)
    expect(h.server.events.broadcast('notify', [{ kind: 'test' }])).toBe(1)
    expect(JSON.parse((await invocation).replace(RS, ''))).toEqual({
      type: 1,
      target: 'notify',
      arguments: [{ kind: 'test' }],
    })

    const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }))
    ws.send(`${JSON.stringify({ type: 7 })}${RS}`)
    await closed
    await Bun.sleep(20)
    expect(h.server.events.connections()).toBe(0)
  })

  test('without a session the upgrade is refused', async () => {
    const { url } = await listening()
    const response = await fetch(url.replace('ws:', 'http:'), {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    expect(response.status).toBe(401)
  })

  test('an unsupported protocol is refused in the handshake', async () => {
    const { h, url } = await listening()
    const ws = new WebSocket(url, { headers: { cookie: h.cookie() } } as unknown as string[])
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
    const reply = nextMessage(ws)
    ws.send(`${JSON.stringify({ protocol: 'messagepack', version: 1 })}${RS}`)
    expect(await reply).toContain('is not supported')
  })
})

describe('tree ancestors', () => {
  test('a missing descendant answers with no ancestors, as Umbraco does', async () => {
    const h = await signedInServer()
    open.push({ h, server: { stop() {} } as unknown as Server<unknown> })
    for (const tree of ['document', 'document-type', 'media-type', 'data-type', 'template'])
      expect([tree, await h.json<unknown[]>(`${V1}/tree/${tree}/ancestors`)]).toEqual([tree, []])
  })
})

describe('server events from changes', () => {
  const operations = new Map(listOperations(loadSpec()).map((o) => [o.operationId, o]))
  const ok = (headers: Record<string, string> = {}) => new Response(null, { status: 200, headers })
  const eventOf = (id: string, params: Record<string, string>, response: Response) =>
    serverEventFor(
      operations.get(id) as NonNullable<ReturnType<typeof operations.get>>,
      params,
      response,
    )
  const KEY = '0b1c8e3a-7777-4a5b-9c1d-000000000001'

  test('names the entity, the change and the key, as Umbraco does', () => {
    expect(eventOf('PutDocumentTypeById', { id: KEY }, ok())).toEqual({
      eventSource: 'Umbraco:CMS:DocumentType',
      eventType: 'Updated',
      key: KEY,
    })
    expect(
      eventOf(
        'PostDocument',
        {},
        new Response(null, { status: 201, headers: { 'umb-generated-resource': KEY } }),
      ),
    ).toEqual({ eventSource: 'Umbraco:CMS:Document', eventType: 'Created', key: KEY })
    expect(eventOf('PutDocumentByIdPublish', { id: KEY }, ok())?.eventType).toBe('Updated')
    expect(eventOf('PutDocumentByIdMoveToRecycleBin', { id: KEY }, ok())?.eventType).toBe('Trashed')
    expect(eventOf('DeleteDataTypeById', { id: KEY }, ok())).toMatchObject({
      eventSource: 'Umbraco:CMS:DataType',
      eventType: 'Deleted',
    })
    expect(eventOf('PutLanguageByIsoCode', { isoCode: 'en-US' }, ok())?.key).toBe('en-US')
    expect(eventOf('DeleteRecycleBinMediaById', { id: KEY }, ok())).toMatchObject({
      eventSource: 'Umbraco:CMS:Media',
      eventType: 'Deleted',
    })
    expect(eventOf('PutRecycleBinDocumentByIdRestore', { id: KEY }, ok())?.eventType).toBe(
      'Updated',
    )
    // Emptying the bin names no item
    expect(eventOf('DeleteRecycleBinDocument', {}, ok())).toBeUndefined()
  })

  test('is silent for reads, validation, folders, and failures', () => {
    expect(eventOf('GetDocumentTypeById', { id: KEY }, ok())).toBeUndefined()
    expect(eventOf('PostDocumentValidate', {}, ok())).toBeUndefined()
    expect(eventOf('PutDocumentByIdValidate', { id: KEY }, ok())).toBeUndefined()
    expect(eventOf('PutDocumentTypeFolderById', { id: KEY }, ok())).toBeUndefined()
    expect(
      eventOf('PutDocumentTypeById', { id: KEY }, new Response(null, { status: 400 })),
    ).toBeUndefined()
  })

  test('a connected backoffice hears about a change as it is made', async () => {
    const { h, url } = await listening()
    const ws = new WebSocket(`${url}?access_token=%5Bredacted%5D`, {
      headers: { cookie: h.cookie() },
    } as unknown as string[])
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const handshake = nextMessage(ws)
    ws.send(`${JSON.stringify({ protocol: 'json', version: 1 })}${RS}`)
    await handshake

    const heard: unknown[] = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data).replace(RS, ''))
      if (message.type === 1) heard.push(message.arguments[0])
    })
    const created = await h.post(`${V1}/template`, { name: 'Article', alias: 'article' })
    const key = created.headers.get('umb-generated-resource') as string
    await h.put(`${V1}/template/${key}`, { name: 'Article', alias: 'article', content: 'x' })
    await h.del(`${V1}/template/${key}`)
    await Bun.sleep(50)
    expect(heard).toEqual(
      ['Created', 'Updated', 'Deleted'].map((eventType) => ({
        eventSource: 'Umbraco:CMS:Template',
        eventType,
        key,
      })),
    )
    ws.close()
  })
})
