/**
 * Migration 030 — a transfer run records the package it applied.
 *
 * A bundle's content arrives inside an npm package, so the run names the
 * package and the version that brought it. That is what tells the Installed
 * view whether a dependency's content has been applied here, and which release
 * of it. Nullable, because a run before this one has no package to name.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_BUNDLE_PACKAGE } from './bundle-package.ts'

export const STATE_TRANSFER_RUN_PACKAGE = '{6f1d4a8e-0030-4d2b-8e5c-7a1f9b3d6e30}'

export const transferRunPackageMigration: Migration = {
  from: STATE_BUNDLE_PACKAGE,
  to: STATE_TRANSFER_RUN_PACKAGE,
  name: 'AddTransferRunPackage',
  kind: 'expand',
  release: '0.10.0',
  async up(db: Db) {
    const ops = schemaOps(db)
    await ops.addColumn('content_transfer_run', 'package_name', db.dialect.types.varchar(214))
    await ops.addColumn('content_transfer_run', 'package_version', db.dialect.types.varchar(64))
  },
}
