/**
 * Trees as a user with start nodes sees them, as Umbraco's
 * `UserStartNodeTreeControllerBase` serves them: at the root, their start
 * nodes and the top-level ancestors of deeper ones; below a place they cannot
 * reach, only the way down to a start node. Nodes on that way are shown with
 * `noAccess`. With root access nothing is filtered.
 */
import { type DocumentTreeItem, hasPathAccess, type Page, type StartNodes } from '@bunbraco/core'
import type { SkipTake } from '../ports-content.ts'

export interface TreeSource {
  treeRoot(paging: SkipTake): Promise<Page<DocumentTreeItem>>
  treeChildren(parentKey: string, paging: SkipTake): Promise<Page<DocumentTreeItem>>
  items(keys: readonly string[]): Promise<DocumentTreeItem[]>
}

export interface VisibleItem {
  item: DocumentTreeItem
  noAccess: boolean
}

const EVERYTHING: SkipTake = { skip: 0, take: 1_000_000 }
const chainOf = (item: DocumentTreeItem) => [...item.ancestorKeys, item.key]

async function startChains(start: StartNodes, source: TreeSource): Promise<string[][]> {
  return (await source.items(start.keys)).filter((i) => !i.isTrashed).map(chainOf)
}

/** Only what lies on the way to a start node; skip and take no longer apply. */
async function onTheWay(
  start: StartNodes,
  source: TreeSource,
  items: readonly DocumentTreeItem[],
): Promise<Page<VisibleItem>> {
  const chains = await startChains(start, source)
  const visible = items
    .filter((item) => chains.some((chain) => chain.includes(item.key)))
    .map((item) => ({ item, noAccess: !start.keys.includes(item.key) }))
  return { total: visible.length, items: visible }
}

const all = (page: Page<DocumentTreeItem>): Page<VisibleItem> => ({
  total: page.total,
  items: page.items.map((item) => ({ item, noAccess: false })),
})

export async function visibleRoot(
  start: StartNodes,
  source: TreeSource,
  paging: SkipTake,
): Promise<Page<VisibleItem>> {
  if (start.root) return all(await source.treeRoot(paging))
  return onTheWay(start, source, (await source.treeRoot(EVERYTHING)).items)
}

export async function visibleChildren(
  start: StartNodes,
  source: TreeSource,
  parentKey: string,
  paging: SkipTake,
): Promise<Page<VisibleItem>> {
  if (start.root) return all(await source.treeChildren(parentKey, paging))
  const [parent] = await source.items([parentKey])
  if (parent && hasPathAccess(start, chainOf(parent), parent.isTrashed))
    return all(await source.treeChildren(parentKey, paging))
  return onTheWay(start, source, (await source.treeChildren(parentKey, EVERYTHING)).items)
}

/** A siblings window, cut down to the way to a start node when the parent is out of reach. */
export async function visibleSiblings(
  start: StartNodes,
  source: TreeSource,
  window: { items: DocumentTreeItem[]; totalBefore: number; totalAfter: number },
): Promise<{ items: VisibleItem[]; totalBefore: number; totalAfter: number }> {
  const whole = { ...window, items: window.items.map((item) => ({ item, noAccess: false })) }
  if (start.root) return whole
  const parentKey = window.items[0]?.parentKey
  if (parentKey) {
    const [parent] = await source.items([parentKey])
    if (parent && hasPathAccess(start, chainOf(parent), parent.isTrashed)) return whole
  }
  const visible = await onTheWay(start, source, window.items)
  return { items: visible.items, totalBefore: 0, totalAfter: 0 }
}
