/**
 * Story 071: members moving between crombolo sites in a bundle's sealed
 * `people/` — by key, with e-mail clashes answered, and a password set at the
 * destination kept.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemberRepository, SYSTEM_MEMBER_TYPE } from '@crombolo/data'
import {
  type BundlePeople,
  type ContentSet,
  exportBundle,
  exportPeople,
  importBundle,
  loadBundle,
  newSeal,
  openBundle,
  writeBundle,
  writeBundlePackage,
} from '@crombolo/transfer'
import { dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const PASS = 'members on the move'
const CHEAP = { n: 2 ** 10, r: 8, p: 1 }

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

async function server(): Promise<Harness> {
  const h = await signedInServer()
  open.push(h)
  return h
}

async function member(h: Harness, name: string, password: string, groups: string[] = []) {
  const created = await h.post(`${V1}/member`, {
    memberType: { id: SYSTEM_MEMBER_TYPE.key },
    email: `${name}@example.test`,
    username: name,
    password,
    isApproved: true,
    groups,
    values: [],
    variants: [{ culture: null, segment: null, name }],
  })
  expect(created.status).toBe(201)
  return created.headers.get('umb-generated-resource') as string
}

const login = (h: Harness, username: string, password: string) =>
  h.server.fetch(
    new Request('http://localhost/umbraco/members/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  )

/** The source's members as a sealed bundle on disk, opened again as the destination would. */
async function sealedMembers(source: Harness): Promise<ContentSet> {
  const people = await exportPeople(source.server.db, { members: true, users: false })
  const { set } = await exportBundle(source.server.db, {
    roots: [],
    asGiven: [],
    descendants: false,
    snapshot: 'published',
    blueprints: false,
    withBlobs: false,
    siteName: 'Source',
    nodeId: 'source',
  })
  const dir = mkdtempSync(join(process.cwd(), 'output', 'people-transfer-'))
  dirs.push(dir)
  const payload = writeBundle(set, undefined, [], { seal: newSeal(PASS, CHEAP), people })
  for (const file of writeBundlePackage(payload, {
    name: 'members',
    version: '1.0.0',
    id: 'members',
    label: 'Members',
    private: true,
    peerRange: '*',
  })) {
    mkdirSync(join(dir, file.path, '..'), { recursive: true })
    writeFileSync(join(dir, file.path), file.bytes ?? (file.text as string))
  }
  return openBundle(loadBundle(join(dir, 'content')), PASS).set
}

describe(`members between crombolo sites (${dialectUnderTest})`, () => {
  test('arrive with their groups, and sign in with the password they had', async () => {
    const source = await server()
    const group = await source.post(`${V1}/member-group`, { name: 'Friends' })
    expect(group.status).toBe(201)
    const groupKey = group.headers.get('umb-generated-resource') as string
    const ada = await member(source, 'ada', 'a password for ada', [groupKey])
    const set = await sealedMembers(source)
    expect((set.people as BundlePeople).members.map((m) => m.key)).toEqual([ada])

    const destination = await server()
    const result = await importBundle(destination.server.db, set, { nodeId: 'test' })
    expect(result.check.outstanding).toEqual([])
    expect(result.people.map((p) => [p.kind, p.action])).toEqual([
      ['member-group', 'create'],
      ['member', 'create'],
    ])
    expect((await login(destination, 'ada', 'a password for ada')).status).toBe(200)
    const here = await new MemberRepository(destination.server.db).byKey(ada)
    expect(here?.roles).toEqual(['Friends'])
  })

  test('the same key updates the member, keeping a password set here since', async () => {
    const source = await server()
    const ada = await member(source, 'ada', 'the old password')
    const set = await sealedMembers(source)
    const destination = await server()
    await importBundle(destination.server.db, set, { nodeId: 'test' })
    // Changed here after the first import.
    const changed = await destination.put(`${V1}/member/${ada}`, {
      email: 'ada@example.test',
      username: 'ada',
      isApproved: true,
      isLockedOut: false,
      isTwoFactorEnabled: false,
      groups: [],
      values: [],
      variants: [{ culture: null, segment: null, name: 'Ada' }],
      newPassword: 'the password set here',
    })
    expect(changed.status).toBe(200)
    const again = await importBundle(destination.server.db, set, { nodeId: 'test' })
    expect(again.people.map((p) => [p.kind, p.action])).toEqual([['member', 'update']])
    expect((await login(destination, 'ada', 'the password set here')).status).toBe(200)
    expect((await login(destination, 'ada', 'the old password')).status).not.toBe(200)
  })

  test('another member here with the same e-mail is a decision, named by key only', async () => {
    const source = await server()
    const incoming = await member(source, 'ada', 'the bundle password')
    const set = await sealedMembers(source)
    const destination = await server()
    const local = await member(destination, 'ada', 'the local password')

    const asked = await importBundle(destination.server.db, set, { nodeId: 'test' })
    expect(asked.runId).toBeUndefined()
    const conflict = asked.check.outstanding.find((f) => f.code === 'person-conflict')
    expect(conflict).toMatchObject({ kind: 'person', subjectKey: incoming })
    expect(conflict?.message).toContain(local)
    expect(conflict?.message).not.toContain('ada@example.test')

    const skipped = await importBundle(destination.server.db, set, {
      nodeId: 'test',
      resolutions: { [incoming]: { '*': 'skip' } },
    })
    expect(skipped.runId).toBeDefined()
    expect(skipped.people.filter((p) => p.kind === 'member')).toEqual([])

    const taken = await importBundle(destination.server.db, set, {
      nodeId: 'test',
      resolutions: { [incoming]: { '*': 'take-bundle' } },
    })
    expect(taken.people.filter((p) => p.kind === 'member')).toEqual([
      { kind: 'member', key: local, action: 'update' },
    ])
    // The member here keeps their key, and the password set here.
    expect(await new MemberRepository(destination.server.db).byKey(incoming)).toBeUndefined()
    expect((await login(destination, 'ada', 'the local password')).status).toBe(200)
  })

  test('users stay out unless asked for', async () => {
    const source = await server()
    const people = await exportPeople(source.server.db, { members: true, users: false })
    expect(people.users).toEqual([])
    const withUsers = await exportPeople(source.server.db, { members: false, users: true })
    expect(withUsers.users.length).toBeGreaterThan(0)
    expect(withUsers.userGroups.map((g) => g.alias)).toContain('admin')
  })
})
