/**
 * The test harness's own isolation guarantee.
 *
 * `resetPostgresSchema` empties an already-migrated schema rather than dropping
 * and rebuilding it, which is most of what made the Postgres leg several times
 * slower than SQLite. The saving is only safe while everything a test wrote is
 * actually cleared: what is left behind leaks into the next test and surfaces as
 * unrelated failures elsewhere rather than here. Hence these.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { connect, readKeyValue, readLedger, writeKeyValue } from '@bunbraco/data'
import { canConnect, dialectUnderTest } from './support/db.ts'
import { type Harness, signedInServer, V1 } from './support/harness.ts'

const reachable = await canConnect()
const open: Harness[] = []

afterEach(async () => {
  while (open.length > 0)
    await open
      .pop()
      ?.db.close()
      .catch(() => {})
})

async function boot(): Promise<Harness> {
  const h = await signedInServer()
  open.push(h)
  return h
}

describe.skipIf(!reachable)('a server booted twice over one database', () => {
  test('keeps none of the previous boot’s rows, and is seeded again', async () => {
    // A user rather than a document: a bare harness seeds the identity tables and
    // the user groups, but no document type is allowed at root until a site's
    // schema is loaded, so there would be nothing to create content under.
    const email = 'left-over@example.com'
    const users = (h: Harness) => h.json<{ items: { email: string }[] }>(`${V1}/user?take=100`)

    const first = await boot()
    const seeded = (await users(first)).items.length
    const groups = await first.json<{ items: { id: string }[] }>(`${V1}/user-group?take=100`)
    expect(groups.items.length).toBeGreaterThan(0)
    const created = await first.post(`${V1}/user`, {
      kind: 'Default',
      email,
      userName: email,
      name: 'Left over',
      userGroupIds: [{ id: groups.items[0]?.id as string }],
    })
    expect(created.status).toBe(201)
    expect((await users(first)).items.map((u) => u.email)).toContain(email)
    await first.db.close()

    // Signing in at all proves the admin was seeded again, not merely left behind.
    const second = await boot()
    const after = await users(second)
    expect(after.items.map((u) => u.email)).not.toContain(email)
    expect(after.items.length).toBe(seeded)
    // The groups are back too, so the schema was emptied and reseeded rather than
    // left holding the first boot's rows.
    expect(
      (await second.json<{ items: unknown[] }>(`${V1}/user-group?take=100`)).items.length,
    ).toBe(groups.items.length)
  })

  test.skipIf(dialectUnderTest !== 'postgres')(
    'leaves a database a cold rebuild would not tell apart',
    async () => {
      // The fast path skips the migrations, so anything a *migration* installs
      // rather than seeding has to be put back by hand — `schema_state` (without
      // which every write fails "the database is not installed") and the saved log
      // searches both are. Comparing row counts against a genuinely rebuilt schema
      // is what finds the next one, rather than a failure somewhere unrelated.
      const countAll = async () => {
        const h = await boot()
        const tables = await h.server.db.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
        )
        const counts = new Map<string, number>()
        for (const { table_name: table } of tables) {
          const rows = await h.server.db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "${table}"`,
          )
          counts.set(table, Number(rows[0]?.n ?? 0))
        }
        await h.db.close()
        return counts
      }

      // Dropping the schema outright forces the rebuild branch on the next reset.
      const bare = await connect({ poolSize: 1 })
      await bare.exec('DROP SCHEMA IF EXISTS public CASCADE')
      await bare.exec('CREATE SCHEMA public')
      await bare.exec('CREATE EXTENSION IF NOT EXISTS citext SCHEMA public')
      await bare.close()
      const cold = await countAll()
      // This one takes the truncate path, the schema now being migrated.
      const warm = await countAll()

      expect(warm.size).toBe(cold.size)
      const emptied: string[] = []
      const leaked: string[] = []
      for (const [table, before] of cold) {
        const after = warm.get(table) ?? 0
        if (before > 0 && after === 0) emptied.push(`${table}: ${before} -> 0`)
        else if (after > before) leaked.push(`${table}: ${before} -> ${after}`)
      }
      expect(emptied).toEqual([])
      expect(leaked).toEqual([])
    },
    30_000,
  )

  test('a setting written through key_value does not survive, but the applied state does', async () => {
    // `key_value` is the one table held back from the truncate, because it carries
    // the row that lets the migrations be skipped. Everything else in it is a
    // test's own state and has to go, which is the narrow risk this covers.
    const first = await boot()
    await writeKeyValue(first.server.db, 'Test.Leak', 'from the first boot')
    expect(await readKeyValue(first.server.db, 'Test.Leak')).toBe('from the first boot')
    const ledgerBefore = dialectUnderTest === 'postgres' ? await readLedger(first.server.db) : []
    await first.db.close()

    const second = await boot()
    expect(await readKeyValue(second.server.db, 'Test.Leak')).toBeUndefined()
    if (dialectUnderTest !== 'postgres') return
    // The applied state survived, so the second boot skipped the migrations
    // instead of replaying them — which is where the saving comes from. A replay
    // would have appended to the ledger.
    expect((await readLedger(second.server.db)).length).toBe(ledgerBefore.length)
    expect(ledgerBefore.length).toBeGreaterThan(0)
  })
})
