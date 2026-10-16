/**
 * Replacing a site with a whole-site file (story 105): what has to be true
 * before it starts, and what the site has that the file does not.
 *
 * `--replace` recycles content and media the file does not carry, so a revert
 * brings them back, and keeps the site's people. `--replace-all` deletes them,
 * and the members and users the file does not carry too.
 */
import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { discoverBundles } from '@crombolo/backoffice-host'
import {
  currentSchemaState,
  type Db,
  DocumentRepository,
  MemberRepository,
  ObjectTypes,
  TransferRunRepository,
  UserRepository,
} from '@crombolo/data'
import type { BundleManifest, BundlePeople, ContentSet } from '@crombolo/transfer'

export type ReplaceMode = 'replace' | 'replace-all'

/**
 * The server bundles a file needs and this site lacks, or has older, each
 * named with the version wanted.
 */
export function requiresProblems(manifest: BundleManifest, siteDir: string): string[] {
  const required = Object.entries(manifest.requires ?? {})
  if (required.length === 0) return []
  const installed = new Map(
    discoverBundles(siteDir).bundles.map((found) => [found.packageName, found.version]),
  )
  const problems: string[] = []
  for (const [name, version] of required) {
    const here = installed.get(name)
    if (!here) problems.push(`the file needs ${name}@${version}, which this site does not have`)
    else if (Bun.semver.order(here, version) < 0)
      problems.push(`the file needs ${name}@${version}, and this site has ${here}`)
  }
  return problems
}

/** Whether the file's people include someone who can administer the back office. */
export function carriesAdministrator(people: BundlePeople | undefined): boolean {
  return (people?.users ?? []).some((user) => !user.disabled && user.groupAliases.includes('admin'))
}

const PRUNED_KINDS = [
  { objectType: ObjectTypes.Document, kind: 'document' },
  { objectType: ObjectTypes.Media, kind: 'media' },
  { objectType: ObjectTypes.Element, kind: 'element' },
  { objectType: ObjectTypes.DocumentBlueprint, kind: 'blueprint' },
] as const

export interface PrunedNode {
  key: string
  kind: (typeof PRUNED_KINDS)[number]['kind']
  head: number | undefined
  published: number | undefined
}

/**
 * Takes out what the site has and the file does not: the topmost of each such
 * branch, recycled or deleted, inside the caller's transaction. Answers what
 * was recycled, for the run to record so its revert can bring it back.
 */
export async function pruneSite(
  tx: Db,
  set: ContentSet,
  mode: ReplaceMode,
  nodeId: string,
): Promise<PrunedNode[]> {
  const inFile = new Set(set.nodes.map((node) => node.key.toLowerCase()))
  const state = await currentSchemaState(tx)
  const nodeState = { version: state.version, revision: state.revision }
  const pruned: PrunedNode[] = []
  for (const { objectType, kind } of PRUNED_KINDS) {
    const rows = await tx.query<{ id: number; unique_id: string; parent_id: number }>(
      'SELECT id, unique_id, parent_id FROM node WHERE node_object_type = ? AND trashed = ?',
      [objectType, tx.dialect.boolValue(false)],
    )
    const leaving = rows.filter((row) => !inFile.has(String(row.unique_id).toLowerCase()))
    const leavingIds = new Set(leaving.map((row) => Number(row.id)))
    // The top of each branch: recycling or deleting it takes its children too.
    const tops = leaving.filter((row) => !leavingIds.has(Number(row.parent_id)))
    const repo = new DocumentRepository(tx, { kind, nodeState, nodeId, inTreeLock: true })
    for (const row of tops) {
      const key = String(row.unique_id)
      if (mode === 'replace-all') {
        await repo.delete(key)
        continue
      }
      const markers = await repo.eventMarkers(key)
      await repo.moveToRecycleBin(key)
      pruned.push({ key, kind, head: markers?.head, published: markers?.published })
    }
  }
  return pruned
}

/** Members and users the file does not carry, deleted: `--replace-all` only. */
export async function prunePeople(tx: Db, people: BundlePeople | undefined): Promise<void> {
  const members = new Set((people?.members ?? []).map((m) => m.key.toLowerCase()))
  const users = new Set((people?.users ?? []).map((u) => u.key.toLowerCase()))
  const state = await currentSchemaState(tx)
  const memberRepo = new MemberRepository(tx, {
    nodeState: { version: state.version, revision: state.revision },
  })
  const memberRows = await tx.query<{ unique_id: string }>(
    'SELECT unique_id FROM node WHERE node_object_type = ?',
    [ObjectTypes.Member],
  )
  for (const row of memberRows)
    if (!members.has(String(row.unique_id).toLowerCase()))
      await memberRepo.delete(String(row.unique_id))
  const userRepo = new UserRepository(tx)
  for (const row of await tx.query<{ key: string }>('SELECT key FROM user_account'))
    if (!users.has(String(row.key).toLowerCase())) await userRepo.delete(String(row.key))
}

/** Records what a replace recycled on its run, so `content revert` brings it back. */
export async function recordPruned(tx: Db, runId: string, pruned: PrunedNode[]): Promise<void> {
  const runs = new TransferRunRepository(tx)
  for (const node of pruned)
    await runs.record({
      runId,
      nodeKey: node.key,
      kind: node.kind,
      action: 'recycle',
      beforeEventId: node.head ?? null,
      beforePublishedEventId: node.published ?? null,
      eventId: null,
    })
}

export interface ReplaceSummary {
  /** What the site has that the file does not, by kind: recycled, or deleted. */
  leaving: Record<string, number>
  /** Files in the site's folders that the file does not carry. */
  filesRemoved: string[]
  /** Members and users `--replace-all` would delete. */
  people: { members: number; users: number }
}

/** Read-only: what replacing this site with the file would take out. */
export async function replaceSummary(
  db: Db,
  set: ContentSet,
  carriedPaths: ReadonlySet<string>,
  folders: ReadonlyArray<{ section: string; dir: string }>,
  mode: ReplaceMode,
): Promise<ReplaceSummary> {
  const inFile = new Set(set.nodes.map((node) => node.key.toLowerCase()))
  const leaving: Record<string, number> = {}
  for (const { objectType, kind } of PRUNED_KINDS) {
    const rows = await db.query<{ unique_id: string }>(
      'SELECT unique_id FROM node WHERE node_object_type = ? AND trashed = ?',
      [objectType, db.dialect.boolValue(false)],
    )
    const count = rows.filter((row) => !inFile.has(String(row.unique_id).toLowerCase())).length
    if (count > 0) leaving[kind] = count
  }
  const filesRemoved: string[] = []
  for (const { section, dir } of folders) {
    if (!existsSync(dir)) continue
    for (const path of new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true })) {
      const bundlePath = `${section}/${path.split(sep).join('/')}`
      if (!carriedPaths.has(bundlePath)) filesRemoved.push(join(dir, path))
    }
  }
  let people = { members: 0, users: 0 }
  if (mode === 'replace-all') {
    const members = new Set((set.people?.members ?? []).map((m) => m.key.toLowerCase()))
    const users = new Set((set.people?.users ?? []).map((u) => u.key.toLowerCase()))
    const memberRows = await db.query<{ unique_id: string }>(
      'SELECT unique_id FROM node WHERE node_object_type = ?',
      [ObjectTypes.Member],
    )
    const userRows = await db.query<{ key: string }>('SELECT key FROM user_account')
    people = {
      members: memberRows.filter((r) => !members.has(String(r.unique_id).toLowerCase())).length,
      users: userRows.filter((r) => !users.has(String(r.key).toLowerCase())).length,
    }
  }
  return { leaving, filesRemoved, people }
}
