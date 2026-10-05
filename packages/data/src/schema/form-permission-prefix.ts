/**
 * Migration 026 — the form verbs move from `Umb.` to `Bunbraco.`.
 *
 * Migration 025 granted them under `Umb.Form.*` and `Umb.FormEntry.*`, which
 * claimed they were Umbraco's. They are not: Umbraco has no forms in core, so
 * nothing upstream defines them and the prefix was a lie a reader could not
 * check. Every database seeded or upgraded since has the old spelling stored.
 *
 * A rewrite rather than a re-grant, so a verb an administrator removed by hand
 * stays removed. `grantBuiltInPermissions` would have put it back.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_FORM_PERMISSIONS } from './form-permissions.ts'

export const STATE_FORM_PERMISSION_PREFIX = '{6f1d4a8e-0026-4e72-9a55-3d7c1b8e4f02}'

/** Old spelling to new, for every verb migration 025 could have written. */
export const RENAMED_FORM_VERBS: ReadonlyArray<readonly [string, string]> = [
  ['Umb.Form.Read', 'Bunbraco.Form.Read'],
  ['Umb.Form.Manage', 'Bunbraco.Form.Manage'],
  ['Umb.FormEntry.Read', 'Bunbraco.FormEntry.Read'],
  ['Umb.FormEntry.Manage', 'Bunbraco.FormEntry.Manage'],
  ['Umb.FormEntry.Sensitive', 'Bunbraco.FormEntry.Sensitive'],
]

export const formPermissionPrefixMigration: Migration = {
  from: STATE_FORM_PERMISSIONS,
  to: STATE_FORM_PERMISSION_PREFIX,
  name: 'PrefixFormPermissionsWithBunbraco',
  kind: 'expand',
  release: '0.5.0',
  up: async (db: Db) => {
    for (const [before, after] of RENAMED_FORM_VERBS) {
      // The delete first: a group holding both spellings would otherwise break
      // the row's uniqueness on the way through.
      await db.exec(
        `DELETE FROM user_group_permission
         WHERE permission = ? AND user_group_key IN (
           SELECT user_group_key FROM user_group_permission WHERE permission = ?
         )`,
        [before, after],
      )
      await db.exec('UPDATE user_group_permission SET permission = ? WHERE permission = ?', [
        after,
        before,
      ])
    }
  },
}
