/**
 * Migration 025 — the form permission verbs, for databases seeded before they
 * existed. `docs/18-forms.md`.
 *
 * The same shape as migration 007: granting what the seed now grants, so an
 * upgraded site does not have a Forms section nobody can open. Idempotent, and
 * it never takes a verb away.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_FORM_WORKFLOWS } from './form-workflows.ts'
import { grantBuiltInPermissions } from './seed.ts'

export const STATE_FORM_PERMISSIONS = '{6f1d4a8e-0025-4e72-9a55-3d7c1b8e4f02}'

export const formPermissionsMigration: Migration = {
  from: STATE_FORM_WORKFLOWS,
  to: STATE_FORM_PERMISSIONS,
  name: 'GrantFormPermissions',
  kind: 'expand',
  release: '0.5.0',
  // Only the verbs: the `forms` section alias has been seeded on the admin and
  // editor groups all along — Umbraco seeds it too — so there is nothing to add
  // there. What was missing is a section to render, and that is code.
  up: (db: Db) => grantBuiltInPermissions(db),
}
