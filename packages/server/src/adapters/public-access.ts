/**
 * Public access: protecting a branch by member group or by named member.
 *
 * The stored rules are names, not keys, because that is what a signed-in member
 * carries and what the render path compares against. Reading an entry back
 * therefore resolves each name to the member or group the editor should show —
 * and a name that no longer resolves simply drops out, which is exactly what a
 * renamed group means for the rule.
 */
import type {
  MemberGroupItem,
  MemberItem,
  PublicAccessInput,
  PublicAccessPort,
  PublicAccessResponse,
  PublicAccessStatus,
} from '@bunbraco/api-management'
import { ObjectTypes } from '@bunbraco/core'
import {
  type Db,
  MemberRepository,
  NodeRepository,
  type PublicAccessEntry,
  PublicAccessRepository,
} from '@bunbraco/data'

export function createPublicAccessPort(
  db: Db,
  options: { onChange?: () => void | Promise<void> } = {},
): PublicAccessPort {
  const access = new PublicAccessRepository(db)
  const members = new MemberRepository(db)
  const nodes = new NodeRepository(db)

  const isDocument = async (key: string) => {
    const node = await nodes.byKey(key)
    return node?.objectType === ObjectTypes.Document
  }

  const groupsNamed = async (names: readonly string[]): Promise<MemberGroupItem[]> => {
    const found: MemberGroupItem[] = []
    for (const name of names) {
      const rows = await db.query<{ unique_id: string; text: string | null }>(
        'SELECT unique_id, text FROM node WHERE node_object_type = ? AND text = ?',
        [ObjectTypes.MemberGroup, name],
      )
      const row = rows[0]
      if (row) found.push({ id: String(row.unique_id), name: String(row.text ?? ''), flags: [] })
    }
    return found
  }

  const membersNamed = async (usernames: readonly string[]): Promise<MemberItem[]> => {
    const found: MemberItem[] = []
    for (const username of usernames) {
      const member = await members.byUsername(username)
      if (member)
        found.push({
          id: member.key,
          memberType: {
            id: member.contentTypeKey,
            icon: member.contentTypeIcon ?? 'icon-user',
          },
          variants: [{ name: member.name, culture: null }],
          kind: 'Default',
          flags: [],
        })
    }
    return found
  }

  const toResponse = async (
    entry: PublicAccessEntry,
    requestedKey: string,
  ): Promise<PublicAccessResponse> => ({
    loginDocument: { id: entry.loginNodeKey },
    errorDocument: { id: entry.errorNodeKey },
    members: await membersNamed(entry.memberUserNames),
    groups: await groupsNamed(entry.memberGroupNames),
    isProtectedByAncestor: entry.nodeKey !== requestedKey.toLowerCase(),
  })

  return {
    async entry(documentKey, includeAncestors) {
      if (!(await isDocument(documentKey))) return { status: 'content-not-found' }
      const found = includeAncestors
        ? await access.entryFor(documentKey)
        : await access.byNodeKey(documentKey)
      if (!found) return { status: 'entry-not-found' }
      return { status: 'ok', entry: await toResponse(found, documentKey) }
    },

    async save(documentKey, input: PublicAccessInput): Promise<PublicAccessStatus> {
      if (!(await isDocument(documentKey))) return 'content-not-found'
      if (!(await isDocument(input.loginDocumentKey))) return 'login-node-not-found'
      if (!(await isDocument(input.errorDocumentKey))) return 'error-node-not-found'
      const saved = await access.save({
        nodeKey: documentKey,
        loginNodeKey: input.loginDocumentKey,
        errorNodeKey: input.errorDocumentKey,
        memberGroupNames: input.memberGroupNames,
        memberUserNames: input.memberUserNames,
      })
      if (!saved) return 'content-not-found'
      await options.onChange?.()
      return 'ok'
    },

    async remove(documentKey): Promise<PublicAccessStatus> {
      if (!(await isDocument(documentKey))) return 'content-not-found'
      if (!(await access.remove(documentKey))) return 'entry-not-found'
      await options.onChange?.()
      return 'ok'
    },
  }
}
