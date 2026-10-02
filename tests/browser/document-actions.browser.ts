/**
 * WP-6.5's exit: every action in a page's action menu, done through its dialog
 * in the real backoffice, with the outcome checked through the API.
 */
import type { Page } from '@playwright/test'
import { expect, settle, signIn, test } from './fixtures.ts'

const API = '/umbraco/management/api/v1'

/** The suite shares one site, so every test names its pages uniquely. */
const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 7)}`

async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${API}${path}`)
  expect(response.status(), path).toBe(200)
  return (await response.json()) as T
}

/** A published-type page made through the API, as the create dialog would. */
async function createPage(page: Page, name: string, parent: string | null = null) {
  const types = await api<{ items: Array<{ id: string; name: string }> }>(
    page,
    '/document-type/allowed-at-root?skip=0&take=10',
  )
  const type = types.items.find((t) => t.name === 'Home Page') as { id: string }
  const detail = await api<{ defaultTemplate: { id: string } | null }>(
    page,
    `/document-type/${type.id}`,
  )
  const response = await page.request.post(`${API}/document`, {
    data: {
      documentType: { id: type.id },
      template: detail.defaultTemplate,
      parent: parent ? { id: parent } : null,
      values: [{ alias: 'title', culture: null, segment: null, value: name }],
      variants: [{ culture: null, segment: null, name }],
    },
  })
  expect(response.status()).toBe(201)
  return response.headers()['umb-generated-resource'] as string
}

/**
 * Opens a tree item's action menu and runs one action. The actions button shows
 * on hover and is named for its item; tree items nest, so matching by text alone
 * can open an ancestor's menu.
 */
async function openAction(page: Page, itemName: string, action: string, entity = 'Document') {
  await expect(async () => {
    await page
      .getByRole('link', { name: itemName, exact: true })
      .filter({ visible: true })
      .last()
      .hover()
    await page
      .getByRole('button', { name: `View actions for '${itemName}'` })
      .filter({ visible: true })
      .last()
      .click({ force: true, timeout: 2_000 })
    await page
      .getByTestId(`entity-action:Umb.EntityAction.${entity}.${action}`)
      .filter({ visible: true })
      .click({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

/**
 * Opens the Content section afresh. Pages made through the API after sign-in
 * are not in the tree the backoffice already loaded, and switching to a section
 * that is already open does not reload it.
 */
async function showContent(page: Page) {
  await page.goto('/bunbraco/section/content')
  await settle(page)
}

/** The open sidebar or dialog's button, e.g. its Save. */
const modalButton = (page: Page, name: string | RegExp) =>
  page.locator('uui-modal-sidebar, uui-modal-dialog').last().getByRole('button', { name })

test('the page action menu: blueprint, notifications, hostnames, duplicate and move', async ({
  page,
}) => {
  const HOME = unique('Home')
  await signIn(page)
  const home = await createPage(page, HOME)
  await showContent(page)

  await openAction(page, HOME, 'CreateBlueprint')
  await modalButton(page, 'Save').click()
  const blueprint = async () =>
    (
      await api<{ items: Array<{ id: string; name: string }> }>(
        page,
        '/tree/document-blueprint/root?skip=0&take=100',
      )
    ).items.find((b) => b.name === HOME)?.id
  await expect.poll(blueprint).toBeDefined()
  // A blueprint changes every later create dialog for its type, so it goes again
  expect(
    (await page.request.delete(`${API}/document-blueprint/${await blueprint()}`)).status(),
  ).toBe(200)

  await openAction(page, HOME, 'Notifications')
  await page.locator('uui-toggle').filter({ hasText: 'Publish' }).click()
  await modalButton(page, 'Save').click()
  await expect
    .poll(async () =>
      (
        await api<Array<{ alias: string; subscribed: boolean }>>(
          page,
          `/document/${home}/notifications`,
        )
      )
        .filter((n) => n.subscribed)
        .map((n) => n.alias),
    )
    .toEqual(['publish'])

  await openAction(page, HOME, 'CultureAndHostnames')
  await modalButton(page, 'Add new hostname').click()
  // The dialog focuses the new row's hostname, and reads it on change (blur)
  // Hostnames are unique site-wide, so every run uses its own
  const HOSTNAME = `${HOME.split(' ')[1]}.example.test`
  await page.keyboard.type(HOSTNAME)
  await page.keyboard.press('Tab')
  await modalButton(page, 'Save').click()
  await expect
    .poll(
      async () =>
        (await api<{ domains: Array<{ domainName: string }> }>(page, `/document/${home}/domains`))
          .domains,
    )
    .toEqual([expect.objectContaining({ domainName: HOSTNAME })])

  await openAction(page, HOME, 'DuplicateTo')
  await page.locator('uui-modal-sidebar').last().getByText('Content', { exact: true }).click()
  await modalButton(page, 'Copy').click()
  await expect(
    page.locator('umb-menu-item-tree-default').filter({ hasText: `${HOME} (1)` }),
  ).toBeVisible()

  await openAction(page, `${HOME} (1)`, 'MoveTo')
  await page.locator('uui-modal-sidebar').last().getByText(HOME, { exact: true }).click()
  await modalButton(page, /^(Move|Choose)$/).click()
  await expect
    .poll(
      async () =>
        (
          await api<{ total: number }>(
            page,
            `/tree/document/children?parentId=${home}&skip=0&take=10`,
          )
        ).total,
    )
    .toBe(1)
})

test('the page action menu: sort, publish, unpublish, rollback, public access, and the recycle bin', async ({
  page,
  diagnostics,
}) => {
  // Cancelling a dialog rejects its action, which the client logs as an error
  diagnostics.allowed.push(
    'Error executing action: {type: close}',
    'Error executing action: undefined',
  )
  const HOME = unique('Home')
  await signIn(page)
  const home = await createPage(page, HOME)
  await createPage(page, 'Bravo', home)
  await createPage(page, 'Alpha', home)
  // A second version, so there is something to roll back to
  await page.request.put(`${API}/document/${home}`, {
    data: {
      template: null,
      values: [{ alias: 'title', culture: null, segment: null, value: 'Changed' }],
      variants: [{ culture: null, segment: null, name: HOME }],
    },
  })
  await showContent(page)
  const state = async () =>
    (await api<{ variants: Array<{ state: string }> }>(page, `/document/${home}`)).variants[0]
      ?.state

  await openAction(page, HOME, 'SortChildrenOf')
  await page.locator('uui-modal-sidebar').last().getByText('Name', { exact: true }).click()
  await modalButton(page, 'Sort').click()
  await expect
    .poll(async () =>
      (
        await api<{ items: Array<{ variants: Array<{ name: string }> }> }>(
          page,
          `/tree/document/children?parentId=${home}&skip=0&take=10`,
        )
      ).items.map((i) => i.variants[0]?.name),
    )
    .toEqual(['Alpha', 'Bravo'])

  await openAction(page, HOME, 'Publish')
  await page.screenshot({ path: 'output/publish.png' })
  await modalButton(page, 'Publish').click()
  await expect.poll(state).toBe('Published')
  await expect(
    page.locator('uui-toast-notification').filter({ hasText: 'published' }),
  ).toBeVisible()

  await openAction(page, HOME, 'Unpublish')
  await page.screenshot({ path: 'output/unpublish.png' })
  await modalButton(page, 'Unpublish').click()
  await expect.poll(state).toBe('Draft')
  await expect(
    page.locator('uui-toast-notification').filter({ hasText: 'npublished' }),
  ).toBeVisible()

  const title = async () =>
    (
      await api<{ values: Array<{ alias: string; value: unknown }> }>(page, `/document/${home}`)
    ).values.find((v) => v.alias === 'title')?.value
  expect(await title()).toBe('Changed')
  await openAction(page, HOME, 'Rollback')
  // Newest first: the last is the page as it was created
  await page.locator('uui-modal-sidebar').last().getByText('Administrator').last().click()
  await modalButton(page, 'Rollback').click()
  await expect.poll(title).toBe(HOME)

  // Public access opens ready to create a rule; this site has no groups to pick
  await openAction(page, HOME, 'PublicAccess')
  await page
    .locator('uui-modal-sidebar')
    .last()
    .getByText('Group based protection')
    .filter({ visible: true })
    .last()
    .click()
  await page.screenshot({ path: 'output/public-access.png' })
  await modalButton(page, 'Cancel').click()

  await openAction(page, HOME, 'RecycleBin.Trash')
  await page.locator('uui-modal-dialog').last().getByRole('button', { name: /Trash/ }).click()
  await expect
    .poll(async () => (await api<{ isTrashed: boolean }>(page, `/document/${home}`)).isTrashed)
    .toBe(true)

  // In the bin: restore it, trash it again, then delete it for good
  await page.getByRole('link', { name: 'Recycle Bin', exact: true }).hover()
  await page
    .locator('uui-menu-item[label="Recycle Bin"] #caret-button')
    .filter({ visible: true })
    .first()
    .click()
  await openAction(page, HOME, 'RecycleBin.Restore')
  await modalButton(page, 'Restore').click()
  await expect
    .poll(async () => (await api<{ isTrashed: boolean }>(page, `/document/${home}`)).isTrashed)
    .toBe(false)

  // Trashed again, then deleted from the bin
  await page.request.put(`${API}/document/${home}/move-to-recycle-bin`, { data: {} })
  await page.reload()
  await page
    .locator('uui-menu-item[label="Recycle Bin"] #caret-button')
    .filter({ visible: true })
    .first()
    .click()
  await openAction(page, HOME, 'Delete')
  await page
    .locator('uui-modal-dialog')
    .last()
    .getByRole('button', { name: /Delete/ })
    .click()
  await expect
    .poll(async () => (await page.request.get(`${API}/document/${home}`)).status())
    .toBe(404)

  // Emptying the bin removes whatever is left in it
  const other = await createPage(page, 'Other')
  await page.request.put(`${API}/document/${other}/move-to-recycle-bin`, { data: {} })
  await page.reload()
  await openAction(page, 'Recycle Bin', 'RecycleBin.Empty')
  await page
    .locator('uui-modal-dialog')
    .last()
    .getByRole('button', { name: /Empty|Delete/ })
    .click()
  await expect
    .poll(
      async () =>
        (await api<{ total: number }>(page, '/recycle-bin/document/root?skip=0&take=10')).total,
    )
    .toBe(0)
})

test('save and preview opens the preview app, framing the draft', async ({ page }) => {
  const HOME = unique('Home')
  await signIn(page)
  const home = await createPage(page, HOME)
  await page.goto(`/bunbraco/section/content/workspace/document/edit/${home}`)
  await page.locator('umb-property-editor-ui-text-box #input').first().fill('Draft for preview')
  // A plain draft save first: its toast comes from the server's Umb-Notifications
  // header, not from a client-side peek like publishing's, so it is the half that
  // silently stops working if the header is dropped.
  await page.getByTestId('workspace-action:Umb.WorkspaceAction.Document.Save').click()
  await expect(page.locator('uui-toast-notification').filter({ hasText: 'saved' })).toBeVisible()

  const popup = page.waitForEvent('popup')
  await page.getByTestId('workspace-action:Umb.WorkspaceAction.Document.SaveAndPreview').click()
  const preview = await popup
  await expect(preview).toHaveURL(new RegExp(`/bunbraco/preview\\?id=${home}`))
  const frame = preview.frameLocator('iframe')
  await expect(frame.locator('body')).toContainText('Draft for preview', { timeout: 15_000 })
  await preview.screenshot({ path: 'output/preview.png' })
})

test('publish with descendants publishes the branch from the workspace', async ({ page }) => {
  const HOME = unique('Home')
  await signIn(page)
  const home = await createPage(page, HOME)
  const child = await createPage(page, 'Child', home)
  await page.goto(`/bunbraco/section/content/workspace/document/edit/${home}`)
  await page
    .locator('umb-workspace-action')
    .filter({ hasText: 'Save and publish' })
    .locator('#popover-trigger, uui-button[compact]')
    .last()
    .click()
  await page.screenshot({ path: 'output/publish-menu.png' })
  await page
    .getByText(/Publish with descendants/)
    .filter({ visible: true })
    .first()
    .click()
  await page.screenshot({ path: 'output/publish-descendants.png' })
  const state = async (key: string) =>
    (await api<{ variants: Array<{ state: string }> }>(page, `/document/${key}`)).variants[0]?.state
  await page
    .locator('uui-modal-dialog, uui-modal-sidebar')
    .last()
    .getByText(/unpublished/i)
    .click()
  await page
    .locator('uui-modal-dialog, uui-modal-sidebar')
    .last()
    .getByRole('button', { name: /Publish/ })
    .last()
    .click()
  await expect.poll(() => state(child)).toBe('Published')
  expect(await state(home)).toBe('Published')
})
