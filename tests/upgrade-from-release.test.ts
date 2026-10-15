/**
 * Story 080: a database as the previous release (0.11.0) left it upgrades to
 * this one, and the Changes dashboard says so. The ledger summary it reads is
 * pure, so its rules are tested on hand-made rows.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  cromboloPlan,
  type Db,
  type LedgerRow,
  MIGRATION_STATE_KEY,
  migrate,
  readLedger,
  readState,
  STATE_AUDIT_LOG,
  STATE_DELIVERY_MEMBER_TOKENS,
} from '@crombolo/data'
import { summariseUpgrades, VERSION } from '@crombolo/server'
import { freshDb } from './support/db.ts'
import { BACKOFFICE, type Harness, signedInServer } from './support/harness.ts'

const row = (id: number, appliedAt: string, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  id,
  name: `Step${id}`,
  kind: 'expand',
  appliedAt,
  durationMs: 1,
  note: 'release 0.11.0',
  bundle: null,
  ...extra,
})

describe('summarising the ledger', () => {
  test('nothing ran: neither installed nor upgraded', () => {
    expect(summariseUpgrades([], '0.12.0')).toEqual({
      version: '0.12.0',
      installedAt: null,
      lastUpgrade: null,
    })
  })

  test('one run from the start is an install, not an upgrade', () => {
    const summary = summariseUpgrades(
      [row(1, '2026-10-01T10:00:00Z'), row(2, '2026-10-01T10:00:01Z')],
      '0.11.0',
    )
    expect(summary.installedAt).toBe('2026-10-01T10:00:00.000Z')
    expect(summary.lastUpgrade).toBeNull()
  })

  test('a later run is the last upgrade: when, to which release, and how many steps', () => {
    const summary = summariseUpgrades(
      [
        row(1, '2026-10-01T10:00:00Z'),
        row(2, '2026-10-15T09:00:00Z', { note: 'release 0.12.0' }),
        row(3, '2026-10-15T09:00:02Z', { note: 'release 0.12.0' }),
      ],
      '0.12.0',
    )
    expect(summary.lastUpgrade).toEqual({
      at: '2026-10-15T09:00:02.000Z',
      release: '0.12.0',
      steps: 2,
    })
  })

  test("a bundle's steps and value migrations are not the framework's upgrades", () => {
    const summary = summariseUpgrades(
      [
        row(1, '2026-10-01T10:00:00Z'),
        row(2, '2026-10-15T09:00:00Z', { bundle: 'forms' }),
        row(3, '2026-10-15T09:00:00Z', { kind: 'value' }),
      ],
      '0.12.0',
    )
    expect(summary.lastUpgrade).toBeNull()
  })
})

/** Puts a current database back the way 0.11.0 left it, a day ago. */
async function asPreviousRelease(db: Db): Promise<void> {
  for (const table of [
    'delivery_member_token',
    'transfer_answer',
    'transfer_pending',
    'webhook_log',
    'webhook_delivery',
    'webhook',
  ])
    await db.exec(`DROP TABLE ${table}`)
  await db.exec(
    "DELETE FROM migration_history WHERE name IN ('AddWebhooks', 'AddTransferAnswers', 'AddDeliveryMemberTokens')",
  )
  await db.exec('ALTER TABLE server DROP COLUMN crombolo_version')
  await db.exec('ALTER TABLE form_entry_value DROP COLUMN label')
  await db.exec('UPDATE key_value SET value = ? WHERE key = ?', [
    STATE_AUDIT_LOG,
    MIGRATION_STATE_KEY,
  ])
  await db.exec("DELETE FROM migration_history WHERE name = 'AddNodeVersionAndChoiceLabel'")
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString()
  await db.exec(`UPDATE migration_history SET applied_at = ?`, [
    db.dialect.name === 'postgres' ? yesterday : yesterday.replace('T', ' ').slice(0, 19),
  ])
}

const dbs: Db[] = []
const harnesses: Harness[] = []
afterEach(async () => {
  while (dbs.length > 0) await dbs.pop()?.close()
  while (harnesses.length > 0) await harnesses.pop()?.db.close()
})

describe('upgrading from the previous release', () => {
  test('applies only what is new, records it, and the summary calls it an upgrade', async () => {
    const db = await freshDb()
    dbs.push(db)
    await migrate(db, cromboloPlan)
    await asPreviousRelease(db)
    expect(await readState(db)).toBe(STATE_AUDIT_LOG)

    const result = await migrate(db, cromboloPlan, { by: 'upgrade' })
    expect(result.applied).toEqual([
      'AddNodeVersionAndChoiceLabel',
      'AddWebhooks',
      'AddTransferAnswers',
      'AddDeliveryMemberTokens',
    ])
    expect(await readState(db)).toBe(STATE_DELIVERY_MEMBER_TOKENS)
    const summary = summariseUpgrades(await readLedger(db), VERSION)
    expect(summary.lastUpgrade).toMatchObject({ release: '0.12.0', steps: 4 })
  })

  test('the Changes dashboard reports the version, the install and the last upgrade', async () => {
    const h = await signedInServer()
    harnesses.push(h)
    const report = await h.json<{
      upgrades: { version: string; installedAt: string | null; lastUpgrade: unknown }
    }>(`${BACKOFFICE}/crombolo/api/change-report`)
    expect(report.upgrades.version).toBe(VERSION)
    expect(report.upgrades.installedAt).not.toBeNull()
    // Postgres test databases keep their ledger between tests, so whether this
    // one reads as upgraded depends on the run; that it reads its own ledger does not.
    expect(report.upgrades).toEqual(summariseUpgrades(await readLedger(h.server.db), VERSION))
  })
})
