/**
 * The Members section.
 *
 * A member is a content node with a sign-in facet, so the content half of a save
 * is the same machinery documents use and the facet half is the `member` row.
 * Three things are ours to enforce here rather than in the repository:
 *
 * - **Uniqueness.** Umbraco refuses a duplicate username or e-mail; the columns
 *   are case-insensitive in both dialects, so "A@b.com" and "a@b.com" clash.
 * - **Sensitive values.** A member property marked sensitive is withheld from a
 *   user outside the Sensitive data group, compositions included.
 * - **Passwords.** Plaintext arrives here and nowhere deeper; a change of one
 *   rotates the security stamp, which ends the member's sessions.
 *
 * `kind` is always `Default`: Umbraco reports `Api` only for a Delivery API
 * client-credentials member and `ExternalOnly` only for one in its lightweight
 * external-member table, and we have neither.
 */
import type {
  MemberFilterCriteria,
  MemberItem,
  MemberPort,
  MemberResponse,
  Principal,
  SaveMember,
} from '@bunbraco/api-management'
import { hashPassword, passwordConfigJson, verifyPassword } from '@bunbraco/auth'
import {
  type ContentTypeAggregate,
  hasAccessToSensitiveData,
  normaliseUuid,
  type Page,
} from '@bunbraco/core'
import {
  ContentTypeRepository,
  type Db,
  type DocumentRepositoryOptions,
  type MemberCredentials,
  MemberRepository,
  type ValueIntake,
  WriteRejectedError,
} from '@bunbraco/data'

export interface MemberPortOptions extends DocumentRepositoryOptions {
  valueIntake?: ValueIntake
  /** How many failed sign-ins lock an account out; Umbraco's default is 5. */
  maxFailedPasswordAttempts?: number
}

const notFound = () => ({
  ok: false as const,
  reason: 'The member could not be found.',
  status: 404,
})

export function createMemberPort(db: Db, options: MemberPortOptions = {}): MemberPort {
  const members = new MemberRepository(db, options)
  const memberTypes = new ContentTypeRepository(db, { kind: 'member' })

  const userIdOf = async (principal: Principal): Promise<number | undefined> => {
    const rows = await db.query<{ id: number }>('SELECT id FROM user_account WHERE key = ?', [
      principal.id,
    ])
    return rows[0] ? Number(rows[0].id) : undefined
  }

  /** Sensitive aliases of a member type, following its compositions. */
  const sensitiveAliases = async (typeKey: string): Promise<Set<string>> => {
    const all = await memberTypes.all()
    const byKey = new Map(all.map((type) => [normaliseUuid(type.key), type]))
    const aliases = new Set<string>()
    const walk = (type: ContentTypeAggregate | undefined, seen = new Set<string>()) => {
      if (!type || seen.has(type.key)) return
      seen.add(type.key)
      for (const property of type.properties)
        if (property.isSensitive === true) aliases.add(property.alias)
      for (const composition of type.compositions)
        walk(byKey.get(normaliseUuid(composition.contentTypeKey)), seen)
    }
    walk(byKey.get(normaliseUuid(typeKey)))
    return aliases
  }

  const toResponse = async (
    member: MemberCredentials,
    viewer: Principal,
  ): Promise<MemberResponse | undefined> => {
    const content = await members.content.byKey(member.key)
    if (!content) return undefined
    const withheld = hasAccessToSensitiveData(viewer.groups)
      ? new Set<string>()
      : await sensitiveAliases(member.contentTypeKey)
    return {
      id: member.key,
      email: member.email,
      username: member.username,
      memberType: {
        id: member.contentTypeKey,
        icon: member.contentTypeIcon ?? 'icon-user',
        collection: content.contentTypeCollectionKey
          ? { id: content.contentTypeCollectionKey }
          : null,
      },
      isApproved: member.isApproved,
      isLockedOut: member.isLockedOut,
      // No second factor is offered yet, so no member has one enabled.
      isTwoFactorEnabled: false,
      failedPasswordAttempts: member.failedPasswordAttempts,
      lastLoginDate: member.lastLoginDate?.toISOString() ?? null,
      lastLockoutDate: member.lastLockoutDate?.toISOString() ?? null,
      lastPasswordChangeDate: member.lastPasswordChangeDate?.toISOString() ?? null,
      groups: await members.groupKeys(member.key),
      kind: 'Default',
      profileData: null,
      flags: [],
      values: content.values
        .filter((value) => !withheld.has(value.alias))
        .map((value) => ({
          alias: value.alias,
          culture: value.culture,
          segment: value.segment,
          value: value.value,
          editorAlias: value.editorAlias ?? '',
        })),
      variants: content.variants.map((variant) => ({
        culture: variant.culture,
        segment: variant.segment,
        name: variant.name,
        createDate: variant.createDate.toISOString(),
        updateDate: variant.updateDate.toISOString(),
      })),
    }
  }

  const toItem = (member: MemberCredentials): MemberItem => ({
    id: member.key,
    memberType: { id: member.contentTypeKey, icon: member.contentTypeIcon ?? 'icon-user' },
    variants: [{ name: member.name, culture: null }],
    kind: 'Default',
    flags: [],
  })

  const contentOf = (input: SaveMember, contentTypeKey: string) => ({
    key: input.key,
    contentTypeKey,
    componentKey: null,
    parentKey: null,
    values: input.values,
    variants:
      input.variants.length > 0
        ? input.variants
        : [{ culture: null, segment: null, name: input.username }],
  })

  /** Umbraco's duplicate checks, which the columns' case-insensitivity decides. */
  const duplicate = async (input: SaveMember, exceptKey?: string) => {
    if (await members.taken('username', input.username, exceptKey))
      return {
        ok: false as const,
        reason: 'Another member already uses this username.',
        status: 400,
      }
    if (await members.taken('email', input.email, exceptKey))
      return {
        ok: false as const,
        reason: 'Another member already uses this e-mail address.',
        status: 400,
      }
    return undefined
  }

  const failure = (error: unknown) => {
    if (error instanceof WriteRejectedError)
      return { ok: false as const, reason: error.message, status: 409 }
    throw error
  }

  return {
    async byKey(key, viewer) {
      const member = await members.byKey(key)
      return member ? toResponse(member, viewer) : undefined
    },

    validate: (input) => members.content.validate(contentOf(input, input.memberTypeKey), null),

    async create(input, principal) {
      const type = await memberTypes.byKey(input.memberTypeKey)
      if (!type)
        return { ok: false as const, reason: 'The member type could not be found.', status: 404 }
      const clash = await duplicate(input)
      if (clash) return clash
      try {
        const created = await members.create(
          { ...contentOf(input, type.key), userId: await userIdOf(principal) },
          {
            email: input.email,
            username: input.username,
            isApproved: input.isApproved,
            isLockedOut: input.isLockedOut,
            passwordHash: input.password ? await hashPassword(input.password) : null,
            passwordConfig: input.password ? passwordConfigJson() : null,
            groupKeys: input.groupKeys ?? [],
          },
        )
        return { ok: true as const, key: created.key }
      } catch (error) {
        return failure(error)
      }
    },

    async update(key, input, principal) {
      const existing = await members.byKey(key)
      if (!existing) return notFound()
      const clash = await duplicate(input, key)
      if (clash) return clash
      // Umbraco requires the current password only when the editor supplies one;
      // an administrator changing another member's password does not.
      if (input.oldPassword && !(await verifyPassword(input.oldPassword, existing.passwordHash)))
        return { ok: false as const, reason: 'The current password is not correct.', status: 400 }
      try {
        const updated = await members.update(
          key,
          { ...contentOf(input, existing.contentTypeKey), userId: await userIdOf(principal) },
          {
            email: input.email,
            username: input.username,
            isApproved: input.isApproved,
            isLockedOut: input.isLockedOut,
            passwordHash: input.password ? await hashPassword(input.password) : undefined,
            passwordConfig: input.password ? passwordConfigJson() : undefined,
            groupKeys: input.groupKeys,
          },
        )
        return updated ? { ok: true as const } : notFound()
      } catch (error) {
        return failure(error)
      }
    },

    remove: (key) => members.delete(key),

    async filter(criteria: MemberFilterCriteria, viewer): Promise<Page<MemberResponse>> {
      const page = await members.filter(criteria)
      const items: MemberResponse[] = []
      for (const member of page.items) {
        const response = await toResponse(member, viewer)
        if (response) items.push(response)
      }
      return { total: page.total, items }
    },

    async items(keys) {
      return (await members.items(keys)).map(toItem)
    },

    async search(query, paging) {
      const page = await members.search(query, paging)
      return { total: page.total, items: page.items.map(toItem) }
    },
  }
}
