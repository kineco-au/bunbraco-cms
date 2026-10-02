/**
 * Migration 008 — `member_property_type`: what a member may see and edit of
 * each member-type property, and whether it is sensitive. Umbraco's
 * `cmsMemberType` (`propertytypeId`, `memberCanEdit`, `viewOnProfile`,
 * `isSensitive`), snake-cased.
 */
import type { Db } from '../database.ts'
import type { Migration } from '../migrations.ts'
import { STATE_GROUP_PERMISSIONS } from './group-permissions.ts'

export const STATE_MEMBER_PROPERTY_TYPE = '{6f1d4a8e-0008-4c21-9d3a-8b1e5c7a2f08}'

export const memberPropertyTypeMigration: Migration = {
  from: STATE_GROUP_PERMISSIONS,
  to: STATE_MEMBER_PROPERTY_TYPE,
  name: 'AddMemberPropertyType',
  kind: 'expand',
  release: '0.3.0',
  async up(db: Db) {
    const t = db.dialect.types
    await db.exec(
      `CREATE TABLE member_property_type (
         property_type_id ${t.integer} PRIMARY KEY REFERENCES property_type (id),
         member_can_edit ${t.boolean} NOT NULL,
         member_can_view ${t.boolean} NOT NULL,
         is_sensitive ${t.boolean} NOT NULL
       )`,
    )
  },
}
