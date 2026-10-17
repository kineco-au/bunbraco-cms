/**
 * The media tree, for the bulk commands (story 153): its folders by name, what
 * a file's extension makes it, and the repository and file store an upload
 * goes through, so an imported file is placed exactly as the back office
 * places one.
 */
import { ObjectTypes, SystemNodes } from '@crombolo/core'
import {
  currentSchemaState,
  type Db,
  DocumentRepository,
  describeRefFailure,
  NodeRepository,
  type NodeRow,
  resolveNodeRef,
} from '@crombolo/data'
import {
  type CromboloConfig,
  createFileIntake,
  createMediaPort,
  MediaFileStore,
  mediaStoreFor,
} from '@crombolo/server'
import { CliError } from '../errors.ts'

export async function openMedia(db: Db, config: CromboloConfig) {
  const files = new MediaFileStore(await mediaStoreFor(config))
  const state = await currentSchemaState(db)
  const options = {
    nodeState: { version: state.version, revision: state.revision },
    nodeId: `cli:${config.nodeId}`,
  }
  return {
    files,
    nodes: new NodeRepository(db),
    repo: new DocumentRepository(db, {
      ...options,
      kind: 'media',
      valueIntake: createFileIntake(files),
    }),
    // For the rules alone — which type takes which file — not for writing: a
    // write through the port tells the cluster once per item.
    port: createMediaPort(db, files, options),
  }
}

export type MediaTree = Awaited<ReturnType<typeof openMedia>>

/** The node a `--under` names, or the root. */
export async function mediaParent(db: Db, ref: string | undefined): Promise<NodeRow | null> {
  if (!ref) return null
  const resolved = await resolveNodeRef(db, [ObjectTypes.Media], ref)
  if (!resolved.ok) throw new CliError('not_found', describeRefFailure(ref, resolved))
  return resolved.node
}

/** The media directly under a node, by name. */
export async function childrenByName(
  tree: MediaTree,
  parent: NodeRow | null,
): Promise<Map<string, NodeRow>> {
  const page = await tree.nodes.children(
    parent?.id ?? SystemNodes.Root,
    ObjectTypes.Media,
    0,
    Number.MAX_SAFE_INTEGER,
  )
  return new Map(page.items.map((node) => [node.text ?? '', node]))
}

export const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
