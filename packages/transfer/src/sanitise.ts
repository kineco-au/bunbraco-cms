/**
 * Anonymising a bundle before it is written (story 104, reused by 100's clone):
 * the structure travels, the people in it do not. It runs on what the export
 * gathered and before anything is serialised, so an unsanitised copy never
 * exists in the output.
 *
 * - Back-office users are removed; the destination makes one fresh local
 *   administrator. User groups stay, as structure.
 * - Members stay as placeholders — type, groups and approval kept — with name,
 *   username and email replaced, the password and every property value gone.
 * - Every email address in content, people and the dictionary is replaced, the
 *   same address by the same stand-in each time so references still agree.
 *
 * Tokens, sessions, external logins and form entries are never exported, so
 * there is nothing of theirs to remove. Code and schema are left alone: an
 * address in a template is the site's, not a person's.
 */
import type { BundleNode, BundleValue, ContentSet } from './model.ts'
import type { BundleMember, BundlePeople } from './people.ts'

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** The domain stand-ins use: reserved, so nothing is ever delivered to it. */
export const ANONYMISED_DOMAIN = 'example.invalid'

export interface SanitiseInput {
  set: ContentSet
  people?: BundlePeople
  /** The dictionary `.udt`, whose translations may hold addresses. */
  dictionary?: string
}

export interface SanitiseResult {
  set: ContentSet
  people: BundlePeople | undefined
  dictionary: string | undefined
  /** How many distinct email addresses were replaced. */
  emails: number
}

export function sanitise(input: SanitiseInput): SanitiseResult {
  const standIns = new Map<string, string>()
  const standInFor = (address: string): string => {
    const known = address.toLowerCase()
    let replacement = standIns.get(known)
    if (!replacement) {
      replacement = `person-${standIns.size + 1}@${ANONYMISED_DOMAIN}`
      standIns.set(known, replacement)
    }
    return replacement
  }
  const scrub = (text: string) =>
    text.replace(EMAIL, (address) =>
      address.toLowerCase().endsWith(`@${ANONYMISED_DOMAIN}`) ? address : standInFor(address),
    )
  const deep = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value)
    if (Array.isArray(value)) return value.map(deep)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]))
    return value
  }

  const usernames = new Map<string, string>()
  const node = (n: BundleNode): BundleNode => ({
    ...n,
    variants: deep(n.variants) as BundleNode['variants'],
    values: n.values.map((v: BundleValue) => ({ ...v, value: deep(v.value) })),
    ...(n.access
      ? {
          access: {
            ...n.access,
            // A protected page naming a member names their stand-in; one naming
            // someone who did not travel names nobody.
            ...(n.access.memberUserNames
              ? {
                  memberUserNames: n.access.memberUserNames.flatMap((name) => {
                    const standIn = usernames.get(name.toLowerCase())
                    return standIn ? [standIn] : []
                  }),
                }
              : {}),
          },
        }
      : {}),
  })

  const member = (m: BundleMember, index: number): BundleMember => {
    const n = index + 1
    standIns.set(m.email.toLowerCase(), `member-${n}@${ANONYMISED_DOMAIN}`)
    usernames.set(m.username.toLowerCase(), `member-${n}`)
    return {
      ...m,
      name: `Member ${n}`,
      username: `member-${n}`,
      email: `member-${n}@${ANONYMISED_DOMAIN}`,
      passwordHash: null,
      passwordConfig: null,
      values: [],
    }
  }

  // Members first, so an address that belongs to one maps to their stand-in
  // wherever content mentions it.
  const people = input.people
    ? {
        memberGroups: input.people.memberGroups,
        members: input.people.members.map(member),
        userGroups: input.people.userGroups,
        users: [],
      }
    : undefined
  for (const user of input.people?.users ?? []) standInFor(user.email)

  return {
    set: { ...input.set, nodes: input.set.nodes.map(node) },
    people,
    dictionary: input.dictionary === undefined ? undefined : scrub(input.dictionary),
    emails: standIns.size,
  }
}
