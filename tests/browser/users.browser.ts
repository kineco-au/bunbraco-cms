/**
 * WP-6.7's exit in the real backoffice: an administrator creates a user in the
 * Users section and puts them in a group restricted to one branch without the
 * Delete verb; signed in, that editor sees only their start node and is not
 * offered Delete. Plus the Translation section's dictionary.
 */
import type { Page } from '@playwright/test'
import { expect, goToSection, signIn, test } from './fixtures.ts'

const API = '/umbraco/management/api/v1'
const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 7)}`

async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${API}${path}`)
  expect(response.status(), path).toBe(200)
  return (await response.json()) as T
}

async function createPage(page: Page, name: string, parent: string | null = null) {
  const types = await api<{ items: Array<{ id: string; name: string }> }>(
    page,
    '/document-type/allowed-at-root?skip=0&take=10',
  )
  const type = types.items.find((t) => t.name === 'Home Page') as { id: string }
  const response = await page.request.post(`${API}/document`, {
    data: {
      documentType: { id: type.id },
      parent: parent ? { id: parent } : null,
      values: [{ alias: 'title', culture: null, segment: null, value: name }],
      variants: [{ culture: null, segment: null, name }],
    },
  })
  expect(response.status()).toBe(201)
  return response.headers()['umb-generated-resource'] as string
}

test('a user created in the Users section, restricted to one branch, sees only it and cannot delete', async ({
  page,
  browser,
  diagnostics,
}) => {
  const SITE = unique('Site')
  const BRANCH = unique('Branch')
  const OTHER = unique('Other')
  const GROUP = unique('Branch editors')
  const email = `${Math.random().toString(36).slice(2, 9)}@example.com`

  await signIn(page)
  const site = await createPage(page, SITE)
  const branch = await createPage(page, BRANCH, site)
  await createPage(page, OTHER)
  const group = await page.request.post(`${API}/user-group`, {
    data: {
      name: GROUP,
      alias: GROUP.replace(/\W/g, ''),
      sections: ['Umb.Section.Content'],
      languages: [],
      hasAccessToAllLanguages: true,
      documentRootAccess: false,
      documentStartNode: { id: branch },
      mediaRootAccess: true,
      mediaStartNode: null,
      elementRootAccess: false,
      elementStartNode: null,
      fallbackPermissions: [
        'Umb.Document.Read',
        'Umb.Document.Create',
        'Umb.Document.Update',
        'Umb.Document.Publish',
      ],
      permissions: [],
    },
  })
  expect(group.status()).toBe(201)

  // The Users section: create the user through its dialog
  await goToSection(page, 'Users')
  await page
    .locator('umb-section-sidebar')
    .getByRole('link', { name: 'Users', exact: true })
    .click()
  await expect(page.locator('umb-user-collection')).toBeVisible()
  await page.getByRole('button', { name: 'Create', exact: true }).first().click()
  await page
    .getByText(/^User(\.\.\.|…)$/)
    .filter({ visible: true })
    .first()
    .click()
  const dialog = page.locator('umb-create-user-modal')
  await dialog.locator('#name input').fill('Branch Editor')
  await dialog.locator('#email input').fill(email)
  await dialog
    .locator('#userGroups')
    .getByRole('button', { name: /Choose|Add/ })
    .first()
    .click()
  await page
    .locator('uui-modal-sidebar')
    .last()
    .locator('umb-user-group-ref')
    .filter({ hasText: GROUP })
    .click()
  await page
    .locator('uui-modal-sidebar')
    .last()
    .getByRole('button', { name: /Choose|Submit/ })
    .click()
  await dialog.getByRole('button', { name: 'Create user' }).click()

  // The success dialog shows the initial password once
  const success = page.locator('umb-create-user-success-modal')
  await expect(success).toBeVisible()
  const password = page.locator('umb-create-user-success-modal uui-input-password#password')
  await expect
    .poll(async () => (await password.evaluate((el) => (el as HTMLInputElement).value)) ?? '')
    .not.toBe('')
  const initial = (await password.evaluate((el) => (el as HTMLInputElement).value)) as string
  await success.getByRole('button', { name: 'Close' }).click()

  // The group opens in its workspace, with its start node and verbs, and saves unchanged
  await page
    .locator('umb-section-sidebar')
    .getByRole('link', { name: 'User Groups', exact: true })
    .click()
  await page.getByRole('link', { name: GROUP, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Enter alias...' })).toHaveValue(
    GROUP.replace(/\W/g, ''),
  )
  await expect(page.getByText(BRANCH).first()).toBeVisible()
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && /\/user-group\/[0-9a-f-]{36}$/.test(r.url()),
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await saved).status()).toBe(200)
  const after = await api<{
    documentStartNode: { id: string } | null
    fallbackPermissions: string[]
  }>(page, `/user-group/${group.headers()['umb-generated-resource']}`)
  expect(after.documentStartNode).toEqual({ id: branch })
  expect(after.fallbackPermissions).not.toContain('Umb.Document.Delete')

  // The new editor, in their own browser session
  const context = await browser.newContext()
  const editor = await context.newPage()
  diagnostics.attach(editor)
  await signIn(editor, { login: email, password: initial })
  await goToSection(editor, 'Content')
  const tree = editor.locator('umb-tree').first()
  // The way to their start node is shown, greyed out; the rest of the site is not
  const siteItem = tree.locator('umb-tree-item').filter({ hasText: SITE }).first()
  await expect(siteItem).toBeVisible()
  await expect(tree.locator('umb-tree-item').filter({ hasText: OTHER })).toHaveCount(0)
  await expect(tree.getByRole('link', { name: SITE, exact: true })).toHaveCount(0)
  await siteItem
    .getByLabel(/Expand/)
    .first()
    .click()
  await expect(tree.getByRole('link', { name: BRANCH, exact: true })).toBeVisible()

  // Their menu on the start node offers Create, never Delete
  await expect(async () => {
    await editor
      .getByRole('link', { name: BRANCH, exact: true })
      .filter({ visible: true })
      .last()
      .hover()
    await editor
      .getByRole('button', { name: `View actions for '${BRANCH}'` })
      .filter({ visible: true })
      .last()
      .click({ force: true, timeout: 2_000 })
    await expect(
      editor
        .getByTestId('entity-action:Umb.EntityAction.Document.Create')
        .filter({ visible: true }),
    ).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  await expect(
    editor.getByTestId('entity-action:Umb.EntityAction.Document.RecycleBin.Trash'),
  ).toHaveCount(0)
  await expect(editor.getByTestId('entity-action:Umb.EntityAction.Document.Delete')).toHaveCount(0)
  // And the server agrees
  expect(
    (
      await editor.request.put(`${API}/document/${branch}/move-to-recycle-bin`, { data: {} })
    ).status(),
  ).toBe(403)
  await context.close()
})

test('the Translation section: a dictionary item opens from its tree and saves its translation', async ({
  page,
}) => {
  const KEY = unique('Greeting').replace(' ', '.')
  await signIn(page)
  await goToSection(page, 'Translation')
  await expect(page.locator('umb-section-sidebar')).toBeVisible()
  const response = await page.request.post(`${API}/dictionary`, {
    data: { name: KEY, parent: null, translations: [{ isoCode: 'en-US', translation: 'Hello' }] },
  })
  expect(response.status()).toBe(201)
  const key = response.headers()['umb-generated-resource'] as string
  await page.reload()
  const item = page.locator('umb-section-sidebar').getByRole('link', { name: KEY, exact: true })
  await expect(item).toBeVisible()
  await item.click()
  const translation = page
    .locator('umb-workspace-view-dictionary-editor uui-textarea textarea')
    .first()
  await expect(translation).toHaveValue('Hello')
  await translation.fill('Hello there')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await api<{ translations: Array<{ translation: string }> }>(page, `/dictionary/${key}`))
          .translations[0]?.translation,
    )
    .toBe('Hello there')
})
