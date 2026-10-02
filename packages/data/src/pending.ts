/**
 * An element is pending on a node when the deployment that created it is newer
 * than the node, or its file says `since` a version the node has not reached.
 * The one place the rule lives. docs/09-schema-as-code.md, "since".
 */
import { compareStates, compareVersions, type NodeSchemaState } from './schema-state.ts'

export interface SinceMarkers {
  /** The `(version, revision)` of the state that created the row, when known. */
  since: NodeSchemaState | null
  /** The file's explicit `since`, when written. */
  sinceVersion: string | null
}

/** The state the element goes live in, or null when it is live on this node. */
export function pendingUntil(markers: SinceMarkers, node: NodeSchemaState): NodeSchemaState | null {
  if (markers.sinceVersion && compareVersions(markers.sinceVersion, node.version) > 0)
    return { version: markers.sinceVersion, revision: '0' }
  if (markers.since && compareStates(markers.since, node) > 0) return markers.since
  return null
}

export function isPending(markers: SinceMarkers, node: NodeSchemaState): boolean {
  return pendingUntil(markers, node) !== null
}
