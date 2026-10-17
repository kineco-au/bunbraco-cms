/**
 * Light and dark (story 049): chosen from the header, and still chosen after a
 * reload, before the client has booted. The choice is saved for the person, so
 * the test puts Light back for the tests after it.
 */
import type { Page } from '@playwright/test'
import { expect, settle, signIn, test } from './fixtures.ts'

const background = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--uui-color-background').trim(),
  )

async function choose(page: Page, label: string): Promise<void> {
  await page.locator('crombolo-theme-switch uui-button').click()
  await page.locator(`crombolo-theme-switch uui-menu-item[label="${label}"]`).click()
}

test('dark is chosen from the header, and kept across a reload', async ({ page }) => {
  await signIn(page)
  await settle(page)
  try {
    await choose(page, 'Dark')
    await expect.poll(() => background(page)).toBe('#1f1813')

    await page.reload()
    // Linked by the shell's own script, before the client draws anything.
    await expect(page.locator('#crombolo-early-theme')).toHaveAttribute(
      'data-theme',
      'Crombolo.Theme.Dark',
    )
    await settle(page)
    await expect.poll(() => background(page)).toBe('#1f1813')
  } finally {
    await choose(page, 'Light')
    await expect.poll(() => background(page)).toBe('#fff7ea')
  }
})
