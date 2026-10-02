/**
 * WP-6.8: member groups. They are plain `node` rows with the MemberGroup object
 * type — no table of their own — and the contract gives them seven operations:
 * CRUD, the item lookup pickers use, and a flat tree root.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const open: Harness[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

async function harness(): Promise<Harness> {
  const created = await signedInServer()
  open.push(created)
  return created
}

const keyOf = (response: Response) => response.headers.get('umb-generated-resource') as string

describe(`member groups (${process.env.BUNBRACO_DB ?? 'sqlite'})`, () => {
  test('are created, read back, renamed and deleted', async () => {
    const h = await harness()

    const created = await h.post(`${V1}/member-group`, { name: 'Subscribers' })
    expect(created.status).toBe(201)
    const key = keyOf(created)
    expect(created.headers.get('location')).toContain(`/member-group/${key}`)

    expect(await h.json<unknown>(`${V1}/member-group/${key}`)).toEqual<unknown>({
      id: key,
      name: 'Subscribers',
    })

    expect((await h.put(`${V1}/member-group/${key}`, { name: 'Members' })).status).toBe(200)
    expect(await h.json<{ id: string; name: string }>(`${V1}/member-group/${key}`)).toEqual({
      id: key,
      name: 'Members',
    })

    expect((await h.del(`${V1}/member-group/${key}`)).status).toBe(200)
    expect((await h.call(`${V1}/member-group/${key}`)).status).toBe(404)
  })

  test('honour a client-supplied key, and refuse a name already taken', async () => {
    const h = await harness()
    const id = crypto.randomUUID()
    expect(keyOf(await h.post(`${V1}/member-group`, { id, name: 'Staff' }))).toBe(id)

    const duplicate = await h.post(`${V1}/member-group`, { name: 'Staff' })
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({ operationStatus: 'DuplicateName' })

    // Renaming onto another group's name is the same clash...
    const other = keyOf(await h.post(`${V1}/member-group`, { name: 'Editors' }))
    expect((await h.put(`${V1}/member-group/${other}`, { name: 'Staff' })).status).toBe(400)
    // ...but renaming a group to what it is already called is not.
    expect((await h.put(`${V1}/member-group/${other}`, { name: 'Editors' })).status).toBe(200)
  })

  test('list, page, and answer the item lookup pickers use', async () => {
    const h = await harness()
    const keys: string[] = []
    for (const name of ['Alpha', 'Beta', 'Gamma'])
      keys.push(keyOf(await h.post(`${V1}/member-group`, { name })))

    const all = await h.json<{ total: number; items: Array<{ name: string }> }>(
      `${V1}/member-group?skip=0&take=100`,
    )
    expect(all.total).toBe(3)
    expect(all.items.map((i) => i.name).sort()).toEqual(['Alpha', 'Beta', 'Gamma'])

    const firstTwo = await h.json<{ total: number; items: unknown[] }>(
      `${V1}/member-group?skip=0&take=2`,
    )
    expect([firstTwo.total, firstTwo.items.length]).toEqual([3, 2])

    const items = await h.json<Array<{ id: string; name: string; flags: unknown[] }>>(
      `${V1}/item/member-group?id=${keys[0]}&id=${keys[2]}`,
    )
    expect(items.map((i) => i.name).sort()).toEqual(['Alpha', 'Gamma'])
    expect(items.every((i) => Array.isArray(i.flags))).toBe(true)
  })

  test('appear in the tree root as a flat list, never as a branch', async () => {
    const h = await harness()
    await h.post(`${V1}/member-group`, { name: 'Readers' })

    const tree = await h.json<{
      total: number
      items: Array<{ name: string; hasChildren: boolean; parent: unknown }>
    }>(`${V1}/tree/member-group/root?skip=0&take=100`)
    expect(tree.total).toBe(1)
    expect(tree.items[0]?.name).toBe('Readers')
    expect(tree.items[0]?.hasChildren).toBe(false)
    expect(tree.items[0]?.parent).toBeNull()
  })

  test('refuse nonsense: a missing group, a blank name, bad paging', async () => {
    const h = await harness()
    const missing = crypto.randomUUID()

    expect((await h.call(`${V1}/member-group/${missing}`)).status).toBe(404)
    expect((await h.put(`${V1}/member-group/${missing}`, { name: 'x' })).status).toBe(404)
    expect((await h.del(`${V1}/member-group/${missing}`)).status).toBe(404)
    expect((await h.post(`${V1}/member-group`, { name: '   ' })).status).toBe(400)
    expect((await h.call(`${V1}/member-group?skip=-1&take=10`)).status).toBe(400)
  })
})
