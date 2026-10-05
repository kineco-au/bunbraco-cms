/**
 * Migration 027 — `created_package` becomes `bundle`.
 *
 * The table was named after Umbraco's `umbracoCreatedPackageSchema`, which it
 * mirrors column for column. What it holds is a bundle definition
 * (`docs/17-bundles.md`), and the backoffice now says so, so the table does too.
 *
 * A rename rather than an edit to migration 022: 022 has already run on every
 * database that exists, and rewriting it would leave those sites with a table
 * the code no longer looks for and no migration to tell them so.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_FORM_PERMISSION_PREFIX } from './form-permission-prefix.ts'

export const STATE_BUNDLES = '{6f1d4a8e-0027-4e72-9a55-3d7c1b8e4f02}'

export const bundlesRenameMigration: Migration = {
  from: STATE_FORM_PERMISSION_PREFIX,
  to: STATE_BUNDLES,
  name: 'RenameCreatedPackageToBundle',
  kind: 'expand',
  release: '0.5.0',
  async up(db: Db) {
    await db.exec('ALTER TABLE created_package RENAME TO bundle')
    // Neither dialect carries an index name through a table rename, so the
    // unique name constraint is dropped and rebuilt rather than left reading
    // `ux_created_package_name` on a table that no longer exists.
    await db.exec('DROP INDEX ux_created_package_name')
    await db.exec('CREATE UNIQUE INDEX ux_bundle_name ON bundle (name)')
  },
}
