/**
 * Migration 029 — a created bundle records the npm package it is written as.
 *
 * Every bundle is an npm package (`docs/bundles.md`), so the Created view's
 * download needs a package name and version. Umbraco's package definition has
 * neither, so they live here, beside the columns the contract does name. Both
 * are nullable: an unset name or version is derived when the bundle is built.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_BUNDLE_COMPONENTS } from './bundle-components.ts'

export const STATE_BUNDLE_PACKAGE = '{6f1d4a8e-0029-4c5e-9a17-3d8b2e6f4c29}'

export const bundlePackageMigration: Migration = {
  from: STATE_BUNDLE_COMPONENTS,
  to: STATE_BUNDLE_PACKAGE,
  name: 'AddBundlePackageNameAndVersion',
  kind: 'expand',
  release: '0.10.0',
  async up(db: Db) {
    const ops = schemaOps(db)
    await ops.addColumn('bundle', 'package_name', db.dialect.types.varchar(214))
    await ops.addColumn('bundle', 'package_version', db.dialect.types.varchar(64))
  },
}
