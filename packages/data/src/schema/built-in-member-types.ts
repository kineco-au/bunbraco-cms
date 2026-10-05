/**
 * Umbraco's one built-in member type, verbatim from its installer
 * (`DatabaseDataCreator`): alias "Member", icon `icon-user`, and no properties
 * — since Umbraco 18 the standard property stubs are empty and everything a
 * member always has (e-mail, username, approval, lockout) is a column on
 * `member`, not a property.
 *
 * It is a **system** type, like the Folder, Image and File media types: shipped
 * with the framework, ensured at every boot, exempt from schema retirement. A
 * site that wants its own member types adds files under `schema/member-types/`;
 * this one is what makes "create a member" work on a fresh install.
 */
import { type ContentTypeAggregate, SYSTEM_MEMBER_TYPE_KEY } from '@bunbraco/core'
import type { Db } from '../database.ts'
import { ContentTypeRepository } from '../repositories/content-types.ts'

export const SYSTEM_MEMBER_TYPE = {
  key: SYSTEM_MEMBER_TYPE_KEY,
  alias: 'Member',
  name: 'Member',
  icon: 'icon-user',
} as const

export function systemMemberTypeAggregate(): ContentTypeAggregate {
  return {
    key: SYSTEM_MEMBER_TYPE.key,
    alias: SYSTEM_MEMBER_TYPE.alias,
    name: SYSTEM_MEMBER_TYPE.name,
    description: null,
    icon: SYSTEM_MEMBER_TYPE.icon,
    allowedAsRoot: true,
    variesByCulture: false,
    variesBySegment: false,
    isElement: false,
    allowedInLibrary: false,
    collectionKey: null,
    cleanup: {
      preventCleanup: false,
      keepAllVersionsNewerThanDays: null,
      keepLatestVersionPerDayForDays: null,
    },
    containers: [],
    properties: [],
    compositions: [],
    allowedContentTypes: [],
    allowedComponentKeys: [],
    defaultComponentKey: null,
    parentKey: null,
  }
}

/**
 * Creates the "Member" member type if it is missing, by its fixed key; never
 * changes one that exists. Idempotent, and run at every boot.
 */
export async function ensureSystemMemberTypes(db: Db): Promise<string[]> {
  const repo = new ContentTypeRepository(db, { kind: 'member' })
  if (await repo.byKey(SYSTEM_MEMBER_TYPE.key)) return []
  await repo.save(systemMemberTypeAggregate())
  return [SYSTEM_MEMBER_TYPE.alias]
}
