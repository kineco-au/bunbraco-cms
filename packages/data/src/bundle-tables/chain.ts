/**
 * A bundle's compiled steps as a migration chain, run by the same `migrate`,
 * under the same lock and into the same ledger as core's — only its state key
 * and its ledger rows' `bundle` differ. And purging one: dropping exactly the
 * tables under its prefix, found in the database rather than the declaration,
 * because a purged bundle is one the site no longer wires.
 */
import type { Db } from '../database.ts'
import { deleteKeyValue, type Migration, MigrationPlan, recordInLedger } from '../migrations.ts'
import { createTablesCapability } from './capability.ts'
import { renderStep } from './ddl.ts'
import { guardStatement } from './guard.ts'
import { bundlePrefix } from './names.ts'
import type { CompiledStep, CompiledTables } from './schema.ts'

function migrationOf(step: CompiledStep): Migration {
  return {
    from: step.from,
    to: step.to,
    name: step.name,
    kind: step.kind,
    release: step.release,
    contracts: step.contracts,
    checksum: step.checksum,
    async up(db) {
      for (const sql of renderStep(db.dialect, step)) await db.exec(sql)
    },
    backfill: step.backfill
      ? (db) =>
          (step.backfill as NonNullable<CompiledStep['backfill']>)(
            createTablesCapability(db, step.after),
          )
      : undefined,
  }
}

/** The chain `migrate` walks. Throws when the declaration has problems: compile first. */
export function bundlePlan(compiled: CompiledTables): MigrationPlan {
  if (compiled.problems.length > 0)
    throw new Error(
      `The bundle "${compiled.id}"'s tables cannot be planned:\n- ${compiled.problems.join('\n- ')}`,
    )
  return new MigrationPlan(compiled.steps.map(migrationOf), {
    stateKey: compiled.stateKey,
    initialState: compiled.initialState,
    bundle: compiled.id,
  })
}

/**
 * Creates a bundle's tables directly, step by step, without its ledger or its
 * state. Only for proving what core's own migrations do around a bundle's
 * tables: an install is always `migrate`.
 */
export async function applyBundleStepsUnledgered(db: Db, compiled: CompiledTables): Promise<void> {
  for (const migration of bundlePlan(compiled).migrations)
    await db.transaction(async (tx) => {
      await migration.up(tx)
      await migration.backfill?.(tx)
    })
}

/** Every table in the database under a bundle's prefix. */
export async function bundleTablesIn(db: Db, id: string): Promise<string[]> {
  const prefix = bundlePrefix(id)
  const rows =
    db.dialect.name === 'sqlite'
      ? await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      : await db.query<{ name: string }>(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
        )
  // Compared as text rather than with LIKE, where `_` is a wildcard.
  return rows
    .map((row) => row.name)
    .filter((name) => name.startsWith(prefix))
    .sort()
}

/**
 * Drops every table under the bundle's prefix and forgets its state, so adding
 * it again starts its chain from the beginning. Ledgered as a `purge`.
 */
export async function purgeBundleTables(
  db: Db,
  id: string,
  options: { by?: string; stateKey: string },
): Promise<string[]> {
  const prefix = bundlePrefix(id)
  const tables = await bundleTablesIn(db, id)
  const started = performance.now()
  await db.transaction(async (tx) => {
    for (const table of tables)
      await tx.exec(guardStatement(id, prefix, `DROP TABLE ${tx.dialect.quote(table)}`))
  })
  await deleteKeyValue(db, options.stateKey)
  await recordInLedger(db, {
    name: `purge ${id}`,
    kind: 'purge',
    durationMs: Math.round(performance.now() - started),
    appliedBy: options.by ?? null,
    note: tables.length > 0 ? `dropped ${tables.join(', ')}` : 'no tables',
    bundle: id,
  })
  return tables
}
