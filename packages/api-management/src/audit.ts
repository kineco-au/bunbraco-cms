/**
 * What each backoffice change writes to the audit log. Derived from the
 * operation's name, as server events are, with the exceptions listed; every
 * contract operation that changes something is either mapped here or listed as
 * not a change, and a test holds that to the whole contract. docs/audit-log.md.
 */
export type AuditCategory =
  | 'content'
  | 'media'
  | 'member'
  | 'schema'
  | 'settings'
  | 'user'
  | 'permission'
  | 'sign-in'
  | 'system'

export interface AuditPlan {
  category: AuditCategory
  entityType: string
  action: string
  /** Where the item's key is: a path parameter, the created resource, or the request body. */
  key: 'param' | 'generated' | 'none' | ((body: unknown) => string[])
  /** Other items the change names in its body, listed in the entry's detail: a group's users. */
  related?: { entityType: string; label: string; keys: (body: unknown) => string[] }
}

/** One entry the router is about to write, before the item is named. */
export interface AuditDraft {
  category: AuditCategory
  action: string
  entityType: string
  entityKey: string | null
  detail?: string | null
}

export interface AuditRecord extends AuditDraft {
  entityName: string | null
  userKey: string | null
  userName: string | null
  ipAddress: string | null
  forwardedFor: string | null
}

/** Where the router writes. The server adapts the data layer's `AuditLog` to this. */
export interface AuditSink {
  /** Names an item, re-keying it when it belongs to another (a version to its page). */
  describe(
    entityType: string,
    key: string,
  ): Promise<{ entityType: string; entityKey: string; entityName: string | null }>
  record(entries: AuditRecord[]): Promise<void>
}

/** Writes that change nothing anyone would answer for: checks, previews, a user's own UI state. */
export const NOT_AUDITED = new Set([
  'DeletePreview',
  'DeleteTemporaryFileById',
  'DeleteUserDataById',
  'PostDocumentTypeAvailableCompositions',
  'PostDynamicRootQuery',
  'PostHealthCheckGroupByNameCheck',
  'PostInstallValidateDatabase',
  'PostMediaTypeAvailableCompositions',
  'PostMemberTypeAvailableCompositions',
  'PostSecurityForgotPassword',
  'PostSecurityForgotPasswordVerify',
  'PostTemplateQueryExecute',
  'PostTemporaryFile',
  'PostUpgradeAuthorize',
  'PostUserData',
  'PostUserInviteVerify',
  'PutUserData',
])

const ids = (field: string) => (body: unknown) => {
  const list = (body as Record<string, unknown> | null)?.[field]
  return Array.isArray(list)
    ? list.map((item) => (item as { id?: unknown })?.id).filter((id) => typeof id === 'string')
    : []
}

const listed = (body: unknown) =>
  Array.isArray(body)
    ? body.map((item) => (item as { id?: unknown })?.id).filter((id) => typeof id === 'string')
    : []

const GROUPS = { entityType: 'UserGroup', label: 'Groups', keys: ids('userGroupIds') }
const USERS = { entityType: 'User', label: 'Users', keys: listed }

const reference = (field: string) => (body: unknown) => {
  const id = ((body as Record<string, unknown> | null)?.[field] as { id?: unknown } | null)?.id
  return typeof id === 'string' ? [id] : []
}

const EXCEPTIONS: Record<string, AuditPlan> = {
  DeleteUser: { category: 'user', entityType: 'User', action: 'Delete', key: ids('userIds') },
  PostUserDisable: { category: 'user', entityType: 'User', action: 'Disable', key: ids('userIds') },
  PostUserEnable: { category: 'user', entityType: 'User', action: 'Enable', key: ids('userIds') },
  PostUserUnlock: { category: 'user', entityType: 'User', action: 'Unlock', key: ids('userIds') },
  PostUserInvite: { category: 'user', entityType: 'User', action: 'Invite', key: 'generated' },
  PostUserInviteResend: {
    category: 'user',
    entityType: 'User',
    action: 'ResendInvite',
    key: reference('user'),
  },
  PostUserInviteCreatePassword: {
    category: 'user',
    entityType: 'User',
    action: 'AcceptInvite',
    key: reference('user'),
  },
  PostSecurityForgotPasswordReset: {
    category: 'user',
    entityType: 'User',
    action: 'ResetPasswordByLink',
    key: reference('user'),
  },
  PostUserSetUserGroups: {
    category: 'permission',
    entityType: 'User',
    action: 'SetUserGroups',
    key: ids('userIds'),
    related: GROUPS,
  },
  PostUser: {
    category: 'user',
    entityType: 'User',
    action: 'Create',
    key: 'generated',
    related: GROUPS,
  },
  PutUserById: {
    category: 'user',
    entityType: 'User',
    action: 'Save',
    key: 'param',
    related: GROUPS,
  },
  PostUserGroupByIdUsers: {
    category: 'permission',
    entityType: 'UserGroup',
    action: 'AddUsers',
    key: 'param',
    related: USERS,
  },
  DeleteUserGroupByIdUsers: {
    category: 'permission',
    entityType: 'UserGroup',
    action: 'RemoveUsers',
    key: 'param',
    related: USERS,
  },
  DeleteUserGroup: {
    category: 'permission',
    entityType: 'UserGroup',
    action: 'Delete',
    key: ids('userGroupIds'),
  },
  PutDocumentSort: {
    category: 'content',
    entityType: 'Document',
    action: 'Sort',
    key: reference('parent'),
  },
  PutMediaSort: {
    category: 'media',
    entityType: 'Media',
    action: 'Sort',
    key: reference('parent'),
  },
  PutDocumentRootSortChildren: {
    category: 'content',
    entityType: 'Document',
    action: 'Sort',
    key: 'none',
  },
  PutMediaRootSortChildren: { category: 'media', entityType: 'Media', action: 'Sort', key: 'none' },
  PutUserCurrentProfile: {
    category: 'user',
    entityType: 'User',
    action: 'SaveProfile',
    key: 'none',
  },
  PostUserCurrentChangePassword: {
    category: 'user',
    entityType: 'User',
    action: 'ChangePassword',
    key: 'none',
  },
  PostUserCurrentAvatar: { category: 'user', entityType: 'User', action: 'SetAvatar', key: 'none' },
  DeleteUserCurrentAvatar: {
    category: 'user',
    entityType: 'User',
    action: 'RemoveAvatar',
    key: 'none',
  },
  PostUserCurrent2faByProviderName: {
    category: 'user',
    entityType: 'User',
    action: 'EnableTwoFactor',
    key: 'none',
  },
  DeleteUserCurrent2faByProviderName: {
    category: 'user',
    entityType: 'User',
    action: 'DisableTwoFactor',
    key: 'none',
  },
  PostInstallSetup: { category: 'system', entityType: 'Install', action: 'Install', key: 'none' },
  PostPublishedCacheRebuild: {
    category: 'system',
    entityType: 'PublishedCache',
    action: 'Rebuild',
    key: 'none',
  },
  PostPublishedCacheReload: {
    category: 'system',
    entityType: 'PublishedCache',
    action: 'Reload',
    key: 'none',
  },
  PostModelsBuilderBuild: {
    category: 'system',
    entityType: 'ModelsBuilder',
    action: 'Build',
    key: 'none',
  },
  PostTelemetryLevel: {
    category: 'settings',
    entityType: 'Telemetry',
    action: 'Save',
    key: 'none',
  },
  PutProfilingStatus: {
    category: 'settings',
    entityType: 'Profiling',
    action: 'Save',
    key: 'none',
  },
  PostRedirectManagementStatus: {
    category: 'settings',
    entityType: 'RedirectManagement',
    action: 'SetStatus',
    key: 'none',
  },
  PostHealthCheckExecuteAction: {
    category: 'system',
    entityType: 'HealthCheck',
    action: 'Execute',
    key: 'none',
  },
  PostIndexerByIndexNameRebuild: {
    category: 'system',
    entityType: 'Index',
    action: 'Rebuild',
    key: 'param',
  },
  PostDocumentCreateAndPublish: {
    category: 'content',
    entityType: 'Document',
    action: 'CreateAndPublish',
    key: 'generated',
  },
  PostElementCreateAndPublish: {
    category: 'content',
    entityType: 'Element',
    action: 'CreateAndPublish',
    key: 'generated',
  },
  PostDocumentBlueprintFromDocument: {
    category: 'content',
    entityType: 'DocumentBlueprint',
    action: 'Create',
    key: 'generated',
  },
  PostDictionaryImport: {
    category: 'settings',
    entityType: 'DictionaryItem',
    action: 'Import',
    key: 'generated',
  },
}

/** Operation-name entity prefixes, longest first so `DocumentType` wins over `Document`. */
const ENTITIES: Array<[string, AuditCategory]> = [
  ['DocumentBlueprint', 'content'],
  ['DocumentVersion', 'content'],
  ['DocumentType', 'schema'],
  ['Document', 'content'],
  ['ElementVersion', 'content'],
  ['Element', 'content'],
  ['MediaType', 'schema'],
  ['Media', 'media'],
  ['MemberGroup', 'member'],
  ['MemberType', 'schema'],
  ['Member', 'member'],
  ['DataType', 'schema'],
  ['Template', 'schema'],
  ['PartialView', 'schema'],
  ['Script', 'schema'],
  ['Stylesheet', 'schema'],
  ['Language', 'settings'],
  ['Dictionary', 'settings'],
  ['LogViewerSavedSearch', 'settings'],
  ['RedirectManagement', 'settings'],
  ['PackageCreated', 'settings'],
  ['Package', 'system'],
  ['Webhook', 'settings'],
  ['UserGroup', 'permission'],
  ['User', 'user'],
]

const ENTITY_TYPE: Record<string, string> = {
  Dictionary: 'DictionaryItem',
  PackageCreated: 'Package',
  RedirectManagement: 'Redirect',
}

/** The part after the item's key, to the action it names; anything else is named as it reads. */
const SUFFIX_ACTION: Record<string, string> = {
  Move: 'Move',
  MoveToRecycleBin: 'Trash',
  Copy: 'Copy',
  Publish: 'Publish',
  Unpublish: 'Unpublish',
  UpdateAndPublish: 'SaveAndPublish',
  PublishWithDescendants: 'PublishWithDescendants',
  SortChildren: 'Sort',
  Domains: 'AssignDomains',
  Notifications: 'SetNotifications',
  Restore: 'Restore',
  Rollback: 'Rollback',
  PreventCleanup: 'PreventCleanup',
  Import: 'Import',
  Rename: 'Rename',
  Template: 'CreateTemplate',
  ChangePassword: 'ChangePassword',
  ResetPassword: 'ResetPassword',
  RunMigration: 'RunMigration',
  Patch: 'Save',
}

const KEY_SEGMENT = /^By(Id|Path|IsoCode|Name|IndexName)/

const plans = new Map<string, AuditPlan | null>()

/** The audit entry an operation writes when it succeeds, or undefined for one that changes nothing. */
export function auditPlanFor(operationId: string): AuditPlan | undefined {
  if (plans.has(operationId)) return plans.get(operationId) ?? undefined
  const plan = derive(operationId)
  plans.set(operationId, plan ?? null)
  return plan
}

function derive(operationId: string): AuditPlan | undefined {
  if (NOT_AUDITED.has(operationId) || /Validate$/.test(operationId)) return undefined
  const exception = EXCEPTIONS[operationId]
  if (exception) return exception
  const verb = /^(Post|Put|Delete|Patch)(.+)$/.exec(operationId)
  if (!verb) return undefined
  const method = verb[1] as string
  let rest = verb[2] as string
  const recycleBin = rest.startsWith('RecycleBin')
  if (recycleBin) rest = rest.slice('RecycleBin'.length)
  const found = ENTITIES.find(([name]) => rest.startsWith(name))
  if (!found) return undefined
  const [entity, category] = found
  let after = rest.slice(entity.length)
  let entityType = ENTITY_TYPE[entity] ?? entity
  if (after.startsWith('Folder')) {
    entityType = `${entityType}Folder`
    after = after.slice('Folder'.length)
  }
  const keyed = KEY_SEGMENT.exec(after)
  if (keyed) after = after.slice(keyed[0].length)

  if (recycleBin && method === 'Delete' && !keyed)
    return { category, entityType, action: 'EmptyRecycleBin', key: 'none' }
  if (after === '') {
    const action = method === 'Post' ? 'Create' : method === 'Delete' ? 'Delete' : 'Save'
    return { category, entityType, action, key: keyed ? 'param' : 'generated' }
  }
  return {
    category: after === 'PublicAccess' ? 'permission' : category,
    entityType,
    action: actionFor(method, after),
    key: keyed ? 'param' : 'none',
  }
}

function actionFor(method: string, after: string): string {
  const mapped = SUFFIX_ACTION[after]
  if (mapped) return mapped
  const add = method === 'Delete' ? 'Remove' : method === 'Post' ? 'Add' : 'Set'
  if (after === 'PublicAccess') return `${add}PublicAccess`
  if (after === 'Avatar') return `${add}Avatar`
  if (after.startsWith('ClientCredentials')) return `${add}ClientCredentials`
  if (after.startsWith('2fa')) return 'DisableTwoFactor'
  return `${method}${after}`
}

/** Whether the router must read the request body for this operation's keys before the handler does. */
export function auditReadsBody(plan: AuditPlan): boolean {
  return typeof plan.key === 'function' || plan.related !== undefined
}

/** Whether the item must be named before the handler runs, because it will be gone after. */
export function auditNamesFirst(plan: AuditPlan): boolean {
  return plan.action === 'Delete' || plan.action === 'Trash'
}

/** The entries for a successful operation, keyed but not yet named. */
export function auditDrafts(
  plan: AuditPlan,
  params: Readonly<Record<string, string>>,
  response: Response,
  body: unknown,
): AuditDraft[] {
  const base = { category: plan.category, action: plan.action, entityType: plan.entityType }
  if (typeof plan.key === 'function')
    return plan.key(body).map((key) => ({ ...base, entityKey: key }))
  if (plan.key === 'none') return [{ ...base, entityKey: null }]
  const key =
    plan.key === 'generated'
      ? response.headers.get('umb-generated-resource')
      : (params.id ?? params.path ?? params.isoCode ?? params.name ?? params.indexName)
  return [{ ...base, entityKey: key ?? null }]
}
