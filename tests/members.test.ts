/**
 * WP-6.8: members. A member is a content node with a sign-in facet, so these
 * cover both halves — the properties a member type declares, and the e-mail,
 * username, approval, lockout and group membership that make it a member.
 *
 * The built-in "Member" type is what a fresh install creates members with, so
 * most of these use it; `customer` exists to prove a site's own type works, and
 * to carry a sensitive property.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Principal } from '@bunbraco/api-management'
import { SYSTEM_MEMBER_TYPE } from '@bunbraco/data'
import { createMemberPort } from '@bunbraco/server'
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

const CUSTOMER = `[member-type]
key = "7b0f1c3d-0001-4a2b-8c4d-000000000001"
alias = "customer"
name = "Customer"
icon = "icon-user"

[[property]]
key = "7b0f1c3d-0001-4a2b-8c4d-000000000002"
alias = "nickname"
name = "Nickname"
type = "textstring"

[[property]]
key = "7b0f1c3d-0001-4a2b-8c4d-000000000003"
alias = "creditLimit"
name = "Credit limit"
type = "textstring"
sensitive = true
`

const CUSTOMER_KEY = '7b0f1c3d-0001-4a2b-8c4d-000000000001'

async function site() {
  const root = mkdtempSync(join(process.cwd(), 'output', 'members-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'member-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'member-types', 'customer.toml'), CUSTOMER)
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components') },
  })
  open.push(h)

  const group = async (name: string) => {
    const response = await h.post(`${V1}/member-group`, { name })
    return response.headers.get('umb-generated-resource') as string
  }
  const create = async (body: Record<string, unknown>) => {
    const response = await h.post(`${V1}/member`, {
      memberType: { id: SYSTEM_MEMBER_TYPE.key },
      isApproved: true,
      values: [],
      ...body,
      variants: body.variants ?? [
        { culture: null, segment: null, name: String(body.username ?? 'Member') },
      ],
    })
    return response
  }
  const member = async (username: string, body: Record<string, unknown> = {}) => {
    const response = await create({
      email: `${username}@example.test`,
      username,
      password: 'correct-horse-battery',
      ...body,
    })
    if (response.status !== 201)
      throw new Error(`create member ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  return { h, create, member, group }
}

interface MemberResponse {
  id: string
  email: string
  username: string
  memberType: { id: string; icon: string }
  isApproved: boolean
  isLockedOut: boolean
  isTwoFactorEnabled: boolean
  failedPasswordAttempts: number
  groups: string[]
  kind: string
  values: Array<{ alias: string; value: unknown }>
  variants: Array<{ name: string }>
}

describe(`members (${process.env.BUNBRACO_DB ?? 'sqlite'})`, () => {
  test('are created, read back, changed and deleted', async () => {
    const { h, member, group } = await site()
    const subscribers = await group('Subscribers')
    const key = await member('ada', { groups: [subscribers] })

    const read = await h.json<MemberResponse>(`${V1}/member/${key}`)
    expect(read).toMatchObject({
      id: key,
      email: 'ada@example.test',
      username: 'ada',
      isApproved: true,
      isLockedOut: false,
      // No second factor is offered, so no member has one.
      isTwoFactorEnabled: false,
      failedPasswordAttempts: 0,
      kind: 'Default',
      memberType: { id: SYSTEM_MEMBER_TYPE.key },
    })
    expect(read.groups).toEqual([subscribers])
    expect(read.variants.map((v) => v.name)).toEqual(['ada'])

    const updated = await h.put(`${V1}/member/${key}`, {
      email: 'ada.lovelace@example.test',
      username: 'ada',
      isApproved: false,
      isLockedOut: false,
      isTwoFactorEnabled: false,
      groups: [],
      values: [],
      variants: [{ culture: null, segment: null, name: 'Ada Lovelace' }],
    })
    expect(updated.status).toBe(200)
    const after = await h.json<MemberResponse>(`${V1}/member/${key}`)
    expect([after.email, after.isApproved, after.groups]).toEqual([
      'ada.lovelace@example.test',
      false,
      [],
    ])
    expect(after.variants.map((v) => v.name)).toEqual(['Ada Lovelace'])

    expect((await h.del(`${V1}/member/${key}`)).status).toBe(200)
    expect((await h.call(`${V1}/member/${key}`)).status).toBe(404)
  })

  test('hold the values their member type declares', async () => {
    const { h, member } = await site()
    const key = await member('grace', {
      memberType: { id: CUSTOMER_KEY },
      values: [{ alias: 'nickname', culture: null, segment: null, value: 'Amazing Grace' }],
    })
    const read = await h.json<MemberResponse>(`${V1}/member/${key}`)
    expect(read.memberType.id).toBe(CUSTOMER_KEY)
    expect(read.values.find((v) => v.alias === 'nickname')?.value).toBe('Amazing Grace')
  })

  test('refuse a username or an e-mail another member already has, whatever the casing', async () => {
    const { h, create, member } = await site()
    await member('ada')

    const sameName = await create({
      email: 'other@example.test',
      username: 'ADA',
      password: 'correct-horse-battery',
    })
    expect(sameName.status).toBe(400)
    expect(await sameName.text()).toContain('username')

    const sameEmail = await create({
      email: 'ADA@example.test',
      username: 'other',
      password: 'correct-horse-battery',
    })
    expect(sameEmail.status).toBe(400)

    // A member keeps its own username and e-mail on save.
    const second = await member('grace')
    expect(
      (
        await h.put(`${V1}/member/${second}`, {
          email: 'grace@example.test',
          username: 'grace',
          isApproved: true,
          isLockedOut: false,
          isTwoFactorEnabled: false,
          values: [],
          variants: [{ culture: null, segment: null, name: 'Grace' }],
        })
      ).status,
    ).toBe(200)
  })

  test('refuse a create with nothing to identify it, and an unknown member type', async () => {
    const { h, create } = await site()
    expect((await create({ username: 'x', password: 'p' })).status).toBe(400)
    expect((await create({ email: 'x@y.z', password: 'p' })).status).toBe(400)
    expect((await create({ email: 'x@y.z', username: 'x' })).status).toBe(400)
    expect(
      (
        await create({
          email: 'x@y.z',
          username: 'x',
          password: 'p',
          memberType: { id: crypto.randomUUID() },
        })
      ).status,
    ).toBe(404)
    expect((await h.call(`${V1}/member/${crypto.randomUUID()}`)).status).toBe(404)
  })

  test('the collection filters by type, group, approval, lockout and text, and orders', async () => {
    const { h, member, group } = await site()
    const staff = await group('Staff')
    await member('ada', { groups: [staff] })
    await member('grace')
    await member('alan', { memberType: { id: CUSTOMER_KEY }, isApproved: false })

    const all = await h.json<{ total: number; items: MemberResponse[] }>(
      `${V1}/filter/member?skip=0&take=100`,
    )
    expect(all.total).toBe(3)
    // Username ascending is Umbraco's default order.
    expect(all.items.map((m) => m.username)).toEqual(['ada', 'alan', 'grace'])

    const descending = await h.json<{ items: MemberResponse[] }>(
      `${V1}/filter/member?skip=0&take=100&orderDirection=Descending`,
    )
    expect(descending.items.map((m) => m.username)).toEqual(['grace', 'alan', 'ada'])

    const byType = await h.json<{ total: number }>(
      `${V1}/filter/member?skip=0&take=100&memberTypeId=${CUSTOMER_KEY}`,
    )
    expect(byType.total).toBe(1)

    const byGroup = await h.json<{ items: MemberResponse[] }>(
      `${V1}/filter/member?skip=0&take=100&memberGroupName=Staff`,
    )
    expect(byGroup.items.map((m) => m.username)).toEqual(['ada'])

    const unapproved = await h.json<{ items: MemberResponse[] }>(
      `${V1}/filter/member?skip=0&take=100&isApproved=false`,
    )
    expect(unapproved.items.map((m) => m.username)).toEqual(['alan'])

    // The text filter reaches the e-mail, the username and the name.
    const text = await h.json<{ items: MemberResponse[] }>(
      `${V1}/filter/member?skip=0&take=100&filter=ala`,
    )
    expect(text.items.map((m) => m.username)).toEqual(['alan'])

    const firstTwo = await h.json<{ total: number; items: unknown[] }>(
      `${V1}/filter/member?skip=0&take=2`,
    )
    expect([firstTwo.total, firstTwo.items.length]).toEqual([3, 2])
    expect((await h.call(`${V1}/filter/member?skip=-1&take=10`)).status).toBe(400)
  })

  test('answer the lookups a member picker makes', async () => {
    const { h, member } = await site()
    const ada = await member('ada')
    const alan = await member('alan', { memberType: { id: CUSTOMER_KEY } })

    const items = await h.json<
      Array<{ id: string; kind: string; variants: Array<{ name: string }> }>
    >(`${V1}/item/member?id=${ada}&id=${alan}`)
    expect(items.map((i) => i.id)).toEqual([ada, alan])
    expect(items.every((i) => i.kind === 'Default')).toBe(true)

    const search = await h.json<{ total: number; items: Array<{ id: string }> }>(
      `${V1}/item/member/search?query=ala&skip=0&take=10`,
    )
    expect(search.items.map((i) => i.id)).toEqual([alan])

    // A picker limited to one member type sees only members of it.
    const limited = await h.json<{ items: Array<{ id: string }> }>(
      `${V1}/item/member/search?query=a&skip=0&take=10&allowedMemberTypes=${CUSTOMER_KEY}`,
    )
    expect(limited.items.map((i) => i.id)).toEqual([alan])

    // A member has no ancestors, but the picker asks all the same.
    expect(await h.json<unknown>(`${V1}/item/member/ancestors?id=${ada}`)).toEqual([
      { id: ada, ancestors: [] },
    ])
  })

  test('withhold a sensitive property from a user outside the Sensitive data group', async () => {
    const { h, member } = await site()
    const key = await member('grace', {
      memberType: { id: CUSTOMER_KEY },
      values: [
        { alias: 'nickname', culture: null, segment: null, value: 'Grace' },
        { alias: 'creditLimit', culture: null, segment: null, value: '5000' },
      ],
    })

    // The seeded administrator is in Sensitive data, as Umbraco's installer puts
    // it, so the editor sees everything.
    const read = await h.json<MemberResponse>(`${V1}/member/${key}`)
    expect(read.values.map((v) => v.alias).sort()).toEqual(['creditLimit', 'nickname'])

    // A user outside that group does not. Asking the port directly is the way to
    // hold the one group membership that decides it.
    // The schema state matters: values of properties the node does not yet know
    // about are not read at all, so the port needs the state the server booted at.
    const port = createMemberPort(h.server.db, { nodeState: h.server.schema.nodeState })
    const viewer = (aliases: string[]) =>
      ({
        groups: aliases.map((alias) => ({
          key: crypto.randomUUID(),
          alias,
          defaults: [],
          granular: new Map(),
        })),
      }) as unknown as Principal
    const withheld = await port.byKey(key, viewer(['admin']))
    expect(withheld?.values.map((v) => v.alias)).toEqual(['nickname'])
    const shown = await port.byKey(key, viewer(['admin', 'sensitiveData']))
    expect(shown?.values.map((v) => v.alias).sort()).toEqual(['creditLimit', 'nickname'])
    expect(shown?.values.find((v) => v.alias === 'creditLimit')?.value).toBe('5000')
  })

  test('validate before a save, exactly as the save would', async () => {
    const { h, member } = await site()
    const key = await member('ada')

    const body = {
      email: 'ada@example.test',
      username: 'ada',
      isApproved: true,
      isLockedOut: false,
      isTwoFactorEnabled: false,
      values: [],
      variants: [{ culture: null, segment: null, name: 'Ada' }],
    }
    expect((await h.put(`${V1}/member/${key}/validate`, body)).status).toBe(200)
    expect((await h.put(`${V1}/member/${key}/validate`, { ...body, email: '' })).status).toBe(400)
    expect((await h.put(`${V1}/member/${crypto.randomUUID()}/validate`, body)).status).toBe(404)

    expect(
      (
        await h.post(`${V1}/member/validate`, {
          ...body,
          memberType: { id: SYSTEM_MEMBER_TYPE.key },
          password: 'correct-horse-battery',
        })
      ).status,
    ).toBe(200)
    expect((await h.post(`${V1}/member/validate`, body)).status).toBe(400)
  })
})
