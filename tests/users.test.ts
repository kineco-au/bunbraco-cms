/**
 * WP-6.7: users and user groups, and permissions enforced on every call. The
 * exit: an editor in a restricted group sees only their start node and
 * cannot delete.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComponentRepository, ContentTypeRepository, SUPER_USER_KEY } from '@bunbraco/data'
import type { UserLinkSender } from '@bunbraco/server'
import { BACKOFFICE, type Harness, signedInServer, signIn, V1 } from './support/harness.ts'

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
allow-at-root = true
allow-children = ["page"]
components = ["page"]
default-component = "page"

[[property]]
alias = "title"
name = "Title"
type = "textstring"
`

const GROUPS = {
  admin: 'e5e7f6c8-7f9c-4b5b-8d5d-9e1e5a4f7e4d',
  editor: '44dc260e-b4d4-4dd9-9081-eec5598f1641',
  writer: '9fc2a16f-528c-46d6-a014-75bf4ec2480c',
  sensitiveData: '8c6ad70f-d307-4e4a-af58-72c2e4e9439d',
}
const PASSWORD = 'a-long-password'

interface UserBody {
  id: string
  state: string
  isAdmin: boolean
  userGroupIds: Array<{ id: string }>
  documentStartNodeIds: Array<{ id: string }>
  hasDocumentRootAccess: boolean
  languageIsoCode: string | null
  name: string
  avatarUrls: string[]
  kind: string
}

async function site(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'users-'))
  dirs.push(root)
  mkdirSync(join(root, 'schema', 'document-types'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  writeFileSync(join(root, 'schema', 'document-types', 'page.toml'), TYPE_TOML)
  writeFileSync(join(root, 'components', 'page.tsx'), 'export default () => <main />\n')
  const h = await signedInServer({
    config: {
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      mediaDir: join(root, 'media'),
      ...config,
    },
  })
  open.push(h)
  const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
  const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
  const page = async (name: string, parent: string | null = null, client = h) => {
    const response = await client.post(`${V1}/document`, {
      documentType: { id: typeKey },
      template: { id: componentKey },
      parent: parent ? { id: parent } : null,
      values: [],
      variants: [{ culture: null, segment: null, name }],
    })
    if (response.status !== 201)
      throw new Error(`create ${response.status}: ${await response.text()}`)
    return response.headers.get('umb-generated-resource') as string
  }
  /** Creates a user in `groups` and returns them signed in, via the password reset the backoffice shows. */
  const user = async (email: string, groups: string[], name = email) => {
    const created = await h.post(`${V1}/user`, {
      kind: 'Default',
      email,
      userName: email,
      name,
      userGroupIds: groups.map((id) => ({ id })),
    })
    if (created.status !== 201) throw new Error(`user ${created.status}: ${await created.text()}`)
    const key = created.headers.get('umb-generated-resource') as string
    const reset = await h.json<{ resetPassword: string }>(`${V1}/user/${key}/reset-password`, {
      method: 'POST',
    })
    const client = await signIn(h.server, { username: email, password: reset.resetPassword })
    return { key, client, password: reset.resetPassword }
  }
  const group = async (body: Record<string, unknown>, client = h) => {
    const response = await client.post(`${V1}/user-group`, {
      name: 'Group',
      alias: 'group',
      sections: ['Umb.Section.Content'],
      languages: [],
      hasAccessToAllLanguages: true,
      documentRootAccess: false,
      documentStartNode: null,
      mediaRootAccess: true,
      mediaStartNode: null,
      elementRootAccess: false,
      elementStartNode: null,
      fallbackPermissions: ['Umb.Document.Read'],
      permissions: [],
      ...body,
    })
    return response
  }
  return { h, page, user, group }
}

describe('users', () => {
  test('create, read, list and filter, with the state Umbraco derives', async () => {
    const { h, user } = await site()
    const writer = await user('writer@example.com', [GROUPS.writer], 'Wanda Writer')
    const created = await h.post(`${V1}/user`, {
      kind: 'Default',
      email: 'new@example.com',
      userName: 'new@example.com',
      name: 'Never Signed In',
      userGroupIds: [{ id: GROUPS.editor }],
    })
    expect(created.status).toBe(201)
    const fresh = created.headers.get('umb-generated-resource') as string

    const one = await h.json<UserBody>(`${V1}/user/${fresh}`)
    expect(one).toMatchObject({
      id: fresh,
      name: 'Never Signed In',
      state: 'Inactive',
      isAdmin: false,
      kind: 'Default',
      userGroupIds: [{ id: GROUPS.editor }],
    })
    expect((await h.json<UserBody>(`${V1}/user/${writer.key}`)).state).toBe('Active')
    expect((await h.json<UserBody>(`${V1}/user/${SUPER_USER_KEY}`)).isAdmin).toBe(true)

    const all = await h.json<{ total: number; items: UserBody[] }>(`${V1}/user?skip=0&take=10`)
    expect(all.total).toBe(3)
    const filtered = await h.json<{ items: UserBody[] }>(
      `${V1}/filter/user?skip=0&take=10&filter=wanda&orderBy=Name&orderDirection=Ascending`,
    )
    expect(filtered.items.map((u) => u.id)).toEqual([writer.key])
    const inactive = await h.json<{ items: UserBody[] }>(
      `${V1}/filter/user?skip=0&take=10&userStates=Inactive`,
    )
    expect(inactive.items.map((u) => u.id)).toEqual([fresh])
    const editors = await h.json<{ items: UserBody[] }>(
      `${V1}/filter/user?skip=0&take=10&userGroupIds=${GROUPS.editor}`,
    )
    expect(editors.items.map((u) => u.id)).toEqual([fresh])
    const byName = await h.json<{ items: UserBody[] }>(
      `${V1}/filter/user?skip=0&take=10&orderBy=Name&orderDirection=Descending`,
    )
    expect(byName.items.map((u) => u.name)).toEqual([
      'Wanda Writer',
      'Never Signed In',
      expect.any(String),
    ])
    expect(
      (await h.json<{ total: number }>(`${V1}/user/batch?id=${fresh}&id=${writer.key}`)).total,
    ).toBe(2)
    expect(await h.json<unknown>(`${V1}/item/user?id=${fresh}`)).toEqual<unknown>([
      { id: fresh, name: 'Never Signed In', avatarUrls: [], kind: 'Default', flags: [] },
    ])

    // The rules on creation
    const fail = async (body: Record<string, unknown>) => {
      const response = await h.post(`${V1}/user`, {
        kind: 'Default',
        email: 'x@example.com',
        userName: 'x@example.com',
        name: 'X',
        userGroupIds: [{ id: GROUPS.editor }],
        ...body,
      })
      return [response.status, (await response.json()).operationStatus]
    }
    expect(await fail({ email: 'new@example.com', userName: 'new@example.com' })).toEqual([
      400,
      'DuplicateUserName',
    ])
    expect(await fail({ userName: 'someone-else@example.com' })).toEqual([
      400,
      'UserNameIsNotEmail',
    ])
    expect(await fail({ email: 'nope', userName: 'nope' })).toEqual([400, 'InvalidEmail'])
    expect(await fail({ userGroupIds: [] })).toEqual([400, 'NoUserGroup'])
    expect(await fail({ userGroupIds: [{ id: crypto.randomUUID() }] })).toEqual([
      404,
      'MissingUserGroup',
    ])
    expect((await h.call(`${V1}/user/${crypto.randomUUID()}`)).status).toBe(404)
  })

  test('update, disable, enable, unlock, delete — and nobody disables or deletes themselves', async () => {
    const { h, user, page } = await site()
    const home = await page('Home')
    const writer = await user('writer@example.com', [GROUPS.writer])
    const update = (key: string, body: Record<string, unknown> = {}) =>
      h.put(`${V1}/user/${key}`, {
        email: 'writer@example.com',
        userName: 'writer@example.com',
        name: 'Renamed',
        languageIsoCode: 'da-DK',
        userGroupIds: [{ id: GROUPS.writer }, { id: GROUPS.editor }],
        documentStartNodeIds: [{ id: home }],
        hasDocumentRootAccess: false,
        mediaStartNodeIds: [],
        hasMediaRootAccess: true,
        elementStartNodeIds: [],
        hasElementRootAccess: false,
        ...body,
      })
    expect((await update(writer.key)).status).toBe(200)
    expect(await h.json<UserBody>(`${V1}/user/${writer.key}`)).toMatchObject({
      name: 'Renamed',
      languageIsoCode: 'da-DK',
      userGroupIds: [{ id: GROUPS.writer }, { id: GROUPS.editor }],
      documentStartNodeIds: [{ id: home }],
      hasDocumentRootAccess: false,
    })
    expect(
      (await update(writer.key, { documentStartNodeIds: [{ id: crypto.randomUUID() }] })).status,
    ).toBe(400)
    expect((await update(writer.key, { languageIsoCode: 'not a culture' })).status).toBe(400)
    const calculated = await h.json<{
      documentStartNodeIds: unknown[]
      hasDocumentRootAccess: boolean
    }>(`${V1}/user/${writer.key}/calculate-start-nodes`)
    // The user's own start node replaces their groups' root
    expect(calculated).toMatchObject({
      documentStartNodeIds: [{ id: home }],
      hasDocumentRootAccess: false,
    })

    // Disabling signs the user out and refuses them
    expect((await h.post(`${V1}/user/disable`, { userIds: [{ id: writer.key }] })).status).toBe(200)
    expect((await h.json<UserBody>(`${V1}/user/${writer.key}`)).state).toBe('Disabled')
    expect((await writer.client.call(`${V1}/user/current`)).status).toBe(401)
    expect((await h.post(`${V1}/user/enable`, { userIds: [{ id: writer.key }] })).status).toBe(200)
    expect((await h.json<UserBody>(`${V1}/user/${writer.key}`)).state).toBe('Active')
    await h.server.db.exec('UPDATE user_account SET is_locked_out = ? WHERE key = ?', [
      h.server.db.dialect.boolValue(true),
      writer.key,
    ])
    expect((await h.json<UserBody>(`${V1}/user/${writer.key}`)).state).toBe('LockedOut')
    expect((await h.post(`${V1}/user/unlock`, { userIds: [{ id: writer.key }] })).status).toBe(200)
    expect((await h.json<UserBody>(`${V1}/user/${writer.key}`)).state).toBe('Active')

    const disableSelf = await h.post(`${V1}/user/disable`, { userIds: [{ id: SUPER_USER_KEY }] })
    expect((await disableSelf.json()).operationStatus).toBe('CannotDisableSelf')
    expect(
      ((await (await h.del(`${V1}/user/${SUPER_USER_KEY}`)).json()) as { operationStatus: string })
        .operationStatus,
    ).toBe('CannotDeleteSelf')
    // Someone who has signed in is disabled, not deleted
    const signedIn = await h.del(`${V1}/user/${writer.key}`)
    expect((await signedIn.json()).operationStatus).toBe('CannotDeleteUserWithLoginHistory')
    const never = await h.post(`${V1}/user`, {
      kind: 'Default',
      email: 'never@example.com',
      userName: 'never@example.com',
      name: 'Never',
      userGroupIds: [{ id: GROUPS.writer }],
    })
    const neverKey = never.headers.get('umb-generated-resource') as string
    expect((await h.del(`${V1}/user/${neverKey}`)).status).toBe(200)
    expect((await h.call(`${V1}/user/${neverKey}`)).status).toBe(404)
  })

  test('passwords: reset shows a new one, changing your own needs the old one, the rules apply', async () => {
    const { h, user } = await site()
    const writer = await user('writer@example.com', [GROUPS.writer])
    const change = (body: Record<string, unknown>) =>
      writer.client.post(`${V1}/user/current/change-password`, body)
    expect(
      (await (await change({ newPassword: 'another-long-password' })).json()).operationStatus,
    ).toBe('SelfOldPasswordRequired')
    expect(
      (await (await change({ oldPassword: 'wrong', newPassword: 'another-long-password' })).json())
        .operationStatus,
    ).toBe('InvalidPassword')
    expect(
      (await (await change({ oldPassword: writer.password, newPassword: 'short' })).json())
        .operationStatus,
    ).toBe('InvalidPassword')
    expect(
      (await change({ oldPassword: writer.password, newPassword: 'another-long-password' })).status,
    ).toBe(200)
    await signIn(h.server, { username: 'writer@example.com', password: 'another-long-password' })

    // An admin sets someone else's without the old one, which signs them out
    expect(
      (
        await h.post(`${V1}/user/${writer.key}/change-password`, {
          newPassword: 'admin-chosen-password',
        })
      ).status,
    ).toBe(200)
    expect((await writer.client.call(`${V1}/user/current`)).status).toBe(401)
    await signIn(h.server, { username: 'writer@example.com', password: 'admin-chosen-password' })

    expect(await h.json<unknown>(`${V1}/security/configuration`)).toEqual<unknown>({
      passwordConfiguration: {
        minimumPasswordLength: 10,
        requireNonLetterOrDigit: false,
        requireDigit: false,
        requireLowercase: false,
        requireUppercase: false,
      },
    })
  })

  test('the current user: language, avatar, two-factor and login providers answer honestly', async () => {
    const { h } = await site()
    expect((await h.put(`${V1}/user/current/profile`, { languageIsoCode: 'da-DK' })).status).toBe(
      200,
    )
    expect((await h.json<{ languageIsoCode: string }>(`${V1}/user/current`)).languageIsoCode).toBe(
      'da-DK',
    )
    expect((await h.put(`${V1}/user/current/profile`, { languageIsoCode: '??' })).status).toBe(400)
    // The backoffice loads the chosen UI language's strings from the shipped client
    const strings = await h.call(`${h.server.paths.assetsPath}/assets/lang/da.js`)
    expect(strings.status).toBe(200)
    expect(strings.headers.get('content-type')).toContain('javascript')

    const upload = async (name: string, content: BlobPart) => {
      const id = crypto.randomUUID()
      const form = new FormData()
      form.set('Id', id)
      form.set('File', new File([content], name))
      await h.call(`${V1}/temporary-file`, { method: 'POST', body: form })
      return id
    }
    const png = await Bun.file(join(import.meta.dir, 'fixtures', 'pixel.png')).bytes()
    expect(
      (await h.post(`${V1}/user/current/avatar`, { file: { id: await upload('me.png', png) } }))
        .status,
    ).toBe(200)
    const urls = (await h.json<UserBody>(`${V1}/user/${SUPER_USER_KEY}`)).avatarUrls
    expect(urls).toHaveLength(5)
    expect(urls[0]).toMatch(/^\/media\/[0-9a-f]{8}\/me\.png\?rmode=crop&width=30&height=30$/)
    expect((await h.call(urls[0] as string)).status).toBe(200)
    const notImage = await h.post(`${V1}/user/current/avatar`, {
      file: { id: await upload('cv.pdf', '%PDF') },
    })
    expect((await notImage.json()).operationStatus).toBe('InvalidAvatar')
    expect((await h.del(`${V1}/user/current/avatar`)).status).toBe(200)
    expect((await h.json<UserBody>(`${V1}/user/${SUPER_USER_KEY}`)).avatarUrls).toEqual([])

    expect(await h.json<unknown>(`${V1}/user/current/2fa`)).toEqual<unknown>([])
    expect((await h.call(`${V1}/user/current/2fa/GoogleAuthenticator`)).status).toBe(404)
    expect(await h.json<unknown>(`${V1}/user/${SUPER_USER_KEY}/2fa`)).toEqual<unknown>([])
    expect(await h.json<unknown>(`${V1}/user/current/login-providers`)).toEqual<unknown>([])
    expect(await h.json(`${V1}/user/current/configuration`)).toMatchObject({
      keepUserLoggedIn: false,
      allowChangePassword: true,
      allowTwoFactor: false,
    })
  })

  test('API users hold client credentials; other users cannot', async () => {
    const { h } = await site()
    const created = await h.post(`${V1}/user`, {
      kind: 'Api',
      email: 'robot@example.com',
      userName: 'robot@example.com',
      name: 'Robot',
      userGroupIds: [{ id: GROUPS.editor }],
    })
    const robot = created.headers.get('umb-generated-resource') as string
    const add = (key: string, clientId: string) =>
      h.post(`${V1}/user/${key}/client-credentials`, {
        clientId,
        clientSecret: 'a-long-client-secret',
      })
    expect((await add(robot, 'bunbraco-back-office-robot')).status).toBe(200)
    expect((await (await add(robot, 'bunbraco-back-office-robot')).json()).operationStatus).toBe(
      'DuplicateClientId',
    )
    expect((await (await add(robot, 'robot')).json()).operationStatus).toBe('InvalidClientId')
    // The prefix is bunbraco's as of migration 020; Umbraco's is no longer accepted.
    expect((await (await add(robot, 'umbraco-back-office-robot')).json()).operationStatus).toBe(
      'InvalidClientId',
    )
    expect(
      (await (await add(SUPER_USER_KEY, 'bunbraco-back-office-me')).json()).operationStatus,
    ).toBe('InvalidUserType')
    expect(await h.json<unknown>(`${V1}/user/${robot}/client-credentials`)).toEqual<unknown>([
      'bunbraco-back-office-robot',
    ])
    // The robot signs in with its credential and calls the API with the bearer token
    const token = (secret: string) =>
      h.server.fetch(
        new Request(`http://localhost${V1}/security/back-office/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: 'bunbraco-back-office-robot',
            client_secret: secret,
          }).toString(),
        }),
      )
    expect((await token('the-wrong-secret')).status).toBe(401)
    const issued = (await (await token('a-long-client-secret')).json()) as { access_token: string }
    const asRobot = await h.server.fetch(
      new Request(`http://localhost${V1}/user/current`, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    )
    expect(asRobot.status).toBe(200)
    expect(((await asRobot.json()) as { name: string }).name).toBe('Robot')
    expect(
      (await h.del(`${V1}/user/${robot}/client-credentials/bunbraco-back-office-robot`)).status,
    ).toBe(200)
    expect(await h.json<unknown>(`${V1}/user/${robot}/client-credentials`)).toEqual<unknown>([])
  })

  test('invitations: without a way to send them, nobody can be invited', async () => {
    const { h } = await site({ sendUserLink: null })
    expect(
      (await h.json<{ canInviteUsers: boolean }>(`${V1}/user/configuration`)).canInviteUsers,
    ).toBe(false)
    const invite = await h.post(`${V1}/user/invite`, {
      email: 'guest@example.com',
      userName: 'guest@example.com',
      name: 'Guest',
      userGroupIds: [{ id: GROUPS.writer }],
    })
    expect(invite.status).toBe(500)
    expect((await invite.json()).operationStatus).toBe('CannotInvite')
  })

  test('invitations: the link verifies, sets the first password once, and the user can sign in', async () => {
    const sent: Parameters<UserLinkSender>[0][] = []
    const { h } = await site({
      applicationUrl: 'https://cms.example.com',
      allowPasswordReset: true,
      sendUserLink: async (message: Parameters<UserLinkSender>[0]) => {
        sent.push(message)
      },
    })
    expect(
      (await h.json<{ canInviteUsers: boolean }>(`${V1}/user/configuration`)).canInviteUsers,
    ).toBe(true)
    const invite = await h.post(`${V1}/user/invite`, {
      email: 'guest@example.com',
      userName: 'guest@example.com',
      name: 'Guest',
      userGroupIds: [{ id: GROUPS.writer }],
      message: 'Welcome aboard',
    })
    expect(invite.status).toBe(201)
    const key = invite.headers.get('umb-generated-resource') as string
    expect((await h.json<UserBody>(`${V1}/user/${key}`)).state).toBe('Invited')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'invite',
      to: { email: 'guest@example.com' },
      message: 'Welcome aboard',
    })
    const link = new URL(sent[0]?.link as string)
    expect(`${link.origin}${link.pathname}`).toBe(`https://cms.example.com${BACKOFFICE}/login`)
    expect(link.searchParams.get('flow')).toBe('invite-user')
    expect(link.searchParams.get('userId')).toBe(key)
    const token = link.searchParams.get('inviteCode') as string

    // Anonymous, as the login page calls them
    const anonymous = (path: string, body: unknown) =>
      h.server.fetch(
        new Request(`http://localhost${V1}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    expect(
      (await anonymous('/user/invite/verify', { user: { id: key }, token: 'wrong' })).status,
    ).toBe(400)
    const verified = await anonymous('/user/invite/verify', { user: { id: key }, token })
    expect(verified.status).toBe(200)
    expect((await verified.json()).passwordConfiguration.minimumPasswordLength).toBe(10)
    expect(
      (
        await anonymous('/user/invite/create-password', {
          user: { id: key },
          token,
          password: 'short',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await anonymous('/user/invite/create-password', {
          user: { id: key },
          token,
          password: PASSWORD,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await anonymous('/user/invite/create-password', {
          user: { id: key },
          token,
          password: PASSWORD,
        })
      ).status,
    ).toBe(400)
    await signIn(h.server, { username: 'guest@example.com', password: PASSWORD })
    expect((await h.json<UserBody>(`${V1}/user/${key}`)).state).toBe('Active')

    // A forgotten password: the link, then a new password; unknown addresses learn nothing
    expect(
      (await anonymous('/security/forgot-password', { email: 'nobody@example.com' })).status,
    ).toBe(200)
    expect(
      (await anonymous('/security/forgot-password', { email: 'guest@example.com' })).status,
    ).toBe(200)
    expect(sent).toHaveLength(2)
    const reset = new URL(sent[1]?.link as string)
    expect(reset.searchParams.get('flow')).toBe('reset-password')
    const code = reset.searchParams.get('resetCode') as string
    expect(
      (await anonymous('/security/forgot-password/verify', { user: { id: key }, resetCode: code }))
        .status,
    ).toBe(200)
    expect(
      (
        await anonymous('/security/forgot-password/reset', {
          user: { id: key },
          resetCode: code,
          password: 'a-brand-new-password',
        })
      ).status,
    ).toBe(204)
    await signIn(h.server, { username: 'guest@example.com', password: 'a-brand-new-password' })
  })

  test('user data belongs to the user who stores it', async () => {
    const { h, user } = await site()
    const other = await user('writer@example.com', [GROUPS.writer])
    const created = await h.post(`${V1}/user-data`, {
      group: 'ui',
      identifier: 'theme',
      value: 'dark',
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    expect(
      (await h.post(`${V1}/user-data`, { group: 'ui', identifier: 'theme', value: 'x' })).status,
    ).toBe(400)
    expect(await h.json<unknown>(`${V1}/user-data/${key}`)).toEqual<unknown>({
      group: 'ui',
      identifier: 'theme',
      value: 'dark',
    })
    expect(
      (await h.put(`${V1}/user-data`, { key, group: 'ui', identifier: 'theme', value: 'light' }))
        .status,
    ).toBe(200)
    const list = await h.json<{ total: number; items: Array<{ value: string }> }>(
      `${V1}/user-data?groups=ui&skip=0&take=10`,
    )
    expect(list.items.map((i) => i.value)).toEqual(['light'])
    // Another user sees none of it
    expect((await other.client.call(`${V1}/user-data/${key}`)).status).toBe(404)
    expect(
      (await other.client.json<{ total: number }>(`${V1}/user-data?skip=0&take=10`)).total,
    ).toBe(0)
    expect((await h.del(`${V1}/user-data/${key}`)).status).toBe(200)
    expect((await h.del(`${V1}/user-data/${key}`)).status).toBe(404)
  })
})

describe('user groups', () => {
  test('create, read, update, delete, with sections, languages, start nodes and verbs', async () => {
    const { h, page, group } = await site()
    const home = await page('Home')
    const created = await group({
      name: 'Reviewers',
      alias: 'reviewers',
      icon: 'icon-eye',
      sections: ['Umb.Section.Content', 'Umb.Section.Media', 'My.Custom.Section'],
      languages: ['en-US'],
      hasAccessToAllLanguages: false,
      documentStartNode: { id: home },
      fallbackPermissions: ['Umb.Document.Read', 'Umb.Document.Update'],
      permissions: [
        {
          $type: 'DocumentPermissionPresentationModel',
          document: { id: home },
          verbs: ['Umb.Document.Read'],
        },
        {
          $type: 'DocumentPropertyValuePermissionPresentationModel',
          documentType: { id: crypto.randomUUID() },
          propertyType: { id: crypto.randomUUID() },
          verbs: ['Umb.Document.PropertyValue.Read'],
        },
        { $type: 'UnknownTypePermissionPresentationModel', context: 'Custom', verbs: ['Do.Thing'] },
      ],
    })
    expect(created.status).toBe(201)
    const key = created.headers.get('umb-generated-resource') as string
    const read = await h.json<Record<string, unknown>>(`${V1}/user-group/${key}`)
    expect(read).toMatchObject({
      id: key,
      name: 'Reviewers',
      alias: 'reviewers',
      icon: 'icon-eye',
      isDeletable: true,
      aliasCanBeChanged: true,
      sections: expect.arrayContaining([
        'Umb.Section.Content',
        'Umb.Section.Media',
        'My.Custom.Section',
      ]),
      languages: ['en-US'],
      hasAccessToAllLanguages: false,
      documentStartNode: { id: home },
      documentRootAccess: false,
      mediaRootAccess: true,
      fallbackPermissions: ['Umb.Document.Read', 'Umb.Document.Update'],
    })
    expect(read.permissions).toEqual(
      expect.arrayContaining([
        {
          $type: 'DocumentPermissionPresentationModel',
          document: { id: home },
          verbs: ['Umb.Document.Read'],
        },
        expect.objectContaining({
          $type: 'DocumentPropertyValuePermissionPresentationModel',
          verbs: ['Umb.Document.PropertyValue.Read'],
        }),
        { $type: 'UnknownTypePermissionPresentationModel', context: 'Custom', verbs: ['Do.Thing'] },
      ]),
    )
    expect((await group({ alias: 'reviewers', name: 'Again' })).status).toBe(409)
    expect((await group({ alias: 'x', name: '' })).status).toBe(400)
    expect((await group({ alias: 'y', name: 'Y', languages: ['xx-XX'] })).status).toBe(404)
    expect(
      (await group({ alias: 'z', name: 'Z', documentStartNode: { id: crypto.randomUUID() } }))
        .status,
    ).toBe(404)

    const update = await h.put(`${V1}/user-group/${key}`, {
      ...read,
      name: 'Renamed',
      permissions: [],
    })
    expect(update.status).toBe(200)
    expect(await h.json(`${V1}/user-group/${key}`)).toMatchObject({
      name: 'Renamed',
      permissions: [],
    })
    expect(await h.json<unknown>(`${V1}/item/user-group?id=${key}`)).toEqual<unknown>([
      { id: key, name: 'Renamed', icon: 'icon-eye', alias: 'reviewers', flags: [] },
    ])
    const list = await h.json<{ total: number }>(`${V1}/user-group?skip=0&take=100`)
    expect(list.total).toBe(6)
    expect(
      (
        await h.json<{ items: Array<{ id: string }> }>(
          `${V1}/filter/user-group?filter=renam&skip=0&take=10`,
        )
      ).items,
    ).toHaveLength(1)

    // System groups keep their alias and stay
    const admin = await h.json<Record<string, unknown>>(`${V1}/user-group/${GROUPS.admin}`)
    expect(admin).toMatchObject({ isDeletable: false, aliasCanBeChanged: false })
    expect(
      (await h.put(`${V1}/user-group/${GROUPS.admin}`, { ...admin, alias: 'boss' })).status,
    ).toBe(400)
    expect((await h.del(`${V1}/user-group/${GROUPS.admin}`)).status).toBe(400)
    expect((await h.del(`${V1}/user-group/${key}`)).status).toBe(200)
    expect((await h.call(`${V1}/user-group/${key}`)).status).toBe(404)
  })

  test('members are added and removed; the admin group is never left empty', async () => {
    const { h, user } = await site()
    const writer = await user('writer@example.com', [GROUPS.writer])
    expect(
      (await h.post(`${V1}/user-group/${GROUPS.editor}/users`, [{ id: writer.key }])).status,
    ).toBe(200)
    expect((await h.json<UserBody>(`${V1}/user/${writer.key}`)).userGroupIds).toContainEqual({
      id: GROUPS.editor,
    })
    const remove = (group: string, key: string) =>
      h.call(`${V1}/user-group/${group}/users`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ id: key }]),
      })
    expect((await remove(GROUPS.editor, writer.key)).status).toBe(200)
    const lastAdmin = await remove(GROUPS.admin, SUPER_USER_KEY)
    expect((await lastAdmin.json()).operationStatus).toBe('AdminGroupCannotBeEmpty')
    expect(
      (
        await h.post(`${V1}/user/set-user-groups`, {
          userIds: [{ id: writer.key }],
          userGroupIds: [{ id: GROUPS.editor }],
        })
      ).status,
    ).toBe(200)
    expect((await h.json<UserBody>(`${V1}/user/${writer.key}`)).userGroupIds).toEqual([
      { id: GROUPS.editor },
    ])
  })
})

describe('who may do what', () => {
  test('sections gate whole areas: a writer reaches content, not settings or users', async () => {
    const { h, user } = await site()
    const writer = await user('writer@example.com', [GROUPS.writer])
    const typeKey = (await new ContentTypeRepository(h.server.db).byAlias('page'))?.key as string
    expect((await writer.client.call(`${V1}/user?skip=0&take=10`)).status).toBe(403)
    expect((await writer.client.call(`${V1}/user-group?skip=0&take=10`)).status).toBe(403)
    expect((await writer.client.call(`${V1}/dictionary?skip=0&take=10`)).status).toBe(403)
    expect((await writer.client.call(`${V1}/tree/document-type/root?skip=0&take=10`)).status).toBe(
      403,
    )
    expect((await writer.client.call(`${V1}/media/configuration`)).status).toBe(403)
    // Reading a type is how the content editor renders; changing it is Settings'
    expect((await writer.client.call(`${V1}/document-type/${typeKey}`)).status).toBe(200)
    expect((await writer.client.call(`${V1}/document-type/configuration`)).status).toBe(403)
    expect((await writer.client.del(`${V1}/document-type/${typeKey}`)).status).toBe(403)
    expect((await writer.client.call(`${V1}/tree/document/root?skip=0&take=10`)).status).toBe(200)
    // Everyone reaches their own things
    expect((await writer.client.call(`${V1}/user/current`)).status).toBe(200)
    expect((await writer.client.call(`${V1}/user-data?skip=0&take=10`)).status).toBe(200)
    expect((await writer.client.call(`${V1}/language?skip=0&take=10`)).status).toBe(200)
    expect(
      (await writer.client.post(`${V1}/language`, { isoCode: 'da-DK', name: 'Danish' })).status,
    ).toBe(403)
  })

  test('only admins see and change admins; a non-admin hands out only groups they hold', async () => {
    const { h, user, group } = await site()
    // A manager: the Users section, but not an admin
    const managers = await group({
      name: 'Managers',
      alias: 'managers',
      sections: ['Umb.Section.Users', 'Umb.Section.Content'],
      documentRootAccess: true,
    })
    const managersKey = managers.headers.get('umb-generated-resource') as string
    const manager = await user('manager@example.com', [managersKey, GROUPS.writer])
    const writer = await user('writer@example.com', [GROUPS.writer])
    const other = await user('editor@example.com', [GROUPS.editor])

    const visible = await manager.client.json<{ items: UserBody[] }>(`${V1}/user?skip=0&take=10`)
    expect(visible.items.map((u) => u.id)).not.toContain(SUPER_USER_KEY)
    expect(visible.items.map((u) => u.id)).toContain(writer.key)
    expect((await manager.client.call(`${V1}/user/${SUPER_USER_KEY}`)).status).toBe(403)
    expect(
      (await manager.client.post(`${V1}/user/${SUPER_USER_KEY}/reset-password`, {})).status,
    ).toBe(403)
    expect((await manager.client.call(`${V1}/user/${writer.key}`)).status).toBe(200)

    // Adding a group the manager is not in is refused; keeping one the user has is fine
    const giving = (groups: string[]) =>
      manager.client.post(`${V1}/user/set-user-groups`, {
        userIds: [{ id: writer.key }],
        userGroupIds: groups.map((id) => ({ id })),
      })
    expect((await giving([GROUPS.writer, GROUPS.editor])).status).toBe(401)
    expect((await giving([GROUPS.writer, GROUPS.admin])).status).toBe(401)
    expect((await giving([GROUPS.writer, managersKey])).status).toBe(200)
    expect((await manager.client.post(`${V1}/user/${other.key}/reset-password`, {})).status).toBe(
      200,
    )

    // Groups: only their own, never the admin group
    expect((await manager.client.call(`${V1}/user-group/${GROUPS.admin}`)).status).toBe(403)
    expect((await manager.client.call(`${V1}/user-group/${GROUPS.editor}`)).status).toBe(403)
    expect((await manager.client.call(`${V1}/user-group/${managersKey}`)).status).toBe(200)
    const filtered = await manager.client.json<{ items: Array<{ id: string }> }>(
      `${V1}/filter/user-group?skip=0&take=10`,
    )
    expect(filtered.items.map((g) => g.id).sort()).toEqual([managersKey, GROUPS.writer].sort())
    // A group granting a section they lack is refused; one they may grant, they join
    expect(
      (
        await group(
          { name: 'Wider', alias: 'wider', sections: ['Umb.Section.Settings'] },
          manager.client,
        )
      ).status,
    ).toBe(401)
    const own = await group(
      { name: 'Narrow', alias: 'narrow', sections: ['Umb.Section.Content'] },
      manager.client,
    )
    expect(own.status).toBe(201)
    const ownKey = own.headers.get('umb-generated-resource') as string
    expect((await h.json<UserBody>(`${V1}/user/${manager.key}`)).userGroupIds).toContainEqual({
      id: ownKey,
    })
  })

  test('the exit: a restricted editor sees only their start node and cannot delete', async () => {
    const { h, page, user, group } = await site()
    const home = await page('Home')
    const about = await page('About', home)
    const team = await page('Team', about)
    const news = await page('News', home)
    const other = await page('Other site')

    const restricted = await group({
      name: 'About editors',
      alias: 'aboutEditors',
      sections: ['Umb.Section.Content'],
      documentStartNode: { id: about },
      fallbackPermissions: [
        'Umb.Document.Read',
        'Umb.Document.Create',
        'Umb.Document.Update',
        'Umb.Document.Publish',
      ],
      // Nothing at all on Team: an explicit empty set
      permissions: [
        { $type: 'DocumentPermissionPresentationModel', document: { id: team }, verbs: [] },
      ],
    })
    const editor = await user('about@example.com', [
      restricted.headers.get('umb-generated-resource') as string,
    ])
    const c = editor.client

    const me = await c.json<{
      documentStartNodeIds: unknown[]
      hasDocumentRootAccess: boolean
      permissions: Array<{ document: { id: string }; verbs: string[] }>
    }>(`${V1}/user/current`)
    expect(me.documentStartNodeIds).toEqual([{ id: about }])
    expect(me.hasDocumentRootAccess).toBe(false)
    expect(me.permissions).toEqual([
      { $type: 'DocumentPermissionPresentationModel', document: { id: team }, verbs: [] },
    ] as never)

    // The tree: only the way to About at the root, About itself below Home
    const root = await c.json<{ total: number; items: Array<{ id: string; noAccess: boolean }> }>(
      `${V1}/tree/document/root?skip=0&take=10`,
    )
    expect(root.items.map((i) => [i.id, i.noAccess])).toEqual([[home, true]])
    expect(root.total).toBe(1)
    const underHome = await c.json<{ items: Array<{ id: string; noAccess: boolean }> }>(
      `${V1}/tree/document/children?parentId=${home}&skip=0&take=10`,
    )
    expect(underHome.items.map((i) => [i.id, i.noAccess])).toEqual([[about, false]])
    const underAbout = await c.json<{ items: Array<{ id: string; noAccess: boolean }> }>(
      `${V1}/tree/document/children?parentId=${about}&skip=0&take=10`,
    )
    expect(underAbout.items.map((i) => [i.id, i.noAccess])).toEqual([[team, false]])
    expect(
      (await c.json<{ total: number }>(`${V1}/recycle-bin/document/root?skip=0&take=10`)).total,
    ).toBe(0)
    // The admin still sees everything
    expect((await h.json<{ total: number }>(`${V1}/tree/document/root?skip=0&take=10`)).total).toBe(
      2,
    )

    // Reading: About and below; not Home, News or the other site
    expect((await c.call(`${V1}/document/${about}`)).status).toBe(200)
    expect((await c.call(`${V1}/document/${home}`)).status).toBe(403)
    expect((await c.call(`${V1}/document/${news}`)).status).toBe(403)
    expect((await c.call(`${V1}/document/${other}`)).status).toBe(403)
    // The list view answers with the children's own values, so it is the same
    // read by another route and stops at the same place
    expect((await c.call(`${V1}/collection/document/${about}?skip=0&take=10`)).status).toBe(200)
    expect((await c.call(`${V1}/collection/document/${home}?skip=0&take=10`)).status).toBe(403)
    expect((await c.call(`${V1}/collection/document/${other}?skip=0&take=10`)).status).toBe(403)
    // Team's explicit empty set denies even reading it
    expect((await c.call(`${V1}/document/${team}`)).status).toBe(403)

    // Cannot delete, trash or move; can edit and create below About, not at the root
    expect((await c.del(`${V1}/document/${about}`)).status).toBe(403)
    expect((await c.put(`${V1}/document/${about}/move-to-recycle-bin`, {})).status).toBe(403)
    expect((await c.put(`${V1}/document/${about}/move`, { target: null })).status).toBe(403)
    const current = await c.json<{ values: unknown[]; variants: Array<{ name: string }> }>(
      `${V1}/document/${about}`,
    )
    const componentKey = (await new ComponentRepository(h.server.db).byAlias('page'))?.key as string
    expect(
      (
        await c.put(`${V1}/document/${about}`, {
          template: { id: componentKey },
          values: current.values,
          variants: [{ culture: null, segment: null, name: 'About us' }],
        })
      ).status,
    ).toBe(200)
    await h.put(`${V1}/document/${home}/publish`, { publishSchedules: [] })
    expect((await c.put(`${V1}/document/${about}/publish`, { publishSchedules: [] })).status).toBe(
      200,
    )
    await page('Careers', about, c)
    await expect(page('Rogue', null, c)).rejects.toThrow('create 403')
    await expect(page('Sideways', news, c)).rejects.toThrow('create 403')

    // The verbs the backoffice asks for per node
    const permissions = await c.json<{
      permissions: Array<{ nodeKey: string; permissions: string[] }>
    }>(`${V1}/user/current/permissions/document?id=${about}&id=${team}`)
    expect(permissions.permissions.find((p) => p.nodeKey === about)?.permissions.sort()).toEqual(
      [
        'Umb.Document.Create',
        'Umb.Document.Publish',
        'Umb.Document.Read',
        'Umb.Document.Update',
      ].sort(),
    )
    expect(permissions.permissions.find((p) => p.nodeKey === team)?.permissions).toEqual([])
  })
})
