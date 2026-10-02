/**
 * WP-6.7's login flows on our login page: an invited user follows their link,
 * chooses a password and signs in; later they forget it, ask for a reset link
 * from the sign-in screen, and choose a new one. The browser site records the
 * links it would have e-mailed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, settle, signIn, test } from './fixtures.ts'

const API = '/umbraco/management/api/v1'
const WRITERS = '9fc2a16f-528c-46d6-a014-75bf4ec2480c'
const LINKS = join(import.meta.dirname, '../../output/browser-links.jsonl')

function lastLink(email: string, kind: 'invite' | 'reset'): string | undefined {
  return readFileSync(LINKS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { email: string; kind: string; link: string })
    .filter((entry) => entry.email === email && entry.kind === kind)
    .at(-1)?.link
}

async function choosePassword(page: Page, heading: string, password: string) {
  await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  await page.locator('input[name="password"]').fill(password)
  await page.locator('input[name="confirm"]').fill(password)
  await page.getByRole('button', { name: 'Set password' }).click()
  await expect(page.getByText('Your password is set. Sign in with it now.')).toBeVisible()
}

async function signInAs(page: Page, email: string, password: string) {
  await page.locator('input[name="username"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: /^(Login|Sign in)$/ }).click()
  await expect(page.locator('umb-backoffice-header')).toBeVisible({ timeout: 30_000 })
  await settle(page)
}

test('an invited user sets a password from their link; a forgotten one is reset from the sign-in screen', async ({
  page,
  browser,
  diagnostics,
}) => {
  const email = `${Math.random().toString(36).slice(2, 9)}@example.com`
  await signIn(page)
  const invite = await page.request.post(`${API}/user/invite`, {
    data: {
      email,
      userName: email,
      name: 'Invited',
      userGroupIds: [{ id: WRITERS }],
      message: null,
    },
  })
  expect(invite.status()).toBe(201)
  await expect.poll(() => lastLink(email, 'invite')).toBeDefined()

  // The invitation, in a browser with no session
  const context = await browser.newContext()
  const guest = await context.newPage()
  diagnostics.attach(guest)
  await guest.goto(lastLink(email, 'invite') as string)
  await choosePassword(guest, 'Choose your password', 'the-first-password')
  await guest.goto('/bunbraco')
  await signInAs(guest, email, 'the-first-password')
  await context.close()

  // Forgotten: the sign-in screen sends a reset link
  const later = await browser.newContext()
  const forgetful = await later.newPage()
  diagnostics.attach(forgetful)
  await forgetful.goto('/bunbraco')
  await forgetful.getByRole('button', { name: 'Forgotten password?' }).click()
  await forgetful.locator('input[name="email"]').fill(email)
  await forgetful.getByRole('button', { name: 'Send reset link' }).click()
  await expect(forgetful.getByText('If that address belongs to an account')).toBeVisible()
  await expect.poll(() => lastLink(email, 'reset')).toBeDefined()
  await forgetful.goto(lastLink(email, 'reset') as string)
  await choosePassword(forgetful, 'Choose a new password', 'the-second-password')
  await forgetful.goto('/bunbraco')
  await signInAs(forgetful, email, 'the-second-password')
  await later.close()
})
