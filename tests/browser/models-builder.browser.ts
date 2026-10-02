/**
 * The Models Builder dashboard is Umbraco's own element with hard-coded
 * expectations: it shows the Generate button only when `canGenerate` is true,
 * and treats any non-200 from the build as a failed request. Only the running
 * backoffice shows that our responses satisfy it — and that the button writes
 * the models.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, settle, signIn, test } from './fixtures.ts'

/** The throwaway site this run's server was given. */
function siteDir(): string {
  const tmp = join(process.cwd(), 'output')
  const newest = readdirSync(tmp)
    .filter((entry) => entry.startsWith('browser-site-'))
    .map((entry) => ({ entry, at: statSync(join(tmp, entry)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]?.entry
  if (!newest) throw new Error('no browser site directory')
  return join(tmp, newest)
}

test('the models builder dashboard generates the TypeScript models', async ({ page }) => {
  const target = join(siteDir(), 'schema', 'content-types.d.ts')
  rmSync(target, { force: true })
  expect(existsSync(target)).toBe(false)

  await signIn(page)
  await page.goto('/bunbraco/section/settings/dashboard/models-builder')
  await settle(page)

  const dashboard = page.locator('umb-models-builder-dashboard')
  await expect(dashboard).toHaveCount(1)
  const generate = dashboard.getByRole('button', { name: /generate/i })
  await expect(generate).toBeVisible()

  await generate.click()
  await expect
    .poll(() => existsSync(target), { timeout: 10_000, message: 'models were not written' })
    .toBe(true)
  expect(readFileSync(target, 'utf8')).toContain('bunbraco generate')
})
