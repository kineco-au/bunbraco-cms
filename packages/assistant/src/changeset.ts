/**
 * A changeset: what the assistant has proposed, and nothing more than that.
 *
 * A proposal is a prepared Management API request — the operation, its path
 * parameters and its body — so approving one needs no translation and applying it
 * takes the same authorised path as the editor's own Save. Until then it is
 * inert: nothing here touches a database or a file.
 */
import type { SchemaProblem } from '@bunbraco/schema'
import type { ChangeKind } from './operations.ts'

export type ChangeStatus = 'proposed' | 'applied' | 'discarded' | 'failed'

/** Where a proposal came from, so a review can say who was driving. */
export type ChangeOrigin = 'backoffice' | 'mcp'

export interface ProposedChange {
  key: string
  kind: ChangeKind
  /** One line for the review list, written by the assistant. */
  summary: string
  /** Path parameters for the apply operation, e.g. `{ id }`. */
  params: Readonly<Record<string, string>>
  /** The request body the approval dispatches. */
  body: unknown
  /**
   * The entity as it was when proposed — a version key, or a hash of the source
   * for a file. Apply refuses when it no longer matches.
   */
  baseline: string | undefined
  /** A non-empty list blocks approval; the UI shows why. */
  problems: SchemaProblem[]
  status: ChangeStatus
  error: string | undefined
  createDate: string
}

export interface Changeset {
  key: string
  userKey: string
  title: string
  origin: ChangeOrigin
  changes: ProposedChange[]
  createDate: string
  updateDate: string
}

/** Persistence for changesets, implemented against the database by the server. */
export interface ChangesetStore {
  create(input: { userKey: string; title: string; origin: ChangeOrigin }): Promise<Changeset>
  load(key: string): Promise<Changeset | undefined>
  /** A user's changesets, most recently updated first. */
  listFor(userKey: string, limit?: number): Promise<Changeset[]>
  /**
   * One of the user's own changes, wherever it sits. Scoped to the user so that
   * knowing a key is not enough to approve somebody else's proposal, and a single
   * lookup so that an old changeset is as approvable as a new one.
   */
  changeFor(userKey: string, changeKey: string): Promise<ProposedChange | undefined>
  /** The user's newest changeset of this origin with something still awaiting review. */
  openFor(userKey: string, origin: ChangeOrigin): Promise<Changeset | undefined>
  append(changesetKey: string, change: ProposedChange): Promise<void>
  /**
   * Replaces what an approved change would send, after a person edited it. Only
   * the body: the kind and the path parameters stay as proposed, so an edit can
   * never turn a draft save into a different operation.
   */
  replaceBody(changeKey: string, body: unknown, problems: SchemaProblem[]): Promise<void>
  /** Records the outcome of an approval or a discard. */
  settle(
    changeKey: string,
    outcome: { status: ChangeStatus; error?: string | undefined },
  ): Promise<void>
  remove(key: string): Promise<void>
}

export const isApprovable = (change: ProposedChange): boolean =>
  change.status === 'proposed' && change.problems.length === 0

/**
 * What approving this item does, in the words the UI must use. A document lands
 * as a draft and stays invisible to visitors; a template and a type take effect
 * at once, because neither has a draft state.
 */
export function effectOf(kind: ChangeKind): string {
  switch (kind) {
    case 'document':
    case 'document-create':
      return 'Saves a draft. Nothing changes for visitors until you publish it.'
    case 'template':
    case 'template-create':
      return 'Goes live immediately — templates have no draft state.'
    default:
      return 'Changes the schema immediately, as saving the type in its workspace does.'
  }
}

/**
 * Schema proposals, which are TOML files rather than API requests.
 *
 * Implemented by the server, because reading and writing `schema/` and importing
 * it are the server's business; this package only ever holds the intent.
 */
export interface SchemaProposalPort {
  /** The file this alias would be written to, repository-relative. */
  fileFor(kind: string, alias: string): string
  /** The TOML on disk now, or undefined when the type does not exist yet. */
  read(kind: string, alias: string): Promise<string | undefined>
  /** Problems with the proposed TOML, checked against the rest of the schema. */
  validate(kind: string, alias: string, toml: string): Promise<SchemaProblem[]>
  /**
   * Writes it and imports it. Only an approval calls this, and only after the
   * caller's Settings access has been checked.
   */
  apply(
    kind: string,
    alias: string,
    toml: string,
  ): Promise<{ ok: boolean; error?: string; version?: string }>
}
