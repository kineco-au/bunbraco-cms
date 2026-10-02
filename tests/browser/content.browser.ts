/**
 * WP-6.1's journey in the real backoffice: the Content section's create
 * action offers the site's document type and opens the editor for it.
 */
import type { Page } from '@playwright/test'
import { expect, expectEveryPropertyEditorRenders, signIn, test } from './fixtures.ts'

const API = '/umbraco/management/api/v1'

/**
 * Opens the create dialog from the content root. Right after sign-in the
 * header's actions can render before they are wired, so a click may open
 * nothing; retry until the dialog appears.
 */
async function openCreateDialog(page: Page) {
  const dialog = page.locator('umb-document-create-options-modal')
  await expect(async () => {
    // The root's "+" runs the same Create action as its menu
    await page
      .getByRole('button', { name: 'Create item for Content' })
      .click({ force: true, timeout: 2_000 })
    await expect(dialog).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  return dialog
}

/**
 * Opens the create dialog and chooses a document type there. The dialog closes
 * if the backoffice's router moves while it is open, so the pair is retried.
 */
async function createFromDialog(page: Page, typeName: string) {
  await expect(async () => {
    const dialog = await openCreateDialog(page)
    await expect(dialog.locator('uui-loader')).toHaveCount(0, { timeout: 3_000 })
    await page
      .locator('uui-ref-node-document-type')
      .filter({ hasText: typeName })
      .click({ timeout: 3_000 })
    await expect(page.locator('#name-input input')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
}

test('the create action at the content root lists the allowed types and opens the editor', async ({
  page,
}) => {
  // Sign-in lands on Content; the types allowed at the root are offered, and one opens the editor
  await signIn(page)
  await createFromDialog(page, 'Home Page')
  // Every property renders its editor, none the missing-UI placeholder
  await expectEveryPropertyEditorRenders(page)
})

test('a new page saves and publishes, renders at its URL, and keeps its rich text', async ({
  page,
}) => {
  const NAME = `Home ${Math.random().toString(36).slice(2, 7)}`
  await signIn(page)
  await createFromDialog(page, 'Home Page')
  await expectEveryPropertyEditorRenders(page)

  await page.locator('#name-input input').fill(NAME)
  await page.locator('umb-property-editor-ui-text-box #input').first().fill('Welcome home')
  const richText = page.locator('umb-property-editor-ui-tiptap .ProseMirror')
  await richText.click()
  await page.keyboard.type('Rich body copy')
  await page.getByTestId('workspace-action:Umb.WorkspaceAction.Document.SaveAndPublish').click()

  // The confirmation an editor needs: publishing is otherwise silent, and nothing
  // else on the screen says it worked
  await expect(
    page.locator('uui-toast-notification').filter({ hasText: 'published' }),
  ).toBeVisible()

  // Published: the tree shows it and the site renders it at the URL it reports
  await expect(page.locator('umb-menu-item-tree-default').filter({ hasText: NAME })).toBeVisible()
  await expect(page).toHaveURL(/\/workspace\/document\/edit\//)
  const key = /\/edit\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string
  const url = async () =>
    (
      (await (
        await page.request.get(`/umbraco/management/api/v1/document/urls?id=${key}`)
      ).json()) as Array<{ urlInfos: Array<{ url: string }> }>
    )[0]?.urlInfos[0]?.url
  await expect.poll(url, { timeout: 10_000 }).toBeDefined()
  const html = await (await page.request.get((await url()) as string)).text()
  expect(html).toContain('Welcome home')
  expect(html).toContain('<p>Rich body copy</p>')

  // Reopened from the server, the editor shows the saved text
  await page.reload()
  await expect(richText).toContainText('Rich body copy')

  // The Info tab loads its history, references and redirects without an error
  await page.getByRole('tab', { name: 'Info' }).click()
  await expect(page.getByText('Content saved and Published')).toBeVisible()
  // No re-authentication was asked for along the way
  await expect(page.locator('umb-app-auth-modal')).toHaveCount(0)
})

test("the create dialog under a page offers that type's allowed children, not the root set", async ({
  page,
}) => {
  await signIn(page)
  // Made through the API: this test is about the dialog, not about creating.
  const types = (await (
    await page.request.get(`${API}/document-type/allowed-at-root?skip=0&take=10`)
  ).json()) as { items: Array<{ id: string; name: string }> }
  const homeType = types.items.find((t) => t.name === 'Home Page') as { id: string }
  const detail = (await (await page.request.get(`${API}/document-type/${homeType.id}`)).json()) as {
    defaultTemplate: { id: string } | null
  }
  const NAME = `Parent ${Math.random().toString(36).slice(2, 7)}`
  const created = await page.request.post(`${API}/document`, {
    data: {
      documentType: { id: homeType.id },
      template: detail.defaultTemplate,
      parent: null,
      values: [{ alias: 'title', culture: null, segment: null, value: NAME }],
      variants: [{ culture: null, segment: null, name: NAME }],
    },
  })
  expect(created.status()).toBe(201)

  await page.goto('/bunbraco/section/content')
  await expect(page.getByRole('link', { name: NAME, exact: true })).toBeVisible({ timeout: 20_000 })

  // The node's own "+" is the create action. Located by title: every node carries
  // one with the same test id and the same role, and only the title names the node.
  // Retried because the actions can render before they are wired, so an early click
  // opens nothing — the same reason `openCreateDialog` above retries.
  const dialog = page.locator('umb-document-create-options-modal')
  await expect(async () => {
    await page
      .getByRole('link', { name: NAME, exact: true })
      .filter({ visible: true })
      .last()
      .hover()
    // `.first()` is the uui-button; its shadow button carries the same title, and
    // the outer one is what handles the click.
    await page.getByTitle(`Create item for ${NAME}`).first().click({ force: true, timeout: 2_000 })
    await expect(dialog).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 25_000 })
  await expect(dialog.locator('uui-loader')).toHaveCount(0, { timeout: 5_000 })
  // Home Page allows both itself and Content Page. The root dialog would offer only
  // Home Page, because Content Page is not allowed at root — so a dialog showing
  // just Home Page means the parent's type never reached it.
  await expect(dialog).toContainText('Content Page')
  await expect(dialog).toContainText('Home Page')
})
