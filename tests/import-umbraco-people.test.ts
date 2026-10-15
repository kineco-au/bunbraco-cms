/**
 * Story 071: an Umbraco site's members, users, protected pages, redirects and
 * schedules, imported. The demo store has its administrator and none of the
 * rest, so an altered copy adds a member per hash format in a group, a
 * protected page, a redirect and a schedule.
 */
import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ObjectTypes } from '@crombolo/core'
import { DocumentRepository, PublicAccessRepository, RedirectRepository } from '@crombolo/data'
import { type ImportPlan, planImport } from '@crombolo/import-umbraco'
import { componentAliasesIn, VERSION } from '@crombolo/server'
import {
  importBundle,
  loadBundle,
  openBundle,
  revertRun,
  WrongPassphraseError,
} from '@crombolo/transfer'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, signIn } from './support/harness.ts'
import { DEMO_STORE, writePlan } from './support/umbraco-import.ts'

const PASS = 'the demo store passphrase'
const work = mkdtempSync(join(process.cwd(), 'output', 'import-people-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const GROUP = 'c0ffee00-0000-4000-8000-000000000001'
/** One member per format Umbraco has written, and the password each was made from. */
const MEMBERS = [
  {
    key: 'c0ffee00-0000-4000-8000-0000000000a1',
    login: 'identity',
    password: 'Password123!',
    hash: 'AQAAAAIAAYagAAAAEJBorDjt+UEvw55UJVsbgAS6T2IGao+2XpCBbO3EKZoAMzoN+CNOpPdu1c0qrFcJVw==',
    config: '{"hashAlgorithm":"PBKDF2.ASPNETCORE.V3"}',
  },
  {
    key: 'c0ffee00-0000-4000-8000-0000000000a2',
    login: 'umbraco8',
    password: 'Umbraco9Rocks!',
    hash: 'uB/pLEhhe1W7EtWMv/pSgg==1y8+aso9+h3AKRtJXlVYeg2TZKJUr64hccj82ZZ7Ksk=',
    config: null,
  },
  {
    key: 'c0ffee00-0000-4000-8000-0000000000a3',
    login: 'umbraco4',
    password: 'Umbraco9Rocks!',
    hash: 't0U8atXTX/efNCtTafukwZeIpr8=',
    config: '{"hashAlgorithm":"HMACSHA1"}',
  },
]
const HOME = 'a8bcc42f-88a2-427d-8fcc-2de3ed457e57'

let site: string
let plan: ImportPlan
let pages: { protectedPage: string; login: string }

beforeAll(async () => {
  const staging = join(work, 'staging.sqlite')
  // The first plan only converts the backup to SQLite, for the copy to alter.
  await planImport({ source: DEMO_STORE, staging, coreVersion: VERSION })
  const altered = join(work, 'altered.sqlite')
  cpSync(staging, altered)
  const db = new Database(altered)
  const id = (key: string) =>
    (db.query('SELECT id FROM umbracoNode WHERE uniqueId = ?').get(key) as { id: number }).id
  const documents = db
    .query(
      `SELECT n.id, n.uniqueId AS key FROM umbracoNode n JOIN umbracoDocument d ON d.nodeId = n.id
       WHERE n.trashed = 0 AND n.parentId = ? ORDER BY n.sortOrder LIMIT 2`,
    )
    .all(id(HOME)) as Array<{ id: number; key: string }>
  const [protectedPage, login] = documents as [
    { id: number; key: string },
    { id: number; key: string },
  ]
  pages = { protectedPage: protectedPage.key.toLowerCase(), login: login.key.toLowerCase() }
  const memberType = (
    db
      .query(
        "SELECT n.id FROM umbracoNode n WHERE n.nodeObjectType = '9b5416fb-e72f-45a9-a07b-5a9a2709ce43' COLLATE NOCASE ORDER BY n.id LIMIT 1",
      )
      .get() as { id: number }
  ).id
  const node = (key: string, objectType: string, text: string) => {
    db.run(
      `INSERT INTO umbracoNode (uniqueId, parentId, level, path, sortOrder, trashed, nodeUser, "text", nodeObjectType, createDate)
       VALUES (?, -1, 1, '-1', 0, 0, -1, ?, ?, '2026-01-01 00:00:00')`,
      [key, text, objectType],
    )
    const created = id(key)
    db.run('UPDATE umbracoNode SET path = ? WHERE id = ?', [`-1,${created}`, created])
    return created
  }
  const group = node(GROUP, ObjectTypes.MemberGroup, 'Staff')
  for (const member of MEMBERS) {
    const memberId = node(member.key, ObjectTypes.Member, member.login)
    db.run('INSERT INTO umbracoContent (nodeId, contentTypeId) VALUES (?, ?)', [
      memberId,
      memberType,
    ])
    db.run(
      `INSERT INTO umbracoContentVersion (nodeId, versionDate, userId, "current", "text")
       VALUES (?, '2026-01-01 00:00:00', -1, 1, ?)`,
      [memberId, member.login],
    )
    db.run(
      `INSERT INTO cmsMember (nodeId, Email, LoginName, Password, passwordConfig, isLockedOut, isApproved, failedPasswordAttempts)
       VALUES (?, ?, ?, ?, ?, 0, 1, 0)`,
      [memberId, `${member.login}@example.test`, member.login, member.hash, member.config],
    )
    db.run('INSERT INTO cmsMember2MemberGroup (Member, MemberGroup) VALUES (?, ?)', [
      memberId,
      group,
    ])
  }
  const access = 'c0ffee00-0000-4000-8000-0000000000b1'
  db.run(
    `INSERT INTO umbracoAccess (id, nodeId, loginNodeId, noAccessNodeId, createDate, updateDate)
     VALUES (?, ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    [access, protectedPage.id, login.id, login.id],
  )
  for (const [type, value] of [
    ['MemberRole', 'Staff'],
    ['MemberUsername', 'identity'],
  ] as const)
    db.run(
      `INSERT INTO umbracoAccessRule (id, accessId, ruleValue, ruleType, createDate, updateDate)
       VALUES (?, ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
      [crypto.randomUUID(), access, value, type],
    )
  db.run(
    `INSERT INTO umbracoRedirectUrl (id, contentKey, createDateUtc, url, culture, urlHash)
     VALUES (?, ?, '2026-01-01 00:00:00', '/old-address/', NULL, 'x')`,
    [crypto.randomUUID(), protectedPage.key],
  )
  db.run(
    `INSERT INTO umbracoContentSchedule (id, nodeId, languageId, date, action)
     VALUES (?, ?, NULL, '2030-06-01 09:30:00', 'Expire')`,
    [crypto.randomUUID(), protectedPage.id],
  )
  db.close()

  plan = await planImport({
    source: altered,
    coreVersion: VERSION,
    content: 'sealed',
    withMembers: true,
    withUsers: true,
    passphrase: PASS,
  })
  site = join(work, 'site')
  await writePlan(site, plan)
}, 120_000)

const BUNDLE = () => join(site, 'bundles', 'umbraco-import', 'content')
const finding = (code: string) => plan.report.findings.find((f) => f.code === code)

describe('what the report says', () => {
  test('each kind moves to imported, with its count', () => {
    expect(finding('members')).toMatchObject({ class: 'migrates', count: 3 })
    expect(finding('users')).toMatchObject({ class: 'migrates', count: 1 })
    expect(finding('public-access')).toMatchObject({ class: 'migrates', count: 1 })
    expect(finding('redirects')).toMatchObject({ class: 'migrates', count: 1 })
    expect(finding('schedules')).toMatchObject({ class: 'migrates', count: 1 })
    expect(plan.report.findings.filter((f) => f.class === 'not-yet')).toEqual([])
  })
})

describe('the bundle it writes', () => {
  test('names nobody and holds no value in the clear', () => {
    const loaded = loadBundle(BUNDLE())
    expect(loaded.problems).toEqual([])
    expect(loaded.set?.manifest).toMatchObject({
      content: 'sealed',
      people: { counts: { members: 3, memberGroups: 1, users: 1 } },
    })
    const files = [...new Bun.Glob('**/*').scanSync({ cwd: BUNDLE() })]
    const everything = files
      .map((f) => readFileSync(join(BUNDLE(), f)).toString('latin1'))
      .join('\n')
    for (const secret of ['identity@example.test', 'admin@example.com', MEMBERS[0]?.hash as string])
      expect(everything).not.toContain(secret)
    const protectedNode = JSON.parse(
      readFileSync(join(BUNDLE(), 'nodes', `${pages.protectedPage}.json`), 'utf8'),
    )
    expect(protectedNode.access).toEqual({
      loginNode: pages.login,
      errorNode: pages.login,
      memberGroups: ['Staff'],
    })
    expect(protectedNode.redirects).toEqual([{ path: '/old-address', root: null, culture: null }])
    expect(protectedNode.schedule).toEqual([
      { culture: null, action: 'unpublish', date: '2030-06-01T09:30:00.000Z' },
    ])
  })

  test('opens only with the passphrase', () => {
    expect(() => openBundle(loadBundle(BUNDLE()), 'not it')).toThrow(WrongPassphraseError)
  })
})

describe(`importing it (${dialectUnderTest})`, () => {
  const open: Harness[] = []
  afterEach(async () => {
    while (open.length > 0)
      await open
        .pop()
        ?.db.close()
        .catch(() => {})
  })

  test('everyone signs in with the password they had; the rules hold; a revert removes them', async () => {
    if (!(await canConnect())) throw new Error(`no ${dialectUnderTest} to test against`)
    const h = await signedInServer({
      config: { schemaDir: join(site, 'schema'), componentsDir: join(site, 'components') },
    })
    open.push(h)
    const db = h.server.db
    const sealed = loadBundle(BUNDLE())
    const refused = await importBundle(db, sealed.set as never, { nodeId: 'test' })
    expect(refused.runId).toBeUndefined()
    expect(refused.check.outstanding.map((f) => f.code)).toEqual(['content-sealed'])

    const { set } = openBundle(sealed, PASS)
    const result = await importBundle(db, set, {
      nodeId: 'test',
      // As `crombolo start` does on the database it has just created: the
      // administrator it seeded is the site's own, on the password it had.
      adoptUsers: true,
      publish: true,
      allowMissingBlobs: true,
      componentAliases: componentAliasesIn(join(site, 'components')),
    })
    expect(result.check.outstanding).toEqual([])
    expect(result.runId).toBeDefined()
    expect(result.rules).toEqual({ access: 1, schedules: 1, redirects: 1 })
    expect(result.people.filter((p) => p.kind === 'member')).toHaveLength(3)

    // The values came through the seal.
    const home = await new DocumentRepository(db, {
      nodeState: { version: '1.0.0', revision: '0' },
    }).byKey(HOME)
    expect(home?.values.find((v) => v.alias === 'siteName')?.value).toBeTruthy()

    for (const member of MEMBERS) {
      const login = (password: string) =>
        h.server.fetch(
          new Request('http://localhost/umbraco/members/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: member.login, password }),
          }),
        )
      expect((await login('wrong password')).status, member.login).not.toBe(200)
      expect((await login(member.password)).status, member.login).toBe(200)
    }
    // The demo store's administrator, on the password the fixture's README gives.
    await signIn(h.server, { username: 'admin@example.com', password: 'password1234' })

    const access = await new PublicAccessRepository(db).byNodeKey(pages.protectedPage)
    expect(access).toMatchObject({
      loginNodeKey: pages.login,
      memberGroupNames: ['Staff'],
      memberUserNames: ['identity'],
    })
    const redirects = await new RedirectRepository(db).byDocument(pages.protectedPage)
    expect(redirects.items.map((r) => [r.source, r.pattern])).toEqual([['tracked', '/old-address']])
    const schedules = await new DocumentRepository(db, {
      nodeState: { version: '1.0.0', revision: '0' },
    }).schedules(pages.protectedPage)
    expect(schedules.map((s) => [s.action, s.date.toISOString()])).toEqual([
      ['Expire', '2030-06-01T09:30:00.000Z'],
    ])

    const reverted = await revertRun(db, result.runId as string, { resolveAll: 'discard' })
    expect(reverted.check.outstanding).toEqual([])
    expect(reverted.removed).toContain(MEMBERS[0]?.key as string)
    const left = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM member')
    expect(Number(left[0]?.n)).toBe(0)
  }, 180_000)
})
