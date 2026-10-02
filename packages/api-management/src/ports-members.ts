/**
 * Members and the groups they belong to. The response types come from the
 * generated contract, so an implementation that drifts from the wire shape is a
 * compile error rather than a broken editor.
 */
import type { ResponseOf } from '@bunbraco/contracts'
import type { DocumentValidationError, DocumentValue, Page, SkipTake } from '@bunbraco/core'
import type { PortFailure } from './ports-content.ts'
import type { Principal } from './router.ts'

export type MemberGroupResponse = ResponseOf<'GetMemberGroupById'>
export type MemberGroupItem = ResponseOf<'GetItemMemberGroup'>[number]
export type MemberGroupTreeItem = ResponseOf<'GetTreeMemberGroupRoot'>['items'][number]

/** A name already taken is Umbraco's only failure here besides a missing group. */
export type MemberGroupStatus = 'ok' | 'not-found' | 'duplicate-name'

export type MemberResponse = ResponseOf<'GetMemberById'>
export type MemberItem = ResponseOf<'GetItemMember'>[number]

/**
 * What a create or a save carries. `password` is plaintext here and hashed by
 * the adapter: hashing belongs to `@bunbraco/auth`, and a handler should not be
 * able to store one by accident.
 */
export interface SaveMember {
  key: string
  memberTypeKey: string
  email: string
  username: string
  password?: string | null
  oldPassword?: string | null
  isApproved: boolean
  isLockedOut: boolean
  isTwoFactorEnabled: boolean
  groupKeys: string[] | undefined
  values: DocumentValue[]
  variants: Array<{ culture: string | null; segment: string | null; name: string }>
}

export interface MemberFilterCriteria extends SkipTake {
  memberTypeKey?: string | null
  memberGroupName?: string | null
  isApproved?: boolean
  isLockedOut?: boolean
  filter?: string
  orderBy?: string
  orderDirection?: 'Ascending' | 'Descending'
}

export interface MemberPort {
  byKey(key: string, viewer: Principal): Promise<MemberResponse | undefined>
  /** The rules the server would enforce on a save, for the editor to show first. */
  validate(input: SaveMember): Promise<DocumentValidationError[]>
  create(input: SaveMember, principal: Principal): Promise<{ ok: true; key: string } | PortFailure>
  update(key: string, input: SaveMember, principal: Principal): Promise<{ ok: true } | PortFailure>
  remove(key: string): Promise<boolean>
  /** The Members collection. */
  filter(criteria: MemberFilterCriteria, viewer: Principal): Promise<Page<MemberResponse>>
  items(keys: readonly string[]): Promise<MemberItem[]>
  search(
    query: string,
    options: { allowedMemberTypeKeys: readonly string[] } & SkipTake,
  ): Promise<Page<MemberItem>>
}

export type PublicAccessResponse = ResponseOf<'GetDocumentByIdPublicAccess'>

/**
 * Why a public-access write was refused, in Umbraco's own vocabulary — the
 * client keys its messages off these.
 */
export type PublicAccessStatus =
  | 'ok'
  | 'content-not-found'
  | 'login-node-not-found'
  | 'error-node-not-found'
  | 'entry-not-found'

export interface PublicAccessInput {
  loginDocumentKey: string
  errorDocumentKey: string
  memberGroupNames: string[]
  memberUserNames: string[]
}

export interface PublicAccessPort {
  /**
   * The entry protecting a document. `includeAncestors` follows the branch up,
   * which is how the editor tells "protected here" from "protected above".
   */
  entry(
    documentKey: string,
    includeAncestors: boolean,
  ): Promise<{ status: PublicAccessStatus; entry?: PublicAccessResponse }>
  save(documentKey: string, input: PublicAccessInput): Promise<PublicAccessStatus>
  remove(documentKey: string): Promise<PublicAccessStatus>
}

export interface MemberGroupPort {
  list(paging: SkipTake): Promise<Page<MemberGroupResponse>>
  byKey(key: string): Promise<MemberGroupResponse | undefined>
  items(keys: readonly string[]): Promise<MemberGroupItem[]>
  tree(paging: SkipTake): Promise<Page<MemberGroupTreeItem>>
  create(input: {
    key?: string
    name: string
  }): Promise<{ status: MemberGroupStatus; key?: string }>
  rename(key: string, name: string): Promise<MemberGroupStatus>
  remove(key: string): Promise<MemberGroupStatus>
}
