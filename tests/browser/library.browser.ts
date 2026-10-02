/**
 * The Library section (Elements), against the real backoffice.
 *
 * The regression this guards: Create offering nothing but Folder. That is correct
 * when a site has no element type, and wrong the moment it has one — Umbraco offers
 * a type there only when it carries both `is-element` and `allow-in-library`, which
 * `apps/site`'s `quote.toml` does.
 */
import { BLOCK_ONLY_ELEMENT_TYPE, expect, signIn, test } from './fixtures.ts'

test('Create offers the site element types, not just Folder, and one saves and publishes', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/bunbraco/section/library')

  const dialog = page.locator('umb-element-create-options-modal')
  await expect(async () => {
    await page
      .getByRole('button', { name: /Create item for Elements/i })
      .click({ force: true, timeout: 2_000 })
    await expect(dialog).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  await expect(dialog.locator('uui-loader')).toHaveCount(0, { timeout: 5_000 })

  // Folder is always there; Quote is there because the site declares an element
  // type flagged for the library.
  await expect(dialog).toContainText('Folder')
  await expect(dialog).toContainText('Quote')

  // The option's own element, not the button inside it: the wrapper intercepts
  // pointer events, which is why the content suite clicks it the same way.
  await dialog.locator('uui-ref-node-document-type').filter({ hasText: 'Quote' }).click()
  await expect(page.locator('#name-input input')).toBeVisible({ timeout: 10_000 })

  const NAME = `Quote ${Math.random().toString(36).slice(2, 7)}`
  const name = page.locator('#name-input input')
  const body = page.locator('umb-property-editor-ui-text-box input').first()
  // A new item's workspace focuses its name field as it opens. Typed into at
  // that moment, the body's text lands in the name instead — and the publish is
  // then refused for an empty body. So both are typed until both hold.
  await expect(async () => {
    await name.fill(NAME)
    await body.fill('Measure twice')
    await expect(name).toHaveValue(NAME, { timeout: 500 })
    await expect(body).toHaveValue('Measure twice', { timeout: 500 })
  }).toPass({ timeout: 10_000 })
  await page.getByTestId('workspace-action:Umb.WorkspaceAction.Element.SaveAndPublish').click()

  await expect(page.locator('uui-toast-notification').filter({ hasText: /publish/i })).toBeVisible()
  // It lands in the Library tree, which is the thing that was empty before.
  await expect(page.locator('umb-menu-item-tree-default').filter({ hasText: NAME })).toBeVisible()
})

test('the workspace hints that an element type is not in the Library until that flag is on', async ({
  page,
}) => {
  await signIn(page)
  const hint = page.locator('bunbraco-element-type-hint')
  const workspace = (key: string) =>
    page.goto(`/bunbraco/section/settings/workspace/document-type/edit/${key}`)

  // An element type with no library flag — the case that sends someone looking
  // in the Library and finding nothing. The suite's own type (`serve.ts`), so a
  // toggle flipped in the dev site cannot change what this tests.
  await workspace(BLOCK_ONLY_ELEMENT_TYPE)
  await expect(hint.getByText(/Not in the Library/)).toBeVisible()

  // `quote.toml` carries both flags, so it says nothing.
  await workspace('3f2a9c17-6d84-4b0e-9a55-1c7e2d40b8f3')
  await expect(hint.getByText(/Not in the Library/)).toHaveCount(0)

  // …and neither does an ordinary document type, which the hint must never nag.
  await workspace('bf568bcf-9e04-4ef2-ba37-e582717178e3')
  await expect(page.locator('umb-workspace-editor')).toBeVisible()
  await expect(hint.getByText(/Not in the Library/)).toHaveCount(0)
})
