/**
 * What authorization needs from the database: where nodes sit in their trees,
 * and each signed-in user's combined start nodes, group verbs and languages.
 */
import type { NodeChain, NodeLookup, Principal } from '@bunbraco/api-management'
import { combineStartNodes, normaliseUuid, ObjectTypes } from '@bunbraco/core'
import { type Db, fromDbBool, UserRepository } from '@bunbraco/data'

const inList = (values: readonly unknown[]) => values.map(() => '?').join(', ')

async function chains(
  db: Db,
  rows: Array<{ id: number; unique_id: string; path: string; trashed: unknown }>,
): Promise<Map<string, NodeChain>> {
  const ids = [
    ...new Set(
      rows.flatMap((r) =>
        String(r.path)
          .split(',')
          .map(Number)
          .filter((id) => id > 0),
      ),
    ),
  ]
  const keys = new Map<number, string>()
  if (ids.length > 0)
    for (const row of await db.query<{ id: number; unique_id: string }>(
      `SELECT id, unique_id FROM node WHERE id IN (${inList(ids)})`,
      ids,
    ))
      keys.set(Number(row.id), normaliseUuid(String(row.unique_id)))
  return new Map(
    rows.map((row) => [
      normaliseUuid(String(row.unique_id)),
      {
        chain: String(row.path)
          .split(',')
          .map(Number)
          .filter((id) => id > 0)
          .flatMap((id) => {
            const key = keys.get(id)
            return key ? [key] : []
          }),
        trashed: fromDbBool(row.trashed),
      },
    ]),
  )
}

export function createNodeLookup(db: Db): NodeLookup {
  const byKeys = async (objectType: string, keys: readonly string[]) => {
    const wanted = keys.filter((k) => /^[0-9a-f-]{32,36}$/i.test(k)).map(normaliseUuid)
    if (wanted.length === 0) return new Map<string, NodeChain>()
    return chains(
      db,
      await db.query(
        `SELECT id, unique_id, path, trashed FROM node
         WHERE node_object_type = ? AND unique_id IN (${inList(wanted)})`,
        [objectType, ...wanted],
      ),
    )
  }
  return {
    documents: (keys) => byKeys(ObjectTypes.Document, keys),
    media: (keys) => byKeys(ObjectTypes.Media, keys),
    async documentDescendants(key) {
      const node = (
        await db.query<{ path: string }>('SELECT path FROM node WHERE unique_id = ?', [
          normaliseUuid(key),
        ])
      )[0]
      if (!node) return []
      return [
        ...(
          await chains(
            db,
            await db.query(
              'SELECT id, unique_id, path, trashed FROM node WHERE node_object_type = ? AND path LIKE ?',
              [ObjectTypes.Document, `${node.path},%`],
            ),
          )
        ).values(),
      ]
    },
    async versionDocument(versionId) {
      const id = Number(versionId)
      if (!Number.isInteger(id)) return undefined
      const row = (
        await db.query<{ unique_id: string }>(
          'SELECT n.unique_id FROM content_version cv JOIN node n ON n.id = cv.node_id WHERE cv.id = ?',
          [id],
        )
      )[0]
      return row ? normaliseUuid(String(row.unique_id)) : undefined
    },
  }
}

/** A user's languages, combined start nodes per tree, and group verbs. */
export async function loadAccess(
  db: Db,
  userId: number,
): Promise<Pick<Principal, 'languages' | 'startNodes' | 'groups'>> {
  const data = await new UserRepository(db).access(userId)
  return {
    languages: data.languages,
    groups: data.groups,
    startNodes: {
      document: combineStartNodes(data.groupStartNodes.document, data.userStartNodes.document),
      media: combineStartNodes(data.groupStartNodes.media, data.userStartNodes.media),
      element: combineStartNodes(data.groupStartNodes.element, data.userStartNodes.element),
    },
  }
}
