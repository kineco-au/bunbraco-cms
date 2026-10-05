/**
 * Permission verbs.
 *
 * Umbraco 18 replaced the old single-letter action codes with verbs of the form
 * `Umb.<Entity>.<Action>`, stored one per row. Granular rows additionally carry a
 * node key and a context discriminator, so one table serves both per-document
 * ACLs and per-property field-level security.
 *
 * A verb bunbraco invented carries `Bunbraco.` instead, so the prefix says who
 * defined it. `Umb.` here means the verb is Umbraco's and means there what it
 * means here; `Bunbraco.` means there is nothing upstream to agree with.
 */
export const DocumentPermissions = {
  Read: 'Umb.Document.Read',
  Create: 'Umb.Document.Create',
  Update: 'Umb.Document.Update',
  Delete: 'Umb.Document.Delete',
  Publish: 'Umb.Document.Publish',
  Unpublish: 'Umb.Document.Unpublish',
  Move: 'Umb.Document.Move',
  Duplicate: 'Umb.Document.Duplicate',
  Sort: 'Umb.Document.Sort',
  Rollback: 'Umb.Document.Rollback',
  Notifications: 'Umb.Document.Notifications',
  Permissions: 'Umb.Document.Permissions',
  CultureAndHostnames: 'Umb.Document.CultureAndHostnames',
  PublicAccess: 'Umb.Document.PublicAccess',
  CreateBlueprint: 'Umb.Document.CreateBlueprint',
  PropertyValueRead: 'Umb.Document.PropertyValue.Read',
  PropertyValueWrite: 'Umb.Document.PropertyValue.Write',
  RecycleBinRestore: 'Umb.DocumentRecycleBin.Restore',
} as const

export type DocumentVerb = (typeof DocumentPermissions)[keyof typeof DocumentPermissions]

/**
 * Forms, which are four separate concerns on purpose.
 *
 * Designing a form is a developer's job and editing its entries is not, so
 * `Manage` and `EntriesView` are different grants. `EntriesSensitive` is
 * separate again because a field marked sensitive in the definition is withheld
 * from anyone without it, in the API rather than in the UI.
 *
 * `Bunbraco.`-prefixed because Umbraco has no forms in core: these name nothing
 * upstream, and wearing `Umb.` would have claimed they did.
 */
export const FormPermissions = {
  View: 'Bunbraco.Form.Read',
  Manage: 'Bunbraco.Form.Manage',
  EntriesView: 'Bunbraco.FormEntry.Read',
  EntriesManage: 'Bunbraco.FormEntry.Manage',
  EntriesSensitive: 'Bunbraco.FormEntry.Sensitive',
} as const

export type FormVerb = (typeof FormPermissions)[keyof typeof FormPermissions]

/** The discriminator on a granular permission row. */
export type PermissionContext = 'Document' | 'Element' | 'DocumentTypeProperty'

export const ADMIN_GROUP_ALIAS = 'admin'

/** The resolved permission set for a user, assembled from all their groups. */
export interface UserPermissions {
  isAdmin: boolean
  /** Verbs granted regardless of node. */
  global: ReadonlySet<string>
  /** Verbs granted only on specific nodes, keyed by node key. */
  granular: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Where a user may work in one tree: everywhere, or at and below the given
 * nodes. Neither means no access at all, not even to the root.
 */
export interface StartNodes {
  root: boolean
  keys: readonly string[]
}

export const ROOT_ACCESS: StartNodes = { root: true, keys: [] }

/**
 * Umbraco's path access: with root access everything, the recycle bin
 * included; otherwise a node at or below a start node, and never in the bin.
 * `chain` is the node's ancestor keys then its own, root first.
 */
export function hasPathAccess(
  start: StartNodes,
  chain: readonly string[],
  trashed: boolean,
): boolean {
  if (start.root) return true
  if (trashed) return false
  return start.keys.some((key) => chain.includes(key))
}

/** A start node's position: its ancestor keys then its own, root first; empty for the root. */
export type StartNodePath = readonly string[]

const within = (path: StartNodePath, ancestor: StartNodePath) =>
  ancestor.length <= path.length && ancestor.every((key, i) => path[i] === key)

/**
 * Umbraco's `CombineStartNodes`: the groups' start nodes keep the topmost, the
 * user's own keep the deepest, and each of the user's replaces any group start
 * node above or below it. Callers leave out nodes that no longer exist or are
 * in the recycle bin.
 */
export function combineStartNodes(
  group: readonly StartNodePath[],
  user: readonly StartNodePath[],
): StartNodes {
  let kept: StartNodePath[] = []
  for (const path of group) {
    if (kept.some((k) => within(path, k))) continue
    kept = kept.filter((k) => !within(k, path))
    kept.push(path)
  }
  let own: StartNodePath[] = []
  for (const path of user) {
    if (own.some((k) => within(k, path))) continue
    own = own.filter((k) => !within(path, k))
    own.push(path)
  }
  for (const path of own) {
    kept = kept.filter((k) => !within(path, k) && !within(k, path))
    kept.push(path)
  }
  return {
    root: kept.some((path) => path.length === 0),
    keys: kept.filter((path) => path.length > 0).map((path) => path[path.length - 1] as string),
  }
}

/** One group's verbs: its defaults, and the nodes it sets explicitly (an empty list denies all). */
export interface GroupGrant {
  key: string
  alias: string
  defaults: readonly string[]
  granular: ReadonlyMap<string, readonly string[]>
}

/**
 * Umbraco's `HasAccessToSensitiveData`: membership of the Sensitive data group.
 * Without it, values of member properties marked sensitive are withheld.
 */
export function hasAccessToSensitiveData(groups: ReadonlyArray<{ alias: string }>): boolean {
  return groups.some((group) => group.alias === 'sensitiveData')
}

/**
 * The verbs a user holds on a node, as Umbraco calculates them: for each group,
 * the nearest node on the path (the node itself first) that the group sets
 * explicitly replaces its defaults; the result is the union over groups.
 * `chain` is the node's ancestor keys then its own, root first; empty for the
 * root itself.
 */
export function permissionsForPath(
  groups: readonly GroupGrant[],
  chain: readonly string[],
): Set<string> {
  const verbs = new Set<string>()
  for (const group of groups) {
    let granted = group.defaults
    for (let i = chain.length - 1; i >= 0; i--) {
      const explicit = group.granular.get(chain[i] as string)
      if (explicit) {
        granted = explicit
        break
      }
    }
    for (const verb of granted) verbs.add(verb)
  }
  return verbs
}

/**
 * An administrator bypasses the permission tables entirely, matching Umbraco:
 * membership of the admin group is the check, not an exhaustive grant list.
 */
export function hasPermission(
  permissions: UserPermissions,
  verb: string,
  nodeKey?: string,
): boolean {
  if (permissions.isAdmin) return true
  if (permissions.global.has(verb)) return true
  if (!nodeKey) return false
  return permissions.granular.get(nodeKey)?.has(verb) === true
}
