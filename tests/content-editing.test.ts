/**
 * WP-6.5: the document action menu beyond save and publish — move, copy, sort,
 * the recycle bin, publishing a branch, and reading a past version.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComponentRepository, ContentTypeRepository } from '@bunbraco/data'
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

const TYPE_TOML = `[document-type]
alias = "page"
name = "Page"
icon = "icon-document"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
mandatory = true

[[property]]
alias = "body"
name = "Body"
type = "textarea"
`

const VIEW = `export default function Page({ model, culture }) {
  return <main><h1>{model.text('title')}</h1><i>{culture ?? 'none'}</i></main>
}
`

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'content-editing-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), VIEW)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string

  const create = async (
    name: string,
    parent: string | null = null,
    title: string | null = name,
  ) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: parent ? { id: parent } : null,
      values:
        title === null ? [] : [{ alias: 'title', culture: null, segment: null, value: title }],
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  const publish = (key: string) => h.put(`${V1}/document/${key}/publish`, { publishSchedules: [] })
  const children = async (parent: string | null) =>
    (
      await h.json<{
        items: Array<{ id: string; variants: Array<{ name: string; state: string }> }>
      }>(
        parent
          ? `${V1}/tree/document/children?parentId=${parent}&skip=0&take=100`
          : `${V1}/tree/document/root?skip=0&take=100`,
      )
    ).items
  const names = async (parent: string | null) =>
    (await children(parent)).map((i) => i.variants[0]?.name)
  return { h, create, publish, children, names, componentKey }
}

describe('WP-6.5 move, copy, sort', () => {
  test('move re-parents a branch, and refuses to move below itself', async () => {
    const { h, create, publish, names } = await site()
    const home = await create('Home')
    const about = await create('About', home)
    const team = await create('Team', about)
    const news = await create('News')
    for (const key of [home, about, team, news]) await publish(key)

    const moved = await h.put(`${V1}/document/${about}/move`, { target: { id: news } })
    expect(moved.status).toBe(200)
    expect(await names(news)).toEqual(['About'])
    expect(await names(about)).toEqual(['Team'])
    // The branch moved with it: the grandchild's ancestors are the new ones
    const ancestors = await h.json<Array<{ id: string }>>(
      `${V1}/tree/document/ancestors?descendantId=${team}`,
    )
    expect(ancestors.map((a) => a.id)).toEqual([news, about])
    // No root's segment appears in the URLs below it, so the branch keeps its path
    expect((await h.call('/about/team')).status).toBe(200)

    expect((await h.put(`${V1}/document/${news}/move`, { target: { id: team } })).status).toBe(400)
    expect((await h.put(`${V1}/document/${news}/move`, { target: { id: news } })).status).toBe(400)
    expect(
      (await h.put(`${V1}/document/${news}/move`, { target: { id: crypto.randomUUID() } })).status,
    ).toBe(404)
    // To the root
    expect((await h.put(`${V1}/document/${about}/move`, { target: null })).status).toBe(200)
    expect(await names(null)).toEqual(['Home', 'News', 'About'])
  })

  test('copy makes an unpublished twin with a free name, with or without its branch', async () => {
    const { h, create, publish, children, names } = await site()
    const home = await create('Home')
    const about = await create('About', home)
    await create('Team', about)
    await publish(home)
    await publish(about)

    const copied = await h.post(`${V1}/document/${about}/copy`, {
      target: { id: home },
      relateToOriginal: false,
      includeDescendants: true,
    })
    expect(copied.status).toBe(201)
    const copyKey = copied.headers.get('umb-generated-resource') as string
    expect(await names(home)).toEqual(['About', 'About (1)'])
    const twin = (await children(home)).find((c) => c.id === copyKey)
    expect(twin?.variants[0]?.state).toBe('Draft')
    expect(await names(copyKey)).toEqual(['Team'])
    const values = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${copyKey}`,
    )
    expect(values.values.find((v) => v.alias === 'title')?.value).toBe('About')

    const shallow = await h.post(`${V1}/document/${about}/copy`, {
      target: null,
      relateToOriginal: false,
      includeDescendants: false,
    })
    const shallowKey = shallow.headers.get('umb-generated-resource') as string
    expect(await names(null)).toEqual(['Home', 'About'])
    expect(await names(shallowKey)).toEqual([])
  })

  test('sort sets the order of named children; sort-children orders by a field', async () => {
    const { h, create, names } = await site()
    const home = await create('Home')
    const c = await create('Charlie', home)
    const a = await create('Alpha', home)
    const b = await create('Bravo', home)

    expect(
      (
        await h.put(`${V1}/document/sort`, {
          parent: { id: home },
          sorting: [
            { id: b, sortOrder: 0 },
            { id: c, sortOrder: 1 },
            { id: a, sortOrder: 2 },
          ],
        })
      ).status,
    ).toBe(200)
    expect(await names(home)).toEqual(['Bravo', 'Charlie', 'Alpha'])

    const byName = await h.put(`${V1}/document/${home}/sort-children`, {
      field: 'Name',
      direction: 'Ascending',
    })
    expect(byName.status).toBe(200)
    expect(await names(home)).toEqual(['Alpha', 'Bravo', 'Charlie'])
    await h.put(`${V1}/document/${home}/sort-children`, {
      field: 'CreateDate',
      direction: 'Descending',
    })
    expect(await names(home)).toEqual(['Bravo', 'Alpha', 'Charlie'])

    // A document that is not a child of the parent is refused
    const other = await create('Other')
    expect(
      (
        await h.put(`${V1}/document/sort`, {
          parent: { id: home },
          sorting: [{ id: other, sortOrder: 0 }],
        })
      ).status,
    ).toBe(404)
    expect(
      (await h.put(`${V1}/document/root/sort-children`, { field: 'Name', direction: 'Descending' }))
        .status,
    ).toBe(200)
    expect(await names(null)).toEqual(['Other', 'Home'])
    expect(
      (await h.put(`${V1}/document/root/sort-children`, { field: 'Size', direction: 'Descending' }))
        .status,
    ).toBe(400)
  })
})

describe('WP-6.5 recycle bin', () => {
  test('restore returns a branch to where it was, or to a chosen target', async () => {
    const { h, create, publish, names } = await site()
    const home = await create('Home')
    const about = await create('About', home)
    const team = await create('Team', about)
    const news = await create('News')
    for (const key of [home, about, team]) await publish(key)

    await h.put(`${V1}/document/${about}/move-to-recycle-bin`, {})
    expect(await names(home)).toEqual([])
    const restored = await h.put(`${V1}/recycle-bin/document/${about}/restore`, {})
    expect(restored.status).toBe(200)
    expect(await names(home)).toEqual(['About'])
    expect(await names(about)).toEqual(['Team'])
    // Restored content is not published, and not in the bin
    const doc = await h.json<{ isTrashed: boolean; variants: Array<{ state: string }> }>(
      `${V1}/document/${about}`,
    )
    expect(doc).toMatchObject({ isTrashed: false, variants: [{ state: 'Draft' }] })

    await h.put(`${V1}/document/${about}/move-to-recycle-bin`, {})
    expect(
      (await h.put(`${V1}/recycle-bin/document/${about}/restore`, { target: { id: news } })).status,
    ).toBe(200)
    expect(await names(news)).toEqual(['About'])
    // Only what is in the bin can be restored
    expect((await h.put(`${V1}/recycle-bin/document/${about}/restore`, {})).status).toBe(404)
  })

  test('delete removes one trashed branch; empty removes them all', async () => {
    const { h, create } = await site()
    const a = await create('A')
    const a1 = await create('A1', a)
    const b = await create('B')
    const live = await create('Live')

    expect((await h.del(`${V1}/recycle-bin/document/${live}`)).status).toBe(400)
    await h.put(`${V1}/document/${a}/move-to-recycle-bin`, {})
    await h.put(`${V1}/document/${b}/move-to-recycle-bin`, {})
    expect((await h.del(`${V1}/recycle-bin/document/${a}`)).status).toBe(200)
    expect((await h.call(`${V1}/document/${a1}`)).status).toBe(404)
    const bin = async () =>
      (await h.json<{ total: number }>(`${V1}/recycle-bin/document/root?skip=0&take=10`)).total
    expect(await bin()).toBe(1)
    expect((await h.del(`${V1}/recycle-bin/document`)).status).toBe(200)
    expect(await bin()).toBe(0)
    expect((await h.call(`${V1}/document/${live}`)).status).toBe(200)
  })
})

describe('WP-6.5 publishing a branch and past versions', () => {
  test('publish with descendants publishes what was published, or everything, skipping what cannot', async () => {
    const { h, create, publish, children } = await site()
    const home = await create('Home')
    const a = await create('A', home)
    const b = await create('B', home)
    const bChild = await create('B child', b)
    const broken = await create('Broken', home, null)
    await publish(home)
    await publish(a)
    // Change A so republishing it is visible
    await h.put(`${V1}/document/${a}`, {
      template: null,
      values: [{ alias: 'title', culture: null, segment: null, value: 'A2' }],
      variants: [{ culture: null, segment: null, name: 'A' }],
    })
    const state = async () =>
      Object.fromEntries(
        (await children(home)).map((c) => [c.variants[0]?.name, c.variants[0]?.state]),
      )
    expect(await state()).toEqual({
      A: 'PublishedPendingChanges',
      B: 'Draft',
      Broken: 'Draft',
    })

    const only = await h.put(`${V1}/document/${home}/publish-with-descendants`, {
      includeUnpublishedDescendants: false,
      cultures: [],
    })
    expect(only.status).toBe(200)
    const task = await only.json()
    expect(task).toMatchObject({ isComplete: true })
    expect(await state()).toEqual({ A: 'Published', B: 'Draft', Broken: 'Draft' })

    const all = await h.put(`${V1}/document/${home}/publish-with-descendants`, {
      includeUnpublishedDescendants: true,
      cultures: [],
    })
    expect(all.status).toBe(200)
    // The one missing its mandatory title is reported and skipped
    expect(all.headers.get('umb-notifications')).toContain('Title')
    expect(await state()).toEqual({ A: 'Published', B: 'Published', Broken: 'Draft' })
    expect((await children(b))[0]?.variants[0]?.state).toBe('Published')
    void bChild
    void broken

    const { taskId } = (await all.json()) as { taskId: string }
    expect(
      await h.json<unknown>(`${V1}/document/${home}/publish-with-descendants/result/${taskId}`),
    ).toEqual({ taskId, isComplete: true })
    expect(
      (
        await h.call(
          `${V1}/document/${home}/publish-with-descendants/result/${crypto.randomUUID()}`,
        )
      ).status,
    ).toBe(404)
  })

  test('a past version reads as it stood; item ancestors list the path', async () => {
    const { h, create } = await site()
    const home = await create('Home')
    const page = await create('First name', home, 'First title')
    await h.put(`${V1}/document/${page}`, {
      template: null,
      values: [{ alias: 'title', culture: null, segment: null, value: 'Second title' }],
      variants: [{ culture: null, segment: null, name: 'Second name' }],
    })
    const versions = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/document-version?documentId=${page}&skip=0&take=10`,
    )
    const oldest = versions.items.at(-1)?.id as string
    const version = await h.json<{
      id: string
      document: { id: string }
      values: Array<{ alias: string; value: unknown }>
      variants: Array<{ name: string }>
    }>(`${V1}/document-version/${oldest}`)
    expect(version).toMatchObject({ id: oldest, document: { id: page } })
    expect(version.values.find((v) => v.alias === 'title')?.value).toBe('First title')
    expect(version.variants[0]?.name).toBe('First name')
    expect((await h.call(`${V1}/document-version/999999`)).status).toBe(404)

    const ancestors = await h.json<Array<{ id: string; ancestors: Array<{ id: string }> }>>(
      `${V1}/item/document/ancestors?id=${page}&id=${home}`,
    )
    expect(ancestors).toEqual([
      { id: page, ancestors: [expect.objectContaining({ id: home })] },
      { id: home, ancestors: [] },
    ])
  })
})

describe('WP-6.5 scheduled publishing', () => {
  test('a future publish time waits for the job; an unpublish time takes the page down later', async () => {
    const { h, create } = await site()
    const home = await create('Home')
    const inAnHour = new Date(Date.now() + 60 * 60_000)
    const inADay = new Date(Date.now() + 24 * 60 * 60_000)
    const scheduled = await h.put(`${V1}/document/${home}/publish`, {
      publishSchedules: [
        {
          culture: null,
          schedule: { publishTime: inAnHour.toISOString(), unpublishTime: inADay.toISOString() },
        },
      ],
    })
    expect(scheduled.status).toBe(200)
    type Doc = {
      variants: Array<{
        state: string
        scheduledPublishDate: string | null
        scheduledUnpublishDate: string | null
      }>
    }
    const before = await h.json<Doc>(`${V1}/document/${home}`)
    expect(before.variants[0]).toMatchObject({
      state: 'Draft',
      scheduledPublishDate: inAnHour.toISOString(),
      scheduledUnpublishDate: inADay.toISOString(),
    })
    expect((await h.call('/')).status).toBe(404)

    // Nothing is due yet
    expect((await h.server.jobs.runScheduledPublishing()).published).toEqual([])
    const release = await h.server.jobs.runScheduledPublishing(new Date(inAnHour.getTime() + 1000))
    expect(release.published).toEqual([home])
    expect((await h.call('/')).status).toBe(200)
    const live = await h.json<Doc>(`${V1}/document/${home}`)
    expect(live.variants[0]).toMatchObject({
      state: 'Published',
      scheduledPublishDate: null,
      scheduledUnpublishDate: inADay.toISOString(),
    })
    // A schedule runs once
    expect(
      (await h.server.jobs.runScheduledPublishing(new Date(inAnHour.getTime() + 2000))).published,
    ).toEqual([])

    const expire = await h.server.jobs.runScheduledPublishing(new Date(inADay.getTime() + 1000))
    expect(expire.unpublished).toEqual([home])
    expect((await h.call('/')).status).toBe(404)
  })

  test('publishing now clears a pending schedule; a bad date is refused', async () => {
    const { h, create } = await site()
    const home = await create('Home')
    const later = new Date(Date.now() + 60 * 60_000).toISOString()
    await h.put(`${V1}/document/${home}/publish`, {
      publishSchedules: [{ culture: null, schedule: { publishTime: later } }],
    })
    await h.put(`${V1}/document/${home}/publish`, {
      publishSchedules: [{ culture: null, schedule: null }],
    })
    const doc = await h.json<{ variants: Array<{ state: string; scheduledPublishDate: null }> }>(
      `${V1}/document/${home}`,
    )
    expect(doc.variants[0]).toMatchObject({ state: 'Published', scheduledPublishDate: null })
    expect(
      (
        await h.put(`${V1}/document/${home}/publish`, {
          publishSchedules: [{ culture: null, schedule: { publishTime: 'soon' } }],
        })
      ).status,
    ).toBe(400)
  })
})

describe('WP-6.5 version cleanup', () => {
  test('prunes by age and per day, keeps pinned and current versions, and every kept version reads as before', async () => {
    const { h, create } = await site()
    const page = await create('Page', null, 'A1')
    const save = (title: string, body?: string) =>
      h.put(`${V1}/document/${page}`, {
        template: null,
        values: [
          { alias: 'title', culture: null, segment: null, value: title },
          ...(body === undefined
            ? []
            : [{ alias: 'body', culture: null, segment: null, value: body }]),
        ],
        variants: [{ culture: null, segment: null, name: 'Page' }],
      })
    await save('A1', 'B') // e2 (e1 was the create)
    await save('A2', 'B') // e3
    await save('A3', 'B') // e4
    await save('A4', 'B') // e5
    await save('A5', 'B') // e6, current
    type Versions = { items: Array<{ id: string }> }
    const ids = (
      await h.json<Versions>(`${V1}/document-version?documentId=${page}&skip=0&take=50`)
    ).items
      .map((v) => Number(v.id))
      .sort((a, b) => a - b)
    expect(ids).toHaveLength(6)
    const [e1, e2, e3, e4, e5, e6] = ids as [number, number, number, number, number, number]
    const day = 24 * 60 * 60_000
    const now = Date.now()
    const at = (id: number, when: number) =>
      h.server.db.exec('UPDATE content_version SET version_date = ? WHERE id = ?', [
        new Date(when).toISOString(),
        id,
      ])
    await at(e1, now - 300 * day)
    await at(e2, now - 200 * day) // body B first written here
    await at(e3, now - 200 * day + 1000)
    // Midday UTC ten days ago, so both land on the same calendar day
    const midday = Math.floor((now - 10 * day) / day) * day + day / 2
    await at(e4, midday) // same day as e5, earlier: pruned
    await at(e5, midday + 1000) // that day's latest: kept
    // Pin e3; it reads body B, which only the pruned e2 wrote
    await h.put(`${V1}/document-version/${e3}/prevent-cleanup?preventCleanup=true`, {})

    const read = async (id: number) =>
      Object.fromEntries(
        (
          await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
            `${V1}/document-version/${id}`,
          )
        ).values.map((v) => [v.alias, v.value]),
      )
    const before = { e3: await read(e3), e5: await read(e5), e6: await read(e6) }
    expect(before.e3).toEqual({ title: 'A2', body: 'B' })

    const result = await h.server.jobs.runVersionCleanup(new Date(now))
    expect(result).toEqual({ nodes: 1, versionsDeleted: 3 })
    const left = (
      await h.json<Versions>(`${V1}/document-version?documentId=${page}&skip=0&take=50`)
    ).items
      .map((v) => Number(v.id))
      .sort((a, b) => a - b)
    expect(left).toEqual([e3, e5, e6])
    expect({ e3: await read(e3), e5: await read(e5), e6: await read(e6) }).toEqual(before)
    const current = await h.json<{ values: Array<{ alias: string; value: unknown }> }>(
      `${V1}/document/${page}`,
    )
    expect(Object.fromEntries(current.values.map((v) => [v.alias, v.value]))).toEqual({
      title: 'A5',
      body: 'B',
    })
    // Nothing more to do on a second run
    expect(await h.server.jobs.runVersionCleanup(new Date(now))).toEqual({
      nodes: 0,
      versionsDeleted: 0,
    })
  })
})

describe('WP-6.5 culture and hostnames, notifications', () => {
  test('a hostname roots the site at a document, in its culture; names are unique', async () => {
    const { h, create, publish } = await site()
    const home = await create('Home')
    const about = await create('About', home)
    const other = await create('Other Site')
    const contact = await create('Contact', other)
    for (const key of [home, about, other, contact]) await publish(key)

    expect(await h.json<unknown>(`${V1}/document/${other}/domains`)).toEqual({
      defaultIsoCode: null,
      domains: [],
    })
    const saved = await h.put(`${V1}/document/${other}/domains`, {
      defaultIsoCode: 'en-US',
      domains: [
        { domainName: 'https://Other.example/', isoCode: 'en-US' },
        { domainName: 'other.example/sub', isoCode: 'en-US' },
      ],
    })
    expect(saved.status).toBe(200)
    expect(await h.json<unknown>(`${V1}/document/${other}/domains`)).toEqual({
      defaultIsoCode: 'en-US',
      domains: [
        { domainName: 'other.example', isoCode: 'en-US' },
        { domainName: 'other.example/sub', isoCode: 'en-US' },
      ],
    })

    const visit = (url: string) => h.server.fetch(new Request(url))
    // The hostname's document is its root, and its children sit directly below
    const rooted = await (await visit('http://other.example/')).text()
    expect(rooted).toContain('<h1>Other Site</h1>')
    // …in the hostname's culture
    expect(rooted).toContain('<i>en-US</i>')
    expect(await (await visit('http://other.example/contact')).text()).toContain('<h1>Contact</h1>')
    // The longest match wins: the /sub prefix roots at the same document
    expect((await visit('http://other.example/sub/contact')).status).toBe(200)
    // Another host still routes without domains
    const plain = await (await visit('http://localhost/')).text()
    expect(plain).toContain('<h1>Home</h1>')
    expect(plain).toContain('<i>none</i>')
    expect((await visit('http://other.example/about')).status).toBe(404)
    // The editor's URL for a page under a hostname names the host
    const urls = await h.json<Array<{ urlInfos: Array<{ url: string }> }>>(
      `${V1}/document/urls?id=${contact}`,
    )
    expect(urls[0]?.urlInfos[0]?.url).toBe('//other.example/contact')

    // A hostname belongs to one document
    const taken = await h.put(`${V1}/document/${home}/domains`, {
      defaultIsoCode: null,
      domains: [{ domainName: 'other.example', isoCode: 'en-US' }],
    })
    expect(taken.status).toBe(409)
    expect(
      (
        await h.put(`${V1}/document/${home}/domains`, {
          defaultIsoCode: null,
          domains: [{ domainName: 'home.example', isoCode: 'xx-XX' }],
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await h.put(`${V1}/document/${home}/domains`, {
          defaultIsoCode: null,
          domains: [{ domainName: 'not a host!', isoCode: 'en-US' }],
        })
      ).status,
    ).toBe(400)
    // Clearing them restores path routing for that host
    await h.put(`${V1}/document/${other}/domains`, { defaultIsoCode: null, domains: [] })
    expect((await visit('http://other.example/contact')).status).toBe(200)
    expect(await (await visit('http://other.example/')).text()).toContain('<h1>Home</h1>')
  })

  test("notifications list Umbraco's actions, and keep each user's subscriptions", async () => {
    const { h, create } = await site()
    const home = await create('Home')
    type Notification = { actionId: string; alias: string; subscribed: boolean }
    const list = await h.json<Notification[]>(`${V1}/document/${home}/notifications`)
    expect(list.map((n) => n.alias)).toEqual([
      'copy',
      'delete',
      'move',
      'create',
      'protect',
      'publish',
      'restore',
      'rights',
      'rollback',
      'sort',
      'update',
    ])
    expect(list.every((n) => !n.subscribed)).toBe(true)

    const saved = await h.put(`${V1}/document/${home}/notifications`, {
      subscribedActionIds: ['Umb.Document.Publish', 'Umb.Document.Delete', 'Not.An.Action'],
    })
    expect(saved.status).toBe(200)
    const after = await h.json<Notification[]>(`${V1}/document/${home}/notifications`)
    expect(after.filter((n) => n.subscribed).map((n) => n.actionId)).toEqual([
      'Umb.Document.Delete',
      'Umb.Document.Publish',
    ])
    expect((await h.call(`${V1}/document/${crypto.randomUUID()}/notifications`)).status).toBe(404)
    // Deleting the document takes its subscriptions with it
    await h.put(`${V1}/document/${home}/move-to-recycle-bin`, {})
    expect((await h.del(`${V1}/recycle-bin/document/${home}`)).status).toBe(200)
  })
})

describe('WP-6.5 preview', () => {
  test('the preview URL enters preview; a signed-in editor then sees drafts, and nobody else does', async () => {
    const { h, create, publish, componentKey } = await site()
    const home = await create('Home', null, 'Published title')
    await publish(home)
    await h.put(`${V1}/document/${home}`, {
      template: { id: componentKey },
      values: [{ alias: 'title', culture: null, segment: null, value: 'Draft title' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    const draftOnly = await create('Draft only', home, 'Never published')

    // Before preview, the editor sees what everyone sees
    expect(await (await h.call('/')).text()).toContain('Published title')

    const response = await h.call(
      `${V1}/document/${home}/preview-url?providerAlias=umbDocumentUrlProvider`,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('UMB_PREVIEW=preview')
    expect(await response.json()).toEqual({
      url: `preview?id=${home}&culture=&segment=`,
      provider: 'umbDocumentUrlProvider',
      isExternal: false,
      culture: null,
      message: null,
    })

    // The preview app frames /<key>; routed URLs render drafts too
    expect(await (await h.call(`/${home}`)).text()).toContain('Draft title')
    expect(await (await h.call('/')).text()).toContain('Draft title')
    expect(await (await h.call(`/${draftOnly}`)).text()).toContain('Never published')

    // Without a signed-in editor the cookie changes nothing
    const anonymous = (path: string) =>
      h.server.fetch(
        new Request(`http://localhost${path}`, { headers: { cookie: 'UMB_PREVIEW=preview' } }),
      )
    expect(await (await anonymous('/')).text()).toContain('Published title')
    expect((await anonymous(`/${draftOnly}`)).status).toBe(404)

    // Leaving preview expires the cookie
    const exit = await h.del(`${V1}/preview`)
    expect(exit.status).toBe(200)
    expect(exit.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await (await h.call('/')).text()).toContain('Published title')
    expect(
      (await h.call(`${V1}/document/${crypto.randomUUID()}/preview-url?providerAlias=x`)).status,
    ).toBe(404)
  })

  test('an open preview is told to refresh when its document is saved', async () => {
    const { h, create } = await site()
    const home = await create('Home')
    const server = Bun.serve({ ...h.server.serveOptions, port: 0 })
    try {
      const ws = new WebSocket(`ws://localhost:${server.port}/umbraco/PreviewHub`, {
        headers: { cookie: h.cookie() },
      } as unknown as string[])
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', reject, { once: true })
      })
      const RS = '\u001e'
      const handshake = new Promise((resolve) =>
        ws.addEventListener('message', resolve, { once: true }),
      )
      ws.send(`${JSON.stringify({ protocol: 'json', version: 1 })}${RS}`)
      await handshake
      const refreshed = new Promise<unknown>((resolve) =>
        ws.addEventListener(
          'message',
          (event) => resolve(JSON.parse(String(event.data).replace(RS, ''))),
          {
            once: true,
          },
        ),
      )
      await h.put(`${V1}/document/${home}`, {
        template: null,
        values: [{ alias: 'title', culture: null, segment: null, value: 'Changed' }],
        variants: [{ culture: null, segment: null, name: 'Home' }],
      })
      expect(await refreshed).toEqual({ type: 1, target: 'refreshed', arguments: [home] })
      ws.close()
    } finally {
      server.stop(true)
    }
  })
})

describe('WP-6.5 document blueprints', () => {
  test('a blueprint made from a page lists under its type, and scaffolds a new page', async () => {
    const { h, create } = await site()
    const home = await create('Home', null, 'Welcome')
    const typeKey = (await h.json<{ documentType: { id: string } }>(`${V1}/document/${home}`))
      .documentType.id

    const folder = await h.post(`${V1}/document-blueprint/folder`, {
      name: 'Landing pages',
      parent: null,
    })
    expect(folder.status).toBe(201)
    const folderKey = folder.headers.get('umb-generated-resource') as string

    const made = await h.post(`${V1}/document-blueprint/from-document`, {
      document: { id: home },
      name: 'Landing page',
      parent: { id: folderKey },
    })
    expect(made.status).toBe(201)
    const blueprintKey = made.headers.get('umb-generated-resource') as string

    type Blueprint = {
      id: string
      documentType: { id: string }
      values: Array<{ alias: string; value: unknown }>
      variants: Array<{ name: string; state: string }>
    }
    const blueprint = await h.json<Blueprint>(`${V1}/document-blueprint/${blueprintKey}`)
    expect(blueprint).toMatchObject({
      id: blueprintKey,
      documentType: { id: typeKey },
      variants: [{ name: 'Landing page', state: 'Draft' }],
    })
    expect(blueprint.values.find((v) => v.alias === 'title')?.value).toBe('Welcome')

    // The tree: the folder at the root, the blueprint inside it
    type Tree = {
      items: Array<{ id: string; name: string; isFolder: boolean; documentType: unknown }>
    }
    const root = await h.json<Tree>(`${V1}/tree/document-blueprint/root?skip=0&take=10`)
    expect(root.items).toEqual([
      expect.objectContaining({
        id: folderKey,
        name: 'Landing pages',
        isFolder: true,
        documentType: null,
      }),
    ])
    const inside = await h.json<Tree>(
      `${V1}/tree/document-blueprint/children?parentId=${folderKey}&skip=0&take=10`,
    )
    expect(inside.items).toEqual([
      expect.objectContaining({
        id: blueprintKey,
        isFolder: false,
        documentType: expect.objectContaining({ id: typeKey }),
      }),
    ])
    expect(
      (
        await h.json<Array<{ id: string }>>(
          `${V1}/tree/document-blueprint/ancestors?descendantId=${blueprintKey}`,
        )
      ).map((a) => a.id),
    ).toEqual([folderKey])
    expect(await h.json<unknown>(`${V1}/item/document-blueprint?id=${blueprintKey}`)).toEqual([
      {
        id: blueprintKey,
        name: 'Landing page',
        documentType: expect.objectContaining({ id: typeKey }),
        flags: [],
      },
    ])

    // The create dialog offers it once the type is picked
    expect(
      await h.json<unknown>(`${V1}/document-type/${typeKey}/blueprint?skip=0&take=10`),
    ).toEqual({
      total: 1,
      items: [{ id: blueprintKey, name: 'Landing page', flags: [] }],
    })
    // …and the new page starts from its scaffold, under a fresh id
    const scaffold = await h.json<Blueprint>(`${V1}/document-blueprint/${blueprintKey}/scaffold`)
    expect(scaffold.id).not.toBe(blueprintKey)
    expect(scaffold.values.find((v) => v.alias === 'title')?.value).toBe('Welcome')

    // Edit it in its own editor; it never publishes
    expect(
      (
        await h.put(`${V1}/document-blueprint/${blueprintKey}`, {
          values: [{ alias: 'title', culture: null, segment: null, value: 'Hello' }],
          variants: [{ culture: null, segment: null, name: 'Landing page v2' }],
        })
      ).status,
    ).toBe(200)
    const edited = await h.json<Blueprint>(`${V1}/document-blueprint/${blueprintKey}`)
    expect(edited.variants[0]?.name).toBe('Landing page v2')
    expect(edited.values.find((v) => v.alias === 'title')?.value).toBe('Hello')
    const log = await h.json<{ total: number }>(
      `${V1}/document-blueprint/${blueprintKey}/audit-log?skip=0&take=10`,
    )
    expect(log.total).toBe(2)
    // Blueprints are not documents, and are not routed
    expect((await h.call(`${V1}/document/${blueprintKey}`)).status).toBe(404)

    // Move out of the folder; the emptied folder can go; the blueprint deletes
    expect(
      (await h.put(`${V1}/document-blueprint/${blueprintKey}/move`, { target: null })).status,
    ).toBe(200)
    expect((await h.del(`${V1}/document-blueprint/folder/${folderKey}`)).status).toBe(200)
    expect((await h.del(`${V1}/document-blueprint/${blueprintKey}`)).status).toBe(200)
    expect((await h.call(`${V1}/document-blueprint/${blueprintKey}`)).status).toBe(404)
  })

  test('a blueprint can be created directly', async () => {
    const { h, create } = await site()
    const home = await create('Home')
    const typeKey = (await h.json<{ documentType: { id: string } }>(`${V1}/document/${home}`))
      .documentType.id
    const made = await h.post(`${V1}/document-blueprint`, {
      documentType: { id: typeKey },
      parent: null,
      values: [{ alias: 'title', culture: null, segment: null, value: 'Blank' }],
      variants: [{ culture: null, segment: null, name: 'Blank page' }],
    })
    expect(made.status).toBe(201)
    const root = await h.json<{ items: Array<{ name: string }> }>(
      `${V1}/tree/document-blueprint/root?skip=0&take=10`,
    )
    expect(root.items.map((i) => i.name)).toEqual(['Blank page'])
    expect(
      (
        await h.post(`${V1}/document-blueprint/from-document`, {
          document: { id: crypto.randomUUID() },
          name: 'x',
        })
      ).status,
    ).toBe(404)
  })
})

describe('WP-6.5 item ancestors and public access', () => {
  test('item ancestors: folders for types and data types, the layout chain for templates', async () => {
    const { h, create, componentKey } = await site()
    const home = await create('Home')
    const typeKey = (await h.json<{ documentType: { id: string } }>(`${V1}/document/${home}`))
      .documentType.id
    const folder = await h.post(`${V1}/document-type/folder`, { name: 'Pages', parent: null })
    const folderKey = folder.headers.get('umb-generated-resource') as string
    expect(
      (await h.put(`${V1}/document-type/${typeKey}/move`, { target: { id: folderKey } })).status,
    ).toBe(200)
    expect(await h.json<unknown>(`${V1}/item/document-type/ancestors?id=${typeKey}`)).toEqual([
      { id: typeKey, ancestors: [{ id: folderKey, name: 'Pages', flags: [] }] },
    ])

    const textstring = '0cc0eba1-9960-42c9-bf9b-60e150b429ae'
    expect(await h.json<unknown>(`${V1}/item/data-type/ancestors?id=${textstring}`)).toEqual([
      { id: textstring, ancestors: [] },
    ])

    const child = await h.post(`${V1}/template`, {
      name: 'Child',
      alias: 'child',
      content: "export const layout = 'page'\nexport default function C() { return <p /> }\n",
    })
    const childKey = child.headers.get('umb-generated-resource') as string
    expect(await h.json<unknown>(`${V1}/item/template/ancestors?id=${childKey}`)).toEqual([
      { id: childKey, ancestors: [{ id: componentKey, name: 'page', alias: 'page', flags: [] }] },
    ])
  })

  test('public access: an unprotected page has no entry, and an unknown one is a 404', async () => {
    const { h, create } = await site()
    const home = await create('Home')
    const read = await h.call(`${V1}/document/${home}/public-access`)
    expect(read.status).toBe(404)
    expect((await read.json()).title).toBe('Entry not found')
    expect((await h.call(`${V1}/document/${crypto.randomUUID()}/public-access`)).status).toBe(404)
  })
})
