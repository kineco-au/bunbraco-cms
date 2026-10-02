/**
 * Every browser test gets a `diagnostics` recorder and fails on anything it
 * saw: a console error, an uncaught exception, a request that failed, or a
 * Management API response of 4xx/5xx (a 501 is an operation the client needs
 * that we have not built). Those are exactly the failures that leave the
 * backoffice showing a spinner with nothing logged on the server.
 */
import { test as base, expect, type Page } from '@playwright/test'

/** The editor's own paths and the API's, which do not move with it. */
const OURS = /^\/(bunbraco|umbraco)\//

export const BROWSER_ADMIN = { login: 'admin@bunbraco.local', password: 'browser-suite-password' }

/** An element type `serve.ts` writes with no library flag, for the workspace hint. */
export const BLOCK_ONLY_ELEMENT_TYPE = '7c4b1f0e-2a5d-4e8b-9f31-6d2c8a0b5e17'

export interface Problem {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'response'
  text: string
}

/**
 * Upstream behaviour, not ours: on first load, with no other tab to share a
 * session, the client asks the token endpoint for a refresh in case a refresh
 * cookie exists (`UmbAuthContext.setInitialState`). Without one, Umbraco too
 * answers 400 invalid_grant, and the client logs it. Allowed narrowly.
 */
const UPSTREAM_BY_DESIGN = [
  'No refresh token was presented',
  '[UmbAuthClient] Token request failed: 400 Bad Request',
  'status of 400 (Bad Request) (http://localhost:',
]

export class Diagnostics {
  readonly problems: Problem[] = []
  /** Problems a test expects; matched by substring and removed from the failure set. */
  readonly allowed: string[] = [...UPSTREAM_BY_DESIGN]

  attach(page: Page): void {
    page.on('console', (message) => {
      if (message.type() === 'error')
        this.problems.push({
          kind: 'console',
          text: `${message.text()} (${message.location().url})`,
        })
    })
    page.on('pageerror', (error) =>
      this.problems.push({
        kind: 'pageerror',
        text: `${error.name}: ${error.message}\n${error.stack ?? ''}`,
      }),
    )
    page.on('requestfailed', async (request) => {
      const errorText = request.failure()?.errorText ?? 'failed'
      // Chrome reports a finished request as aborted when the page never reads
      // its body: the client skips empty (Content-Length: 0) bodies, and the
      // login page navigates away. The server answered, so it is not a failure.
      const response = await request.response().catch(() => null)
      if (errorText === 'net::ERR_ABORTED' && response && response.status() < 400) return
      this.problems.push({
        kind: 'requestfailed',
        text: `${request.method()} ${request.url()} — ${errorText}`,
      })
    })
    page.on('response', async (response) => {
      const url = new URL(response.url())
      if (!OURS.test(url.pathname) || response.status() < 400) return
      let body = ''
      try {
        body = (await response.text()).slice(0, 400)
      } catch {}
      // The speculative first-load refresh above, whose body is gone when the
      // page has already moved on to the login redirect
      if (
        !body &&
        response.status() === 400 &&
        url.pathname.endsWith('/security/back-office/token') &&
        response.request().postData()?.includes('grant_type=refresh_token')
      )
        body = 'No refresh token was presented (body unavailable)'
      this.problems.push({
        kind: 'response',
        text: `${response.status()} ${response.request().method()} ${url.pathname}${url.search} ${body}`,
      })
    })
  }

  unexpected(): Problem[] {
    return this.problems.filter((p) => !this.allowed.some((a) => p.text.includes(a)))
  }
}

export const test = base.extend<{ diagnostics: Diagnostics }>({
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const diagnostics = new Diagnostics()
      diagnostics.attach(page)
      await use(diagnostics)
      if (diagnostics.problems.length > 0)
        await testInfo.attach('browser-problems.json', {
          body: JSON.stringify(diagnostics.problems, null, 2),
          contentType: 'application/json',
        })
      expect(diagnostics.unexpected(), 'the browser reported problems').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/**
 * Waits until the section the backoffice opened has finished rendering. Umbraco's
 * client throws from inside its own code ("Tree context is not set",
 * "context.provideAt is not a function") when a section is left while its tree
 * and dashboards are still initialising — a race a person cannot trigger but a
 * test that clicks within a second of sign-in can, more so on a loaded machine.
 */
export async function settle(page: Page): Promise<void> {
  await expect(page.locator('umb-section-sidebar').first()).toBeVisible({ timeout: 30_000 })
  await page.waitForLoadState('networkidle')
}

/** Signs in through the real login screen, as an editor would, and lets the backoffice settle. */
export async function signIn(
  page: Page,
  credentials: { login: string; password: string } = BROWSER_ADMIN,
): Promise<void> {
  await page.goto('/bunbraco')
  await page.locator('input[name="username"]').fill(credentials.login)
  await page.locator('input[name="password"]').fill(credentials.password)
  // The label differs between login builds ("Login", "Sign in"); the role does not.
  await page.getByRole('button', { name: /^(Login|Sign in)$/ }).click()
  await expect(page.locator('umb-backoffice-header')).toBeVisible({ timeout: 30_000 })
  await settle(page)
}

/** A section by its label in the header. */
export async function goToSection(page: Page, name: string): Promise<void> {
  const tab = page.locator('umb-backoffice-header-sections').getByRole('tab', { name })
  // Clicking the open section's tab navigates again, closing whatever a test opens next
  if ((await tab.getAttribute('active')) === null) await tab.click()
  await settle(page)
}

/**
 * Waits until every property on the page has rendered its editor, then
 * requires that none is Umbraco's missing-UI placeholder — which a data type
 * naming an unregistered UI shows, with nothing in the console.
 */
export async function expectEveryPropertyEditorRenders(page: Page): Promise<void> {
  // Properties and their editors live in shadow roots, so walk them all.
  const scan = () =>
    page.evaluate(() => {
      let properties = 0
      const editors: string[] = []
      const walk = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll('*')) {
          const tag = el.tagName.toLowerCase()
          if (tag === 'umb-property') properties += 1
          // Umbraco names most editors `umb-property-editor-ui-<name>`, but not
          // all of them: the element picker is `umb-element-picker-property-editor-ui`.
          // Matching only the prefix counts a rendered editor as missing.
          if (tag.startsWith('umb-property-editor-ui-') || tag.endsWith('-property-editor-ui'))
            editors.push(tag)
          if (el.shadowRoot) walk(el.shadowRoot)
        }
      }
      walk(document)
      return { properties, editors }
    })
  await expect
    .poll(
      async () => {
        const { properties, editors } = await scan()
        return properties > 0 && editors.length >= properties
      },
      { timeout: 15_000, message: 'every property renders an editor' },
    )
    .toBe(true)
  expect((await scan()).editors.filter((tag) => tag.endsWith('-missing-ui'))).toEqual([])
}
