/**
 * Member groups are plain `node` rows with the MemberGroup object type — no
 * table of their own, so this is the node repository with a name-uniqueness
 * rule on top, as Umbraco's `MemberGroupService` has.
 */
import type { MemberGroupPort, MemberGroupStatus } from '@bunbraco/api-management'
import { ObjectTypes, type Page, SystemNodes } from '@bunbraco/core'
import { type Db, NodeRepository } from '@bunbraco/data'

const TYPE = ObjectTypes.MemberGroup

export function createMemberGroupPort(db: Db): MemberGroupPort {
  const nodes = new NodeRepository(db)

  const named = async (name: string): Promise<{ key: string } | undefined> => {
    const rows = await db.query<{ unique_id: string }>(
      'SELECT n.unique_id FROM node n WHERE n.node_object_type = ? AND n.text = ?',
      [TYPE, name],
    )
    const key = rows[0]?.unique_id
    return key ? { key: String(key) } : undefined
  }

  const page = async (skip: number, take: number): Promise<Page<{ id: string; name: string }>> => {
    const result = await nodes.roots(TYPE, skip, take)
    return {
      total: result.total,
      items: result.items.map((row) => ({ id: row.key, name: row.text ?? '' })),
    }
  }

  return {
    list: (paging) => page(paging.skip, paging.take),

    async byKey(key) {
      const node = await nodes.byKey(key)
      if (!node || node.objectType !== TYPE) return undefined
      return { id: node.key, name: node.text ?? '' }
    },

    async items(keys) {
      const rows = await nodes.byKeys(keys)
      return rows
        .filter((row) => row.objectType === TYPE)
        .map((row) => ({ id: row.key, name: row.text ?? '', flags: [] }))
    },

    async tree(paging) {
      const result = await page(paging.skip, paging.take)
      return {
        total: result.total,
        // A flat list: no group ever has children, and none has a parent.
        items: result.items.map((item) => ({
          ...item,
          parent: null,
          hasChildren: false,
          flags: [],
        })),
      }
    },

    async create(input) {
      if (await named(input.name)) return { status: 'duplicate-name' }
      const node = await nodes.create({
        key: input.key,
        parentId: SystemNodes.Root,
        objectType: TYPE,
        text: input.name,
      })
      return { status: 'ok', key: node.key }
    },

    async rename(key, name): Promise<MemberGroupStatus> {
      const node = await nodes.byKey(key)
      if (!node || node.objectType !== TYPE) return 'not-found'
      const clash = await named(name)
      if (clash && clash.key !== node.key) return 'duplicate-name'
      await nodes.rename(node.id, name)
      return 'ok'
    },

    async remove(key): Promise<MemberGroupStatus> {
      const node = await nodes.byKey(key)
      if (!node || node.objectType !== TYPE) return 'not-found'
      await db.exec('DELETE FROM member_group_member WHERE member_group_id = ?', [node.id])
      await nodes.delete(node.id)
      return 'ok'
    },
  }
}
