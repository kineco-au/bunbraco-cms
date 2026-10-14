/**
 * The chains of the bundles a site wires that own tables: worked out once from
 * the configuration and the packages those bundles came from, and run after
 * core's, in the order `bundles` lists them. `docs/bundles.md`, Part 4.
 *
 * Only a node that mounts bundles — one that serves the backoffice — applies
 * them or checks them at boot. A `web` node reads nothing of a bundle's.
 */
import { type BundlePackage, discoverBundles } from '@crombolo/backoffice-host'
import {
  bundlePlan,
  type CompiledTables,
  compileBundleTables,
  type Db,
  type Migration,
  type MigrationPlan,
  migrate,
  type PlannedStep,
  pendingMigrations,
  planUpgrade,
  readLedger,
  readState,
} from '@crombolo/data'
import { type ServerBundle, validateServerBundles } from './bundles.ts'
import { type CromboloConfig, VERSION } from './config.ts'

/** One bundle's chain, with what it is called. */
export interface BundleChain {
  id: string
  name: string
  compiled: CompiledTables
  plan: MigrationPlan
}

/**
 * The chains of every wired bundle that declares tables, in wiring order.
 * Throws when a declaration is invalid; `validateServerBundles` is what reports
 * the reasons, and boot runs it first.
 */
export function bundleChains(
  bundles: readonly ServerBundle[],
  packages: readonly BundlePackage[],
): BundleChain[] {
  return bundles.flatMap((bundle) => {
    if (!bundle.tables) return []
    const owner = packages.find((pkg) => pkg.id === bundle.id)
    const compiled = compileBundleTables(bundle.tables, owner?.version)
    return [{ id: bundle.id, name: owner?.name ?? bundle.id, compiled, plan: bundlePlan(compiled) }]
  })
}

/** The wired bundles cannot be used: every reason, at once. */
export class BundleConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`The configured bundles cannot be used:\n- ${problems.join('\n- ')}`)
  }
}

/**
 * The chains for a site's configuration, discovering its packages and checking
 * the bundles exactly as boot checks them, so a command off the server refuses
 * what the server would.
 */
export function bundleChainsFor(
  config: Pick<CromboloConfig, 'bundles' | 'siteDir'>,
): BundleChain[] {
  if (config.bundles.length === 0) return []
  const packages = discoverBundles(config.siteDir).bundles
  const problems = validateServerBundles(config.bundles, packages, VERSION)
  if (problems.length > 0) throw new BundleConfigurationError(problems)
  return bundleChains(config.bundles, packages)
}

export interface BundlePending {
  id: string
  name: string
  state: string
  pending: Migration[]
}

/** What each chain still has to run. Throws `UpgradeStateError`, naming the bundle, when one is ahead. */
export async function pendingBundleSteps(
  db: Db,
  chains: readonly BundleChain[],
): Promise<BundlePending[]> {
  const out: BundlePending[] = []
  for (const chain of chains)
    out.push({
      id: chain.id,
      name: chain.name,
      state: await readState(db, chain.plan),
      pending: await pendingMigrations(db, chain.plan),
    })
  return out
}

/** Runs each chain's pending steps, in order, after core's. */
export async function migrateBundles(
  db: Db,
  chains: readonly BundleChain[],
  options: { by?: string } = {},
): Promise<{ id: string; applied: string[] }[]> {
  const out: { id: string; applied: string[] }[] = []
  for (const chain of chains) {
    const result = await migrate(db, chain.plan, { by: options.by })
    out.push({ id: chain.id, applied: result.applied })
  }
  return out
}

/** What each chain would run, without running it. */
export async function planBundleUpgrades(
  db: Db,
  chains: readonly BundleChain[],
): Promise<{ id: string; name: string; steps: PlannedStep[] }[]> {
  const out: { id: string; name: string; steps: PlannedStep[] }[] = []
  for (const chain of chains)
    out.push({ id: chain.id, name: chain.name, steps: await planUpgrade(db, chain.plan) })
  return out
}

export interface BundleTablesReport {
  id: string
  name: string
  pending: { name: string; kind: string; release: string | null }[]
  /** What has run here since the bundle was last purged, oldest first. */
  applied: { name: string; kind: string; release: string | null; appliedAt: string }[]
}

/** Each chain's steps, applied and pending, as the Changes dashboard shows them. */
export async function bundleTablesReport(
  db: Db,
  chains: readonly BundleChain[],
): Promise<BundleTablesReport[]> {
  const ledger = await readLedger(db)
  const out: BundleTablesReport[] = []
  for (const chain of chains) {
    const rows = ledger.filter((row) => row.bundle === chain.id)
    const purged = rows.map((row) => row.kind).lastIndexOf('purge')
    const releases = new Map(chain.compiled.steps.map((step) => [step.name, step.release]))
    out.push({
      id: chain.id,
      name: chain.name,
      pending: (await pendingMigrations(db, chain.plan)).map((step) => ({
        name: step.name,
        kind: step.kind ?? 'expand',
        release: step.release ?? null,
      })),
      applied: rows
        .slice(purged + 1)
        .filter((row) => row.kind === 'expand' || row.kind === 'contract')
        .map((row) => ({
          name: row.name,
          kind: row.kind,
          release: releases.get(row.name) ?? null,
          appliedAt: row.appliedAt,
        })),
    })
  }
  return out
}
