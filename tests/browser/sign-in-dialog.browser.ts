/**
 * Nothing a person sees names Umbraco: not the dialog a timed-out session
 * shows, and not any section of the backoffice. Text, image alternatives and
 * labels are read through every shadow root, which is where the client keeps
 * almost everything.
 */
import type { Page } from '@playwright/test'
import { expect, signIn, test } from './fixtures.ts'

/** Every piece of text a person can read or a screen reader announces. */
async function displayed(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [document.title]
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement?.tagName
        if (parent !== 'STYLE' && parent !== 'SCRIPT' && parent !== 'NOSCRIPT')
          out.push(node.textContent ?? '')
        return
      }
      if (node instanceof Element) {
        for (const name of ['alt', 'title', 'aria-label', 'label', 'placeholder', 'headline'])
          out.push(node.getAttribute(name) ?? '')
        if (node.shadowRoot) walk(node.shadowRoot)
      }
      for (const child of Array.from(node.childNodes)) walk(child)
    }
    walk(document.body)
    return out.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean)
  })
}

const naming = (texts: string[]) => [...new Set(texts.filter((text) => /umbraco/i.test(text)))]

/** Ends the session as a timeout does, through the auth context the client uses. */
async function timeOut(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const find = (root: Document | ShadowRoot, tag: string): Element | null => {
      const hit = root.querySelector(tag)
      if (hit) return hit
      for (const element of Array.from(root.querySelectorAll('*'))) {
        const inner = element.shadowRoot && find(element.shadowRoot, tag)
        if (inner) return inner
      }
      return null
    }
    const { UmbContextConsumer } = await import('@umbraco-cms/backoffice/context-api')
    const { UMB_AUTH_CONTEXT } = await import('@umbraco-cms/backoffice/auth')
    const host = find(document, 'umb-backoffice-header') as HTMLElement
    new UmbContextConsumer(host, UMB_AUTH_CONTEXT, (auth) => auth?.timeOut()).hostConnected()
  })
}

test('a timed-out session gets crombolo’s dialog, which names no other product', async ({
  page,
}) => {
  await signIn(page)
  await timeOut(page)

  const dialog = page.locator('crombolo-sign-in-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Your session has ended')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.locator('umb-app-auth-modal')).toHaveCount(0)
  expect(naming(await displayed(page))).toEqual([])
})

test('no section of the backoffice names Umbraco', async ({ page, diagnostics }) => {
  // Leaving each section as soon as it renders is the client's known race (see
  // `settle`); this test reads text, so the race's errors are not its concern.
  diagnostics.allowed.push(
    'Tree context is not set',
    'provideAt is not a function',
    'repository is missing',
  )
  await signIn(page)
  const found: string[] = []
  for (const section of [
    'Content',
    'Media',
    'Library',
    'Settings',
    'Bundles',
    'Users',
    'Members',
    'Translation',
    'Forms',
    'Workflows',
  ]) {
    // Not `goToSection`: Bundles has no sidebar for it to wait on.
    if (section === 'Settings')
      await page
        .locator('umb-backoffice-header-apps')
        .getByRole('link', { name: 'Settings' })
        .click()
    else {
      await page
        .locator('umb-backoffice-header-sections')
        .getByRole('tab', { name: section })
        .click()
      await expect(page.locator('umb-backoffice-header-sections uui-tab[active]')).toHaveAttribute(
        'label',
        section,
      )
    }
    await page.waitForLoadState('networkidle')
    // Section content draws after its manifests resolve, a beat after the tab:
    // read once it has grown past the header's own text and stopped changing.
    let last = -1
    await expect
      .poll(
        async () => {
          const count = (await displayed(page)).length
          const settled = count === last && count > 50
          last = count
          return settled
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe(true)
    for (const text of naming(await displayed(page))) found.push(`${section}: ${text}`)
  }
  expect(found).toEqual([])
})
