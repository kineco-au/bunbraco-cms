/**
 * Migration 028 — a bundle's `templates` and `partial_views` become `components`.
 *
 * There is one root and one kind of file on disk now (`docs/05-rendering.md`),
 * so a bundle definition that still kept two lists was recording a distinction
 * the rest of the system no longer makes. The two are merged rather than one
 * dropped: both held component aliases, and which tree the backoffice picked
 * one from is not worth keeping.
 *
 * A new migration rather than an edit to 022, for the reason 027 gives: 022 has
 * already run on every database that exists.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { schemaOps } from '../schema-ops.ts'
import { STATE_BUNDLES } from './bundles-rename.ts'

export const STATE_BUNDLE_COMPONENTS = '{6f1d4a8e-0028-4a19-8c64-2f5b9d3e7a14}'

/** A column holding no aliases, however it was written. */
const EMPTY = (column: string) => `(${column} IS NULL OR ${column} IN ('', '[]'))`

export const bundleComponentsMigration: Migration = {
  from: STATE_BUNDLES,
  to: STATE_BUNDLE_COMPONENTS,
  name: 'MergeBundleTemplatesAndPartialViewsIntoComponents',
  kind: 'expand',
  release: '0.6.0',
  async up(db: Db) {
    const ops = schemaOps(db)
    // Renamed rather than added, so the existing values carry over without a
    // default and without a NOT NULL that an empty table could not satisfy.
    await ops.renameColumn('bundle', 'templates', 'components')
    // Both are JSON arrays of aliases, so the merge is `[a,b]` + `[c]` done as
    // text: drop the closing bracket from one, the opening from the other.
    // `||` is the concatenation operator in both dialects.
    await db.exec(
      `UPDATE bundle SET components = partial_views
        WHERE ${EMPTY('components')} AND NOT ${EMPTY('partial_views')}`,
    )
    await db.exec(
      `UPDATE bundle
          SET components = SUBSTR(components, 1, LENGTH(components) - 1) || ',' ||
                           SUBSTR(partial_views, 2)
        WHERE NOT ${EMPTY('components')} AND NOT ${EMPTY('partial_views')}`,
    )
    await ops.dropColumn('bundle', 'partial_views')
  },
}
