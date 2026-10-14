/**
 * Story 083: the audit log — who did what, when and from where, across content,
 * settings, users and sign-ins; the Info tab and the Settings dashboard reading
 * it; nothing able to change an entry; and entries ageing out. docs/audit-log.md.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditPlanFor, NOT_AUDITED } from '@crombolo/api-management'
import { listOperations, loadSpec } from '@crombolo/contracts'
import {
  AUDIT_CATEGORIES,
  type AuditEntry,
  AuditLog,
  ComponentRepository,
  ContentTypeRepository,
  STATE_AUDIT_LOG,
} from '@crombolo/data'
import { type CromboloConfig, pluginAuditPlan } from '@crombolo/server'
import {
  BACKOFFICE,
  type Harness,
  ORIGIN,
  signedInServer,
  signInAsGroup,
  V1,
} from './support/harness.ts'

const open: Harness[] = []
const dirs: string[] = []
/** Postgres runs every test in one database, so a second site in a test must follow the first's close. */
async function closeAll() {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
}

afterEach(async () => {
  await closeAll()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const PAGE = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

const SECURITY = `${V1}/security/back-office`
const AUDIT = `${BACKOFFICE}/crombolo/api/audit`
const EDITOR_GROUP = '44dc260e-b4d4-4dd9-9081-eec5598f1641'

async function site(config: Partial<CromboloConfig> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'crombolo-audit-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), PAGE)
  writeFileSync(
    join(root, 'components', 'page.tsx'),
    'export default function Page() { return <p>page</p> }\n',
  )
  const h = await signedInServer({
    config: { schemaDir: join(root, 'schema'), componentsDir: join(root, 'components'), ...config },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const me = (await h.json<{ id: string; name: string }>(`${V1}/user/current`)).id
  const create = async (name: string) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: null,
      values: [{ alias: 'title', culture: null, segment: null, value: name }],
      variants: [{ culture: null, segment: null, name }],
    })
    expect(response.status).toBe(201)
    return response.headers.get('umb-generated-resource') as string
  }
  const log = new AuditLog(h.server.db)
  const entries = async (filter: Parameters<AuditLog['query']>[0]) =>
    (await log.query({ ascending: true, ...filter }, { skip: 0, take: 500 })).items
  return { h, me, create, log, entries }
}

/** A sign-in attempt straight at the login endpoint, from a given address. */
function attempt(h: Harness, username: string, password: string) {
  return h.server.fetch(
    new Request(`${ORIGIN}${SECURITY}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.9' },
      body: JSON.stringify({ username, password }),
    }),
  )
}

const actions = (list: AuditEntry[]) => list.map((entry) => entry.action)

describe('what is recorded', () => {
  test('every contract operation that changes something is either recorded or deliberately left out', () => {
    const missing: string[] = []
    for (const operation of listOperations(loadSpec())) {
      if (operation.method === 'get') continue
      const id = operation.operationId
      const plan = auditPlanFor(id)
      if (plan) expect(AUDIT_CATEGORIES).toContain(plan.category)
      else if (!NOT_AUDITED.has(id) && !id.endsWith('Validate')) missing.push(id)
    }
    expect(missing).toEqual([])

    expect(auditPlanFor('PutDocumentByIdMoveToRecycleBin')).toMatchObject({
      category: 'content',
      entityType: 'Document',
      action: 'Trash',
      key: 'param',
    })
    expect(auditPlanFor('DeleteRecycleBinDocument')).toMatchObject({ action: 'EmptyRecycleBin' })
    expect(auditPlanFor('DeleteRecycleBinMediaById')).toMatchObject({
      category: 'media',
      action: 'Delete',
    })
    expect(auditPlanFor('PutDocumentByIdPublicAccess')).toMatchObject({
      category: 'permission',
      action: 'SetPublicAccess',
    })
    expect(auditPlanFor('PostUserGroupByIdUsers')).toMatchObject({
      category: 'permission',
      action: 'AddUsers',
    })
    expect(auditPlanFor('PostDocumentVersionByIdRollback')).toMatchObject({
      entityType: 'DocumentVersion',
      action: 'Rollback',
    })
    expect(auditPlanFor('PutDocumentTypeById')).toMatchObject({
      category: 'schema',
      action: 'Save',
    })
    expect(auditPlanFor('PostUserData')).toBeUndefined()
    expect(auditPlanFor('PutDocumentByIdValidate')).toBeUndefined()

    expect(pluginAuditPlan('POST', 'schema-import')).toMatchObject({
      category: 'schema',
      entityType: 'Schema',
      action: 'Import',
    })
    expect(pluginAuditPlan('PUT', 'seo')).toMatchObject({ category: 'settings', action: 'Save' })
    expect(pluginAuditPlan('POST', 'bundles/install')).toMatchObject({ action: 'Install' })
  })

  test("a page's life: who, what, when and from where, still named once it is deleted", async () => {
    const { h, me, create, entries } = await site()
    const home = await create('Home')
    expect(
      (
        await h.call(`${V1}/document/${home}/publish`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
          body: JSON.stringify({ publishSchedules: [] }),
        })
      ).status,
    ).toBe(200)
    expect((await h.put(`${V1}/document/${home}/move-to-recycle-bin`, {})).status).toBe(200)
    expect((await h.del(`${V1}/recycle-bin/document/${home}`)).status).toBe(200)

    const life = await entries({ entityKey: home })
    expect(actions(life)).toEqual(['Create', 'Publish', 'Trash', 'Delete'])
    for (const entry of life)
      expect(entry).toMatchObject({
        category: 'content',
        source: 'request',
        userKey: me,
        userName: expect.any(String),
        entityType: 'Document',
        entityName: 'Home',
      })
    expect(life[1]?.forwardedFor).toBe('203.0.113.7')
    // A failed change writes nothing.
    expect((await h.put(`${V1}/document/${crypto.randomUUID()}/publish`, {})).status).toBe(404)
    expect(await entries({ action: 'Publish' })).toHaveLength(1)
    // Reads write nothing either.
    await h.json(`${V1}/tree/document/root?skip=0&take=10`)
    expect((await entries({})).every((entry) => entry.action !== 'Get')).toBe(true)
  })

  test('schema, users and the permissions they hold are recorded with what they were given', async () => {
    const { h, entries } = await site()
    const made = await h.post(`${V1}/data-type`, {
      name: 'Big Text',
      editorAlias: 'Umbraco.TextArea',
      editorUiAlias: 'Umb.PropertyEditorUi.TextArea',
      values: [],
      parent: null,
    })
    expect(made.status).toBe(201)
    const dataType = made.headers.get('umb-generated-resource') as string
    expect(await entries({ entityKey: dataType })).toEqual([
      expect.objectContaining({ category: 'schema', action: 'Create', entityName: 'Big Text' }),
    ])

    const writer = await signInAsGroup(h)
    open.push(writer)
    const writerKey = (await writer.json<{ id: string }>(`${V1}/user/current`)).id
    const created = await entries({ entityKey: writerKey, category: 'user' })
    expect(actions(created)).toEqual(['Create', 'ResetPassword'])
    expect(created[0]?.detail).toBe('Groups: Writers')

    expect(
      (
        await h.post(`${V1}/user/set-user-groups`, {
          userIds: [{ id: writerKey }],
          userGroupIds: [{ id: EDITOR_GROUP }],
        })
      ).status,
    ).toBe(200)
    expect(await entries({ category: 'permission' })).toEqual([
      expect.objectContaining({
        action: 'SetUserGroups',
        entityType: 'User',
        entityKey: writerKey,
        entityName: 'writer@example.com',
        detail: 'Groups: Editors',
      }),
    ])
  })

  test('sign-ins: success, a wrong password, nobody by that name, a lockout, and signing out', async () => {
    const { h, entries } = await site()
    const writer = await signInAsGroup(h)
    open.push(writer)
    const writerKey = (await writer.json<{ id: string }>(`${V1}/user/current`)).id

    expect((await attempt(h, 'nobody@example.com', 'whatever')).status).toBe(401)
    for (let i = 0; i < 10; i++)
      expect((await attempt(h, 'writer@example.com', 'wrong')).status).toBe(401)
    expect((await attempt(h, 'writer@example.com', 'wrong')).status).toBe(403)

    const signIns = await entries({ category: 'sign-in' })
    expect(signIns.filter((e) => e.action === 'SignIn').map((e) => e.userName)).toEqual([
      expect.any(String),
      'writer@example.com',
    ])
    expect(signIns.find((e) => e.userKey === null)).toMatchObject({
      action: 'SignInFailed',
      userName: 'nobody@example.com',
      detail: 'No such user',
      forwardedFor: '198.51.100.9',
    })
    const writers = signIns.filter((e) => e.userKey === writerKey)
    expect(writers.filter((e) => e.detail === 'Wrong password')).toHaveLength(10)
    expect(writers.filter((e) => e.action === 'LockedOut')).toHaveLength(1)
    expect(writers.at(-1)).toMatchObject({ action: 'SignInFailed', detail: 'Account locked' })

    expect((await h.call(`${SECURITY}/signout`)).status).toBe(302)
    expect((await entries({ category: 'sign-in', action: 'SignOut' }))[0]).toMatchObject({
      userName: expect.any(String),
      entityType: 'User',
    })
  })

  test('scheduled publishing is recorded as the job that did it', async () => {
    const { h, create, entries } = await site()
    const home = await create('Home')
    const inAnHour = new Date(Date.now() + 60 * 60_000)
    expect(
      (
        await h.put(`${V1}/document/${home}/publish`, {
          publishSchedules: [{ culture: null, schedule: { publishTime: inAnHour.toISOString() } }],
        })
      ).status,
    ).toBe(200)
    await h.server.jobs.runScheduledPublishing(new Date(inAnHour.getTime() + 1000))
    expect((await entries({ entityKey: home })).at(-1)).toMatchObject({
      action: 'Publish',
      source: 'job',
      userKey: null,
      entityName: 'Home',
      detail: 'Scheduled',
    })
  })
})

describe('reading it', () => {
  test("a page's Info tab answers from the log, and from its versions for the time before it", async () => {
    const { h, me, create } = await site()
    const home = await create('Home')
    await h.put(`${V1}/document/${home}/publish`, { publishSchedules: [] })
    await h.put(`${V1}/document/${home}/move-to-recycle-bin`, {})
    type Log = {
      total: number
      items: Array<{ user: { id: string }; logType: string; comment: string | null }>
    }
    const info = await h.json<Log>(`${V1}/document/${home}/audit-log?skip=0&take=10`)
    expect(info.items.map((item) => item.logType)).toEqual(['Move', 'Publish', 'New'])
    expect(info.items[0]?.comment).toBe('Moved to the recycle bin')
    expect(info.items.every((item) => item.user.id === me)).toBe(true)

    // A database that began the log later: its versions from before then stand in.
    await closeAll()
    const later = await site()
    const page = await later.create('Page')
    // The Postgres harness keeps the ledger between tests, so the real dates go back after.
    const ledger = later.h.server.db
    const applied = await ledger.query<{ id: number; applied_at: unknown }>(
      'SELECT id, applied_at FROM migration_history WHERE to_state = ?',
      [STATE_AUDIT_LOG],
    )
    try {
      await ledger.exec('UPDATE migration_history SET applied_at = ? WHERE to_state = ?', [
        new Date(Date.now() + 60_000).toISOString(),
        STATE_AUDIT_LOG,
      ])
      const merged = await later.h.json<Log>(`${V1}/document/${page}/audit-log?skip=0&take=10`)
      expect(merged.items.map((item) => item.logType).sort()).toEqual(['New', 'Save'])
    } finally {
      for (const row of applied)
        await ledger.exec('UPDATE migration_history SET applied_at = ? WHERE id = ?', [
          row.applied_at instanceof Date ? row.applied_at.toISOString() : row.applied_at,
          row.id,
        ])
    }
  })

  test('the Settings dashboard filters the log; nothing can change an entry; only Settings reads it', async () => {
    const { h, me, create } = await site()
    await create('Home')
    await create('About us')
    type Page = { total: number; retentionDays: number; items: Array<Record<string, unknown>> }
    const all = await h.json<Page>(`${AUDIT}?skip=0&take=50`)
    expect(all.retentionDays).toBe(365)
    expect(all.items[0]).toMatchObject({
      action: 'Create',
      category: 'content',
      user: { key: me },
      item: { type: 'Document', name: 'About us' },
    })
    const about = await h.json<Page>(`${AUDIT}?text=about&skip=0&take=50`)
    expect(about.items.map((item) => (item.item as { name: string }).name)).toEqual(['About us'])
    const signIns = await h.json<Page>(`${AUDIT}?category=sign-in&user=${me}`)
    expect(signIns.items.map((item) => item.action)).toEqual(['SignIn'])
    expect(
      (await h.json<Page>(`${AUDIT}?since=${new Date(Date.now() + 60_000).toISOString()}`)).total,
    ).toBe(0)
    expect((await h.call(`${AUDIT}?category=gossip`)).status).toBe(400)
    expect(await h.json<{ items: unknown[] }>(`${AUDIT}/users`)).toEqual({
      items: [{ key: me, name: expect.any(String) }],
    })

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect((await h.call(AUDIT, { method })).status).toBe(405)
    const writes = listOperations(loadSpec()).filter(
      (operation) => operation.method !== 'get' && operation.path.includes('audit'),
    )
    expect(writes).toEqual([])

    const writer = await signInAsGroup(h)
    open.push(writer)
    expect((await writer.call(AUDIT)).status).toBe(403)
    expect((await h.server.fetch(new Request(`${ORIGIN}${AUDIT}`))).status).toBe(401)
  })
})

describe('retention', () => {
  test('entries past the retention period age out hourly; 0 keeps them all', async () => {
    const { h, log, entries } = await site()
    const old = new Date(Date.now() - 400 * 86_400_000)
    await log.record({ category: 'system', action: 'Old', source: 'job', occurredAt: old })
    await log.record({ category: 'system', action: 'Recent', source: 'job' })
    expect(await h.server.jobs.runAuditRetention()).toBe(1)
    expect(actions(await entries({ category: 'system' }))).toEqual(['Recent'])

    await closeAll()
    const forever = await site({ auditRetentionDays: 0 })
    await forever.log.record({ category: 'system', action: 'Old', source: 'job', occurredAt: old })
    expect(await forever.h.server.jobs.runAuditRetention()).toBe(0)
    expect(actions(await forever.entries({ category: 'system' }))).toEqual(['Old'])
  })
})
