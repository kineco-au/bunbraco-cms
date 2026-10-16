/**
 * Story 107: the CMS's own server passes the remote protocol's conformance
 * suite (`@crombolo/remote-conformance`), read-only and with a push.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEVICE_CODE_GRANT, REMOTE_CLIENT_ID } from '@crombolo/auth'
import { runConformance } from '@crombolo/remote-conformance'
import { dialectUnderTest } from './support/db.ts'
import { type Harness, ORIGIN, signedInServer, V1 } from './support/harness.ts'

const SECURITY = `${V1}/security/back-office`

const open: Harness[] = []
const dirs: string[] = []
afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

async function remote(protectedEnvironment = false) {
  const root = mkdtempSync(join(process.cwd(), 'output', 'conformance-'))
  dirs.push(root)
  for (const dir of ['schema', 'components', 'css', 'scripts', 'media'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'schema', 'schema.toml'), '[schema]\nversion = "1.0.0"\n')
  const h = await signedInServer({
    config: {
      siteDir: root,
      schemaDir: join(root, 'schema'),
      componentsDir: join(root, 'components'),
      stylesheetsDir: join(root, 'css'),
      scriptsDir: join(root, 'scripts'),
      mediaDir: join(root, 'media'),
      remote: {
        enabled: true,
        environment: 'staging',
        protected: protectedEnvironment,
        approvals: false,
        maxUploadBytes: 1024 ** 3,
      },
    },
  })
  open.push(h)
  return h
}

/** A device sign-in approved by the harness's administrator. */
async function token(h: Harness): Promise<string> {
  const form = (path: string, fields: Record<string, string>) =>
    h.server.fetch(
      new Request(`${ORIGIN}${SECURITY}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }),
    )
  const codes = (await (await form('device', { client_id: REMOTE_CLIENT_ID })).json()) as {
    device_code: string
    user_code: string
  }
  await h.post(`${SECURITY}/device/decide`, { userCode: codes.user_code, approve: true })
  const tokens = (await (
    await form('token', {
      grant_type: DEVICE_CODE_GRANT,
      device_code: codes.device_code,
      client_id: REMOTE_CLIENT_ID,
    })
  ).json()) as { access_token: string }
  return tokens.access_token
}

/** The suite's `fetch`, answered by the server in-process. */
const fetchFrom = (h: Harness) =>
  ((input: RequestInfo | URL, init?: RequestInit) =>
    h.server.fetch(new Request(input, init))) as unknown as typeof fetch

describe(`the remote conformance suite (${dialectUnderTest})`, () => {
  test('passes read-only, and with a push', async () => {
    const h = await remote()
    const report = await runConformance({
      url: ORIGIN,
      token: await token(h),
      push: true,
      timeoutMs: 60_000,
      fetch: fetchFrom(h),
    })
    const failed = report.checks.filter((c) => !c.ok)
    expect(failed).toEqual([])
    expect(report.checks.filter((c) => c.skipped).map((c) => c.name)).toEqual([])
    expect(report.passed).toBe(true)
  }, 60_000)

  test('fails a server that is not a remote', async () => {
    const h = await signedInServer()
    open.push(h)
    const report = await runConformance({ url: ORIGIN, token: 'nothing', fetch: fetchFrom(h) })
    expect(report.passed).toBe(false)
    expect(report.checks[0]?.ok).toBe(false)
  })
})
