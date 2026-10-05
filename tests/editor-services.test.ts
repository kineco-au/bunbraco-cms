/**
 * WP-6.3: what property editors ask the server while editing — tag suggestions
 * and oEmbed markup for the rich text editor.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentTypeRepository } from '@bunbraco/data'
import { createOEmbedService } from '@bunbraco/server'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('tags', () => {
  test('lists the tags pages use, with how many pages use each, filtered as asked', async () => {
    const root = mkdtempSync(join(process.cwd(), 'output', 'tags-'))
    dirs.push(root)
    mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
    mkdirSync(join(root, 'components'), { recursive: true })
    writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
    writeFileSync(
      join(root, 'schema', 'document-types', 'post.toml'),
      '[document-type]\nalias = "post"\nname = "Post"\nallow-at-root = true\n\n[[property]]\nalias = "labels"\nname = "Labels"\ntype = "tags"\n',
    )
    const h = await signedInServer({
      config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
    })
    open.push(h)
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('post'))?.key as string
    const post = async (name: string, labels: string[]) => {
      const response = await h.post(`${V1}/document`, {
        documentType: { id: typeKey },
        template: null,
        parent: null,
        values: [{ alias: 'labels', culture: null, segment: null, value: labels }],
        variants: [{ culture: null, segment: null, name }],
      })
      return response.headers.get('umb-generated-resource') as string
    }
    await post('One', ['News', 'Bun'])
    const two = await post('Two', ['news', 'TypeScript'])
    await post('Three', [])

    type Tags = {
      total: number
      items: Array<{ id: string; text: string; group: string; nodeCount: number }>
    }
    const all = await h.json<Tags>(`${V1}/tag?skip=0&take=10`)
    expect(all.items.map((t) => [t.text, t.group, t.nodeCount])).toEqual([
      ['Bun', 'default', 1],
      ['News', 'default', 2],
      ['TypeScript', 'default', 1],
    ])
    expect(new Set(all.items.map((t) => t.id)).size).toBe(3)
    // Stable across requests
    expect((await h.json<Tags>(`${V1}/tag?skip=0&take=10`)).items[0]?.id).toBe(all.items[0]?.id)
    expect(
      (await h.json<Tags>(`${V1}/tag?query=typ&skip=0&take=10`)).items.map((t) => t.text),
    ).toEqual(['TypeScript'])
    expect((await h.json<Tags>(`${V1}/tag?tagGroup=other&skip=0&take=10`)).total).toBe(0)
    expect((await h.json<Tags>(`${V1}/tag?skip=1&take=1`)).items.map((t) => t.text)).toEqual([
      'News',
    ])

    // A trashed page's tags no longer count
    await h.put(`${V1}/document/${two}/move-to-recycle-bin`, {})
    const after = await h.json<Tags>(`${V1}/tag?skip=0&take=10`)
    expect(after.items.map((t) => [t.text, t.nodeCount])).toEqual([
      ['Bun', 1],
      ['News', 1],
    ])
  })
})

describe('oEmbed', () => {
  const calls: string[] = []
  const fake = (body: unknown, status = 200) =>
    (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch

  test("asks the URL's provider for JSON and returns its markup", async () => {
    calls.length = 0
    const service = createOEmbedService(fake({ type: 'video', html: '<iframe src="x"></iframe>' }))
    expect(await service.markup('https://www.youtube.com/watch?v=abc', 640, 360)).toEqual({
      ok: true,
      markup: '<iframe src="x"></iframe>',
    })
    const asked = new URL(calls[0] as string)
    expect(asked.origin + asked.pathname).toBe('https://www.youtube.com/oembed')
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      url: 'https://www.youtube.com/watch?v=abc',
      format: 'json',
      maxwidth: '640',
      maxheight: '360',
    })
  })

  test('a photo becomes an image; unknown URLs and provider failures are reported', async () => {
    const photo = createOEmbedService(
      fake({
        type: 'photo',
        url: 'https://live.staticflickr.com/1.jpg',
        width: 500,
        height: 375,
        title: 'A "view"',
      }),
    )
    expect(await photo.markup('https://www.flickr.com/photos/me/1')).toEqual({
      ok: true,
      markup:
        '<img src="https://live.staticflickr.com/1.jpg" width="500" height="375" alt="A &quot;view&quot;" />',
    })
    expect(await photo.markup('https://example.com/video')).toMatchObject({
      ok: false,
      status: 'unsupported',
    })
    expect(await createOEmbedService(fake({}, 404)).markup('https://vimeo.com/1')).toMatchObject({
      ok: false,
      status: 'failed',
    })
  })

  test('the endpoint refuses a URL no provider handles', async () => {
    const h = await signedInServer()
    open.push(h)
    const response = await h.call(
      `${V1}/oembed/query?url=${encodeURIComponent('https://example.com/x')}`,
    )
    expect(response.status).toBe(400)
    expect((await response.json()).title).toBe('The specified url is not supported.')
  })
})
