/**
 * Umbraco's members, member groups, users and user groups → a bundle's people
 * (story 071), each password hash kept with its algorithm marker so it still
 * verifies here and is re-hashed on the next sign-in.
 */
import { ObjectTypes } from '@crombolo/core'
import type {
  BundleMember,
  BundlePeople,
  BundleUser,
  BundleUserGroup,
  BundleValue,
} from '@crombolo/transfer'
import { editorValue, type ValueRow } from './content.ts'
import type { Findings } from './findings.ts'
import type { ConvertedSchema } from './schema.ts'
import { key, type Source } from './source.ts'

export interface PeopleOptions {
  members: boolean
  users: boolean
}

const truthy = (value: unknown): boolean => value === 1 || value === true || value === '1'
const text = (value: unknown): string | null =>
  value === null || value === undefined || value === '' ? null : String(value)

export function convertPeople(
  source: Source,
  schema: ConvertedSchema,
  findings: Findings,
  options: PeopleOptions,
): BundlePeople {
  const people: BundlePeople = { memberGroups: [], members: [], userGroups: [], users: [] }
  const nodeKeys = new Map(
    source
      .all<{ id: number; key: string }>('SELECT id, uniqueId AS key FROM umbracoNode')
      .map((row) => [Number(row.id), key(row.key)]),
  )
  if (options.members) convertMembers(source, schema, nodeKeys, people)
  if (options.users) convertUsers(source, nodeKeys, people)

  findings.some({
    class: 'migrates',
    code: 'members',
    title: 'Members',
    detail:
      'With their groups and their passwords, which keep working and are re-hashed the first time each member signs in. They travel encrypted.',
    count: people.members.length,
  })
  findings.some({
    class: 'migrates',
    code: 'users',
    title: 'Backoffice users',
    detail:
      'With their groups and their passwords, which keep working and are re-hashed the first time each user signs in. They travel encrypted.',
    count: people.users.length,
  })
  return people
}

function convertMembers(
  source: Source,
  schema: ConvertedSchema,
  nodeKeys: ReadonlyMap<number, string>,
  people: BundlePeople,
): void {
  people.memberGroups = source
    .all<{ key: string; name: string }>(
      `SELECT uniqueId AS key, "text" AS name FROM umbracoNode
       WHERE nodeObjectType = ? COLLATE NOCASE AND trashed = 0 ORDER BY "text"`,
      ObjectTypes.MemberGroup,
    )
    .map((row) => ({ key: key(row.key), name: row.name }))
  if (!source.has('cmsMember')) return

  const groupsOf = new Map<number, string[]>()
  if (source.has('cmsMember2MemberGroup'))
    for (const row of source.all<{ member: number; group: number }>(
      'SELECT Member AS member, MemberGroup AS "group" FROM cmsMember2MemberGroup',
    )) {
      const group = nodeKeys.get(Number(row.group))
      if (!group) continue
      const list = groupsOf.get(Number(row.member)) ?? []
      list.push(group)
      groupsOf.set(Number(row.member), list)
    }

  const rows = source.all<{
    id: number
    name: string | null
    contentTypeId: number
    versionId: number | null
    email: string
    login: string
    password: string | null
    passwordConfig: string | null
    isApproved: unknown
    isLockedOut: unknown
  }>(
    `SELECT n.id AS id, n."text" AS name, c.contentTypeId AS contentTypeId, cv.id AS versionId,
            m.Email AS email, m.LoginName AS login, m.Password AS password,
            m.passwordConfig AS passwordConfig, m.isApproved AS isApproved, m.isLockedOut AS isLockedOut
     FROM cmsMember m
     JOIN umbracoNode n ON n.id = m.nodeId
     JOIN umbracoContent c ON c.nodeId = n.id
     LEFT JOIN umbracoContentVersion cv ON cv.nodeId = n.id AND cv."current" = 1
     ORDER BY n.id`,
  )
  const versions = new Set(
    rows.flatMap((row) => (row.versionId === null ? [] : [Number(row.versionId)])),
  )
  const valuesByVersion = new Map<number, ValueRow[]>()
  for (const row of source.all<ValueRow>(
    `SELECT versionId, propertyTypeId, languageId, segment, intValue, decimalValue, dateValue,
            varcharValue, textValue FROM umbracoPropertyData`,
  )) {
    const version = Number(row.versionId)
    if (!versions.has(version)) continue
    const list = valuesByVersion.get(version) ?? []
    list.push(row)
    valuesByVersion.set(version, list)
  }

  for (const row of rows) {
    const type = schema.contentTypes.get(Number(row.contentTypeId))
    const memberKey = nodeKeys.get(Number(row.id))
    if (!type || !memberKey) continue
    const values: BundleValue[] = []
    for (const cell of row.versionId === null
      ? []
      : (valuesByVersion.get(Number(row.versionId)) ?? [])) {
      const property = schema.propertyTypes.get(Number(cell.propertyTypeId))
      if (!property) continue
      const value = editorValue(property.dataType.editor, property.dataType.dbType, cell)
      if (value === null || value === undefined) continue
      values.push({
        property: property.alias,
        culture: null,
        segment: cell.segment ?? null,
        editor: property.dataType.editor,
        value,
      })
    }
    const member: BundleMember = {
      key: memberKey,
      name: row.name ?? row.login,
      memberTypeAlias: type.alias,
      email: row.email,
      username: row.login,
      isApproved: truthy(row.isApproved),
      isLockedOut: truthy(row.isLockedOut),
      passwordHash: text(row.password),
      passwordConfig: text(row.passwordConfig),
      groupKeys: groupsOf.get(Number(row.id)) ?? [],
      values,
    }
    people.members.push(member)
  }
}

function convertUsers(
  source: Source,
  nodeKeys: ReadonlyMap<number, string>,
  people: BundlePeople,
): void {
  if (!source.has('umbracoUserGroup') || !source.has('umbracoUser')) return
  const groupRows = source.all<{
    id: number
    key: string | null
    alias: string
    name: string
    icon: string | null
    allLanguages: unknown
    startContentId: number | null
    startMediaId: number | null
  }>(
    `SELECT id, "key" AS key, userGroupAlias AS alias, userGroupName AS name, icon,
            hasAccessToAllLanguages AS allLanguages, startContentId, startMediaId
     FROM umbracoUserGroup ORDER BY id`,
  )
  const appsOf = new Map<number, string[]>()
  if (source.has('umbracoUserGroup2App'))
    for (const row of source.all<{ group: number; app: string }>(
      'SELECT userGroupId AS "group", app FROM umbracoUserGroup2App ORDER BY app',
    ))
      appsOf.set(Number(row.group), [...(appsOf.get(Number(row.group)) ?? []), row.app])
  const permissionsOf = new Map<string, string[]>()
  if (source.has('umbracoUserGroup2Permission'))
    for (const row of source.all<{ group: string; permission: string }>(
      'SELECT userGroupKey AS "group", permission FROM umbracoUserGroup2Permission ORDER BY permission',
    ))
      permissionsOf.set(key(row.group), [
        ...(permissionsOf.get(key(row.group)) ?? []),
        row.permission,
      ])
  const languagesOf = new Map<number, string[]>()
  if (source.has('umbracoUserGroup2Language') && source.has('umbracoLanguage'))
    for (const row of source.all<{ group: number; iso: string }>(
      `SELECT g.userGroupId AS "group", l.languageISOCode AS iso
       FROM umbracoUserGroup2Language g JOIN umbracoLanguage l ON l.id = g.languageId`,
    ))
      languagesOf.set(Number(row.group), [...(languagesOf.get(Number(row.group)) ?? []), row.iso])

  const aliasOf = new Map<number, string>()
  for (const row of groupRows) {
    // Before Umbraco 14 a group had no key: one derived from its alias is stable across runs.
    const groupKey = row.key ? key(row.key) : derivedKey(`user-group:${row.alias}`)
    aliasOf.set(Number(row.id), row.alias)
    const group: BundleUserGroup = {
      key: groupKey,
      alias: row.alias,
      name: row.name,
      icon: row.icon,
      sections: appsOf.get(Number(row.id)) ?? [],
      permissions: permissionsOf.get(groupKey) ?? [],
      hasAccessToAllLanguages: truthy(row.allLanguages),
      languages: languagesOf.get(Number(row.id)) ?? [],
      documentStartNodeKey:
        row.startContentId === null ? null : (nodeKeys.get(Number(row.startContentId)) ?? null),
      mediaStartNodeKey:
        row.startMediaId === null ? null : (nodeKeys.get(Number(row.startMediaId)) ?? null),
    }
    people.userGroups.push(group)
  }

  const groupsOf = new Map<number, string[]>()
  if (source.has('umbracoUser2UserGroup'))
    for (const row of source.all<{ user: number; group: number }>(
      'SELECT userId AS "user", userGroupId AS "group" FROM umbracoUser2UserGroup',
    )) {
      const alias = aliasOf.get(Number(row.group))
      if (alias) groupsOf.set(Number(row.user), [...(groupsOf.get(Number(row.user)) ?? []), alias])
    }

  const hasKind = source.hasColumn('umbracoUser', 'kind')
  for (const row of source.all<{
    id: number
    key: string | null
    name: string
    login: string
    email: string
    language: string | null
    disabled: unknown
    password: string | null
    passwordConfig: string | null
    kind: number | null
  }>(
    `SELECT id, "key" AS key, userName AS name, userLogin AS login, userEmail AS email,
            userLanguage AS language, userDisabled AS disabled, userPassword AS password,
            passwordConfig, ${hasKind ? 'kind' : 'NULL AS kind'}
     FROM umbracoUser ORDER BY id`,
  )) {
    // API users sign in with client credentials, which do not travel.
    if (Number(row.kind ?? 0) !== 0) continue
    const user: BundleUser = {
      key: row.key ? key(row.key) : derivedKey(`user:${row.login}`),
      name: row.name,
      userName: row.login,
      email: row.email,
      languageIsoCode: row.language,
      disabled: truthy(row.disabled),
      passwordHash: text(row.password),
      passwordConfig: text(row.passwordConfig),
      groupAliases: groupsOf.get(Number(row.id)) ?? [],
    }
    people.users.push(user)
  }
}

/** A uuid-shaped key from a name, the same every run. Pure. */
function derivedKey(name: string): string {
  const hex = new Bun.CryptoHasher('sha256').update(name).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
