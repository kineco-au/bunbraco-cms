/**
 * WP-6.6's exit in the real backoffice: on a two-language site, a page that
 * varies by culture is written and published in English, then in Danish
 * through the publish dialog, and each culture renders under its own
 * hostname — Danish falling back to English for the title it leaves empty.
 */
import type { Page } from '@playwright/test'
import { expect, settle, signIn, test } from './fixtures.ts'
import { BASE_URL } from './playwright.config.ts'

const API = '/umbraco/management/api/v1'
const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 7)}`

async function openCreateDialog(page: Page) {
  const dialog = page.locator('umb-document-create-options-modal')
  await expect(async () => {
    await page
      .getByRole('button', { name: 'Create item for Content' })
      .click({ force: true, timeout: 2_000 })
    await expect(dialog).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  return dialog
}

/**
 * Save and publish through the workspace's dialog, choosing exactly one culture.
 * The dialog's container reads as hidden to Playwright, so its parts are found
 * on the page: its heading, its menu of cultures and its confirm button.
 */
async function saveAndPublish(page: Page, culture: string) {
  await page.getByTestId('workspace-action:Umb.WorkspaceAction.Document.SaveAndPublish').click()
  await expect(page.getByRole('heading', { name: 'Save and publish' })).toBeVisible()
  for (const item of await page.getByRole('menu').last().getByRole('menuitem').all()) {
    const wanted = (await item.textContent())?.includes(culture) ?? false
    const selected = await item.evaluate((el) => el.hasAttribute('selected'))
    const disabled = await item.evaluate((el) => el.hasAttribute('disabled'))
    if (wanted !== selected && !disabled) await item.getByRole('button').first().click()
  }
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Save and publish' })).toHaveCount(0)
}

test('a page that varies by culture publishes English, then Danish, and renders each under its hostname', async ({
  page,
  diagnostics,
}) => {
  // Visiting the site itself, Chrome asks it for a favicon the test site has not got
  diagnostics.allowed.push('/favicon.ico')
  const EN = unique('Welcome')
  await signIn(page)
  const language = await page.request.post(`${API}/language`, {
    data: {
      isoCode: 'da-DK',
      name: 'Danish',
      isDefault: false,
      isMandatory: false,
      fallbackIsoCode: 'en-US',
    },
  })
  expect([201, 400]).toContain(language.status())
  await page.reload()
  await settle(page)

  // English first, through the create dialog and the workspace
  await expect(async () => {
    await openCreateDialog(page)
    await page
      .locator('uui-ref-node-document-type')
      .filter({ hasText: 'Variant page' })
      .click({ timeout: 3_000 })
    await expect(page.locator('#name-input input')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await page.locator('#name-input input').fill(`${EN} home`)
  await page.locator('umb-property-editor-ui-text-box #input').first().fill(EN)
  await saveAndPublish(page, 'English')
  await expect(page).toHaveURL(/\/workspace\/document\/edit\//)
  const key = /\/edit\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string
  const states = async () =>
    Object.fromEntries(
      (
        (await (await page.request.get(`${API}/document/${key}`)).json()) as {
          variants: Array<{ culture: string; state: string }>
        }
      ).variants.map((v) => [v.culture, v.state]),
    )
  await expect.poll(states).toMatchObject({ 'en-US': 'Published' })

  // Then Danish: switch the workspace to it, name it, leave the title empty
  await page.getByRole('button', { name: 'Open version selector' }).click()
  await page
    .getByRole('button', { name: /Danish/ })
    .first()
    .click()
  await expect(page.getByRole('button', { name: 'Open version selector' })).toHaveAttribute(
    'title',
    'Danish',
  )
  await expect(page.locator('#name-input input')).toHaveValue('')
  await page.locator('#name-input input').fill('Hjem')
  await expect(page.locator('#name-input input')).toHaveValue('Hjem')
  await saveAndPublish(page, 'Danish')
  await expect.poll(states).toEqual({ 'en-US': 'Published', 'da-DK': 'Published' })

  // Each culture under its own hostname: a path prefix on this host
  const host = new URL(BASE_URL).host
  // Hostnames are unique site-wide, so every run uses its own prefixes
  const run = EN.split(' ')[1]
  const en = `en-${run}`
  const da = `da-${run}`
  expect(
    (
      await page.request.put(`${API}/document/${key}/domains`, {
        data: {
          defaultIsoCode: null,
          domains: [
            { domainName: `${host}/${en}`, isoCode: 'en-US' },
            { domainName: `${host}/${da}`, isoCode: 'da-DK' },
          ],
        },
      })
    ).status(),
  ).toBe(200)
  await page.goto(`/${en}/`)
  await expect(page.locator('h1')).toHaveText(`${EN} home`)
  await expect(page.locator('p.title')).toHaveText(EN)
  await expect(page.locator('i')).toHaveText('en-US')
  await page.goto(`/${da}/`)
  await expect(page.locator('h1')).toHaveText('Hjem')
  // Nothing in Danish: the title falls back to English
  await expect(page.locator('p.title')).toHaveText(EN)
  await expect(page.locator('i')).toHaveText('da-DK')
})
