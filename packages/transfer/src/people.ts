/**
 * A bundle's people (story 071): member groups, members, user groups and
 * users, in the bundle's `people/` directory — always sealed (`seal.ts`). The
 * manifest says how many of each, never who.
 * docs/content-transfer.md, "People".
 */
import type { BundleValue } from './model.ts'
import { openBytes, type Seal, sealBytes } from './seal.ts'

export interface BundleMemberGroup {
  key: string
  name: string
}

export interface BundleMember {
  key: string
  name: string
  memberTypeAlias: string
  email: string
  username: string
  isApproved: boolean
  isLockedOut: boolean
  /** As the source stored it, with its algorithm marker; null for none. */
  passwordHash: string | null
  passwordConfig: string | null
  groupKeys: string[]
  values: BundleValue[]
}

export interface BundleUserGroup {
  key: string
  alias: string
  name: string
  icon: string | null
  sections: string[]
  /** Default permission verbs, e.g. `Umb.Document.Read`. */
  permissions: string[]
  hasAccessToAllLanguages: boolean
  languages: string[]
  documentStartNodeKey: string | null
  mediaStartNodeKey: string | null
}

export interface BundleUser {
  key: string
  name: string
  userName: string
  email: string
  languageIsoCode: string | null
  disabled: boolean
  passwordHash: string | null
  passwordConfig: string | null
  groupAliases: string[]
}

export interface BundlePeople {
  memberGroups: BundleMemberGroup[]
  members: BundleMember[]
  userGroups: BundleUserGroup[]
  users: BundleUser[]
}

export const EMPTY_PEOPLE: BundlePeople = {
  memberGroups: [],
  members: [],
  userGroups: [],
  users: [],
}

/** What the manifest says of a bundle's people: counts, never who. */
export interface PeopleBlock {
  counts: { memberGroups: number; members: number; userGroups: number; users: number }
  /** Every sealed file, in path order. */
  paths: string[]
}

export const PEOPLE_DIR = 'people'

const MEMBER_GROUPS = `${PEOPLE_DIR}/member-groups.json`
const USER_GROUPS = `${PEOPLE_DIR}/user-groups.json`
const memberPath = (key: string) => `${PEOPLE_DIR}/members/${key}.json`
const userPath = (key: string) => `${PEOPLE_DIR}/users/${key}.json`

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

/** People sealed under the bundle's seal: the files, and the manifest's block. */
export function sealPeople(
  people: BundlePeople,
  { key }: Seal,
): { files: Array<{ path: string; bytes: Uint8Array }>; block: PeopleBlock } {
  const plain: Array<{ path: string; bytes: Buffer }> = [
    { path: MEMBER_GROUPS, bytes: json(people.memberGroups) },
    { path: USER_GROUPS, bytes: json(people.userGroups) },
    ...people.members.map((m) => ({ path: memberPath(m.key), bytes: json(m) })),
    ...people.users.map((u) => ({ path: userPath(u.key), bytes: json(u) })),
  ].sort((a, b) => a.path.localeCompare(b.path))
  const files = plain.map((file) => ({
    path: file.path,
    bytes: sealBytes(key, file.path, file.bytes),
  }))
  return {
    files,
    block: {
      counts: {
        memberGroups: people.memberGroups.length,
        members: people.members.length,
        userGroups: people.userGroups.length,
        users: people.users.length,
      },
      paths: files.map((f) => f.path),
    },
  }
}

/** A bundle's people, opened with its key; `SealedFileError` for a file altered or moved. */
export function openPeople(
  block: PeopleBlock,
  files: ReadonlyMap<string, Uint8Array>,
  key: Buffer,
): BundlePeople {
  const read = <T>(path: string): T => {
    const sealed = files.get(path)
    if (!sealed) throw new Error(`${path} is missing from the bundle's people.`)
    return JSON.parse(openBytes(key, path, sealed).toString('utf8')) as T
  }
  const out: BundlePeople = {
    memberGroups: block.paths.includes(MEMBER_GROUPS) ? read(MEMBER_GROUPS) : [],
    userGroups: block.paths.includes(USER_GROUPS) ? read(USER_GROUPS) : [],
    members: [],
    users: [],
  }
  for (const path of block.paths) {
    if (path.startsWith(`${PEOPLE_DIR}/members/`)) out.members.push(read<BundleMember>(path))
    if (path.startsWith(`${PEOPLE_DIR}/users/`)) out.users.push(read<BundleUser>(path))
  }
  const counts = block.counts
  if (
    out.members.length !== counts.members ||
    out.users.length !== counts.users ||
    out.memberGroups.length !== counts.memberGroups ||
    out.userGroups.length !== counts.userGroups
  )
    throw new Error("The bundle's people do not match the counts its manifest gives.")
  return out
}

/** A manifest's people block read without trusting it: undefined when absent or malformed. Pure. */
export function parsePeopleBlock(raw: unknown): PeopleBlock | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const block = raw as Record<string, unknown>
  const counts = block.counts as Record<string, unknown> | undefined
  if (!counts || !Array.isArray(block.paths)) return undefined
  const paths = (block.paths as unknown[]).filter(
    (p): p is string =>
      typeof p === 'string' && p.startsWith(`${PEOPLE_DIR}/`) && !p.split('/').includes('..'),
  )
  const count = (name: string) => (Number.isInteger(counts[name]) ? (counts[name] as number) : 0)
  return {
    counts: {
      memberGroups: count('memberGroups'),
      members: count('members'),
      userGroups: count('userGroups'),
      users: count('users'),
    },
    paths: paths.sort(),
  }
}
