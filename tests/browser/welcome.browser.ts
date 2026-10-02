/**
 * The Content section's Welcome dashboard is ours, not Umbraco's. The manifest
 * declares `overwrites: ['Umb.Dashboard.UmbracoNews']`, and only the running
 * backoffice can show that the registry honoured it.
 */
import { expect, goToSection, settle, signIn, test } from './fixtures.ts'

test('the content section welcomes you to bunbraco, not to Umbraco', async ({ page }) => {
  await signIn(page)
  await goToSection(page, 'Content')
  await settle(page)

  await expect(page.locator('bunbraco-welcome-dashboard')).toHaveCount(1)
  await expect(page.locator('umb-umbraco-news-dashboard')).toHaveCount(0)

  const tabs = (await page.locator('uui-tab').allInnerTexts()).join(' ')
  expect(tabs).toContain('Welcome')
  expect(tabs).not.toContain('Umbraco')

  const dashboard = page.locator('bunbraco-welcome-dashboard')
  await expect(dashboard.getByText('Welcome to Bunbraco')).toBeVisible()
  await expect(dashboard.getByText('Getting started')).toBeVisible()
  await expect(dashboard).not.toContainText('Umbraco Learning Base')
})
