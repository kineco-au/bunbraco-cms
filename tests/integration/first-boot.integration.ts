/**
 * Story 080: the first boot of a self-hosted site, through the real CLI. A
 * production install given no password asks its owner to set it up, guarded by
 * a code it never prints; a server that cannot reach its database says so in
 * the browser and on /health while it retries, then gives up.
 *
 * Named `*.integration.ts`, so `bun test` does not collect it.
 */

import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLI = join(ROOT, 'packages/cli/bin/crombolo.ts')
const CODE = 'integration-setup-code-0123'

let dir: string
const site = () => join(dir, 'site')

function environment(extra: Record<string, string> = {}): Record<string, string> {
  const inherited = { ...(process.env as Record<string, string>) }
  for (const name of [
    'CROMBOLO_SQLITE_FILE',
    'CROMBOLO_COMPONENTS_DIR',
    'CROMBOLO_SCHEMA_DIR',
    'CROMBOLO_MEDIA_DIR',
    'CROMBOLO_ADMIN_PASSWORD',
    'CROMBOLO_SITE_NAME',
  ])
    delete inherited[name]
  return {
    ...inherited,
    CROMBOLO_DB: 'sqlite',
    CROMBOLO_LOGS_DIR: join(dir, 'logs'),
    CROMBOLO_LOG_TO_CONSOLE: 'false',
    NODE_ENV: 'production',
    PORT: '0',
    ...extra,
  }
}

/** Reads a process's output until `until` appears, without waiting for it to exit. */
async function readUntil(proc: Bun.Subprocess, stream: 'stdout' | 'stderr', until: string) {
  const decoder = new TextDecoder()
  let text = ''
  const timer = setTimeout(() => proc.kill(), 60_000)
  for await (const chunk of proc[stream] as ReadableStream<Uint8Array>) {
    text += decoder.decode(chunk)
    if (text.includes(until)) break
  }
  clearTimeout(timer)
  return text
}

beforeAll(async () => {
  dir = mkdtempSync(join(ROOT, 'output', 'crombolo-first-boot-'))
  mkdirSync(site(), { recursive: true })
  const init = Bun.spawn(['bun', CLI, 'init', '--name', 'First Boot'], {
    cwd: site(),
    env: environment(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await init.exited).toBe(0)
}, 120_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the first boot of a self-hosted site', () => {
  test('without a password it asks to be set up, never prints the code, and stays set up', async () => {
    const start = () =>
      Bun.spawn(['bun', CLI, 'start'], {
        cwd: site(),
        env: environment({ CROMBOLO_SETUP_CODE: CODE }),
        stdout: 'pipe',
        stderr: 'pipe',
      })
    const first = start()
    const banner = await readUntil(first, 'stdout', '└─')
    expect(banner).toContain('Set up your new site at')
    expect(banner).not.toContain(CODE)
    expect(banner).not.toContain('password')
    const setupUrl = /(http:\/\/\S+\/setup)/.exec(banner)?.[1] as string
    expect((await fetch(setupUrl)).status).toBe(200)
    const done = await fetch(setupUrl, {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Owner',
        email: 'owner@example.com',
        password: 'a long enough password',
        confirm: 'a long enough password',
        code: CODE,
      }),
    })
    expect(await done.text()).toContain('Your site is ready')
    first.kill()
    await first.exited

    const second = start()
    const again = await readUntil(second, 'stdout', '└─')
    expect(again).not.toContain('Set up your new site')
    const url = /backoffice\s+(http:\/\/\S+)/.exec(again)?.[1] as string
    const setup = await fetch(`${url}/setup`, { redirect: 'manual' })
    expect(setup.status).toBe(303)
    second.kill()
    await second.exited
  }, 120_000)

  test('a database it cannot reach is explained in the browser while it retries, then it stops', async () => {
    const proc = Bun.spawn(['bun', CLI, 'start'], {
      cwd: site(),
      env: environment({
        CROMBOLO_DB: 'postgres',
        CROMBOLO_POSTGRES_URL: 'postgres://site:s3cret-pass@127.0.0.1:1/site',
        CROMBOLO_BOOT_ATTEMPTS: '2',
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const said = await readUntil(proc, 'stderr', 'explains this while it retries.')
    expect(said).toContain("Can't reach the database")
    expect(said).not.toContain('s3cret-pass')
    const url = /(http:\/\/\S+) explains this/.exec(said)?.[1] as string
    const page = await fetch(url)
    expect(page.status).toBe(503)
    const html = await page.text()
    expect(html).toContain('CROMBOLO_POSTGRES_URL')
    expect(html).not.toContain('s3cret-pass')
    expect((await fetch(`${url}health`)).status).toBe(503)
    expect(await proc.exited).not.toBe(0)
  }, 120_000)

  test('a database the previous release left is upgraded by `crombolo upgrade`, and then starts', async () => {
    const file = readdirSync(site()).find((name) => name.endsWith('.sqlite')) as string
    const sqlite = new Database(join(site(), file))
    for (const table of [
      'delivery_member_token',
      'transfer_answer',
      'transfer_pending',
      'webhook_log',
      'webhook_delivery',
      'webhook',
    ])
      sqlite.exec(`DROP TABLE ${table}`)
    sqlite.exec(
      "DELETE FROM migration_history WHERE name IN ('AddWebhooks', 'AddTransferAnswers', 'AddDeliveryMemberTokens')",
    )
    sqlite.exec('ALTER TABLE server DROP COLUMN crombolo_version')
    sqlite.exec('ALTER TABLE form_entry_value DROP COLUMN label')
    sqlite
      .query("UPDATE key_value SET value = ? WHERE key = 'Crombolo.Core.Upgrader.State'")
      .run('{6f1d4a8e-0033-4c1a-9e7d-3a5b8c2d4e33}')
    sqlite.exec("DELETE FROM migration_history WHERE name = 'AddNodeVersionAndChoiceLabel'")
    sqlite.close()

    const run = async (...args: string[]) => {
      const proc = Bun.spawn(['bun', CLI, ...args], {
        cwd: site(),
        env: environment({ CROMBOLO_BOOT_ATTEMPTS: '1' }),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { code: await proc.exited, out: `${out}${err}` }
    }
    const refused = await run('start')
    expect(refused.code, refused.out).not.toBe(0)
    expect(refused.out).toContain('An upgrade is waiting')
    expect(refused.out).toContain('crombolo upgrade')

    const upgraded = await run('upgrade')
    expect(upgraded.code, upgraded.out).toBe(0)
    const ledger = await run('upgrade', 'ledger')
    expect(ledger.out).toContain('AddNodeVersionAndChoiceLabel')

    const proc = Bun.spawn(['bun', CLI, 'start'], {
      cwd: site(),
      env: environment(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await readUntil(proc, 'stdout', '└─')).toContain('Crombolo is running')
    proc.kill()
    await proc.exited
  }, 180_000)
})
