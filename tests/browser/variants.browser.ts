/**
 * Story 025's exit in the real backoffice: on a two-language site, a page that
 * varies by culture is written and published in English, then in Danish
 * through the publish dialog, and each culture renders under its own
 * hostname — Danish falling back to English for the title it leaves empty.
 */
import type { Page } from '@playwright/test'
import { expect, settle, signIn, test } from './fixtures.ts'
import { BASE_URL } from './playwright.config.ts'

const API = '/umbraco/management/api/v1'
const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 7)}`

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

  // English content through the API, not typed into the editor: typing raced
  // the workspace rendering its properties, and the title once landed in the
  // name. What this test is about is the publish dialog and rendering per
  // culture, so that is what goes through the backoffice.
  const types = (await (
    await page.request.get(`${API}/tree/document-type/root?take=100`)
  ).json()) as {
    items: Array<{ id: string; name: string }>
  }
  const typeId = types.items.find((t) => t.name === 'Variant page')?.id as string
  const type = (await (await page.request.get(`${API}/document-type/${typeId}`)).json()) as {
    defaultTemplate: { id: string } | null
  }
  const created = await page.request.post(`${API}/document`, {
    data: {
      documentType: { id: typeId },
      template: type.defaultTemplate,
      parent: null,
      values: [{ alias: 'title', culture: 'en-US', segment: null, value: EN }],
      variants: [{ culture: 'en-US', segment: null, name: `${EN} home` }],
    },
  })
  expect(created.status()).toBe(201)
  const key = created.headers()['umb-generated-resource'] as string

  // Published in English through the workspace's dialog
  await page.goto(`/crombolo/section/content/workspace/document/edit/${key}`)
  await settle(page)
  await expect(page.locator('#name-input input')).toHaveValue(`${EN} home`)
  await saveAndPublish(page, 'English')
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
