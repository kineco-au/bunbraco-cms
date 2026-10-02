/**
 * The backoffice boots, and keeps booting: on a first load, on a reload, and
 * when its own entry points arrive late.
 *
 * Every other browser test assumes this and says nothing useful when it fails —
 * a boot that stalls shows up as thirteen unrelated timeouts. These fail first
 * and say what they mean.
 */
import { expect, settle, signIn, test } from './fixtures.ts'

const SECTION = '/bunbraco/section/content'

test('the backoffice comes up on every reload, not just the first', async ({ page }) => {
  // Six boots in one test, the first of them against a cold server: sign-in has
  // taken 24 s there and a reload 9 s, which is already past the default limit.
  test.setTimeout(180_000)
  await signIn(page)
  for (let boot = 1; boot <= 5; boot++) {
    await page.reload()
    await settle(page)
    // A title that keeps growing is an entry point answering its own change.
    const title = await page.title()
    expect([boot, title.length < 120, title]).toEqual([boot, true, title])
    expect(title).not.toContain('Umbraco')
  }
})

test('the title carries the site’s name, and correcting it settles', async ({ page }) => {
  await signIn(page)
  await page.goto(SECTION)
  await settle(page)
  await expect(page).toHaveTitle(/ \| Bunbraco$/)

  // What the client does on every navigation: write its own suffix. The
  // correction must land once and leave the page its main thread.
  await page.evaluate(() => {
    document.title = 'Somewhere | Umbraco'
  })
  await expect(page).toHaveTitle('Somewhere | Bunbraco')
  expect(await page.evaluate(() => 1 + 1)).toBe(2)
})

test('an entry point that loads after the client has written its title does not hang the page', async ({
  page,
}) => {
  await signIn(page)
  // The ordering that once looped forever: the branding entry point read the
  // site's name from a title the client had already written. Holding the module
  // back makes that ordering certain rather than a race a slow machine loses.
  await page.route('**/branding/branding.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    await route.continue()
  })
  await page.goto(SECTION)
  await settle(page)
  await expect(page).toHaveTitle(/ \| Bunbraco$/, { timeout: 15_000 })
  const title = await page.title()
  expect(title.length).toBeLessThan(120)
  // Responsive, which a page stuck in an observer loop is not.
  expect(await page.evaluate(() => document.readyState)).toBe('complete')
})

test('booting leaves nothing pinning the main thread', async ({ page }) => {
  await signIn(page)
  await page.goto(SECTION)
  await settle(page)
  // Long tasks over two idle seconds: a settled backoffice has next to none, and
  // a livelocked one is a single task that never ends.
  const busy = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) total += entry.duration
        })
        observer.observe({ type: 'longtask', buffered: false })
        setTimeout(() => {
          observer.disconnect()
          resolve(total)
        }, 2_000)
      }),
  )
  expect(busy).toBeLessThan(1_000)
})
