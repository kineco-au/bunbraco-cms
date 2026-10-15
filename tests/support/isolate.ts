/**
 * Preloaded before every test run (bunfig.toml), so runs side by side — two
 * containers, a file beside a full suite — share nothing.
 *
 * - **Directories.** The components, media and logs directories the test
 *   environment names are one per run, under `output/test-runs/<run>/`, rather
 *   than the shared `output/test-views` and friends. A process id would not do:
 *   two containers' processes start from the same small numbers.
 * - **The Postgres database.** Each run creates a database of its own from the
 *   configured one, and drops it afterwards. Resetting one shared schema made
 *   two Postgres runs at once trample each other. A database a killed run left
 *   behind is dropped by a later run once it is six hours old.
 */
import { afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const run = `${Math.floor(Date.now() / 1000)}_${crypto.randomUUID().slice(0, 8)}`
Bun.env.CROMBOLO_TEST_RUN = run

const root = join(process.cwd(), 'output', 'test-runs', run)
const SHARED: Record<string, string> = {
  CROMBOLO_COMPONENTS_DIR: 'views',
  CROMBOLO_MEDIA_DIR: 'media',
  CROMBOLO_LOGS_DIR: 'logs',
}
for (const [variable, name] of Object.entries(SHARED)) {
  // Only the test environment's shared defaults; a value somebody chose stands.
  if (!Bun.env[variable]?.startsWith('output/test-')) continue
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  Bun.env[variable] = dir
}
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

const STALE_SECONDS = 6 * 60 * 60

async function isolatePostgres(): Promise<void> {
  const base = Bun.env.CROMBOLO_POSTGRES_URL ?? Bun.env.DATABASE_URL
  if ((Bun.env.CROMBOLO_DB ?? 'sqlite') !== 'postgres' || !base) return
  const url = new URL(base)
  const name = `${url.pathname.slice(1) || 'crombolo_test'}_${run}`
  const { SQL } = await import('bun')
  const admin = new SQL({ url: base, max: 1 })
  try {
    const now = Math.floor(Date.now() / 1000)
    const existing = (await admin.unsafe(
      "SELECT datname FROM pg_database WHERE datname LIKE '%\\_%\\_%' ESCAPE '\\'",
    )) as Array<{ datname: string }>
    for (const { datname } of existing) {
      const started = Number(/_(\d{10})_[0-9a-f]{8}$/.exec(datname)?.[1])
      if (started && now - started > STALE_SECONDS)
        await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`).catch(() => {})
    }
    await admin.unsafe(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.close()
  }
  url.pathname = `/${name}`
  Bun.env.CROMBOLO_POSTGRES_URL = url.toString()
  afterAll(async () => {
    const cleanup = new SQL({ url: base, max: 1 })
    try {
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    } finally {
      await cleanup.close()
    }
  })
}

await isolatePostgres()
