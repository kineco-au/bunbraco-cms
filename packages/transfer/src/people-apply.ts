/**
 * A bundle's people, applied (story 071): planned by key, then written in the
 * content run's transaction and recorded on it, so a revert removes the people
 * it created. docs/content-transfer.md, "People".
 *
 * The same key is the same person: updated, keeping a password set or
 * re-hashed here. A different key whose e-mail or username is taken here is a
 * decision — take the bundle's details onto the person here, or leave it out.
 * Findings name people by key only.
 */
import { normaliseUuid, ObjectTypes, SystemNodes } from '@crombolo/core'
import {
  ContentTypeRepository,
  currentSchemaState,
  type Db,
  type Finding,
  MemberRepository,
  NodeRepository,
  type NodeSchemaState,
  type TransferRunRepository,
  UserGroupRepository,
  UserRepository,
} from '@crombolo/data'
import type { NodeResolutions, Resolution } from './check.ts'
import type { BundleMember, BundlePeople, BundleUser } from './people.ts'

export type PersonKind = 'member-group' | 'member' | 'user-group' | 'user'

export const PERSON_KINDS: readonly PersonKind[] = ['member-group', 'member', 'user-group', 'user']

export const isPersonKind = (kind: string): kind is PersonKind =>
  (PERSON_KINDS as readonly string[]).includes(kind)

/** What the import would do to one person or group. */
export interface PersonPlan {
  kind: PersonKind
  /** The bundle's key. */
  key: string
  action: 'create' | 'update' | 'unchanged' | 'skip'
  /** Where it lands here, when that is not its own key: matched by name, alias or answer. */
  localKey?: string
  /** The bundle's password replaces one set here: a new site's seeded administrator. */
  takePassword?: boolean
}

export interface PeoplePlan {
  findings: Finding[]
  plan: PersonPlan[]
  counts: Record<PersonKind, { create: number; update: number; skip: number }>
}

/** A hash set or re-hashed here, which an incoming one never replaces. */
const isLocalHash = (hash: string | null | undefined): boolean =>
  typeof hash === 'string' && hash.startsWith('$argon2')

const NOUN: Record<PersonKind, string> = {
  'member-group': 'member group',
  member: 'member',
  'user-group': 'user group',
  user: 'user',
}

const finding = (
  kind: Finding['kind'],
  code: string,
  subject: PersonKind,
  key: string,
  message: string,
): Finding => ({
  kind,
  code,
  subjectType: subject,
  subjectKey: key,
  subjectName: key,
  propertyAlias: null,
  culture: null,
  message,
  link: null,
})

const answerOf = (
  resolutions: Readonly<Record<string, NodeResolutions>>,
  key: string,
  all: Resolution | undefined,
): Resolution | undefined => resolutions[key]?.['*'] ?? all

/** Read-only: what applying these people here would do, and what needs a decision. */
export async function planPeople(
  db: Db,
  people: BundlePeople,
  options: {
    resolutions?: Readonly<Record<string, NodeResolutions>>
    resolveAll?: Resolution | undefined
    /** A user here the bundle's may take over without asking: a new site's seeded administrator. */
    adoptUsers?: boolean
  } = {},
): Promise<PeoplePlan> {
  const resolutions = options.resolutions ?? {}
  const findings: Finding[] = []
  const plan: PersonPlan[] = []
  const nodes = new NodeRepository(db)
  const members = new MemberRepository(db)
  const memberTypes = new ContentTypeRepository(db, { kind: 'member' })
  const users = new UserRepository(db)
  const userGroups = new UserGroupRepository(db)

  for (const group of people.memberGroups) {
    const here = await nodes.byKey(group.key)
    if (here && here.objectType === ObjectTypes.MemberGroup) {
      plan.push({
        kind: 'member-group',
        key: group.key,
        action: here.text === group.name ? 'unchanged' : 'update',
      })
      continue
    }
    const named = await memberGroupNamed(db, group.name)
    plan.push(
      named
        ? { kind: 'member-group', key: group.key, action: 'unchanged', localKey: named }
        : { kind: 'member-group', key: group.key, action: 'create' },
    )
  }

  for (const group of people.userGroups) {
    const here = (await userGroups.byKey(group.key)) ?? (await userGroups.byAlias(group.alias))
    // A group here is this site's to manage: its permissions are not rewritten
    // by a bundle, only its members added.
    plan.push(
      here
        ? { kind: 'user-group', key: group.key, action: 'unchanged', localKey: here.key }
        : { kind: 'user-group', key: group.key, action: 'create' },
    )
  }

  const decide = (kind: PersonKind, key: string, clashKey: string): PersonPlan | undefined => {
    const answer = answerOf(resolutions, key, options.resolveAll)
    if (answer === 'skip') return { kind, key, action: 'skip' }
    if (answer === 'take-bundle') return { kind, key, action: 'update', localKey: clashKey }
    findings.push(
      finding(
        'person',
        'person-conflict',
        kind,
        key,
        `the ${NOUN[kind]} ${key} in the bundle has an e-mail address or username that ${NOUN[kind]} ${clashKey} already has here`,
      ),
    )
    return undefined
  }

  const missingTypes = new Set<string>()
  for (const member of people.members) {
    if (!(await memberTypes.byAlias(member.memberTypeAlias)))
      missingTypes.add(member.memberTypeAlias)
    const here = await members.byKey(member.key)
    if (here) {
      plan.push({ kind: 'member', key: member.key, action: 'update' })
      continue
    }
    const clash =
      (await memberKeyWhere(db, 'email', member.email)) ??
      (await memberKeyWhere(db, 'login_name', member.username))
    if (!clash) {
      plan.push({ kind: 'member', key: member.key, action: 'create' })
      continue
    }
    const decided = decide('member', member.key, clash)
    if (decided) plan.push(decided)
  }
  for (const alias of missingTypes)
    findings.push(
      finding(
        'blocking',
        'missing-member-type',
        'member',
        alias,
        `no member type "${alias}" here — deploy schema/ before importing these members`,
      ),
    )

  for (const user of people.users) {
    if (await users.byKey(user.key)) {
      plan.push({
        kind: 'user',
        key: user.key,
        action: 'update',
        ...(options.adoptUsers ? { takePassword: true } : {}),
      })
      continue
    }
    const clash = (await users.byUserName(user.userName)) ?? (await users.byEmail(user.email))
    if (!clash) {
      plan.push({ kind: 'user', key: user.key, action: 'create' })
      continue
    }
    if (options.adoptUsers) {
      plan.push({
        kind: 'user',
        key: user.key,
        action: 'update',
        localKey: clash.key,
        takePassword: true,
      })
      findings.push(
        finding(
          'auto',
          'user-adopted',
          'user',
          user.key,
          `user ${clash.key} here becomes the bundle's user ${user.key}, with the password it had there`,
        ),
      )
      continue
    }
    const decided = decide('user', user.key, clash.key)
    if (decided) plan.push(decided)
  }

  const counts = Object.fromEntries(
    PERSON_KINDS.map((kind) => [kind, { create: 0, update: 0, skip: 0 }]),
  ) as PeoplePlan['counts']
  for (const entry of plan) if (entry.action !== 'unchanged') counts[entry.kind][entry.action] += 1
  for (const kind of PERSON_KINDS) {
    const c = counts[kind]
    if (c.create + c.update > 0)
      findings.push(
        finding(
          'auto',
          'people',
          kind,
          kind,
          `${c.create} ${NOUN[kind]}(s) created, ${c.update} updated${c.skip > 0 ? `, ${c.skip} left out` : ''}`,
        ),
      )
  }
  return { findings, plan, counts }
}

async function memberGroupNamed(db: Db, name: string): Promise<string | undefined> {
  const rows = await db.query<{ unique_id: string }>(
    'SELECT unique_id FROM node WHERE node_object_type = ? AND text = ?',
    [ObjectTypes.MemberGroup, name],
  )
  return rows[0] ? normaliseUuid(String(rows[0].unique_id)) : undefined
}

async function memberKeyWhere(
  db: Db,
  column: 'email' | 'login_name',
  value: string,
): Promise<string | undefined> {
  const rows = await db.query<{ unique_id: string }>(
    `SELECT n.unique_id FROM member m JOIN node n ON n.id = m.node_id WHERE LOWER(m.${column}) = LOWER(?)`,
    [value],
  )
  return rows[0] ? normaliseUuid(String(rows[0].unique_id)) : undefined
}

/** What one applied person was before: enough for a revert to remove what it created. */
export interface AppliedPerson {
  kind: PersonKind
  key: string
  action: 'create' | 'update'
}

/** Writes the plan, inside the caller's transaction, and records each on the run. */
export async function applyPeople(
  tx: Db,
  people: BundlePeople,
  plan: readonly PersonPlan[],
  run: { id: string; runs: TransferRunRepository; nodeState: NodeSchemaState; nodeId?: string },
): Promise<AppliedPerson[]> {
  const applied: AppliedPerson[] = []
  const planFor = new Map(plan.map((p) => [`${p.kind}|${p.key}`, p]))
  const nodes = new NodeRepository(tx)
  const record = async (kind: PersonKind, key: string, action: 'create' | 'update') => {
    applied.push({ kind, key, action })
    await run.runs.record({
      runId: run.id,
      nodeKey: key,
      kind,
      action,
      beforeEventId: null,
      beforePublishedEventId: null,
      eventId: null,
    })
  }

  // Member groups first: memberships name them.
  const memberGroupKey = new Map<string, string>()
  for (const group of people.memberGroups) {
    const p = planFor.get(`member-group|${group.key}`)
    if (!p || p.action === 'skip') continue
    memberGroupKey.set(group.key, p.localKey ?? group.key)
    if (p.action === 'create') {
      await nodes.create({
        key: group.key,
        parentId: SystemNodes.Root,
        objectType: ObjectTypes.MemberGroup,
        text: group.name,
      })
      await record('member-group', group.key, 'create')
    } else if (p.action === 'update') {
      const here = await nodes.byKey(group.key)
      if (here) await nodes.rename(here.id, group.name)
      await record('member-group', group.key, 'update')
    }
  }

  const userGroups = new UserGroupRepository(tx)
  const userGroupKey = new Map<string, string>()
  for (const group of people.userGroups) {
    const p = planFor.get(`user-group|${group.key}`)
    if (!p || p.action === 'skip') continue
    userGroupKey.set(group.alias, p.localKey ?? group.key)
    if (p.action !== 'create') continue
    const starts = async (key: string | null) =>
      key && (await nodes.byKey(key)) ? { root: false, key } : { root: false, key: null }
    const saved = await userGroups.save({
      key: group.key,
      alias: group.alias,
      name: group.name,
      description: null,
      icon: group.icon,
      sections: group.sections,
      languages: [],
      hasAccessToAllLanguages: group.hasAccessToAllLanguages || group.languages.length > 0,
      startNodes: {
        document: await starts(group.documentStartNodeKey),
        media: await starts(group.mediaStartNodeKey),
        element: { root: false, key: null },
      },
      permissions: group.permissions,
      granular: [],
    })
    if (saved !== 'saved') throw new Error(`The user group "${group.alias}" could not be created.`)
    await record('user-group', group.key, 'create')
  }

  const members = new MemberRepository(tx, { nodeState: run.nodeState, nodeId: run.nodeId })
  const memberTypes = new ContentTypeRepository(tx, { kind: 'member' })
  for (const member of people.members) {
    const p = planFor.get(`member|${member.key}`)
    if (!p || p.action === 'skip' || p.action === 'unchanged') continue
    const type = await memberTypes.byAlias(member.memberTypeAlias)
    if (!type)
      throw new Error(
        `No member type "${member.memberTypeAlias}", which the check should have refused.`,
      )
    const groupKeys = member.groupKeys.flatMap((k) => memberGroupKey.get(k) ?? [])
    const target = p.localKey ?? member.key
    const here = p.action === 'update' ? await members.byKey(target) : undefined
    const content = memberContent(
      member,
      type.key,
      target,
      here ? await currentValues(members, target) : [],
    )
    const identity = {
      email: member.email,
      username: member.username,
      isApproved: member.isApproved,
      isLockedOut: member.isLockedOut,
      groupKeys,
      ...(here && isLocalHash(here.passwordHash)
        ? {}
        : { passwordHash: member.passwordHash, passwordConfig: member.passwordConfig }),
    }
    if (here) {
      await members.update(target, content, identity)
      await record('member', target, 'update')
    } else {
      await members.create(content, identity)
      await record('member', member.key, 'create')
    }
  }

  const users = new UserRepository(tx)
  for (const user of people.users) {
    const p = planFor.get(`user|${user.key}`)
    if (!p || p.action === 'skip' || p.action === 'unchanged') continue
    const groupKeys = user.groupAliases.flatMap((alias) => userGroupKey.get(alias) ?? [])
    const target = p.localKey ?? user.key
    const here = p.action === 'update' ? await users.byKey(target) : undefined
    if (here) {
      const outcome = await users.update(target, {
        name: user.name,
        userName: user.userName,
        email: user.email,
        languageIsoCode: user.languageIsoCode,
        groupKeys: [...new Set([...here.groupKeys, ...groupKeys])],
        startNodes: here.startNodes,
      })
      if (outcome !== 'updated')
        throw new Error(`The user ${target} could not be updated (${outcome}).`)
      if (p.takePassword || !isLocalHash(await users.passwordHash(target)))
        await setUserPassword(tx, target, user)
      await record('user', target, 'update')
    } else {
      const created = await users.create({
        key: user.key,
        name: user.name,
        userName: user.userName,
        email: user.email,
        kind: 'Default',
        groupKeys,
        languageIsoCode: user.languageIsoCode,
      })
      if (!created) throw new Error(`The user ${user.key} could not be created.`)
      await setUserPassword(tx, user.key, user)
      await record('user', user.key, 'create')
    }
    await users.setApproved([target], !user.disabled)
  }
  return applied
}

async function setUserPassword(tx: Db, key: string, user: BundleUser): Promise<void> {
  await tx.exec('UPDATE user_account SET password_hash = ?, password_config = ? WHERE key = ?', [
    user.passwordHash,
    user.passwordConfig,
    normaliseUuid(key),
  ])
}

async function currentValues(members: MemberRepository, key: string) {
  return (await members.content.byKey(key))?.values ?? []
}

/** The member's content: the bundle's values over what is here. Pure. */
function memberContent(
  member: BundleMember,
  contentTypeKey: string,
  key: string,
  current: ReadonlyArray<{
    alias: string
    culture: string | null
    segment: string | null
    value: unknown
  }>,
) {
  const at = (alias: string, culture: string | null, segment: string | null) =>
    `${alias}|${culture ?? ''}|${segment ?? ''}`
  const merged = new Map(current.map((v) => [at(v.alias, v.culture, v.segment), v]))
  for (const v of member.values)
    merged.set(at(v.property, v.culture, v.segment), {
      alias: v.property,
      culture: v.culture,
      segment: v.segment,
      value: v.value,
    })
  return {
    key,
    contentTypeKey,
    componentKey: null,
    parentKey: null,
    values: [...merged.values()],
    variants: [{ culture: null, segment: null, name: member.name }],
  }
}

/** Removes what a run created, for a revert: members, users and groups. */
export async function removePerson(tx: Db, kind: PersonKind, key: string): Promise<boolean> {
  switch (kind) {
    case 'member':
      return new MemberRepository(tx).delete(key)
    case 'user': {
      const users = new UserRepository(tx)
      if (!(await users.byKey(key))) return false
      await users.delete(key)
      return true
    }
    case 'member-group': {
      const nodes = new NodeRepository(tx)
      const node = await nodes.byKey(key)
      if (!node || node.objectType !== ObjectTypes.MemberGroup) return false
      await tx.exec('DELETE FROM member_group_member WHERE member_group_id = ?', [node.id])
      await tx.exec('DELETE FROM node WHERE id = ?', [node.id])
      return true
    }
    case 'user-group': {
      const groups = new UserGroupRepository(tx)
      if (!(await groups.byKey(key))) return false
      return groups.delete(key).then(() => true)
    }
  }
}

/** This site's people, for a bundle: members and their groups, and users and theirs when asked. */
export async function exportPeople(
  db: Db,
  options: { members: boolean; users: boolean },
): Promise<BundlePeople> {
  const people: BundlePeople = { memberGroups: [], members: [], userGroups: [], users: [] }
  const state = await currentSchemaState(db)
  if (options.members) {
    const groups = await db.query<{ unique_id: string; text: string }>(
      'SELECT unique_id, text FROM node WHERE node_object_type = ? ORDER BY text',
      [ObjectTypes.MemberGroup],
    )
    people.memberGroups = groups.map((g) => ({
      key: normaliseUuid(String(g.unique_id)),
      name: String(g.text),
    }))
    const members = new MemberRepository(db, {
      nodeState: { version: state.version, revision: state.revision },
    })
    for (let skip = 0; ; skip += 500) {
      const page = await members.filter({ skip, take: 500 })
      for (const member of page.items) {
        const content = await members.content.byKey(member.key)
        people.members.push({
          key: member.key,
          name: member.name,
          memberTypeAlias: member.contentTypeAlias,
          email: member.email,
          username: member.username,
          isApproved: member.isApproved,
          isLockedOut: member.isLockedOut,
          passwordHash: member.passwordHash,
          passwordConfig: member.passwordConfig,
          groupKeys: await members.groupKeys(member.key),
          values: (content?.values ?? []).map((v) => ({
            property: v.alias,
            culture: v.culture,
            segment: v.segment,
            editor: v.editorAlias ?? '',
            value: v.value,
          })),
        })
      }
      if (skip + 500 >= page.total) break
    }
  }
  if (options.users) {
    const groups = await new UserGroupRepository(db).all()
    people.userGroups = groups.map((g) => ({
      key: g.key,
      alias: g.alias,
      name: g.name,
      icon: g.icon,
      sections: g.sections,
      permissions: g.permissions,
      hasAccessToAllLanguages: g.hasAccessToAllLanguages,
      languages: g.languages,
      documentStartNodeKey: g.startNodes.document.key,
      mediaStartNodeKey: g.startNodes.media.key,
    }))
    const aliasOf = new Map(groups.map((g) => [g.key, g.alias]))
    const users = new UserRepository(db)
    for (const user of await users.all()) {
      if (user.kind !== 'Default') continue
      const [row] = await db.query<{
        password_hash: string | null
        password_config: string | null
      }>('SELECT password_hash, password_config FROM user_account WHERE id = ?', [user.id])
      people.users.push({
        key: user.key,
        name: user.name,
        userName: user.userName,
        email: user.email,
        languageIsoCode: user.languageIsoCode,
        disabled: !user.isApproved,
        passwordHash: row?.password_hash ?? null,
        passwordConfig: row?.password_config ?? null,
        groupAliases: user.groupKeys.flatMap((k) => aliasOf.get(k) ?? []),
      })
    }
  }
  return people
}
