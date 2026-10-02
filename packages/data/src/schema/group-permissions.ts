/**
 * Migration 007 — the built-in groups' default permission verbs, for databases
 * seeded before the seed granted them. Without them the backoffice hides
 * Create, Publish, Delete and every other permission-gated action.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_RECYCLE_BIN } from './recycle-bin.ts'
import { grantBuiltInPermissions } from './seed.ts'

export const STATE_GROUP_PERMISSIONS = '{6f1d4a8e-0007-4c21-9d3a-8b1e5c7a2f07}'

export const groupPermissionsMigration: Migration = {
  from: STATE_RECYCLE_BIN,
  to: STATE_GROUP_PERMISSIONS,
  name: 'GrantBuiltInGroupPermissions',
  kind: 'expand',
  release: '0.3.0',
  up: (db: Db) => grantBuiltInPermissions(db),
}
