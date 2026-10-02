/**
 * The browser smoke suite: the real vendored backoffice, driven by the
 * installed Chrome against a throwaway site. `bun run test:browser`. Not part
 * of `bun test` or `bun run check`; see docs/08-testing.md.
 */
import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.BUNBRACO_BROWSER_PORT ?? 3210)
export const BASE_URL = `http://localhost:${PORT}`

/**
 * The installed Google Chrome by default, which is what a visitor uses. The
 * container sets this empty to get Playwright's bundled Chromium instead — Chrome
 * has no Linux arm64 build, so on this architecture there is nothing else to run,
 * and it is the one difference between the two ways of running the suite.
 */
const CHANNEL = process.env.BUNBRACO_BROWSER_CHANNEL ?? 'chrome'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.browser.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  // A runner is slower and noisier than a laptop, and this suite has proved
  // timing-sensitive: containerising it surfaced two latent ordering bugs. Retries
  // on CI only, so a flake locally is still a flake to investigate.
  retries: process.env.CI ? 2 : 0,
  /**
   * Stop once it is clear the run is lost. When the backoffice cannot link its
   * module graph, every remaining test fails for the same reason: one such run
   * took 30 minutes, retried 12 times, wrote a 104 MB trace artifact and filled
   * the runner's disk — which then produced a second, misleading set of errors on
   * top of the first. Five is enough to see the pattern.
   */
  maxFailures: process.env.CI ? 5 : 0,
  // A stray `test.only` would otherwise turn a green build into one test.
  forbidOnly: Boolean(process.env.CI),
  outputDir: '../../output/browser-results',
  reporter: [['list'], ['html', { outputFolder: '../../output/browser-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    channel: CHANNEL || undefined,
    headless: true,
    trace: 'retain-on-failure',
    // Video needs Playwright's ffmpeg download; the trace already carries screenshots per step.
    video: 'off',
    screenshot: 'only-on-failure',
    testIdAttribute: 'data-mark',
  },
  webServer: {
    command: 'bun tests/browser/serve.ts',
    cwd: '../..',
    url: `${BASE_URL}/bunbraco`,
    env: { BUNBRACO_BROWSER_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
