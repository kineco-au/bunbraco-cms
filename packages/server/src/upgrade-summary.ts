/** What the Changes dashboard says about this site's installs and upgrades, read from the ledger. */
import type { LedgerRow } from '@crombolo/data'

export interface UpgradeSummary {
  version: string
  installedAt: string | null
  /** The last run of framework steps after the install, if there has been one. */
  lastUpgrade: { at: string; release: string | null; steps: number } | null
}

/** Steps this far apart or closer belong to one run. */
const RUN_GAP_MS = 10 * 60_000

/** SQLite and Postgres hand dates back differently; the dashboard gets ISO. */
const iso = (at: string) => {
  const time = Date.parse(at)
  return Number.isNaN(time) ? at : new Date(time).toISOString()
}

const releaseOf = (row: LedgerRow) => /^release (\S+)/.exec(row.note ?? '')?.[1] ?? null

export function summariseUpgrades(ledger: readonly LedgerRow[], version: string): UpgradeSummary {
  const core = ledger
    .filter((row) => !row.bundle && (row.kind === 'expand' || row.kind === 'contract'))
    .sort((a, b) => a.id - b.id)
  const first = core[0]
  if (!first) return { version, installedAt: null, lastUpgrade: null }
  let start = core.length - 1
  while (
    start > 0 &&
    Date.parse(core[start]?.appliedAt ?? '') - Date.parse(core[start - 1]?.appliedAt ?? '') <=
      RUN_GAP_MS
  )
    start--
  const run = core.slice(start)
  const last = run.at(-1) as LedgerRow
  return {
    version,
    installedAt: iso(first.appliedAt),
    lastUpgrade:
      start === 0 ? null : { at: iso(last.appliedAt), release: releaseOf(last), steps: run.length },
  }
}
