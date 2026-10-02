/**
 * The Published Status dashboard. Rebuild is the one worth driving in a browser:
 * the client POSTs, then polls the rebuild status until it reports it has
 * finished, so a wrong shape leaves the button spinning rather than failing.
 */
import { expect, settle, signIn, test } from './fixtures.ts'

test('the published status dashboard reloads and rebuilds the cache', async ({ page }) => {
  await signIn(page)
  await page.goto('/bunbraco/section/settings/dashboard/published-status')
  await settle(page)

  const dashboard = page.locator('umb-dashboard-published-status')
  await expect(dashboard).toHaveCount(1)

  for (const name of [/reload/i, /rebuild/i]) {
    await dashboard.getByRole('button', { name }).first().click()
    await page.getByRole('button', { name: /continue/i }).click()
    // The poll ends only when the status says the rebuild is done.
    await expect(dashboard.locator('uui-button[state="success"]')).toHaveCount(1, {
      timeout: 15_000,
    })
    await page.waitForTimeout(500)
  }
})
