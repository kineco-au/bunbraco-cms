/**
 * Content notifications, delivered (story 045): a change to a page e-mails the
 * people who asked to hear of it — on that page or one above it — a minute
 * later, as one e-mail per person, never the person who made it, and once
 * across a cluster.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentChangeFor } from '@crombolo/api-management'
import {
  ComponentRepository,
  ContentNotificationRepository,
  ContentTypeRepository,
  DbDate,
} from '@crombolo/data'
import {
  createContentNotificationRunner,
  type EmailMessage,
  type EmailPort,
  notificationEmail,
} from '@crombolo/server'
import { markUnavailable } from '../packages/backoffice-host/plugin/notifications-dialog.js'
import { ROOT } from '../scripts/packages.ts'
import { BACKOFFICE, type Harness, signedInServer, signInAsGroup, V1 } from './support/harness.ts'

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

const TYPE = `[content-type]
alias = "page"
name = "Page"
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

function capturing(result: 'ok' | 'fail' = 'ok'): EmailPort & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = []
  return {
    sent,
    description: 'test',
    provider: 'custom',
    async send(message) {
      sent.push(message)
      return result === 'ok' ? { ok: true, id: 'x' } : { ok: false, error: 'the provider is down' }
    },
  }
}

/** A minute and more from now: past every digest delay. */
const later = () => new Date(Date.now() + 5 * 60_000)

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (done(value)) return value
    await Bun.sleep(20)
  }
  return read()
}

async function site(email: EmailPort | null = capturing()) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'content-notifications-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'content-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'content-types', 'page.toml'), TYPE)
  writeFileSync(join(root, 'components', 'page.tsx'), 'export default () => <main />\n')
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      applicationUrl: 'https://site.example',
      email,
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const create = async (name: string, parent: string | null = null) => {
    const response = await h.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: parent ? { id: parent } : null,
      values: [{ alias: 'title', culture: null, segment: null, value: name }],
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201) throw new Error(`create ${response.status}`)
    return response.headers.get('umb-generated-resource') as string
  }
  const outbox = new ContentNotificationRepository(h.server.db)
  const subscribe = (who: Harness, page: string, actions: string[]) =>
    who.put(`${V1}/document/${page}/notifications`, { subscribedActionIds: actions })
  const rows = (count: number) =>
    until(
      () => outbox.all(),
      (all) => all.length >= count,
    )
  return { h, create, outbox, subscribe, rows, email: email as ReturnType<typeof capturing> }
}

describe('which changes notify', () => {
  test('each operation names its action and its page; a sort names the parent, the root sort nobody', () => {
    const ok = { status: 200, headers: new Headers({ 'umb-generated-resource': 'NEW-KEY' }) }
    const of = (operation: string, body?: unknown) =>
      contentChangeFor(operation, { id: 'page' }, ok, body)
    expect(of('PostDocument')).toEqual({
      actions: ['Umb.Document.Create'],
      key: 'new-key',
      keyKind: 'document',
    })
    expect(of('PostDocumentCreateAndPublish')?.actions).toEqual([
      'Umb.Document.Create',
      'Umb.Document.Publish',
    ])
    expect(of('PutDocumentByIdUpdateAndPublish')?.actions).toEqual([
      'Umb.Document.Update',
      'Umb.Document.Publish',
    ])
    expect(of('PutDocumentByIdPublishWithDescendants')).toMatchObject({ withDescendants: true })
    expect(of('PutDocumentByIdMoveToRecycleBin')?.actions).toEqual(['Umb.Document.Delete'])
    expect(of('PostDocumentByIdCopy')).toMatchObject({
      actions: ['Umb.Document.Duplicate'],
      key: 'page',
    })
    expect(of('PostDocumentVersionByIdRollback')).toMatchObject({ keyKind: 'version' })
    expect(of('PutRecycleBinDocumentByIdRestore')?.actions).toEqual([
      'Umb.DocumentRecycleBin.Restore',
    ])
    for (const operation of [
      'PostDocumentByIdPublicAccess',
      'PutDocumentByIdPublicAccess',
      'DeleteDocumentByIdPublicAccess',
    ])
      expect(of(operation)?.actions).toEqual(['Umb.Document.PublicAccess'])
    expect(of('PutDocumentSort', { parent: { id: 'PARENT' } })?.key).toBe('parent')
    expect(of('PutDocumentSort', { parent: null })).toBeUndefined()
    expect(of('PutDocumentRootSortChildren')).toBeUndefined()
    expect(of('PutDocumentByIdUnpublish')).toBeUndefined()
    // Setting a schedule publishes nothing yet: the job notifies when it does.
    const scheduled = {
      publishSchedules: [{ culture: null, schedule: { publishTime: '2030-01-01T00:00:00Z' } }],
    }
    expect(of('PutDocumentByIdPublish', scheduled)).toBeUndefined()
    expect(
      of('PutDocumentByIdPublish', { publishSchedules: [{ culture: null }] })?.actions,
    ).toEqual(['Umb.Document.Publish'])
    expect(
      contentChangeFor(
        'PutDocumentById',
        { id: 'page' },
        { status: 400, headers: new Headers() },
        undefined,
      ),
    ).toBeUndefined()
  })
})

describe(`content notifications (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('a publish e-mails who asked, once, with who did it and a link — and not the person who did it', async () => {
    const { h, create, subscribe, rows, email } = await site()
    const home = await create('Home')
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    expect((await subscribe(editor, home, ['Umb.Document.Publish'])).status).toBe(200)
    // The person publishing asked too, and is not told about their own change.
    await subscribe(h, home, ['Umb.Document.Publish'])
    await h.put(`${V1}/document/${home}/publish`, { publishSchedules: [{ culture: null }] })
    expect((await rows(1)).map((r) => r.actionId)).toEqual(['Umb.Document.Publish'])

    // Not before the digest's minute is up.
    expect((await h.server.jobs.runContentNotifications(new Date())).sent).toBe(0)
    const report = await h.server.jobs.runContentNotifications(later())
    expect(report.sent).toBe(1)
    expect(email.sent).toHaveLength(1)
    const [message] = email.sent
    expect(message?.to).toEqual([{ email: 'ed@example.test', name: 'ed@example.test' }])
    expect(message?.subject).toContain('published "Home"')
    expect(message?.text).toContain(
      `https://site.example${BACKOFFICE}/section/content/workspace/document/edit/${home}`,
    )
    expect((await h.server.jobs.runContentNotifications(later())).sent).toBe(0)
  })

  test('a subscription on a page covers the pages under it, and create tells the parent', async () => {
    const { h, create, subscribe, rows } = await site()
    const home = await create('Home')
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    await subscribe(editor, home, ['Umb.Document.Create', 'Umb.Document.Update'])
    const about = await create('About', home)
    await h.put(`${V1}/document/${about}`, {
      values: [{ alias: 'title', culture: null, segment: null, value: 'About us' }],
      variants: [{ culture: null, segment: null, name: 'About' }],
    })
    const queued = await rows(2)
    expect(queued.map((r) => [r.actionId, r.nodeName])).toEqual([
      ['Umb.Document.Create', 'About'],
      ['Umb.Document.Update', 'About'],
    ])
  })

  test('the changes a person hears of within a minute arrive as one e-mail', async () => {
    const { h, create, subscribe, rows, email } = await site()
    const home = await create('Home')
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    await subscribe(editor, home, [
      'Umb.Document.Create',
      'Umb.Document.Update',
      'Umb.Document.Sort',
    ])
    const child = await create('Child', home)
    await h.put(`${V1}/document/${child}`, {
      values: [{ alias: 'title', culture: null, segment: null, value: 'Changed' }],
      variants: [{ culture: null, segment: null, name: 'Child' }],
    })
    await h.put(`${V1}/document/sort`, {
      parent: { id: home },
      sorting: [{ id: child, sortOrder: 0 }],
    })
    await rows(3)
    await h.server.jobs.runContentNotifications(later())
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]?.subject).toContain('3 changes')
    expect(email.sent[0]?.text).toContain('sorted the pages under "Home"')
  })

  test('moving to the recycle bin tells the people where the page was; restoring and copying notify too', async () => {
    const { h, create, subscribe, rows } = await site()
    const home = await create('Home')
    const page = await create('Page', home)
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    await subscribe(editor, home, [
      'Umb.Document.Delete',
      'Umb.DocumentRecycleBin.Restore',
      'Umb.Document.Duplicate',
      'Umb.Document.Move',
    ])
    await h.post(`${V1}/document/${page}/copy`, {
      target: { id: home },
      relateToOriginal: false,
      includeDescendants: false,
    })
    await h.put(`${V1}/document/${page}/move-to-recycle-bin`, {})
    await h.put(`${V1}/recycle-bin/document/${page}/restore`, { target: { id: home } })
    const queued = await rows(3)
    expect(queued.map((r) => r.actionId)).toEqual([
      'Umb.Document.Duplicate',
      'Umb.Document.Delete',
      'Umb.DocumentRecycleBin.Restore',
    ])
  })

  test("a group's permissions changing on a page notifies who follows its rights", async () => {
    const { h, create, subscribe, rows } = await site()
    const home = await create('Home')
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    await subscribe(editor, home, ['Umb.Document.Permissions'])
    const created = await h.post(`${V1}/user-group`, {
      name: 'Reviewers',
      alias: 'reviewers',
      icon: 'icon-eye',
      sections: ['Umb.Section.Content'],
      languages: [],
      hasAccessToAllLanguages: true,
      documentRootAccess: true,
      mediaRootAccess: true,
      fallbackPermissions: ['Umb.Document.Read'],
      permissions: [
        {
          $type: 'DocumentPermissionPresentationModel',
          document: { id: home },
          verbs: ['Umb.Document.Read'],
        },
      ],
    })
    expect(created.status).toBe(201)
    expect((await rows(1)).map((r) => [r.actionId, r.nodeKey])).toEqual([
      ['Umb.Document.Permissions', home],
    ])
  })

  test('scheduled publishing notifies as an editor would, naming the schedule', async () => {
    const { h, create, subscribe, rows } = await site()
    const home = await create('Home')
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    await subscribe(editor, home, ['Umb.Document.Publish'])
    const soon = new Date(Date.now() + 1000).toISOString()
    await h.put(`${V1}/document/${home}/publish`, {
      publishSchedules: [{ culture: null, schedule: { publishTime: soon } }],
    })
    await h.server.jobs.runScheduledPublishing(new Date(Date.now() + 60_000))
    const [row] = await rows(1)
    expect(row).toMatchObject({
      actionId: 'Umb.Document.Publish',
      actorName: 'The schedule',
      detail: 'scheduled',
    })
  })

  test('a disabled person, or one who can no longer see the page, is skipped with the reason', async () => {
    const { h, create, subscribe, rows, outbox, email } = await site()
    const home = await create('Home')
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    await subscribe(editor, home, ['Umb.Document.Update'])
    await h.put(`${V1}/document/${home}`, {
      values: [{ alias: 'title', culture: null, segment: null, value: 'Changed' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    const [row] = await rows(1)
    const users = await h.json<{ items: Array<{ id: string; email: string }> }>(
      `${V1}/user?take=100`,
    )
    const ed = users.items.find((u) => u.email === 'ed@example.test')?.id
    expect((await h.post(`${V1}/user/disable`, { userIds: [{ id: ed }] })).status).toBe(200)
    expect((await h.server.jobs.runContentNotifications(later())).skipped).toBe(1)
    expect(email.sent).toHaveLength(0)
    const [after] = await outbox.forRecipient(row?.recipientUserKey as string)
    expect(after).toMatchObject({ state: 'skipped', lastError: 'The user is disabled.' })
  })

  test('only one of two nodes polling sends a person their e-mail', async () => {
    const { h, create, subscribe, rows } = await site()
    const home = await create('Home')
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    await subscribe(editor, home, ['Umb.Document.Update'])
    await h.put(`${V1}/document/${home}`, {
      values: [{ alias: 'title', culture: null, segment: null, value: 'Changed' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    await rows(1)
    const ports = [capturing(), capturing()]
    const runners = ports.map((port) =>
      createContentNotificationRunner({
        db: h.server.db,
        email: port,
        siteName: 'Site',
        editUrl: () => undefined,
      }),
    )
    const reports = await Promise.all(runners.map((runner) => runner.runDue(later())))
    expect(reports.reduce((n, r) => n + r.sent, 0)).toBe(1)
    expect(ports.reduce((n, p) => n + p.sent.length, 0)).toBe(1)
  })

  test('a provider that is down is retried later, then failed with its error; a row a dead node left is retried', async () => {
    const { h, create, subscribe, rows, outbox } = await site(capturing('fail'))
    const home = await create('Home')
    const editor = await signInAsGroup(h, 'editor', 'ed@example.test')
    open.push(editor)
    await subscribe(editor, home, ['Umb.Document.Update'])
    await h.put(`${V1}/document/${home}`, {
      values: [{ alias: 'title', culture: null, segment: null, value: 'Changed' }],
      variants: [{ culture: null, segment: null, name: 'Home' }],
    })
    const [row] = await rows(1)
    let now = later()
    expect((await h.server.jobs.runContentNotifications(now)).retrying).toBe(1)
    for (let i = 0; i < 6; i++) {
      now = new Date(now.getTime() + 24 * 3600_000)
      await h.server.jobs.runContentNotifications(now)
    }
    const [failed] = await outbox.forRecipient(row?.recipientUserKey as string)
    expect(failed).toMatchObject({ state: 'failed', lastError: 'the provider is down' })

    // A row stuck `running` since long ago is put back and sent.
    await h.server.db.exec(
      "UPDATE content_notification SET state = 'running', update_date = ? WHERE id = ?",
      [DbDate.toDb(new Date(Date.now() - 3600_000)), failed?.id],
    )
    expect(await outbox.releaseStale(new Date(Date.now() - 15 * 60_000))).toBe(1)
  })
})

describe(`a site with no e-mail (${process.env.CROMBOLO_DB ?? 'sqlite'})`, () => {
  test('queues nothing, refuses a new subscription in plain words, and still lets one be cleared', async () => {
    const { h, create, outbox } = await site(null)
    const home = await create('Home')
    const refused = await h.put(`${V1}/document/${home}/notifications`, {
      subscribedActionIds: ['Umb.Document.Publish'],
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("can't send e-mail yet")
    expect(
      (await h.put(`${V1}/document/${home}/notifications`, { subscribedActionIds: [] })).status,
    ).toBe(200)
    await h.put(`${V1}/document/${home}/publish`, { publishSchedules: [{ culture: null }] })
    await Bun.sleep(100)
    expect(await outbox.all()).toEqual([])
    const status = await h.json<{ canSendNotifications: boolean; affects: string[] }>(
      `${BACKOFFICE}/crombolo/api/email`,
    )
    expect(status.canSendNotifications).toBe(false)
    expect(status.affects).toContain('Notifications about page changes')
  })
})

describe('the e-mail', () => {
  test('one change reads as a sentence; several as a list, with what the person follows', () => {
    const item = (actionId: string, nodeName: string) => ({
      id: actionId,
      recipientUserKey: 'u',
      actionId,
      nodeKey: 'k',
      nodeName,
      actorUserKey: null,
      actorName: 'Ann',
      detail: null,
      occurredAt: new Date('2026-10-17T14:05:00Z'),
      state: 'running' as const,
      attempts: 1,
      lastError: null,
      runAfter: new Date(),
    })
    const one = notificationEmail({ name: 'Ed' }, [item('Umb.Document.Publish', 'About us')], {
      siteName: 'Example',
      editUrl: (key) => `https://site.example/edit/${key}`,
    })
    expect(one.subject).toBe('[Example] Ann published "About us"')
    expect(one.text).toContain('Hello Ed,')
    expect(one.text).toContain('https://site.example/edit/k')
    const two = notificationEmail(
      { name: 'Ed' },
      [item('Umb.Document.Update', 'A'), item('Umb.Document.Move', 'B')],
      { siteName: 'Example', editUrl: () => undefined },
    )
    expect(two.subject).toBe('[Example] 2 changes to pages you follow')
    expect(two.text).toContain('pages here are saved, moved')
  })
})

describe('the notifications dialog without e-mail', () => {
  test('disables every toggle and Save, and says why, once', () => {
    const element = (tag: string, attrs: Record<string, string> = {}) => ({
      tag,
      attrs,
      disabled: false,
    })
    const toggles = [element('uui-toggle'), element('uui-toggle')]
    const save = element('uui-button', { color: 'positive' })
    const prepended: Array<{ textContent: string; className: string }> = []
    const box = {
      ownerDocument: {
        createElement: () => {
          const banner = { textContent: '', className: '', setAttribute() {} }
          return banner
        },
      },
      querySelector: (selector: string) =>
        prepended.find((b) => selector === `.${b.className}`) ?? null,
      prepend: (banner: { textContent: string; className: string }) => prepended.push(banner),
    }
    const root = {
      querySelectorAll: (selector: string) =>
        selector === 'uui-toggle' ? toggles : selector.startsWith('uui-button') ? [save] : [],
      querySelector: (selector: string) => (selector === 'uui-box' ? box : null),
    }
    markUnavailable(root)
    markUnavailable(root)
    expect(toggles.every((t) => t.disabled)).toBe(true)
    expect(save.disabled).toBe(true)
    expect(prepended).toHaveLength(1)
    expect(prepended[0]?.textContent).toContain("can't send e-mail yet")
  })

  test('the vendored dialog it patches is still the one it was written against', () => {
    // A re-vendor that renames or restructures it fails here, not in an editor's browser.
    const chunks = join(ROOT, 'packages/backoffice-dist/dist/chunks')
    const file = readdirSync(chunks).find((name) =>
      name.startsWith('document-notifications-modal.element-'),
    )
    expect(file, 'the notifications dialog chunk').toBeDefined()
    const source = readFileSync(join(chunks, file as string), 'utf8')
    expect(source).toContain('customElement as b')
    expect(source).toContain('b("umb-document-notifications-modal")')
    expect(source).toContain('<uui-toggle')
    expect(source).toContain('<uui-box')
    expect(source).toContain('color="positive"')
  })
})
