/**
 * The server events a successful change announces, as Umbraco's notification
 * handlers do. The backoffice caches entity details while connected to the
 * event hub and drops a cached entity only when an event names it, so a change
 * that announces nothing leaves every open editor, including the one that made
 * it, showing the old copy.
 */
import type { OperationInfo } from '@bunbraco/contracts'

export type ServerEventType = 'Created' | 'Updated' | 'Deleted' | 'Trashed'

export interface ServerEvent {
  eventSource: string
  eventType: ServerEventType
  key: string
}

/** Operation-name entity prefixes, longest first so `DocumentType` wins over `Document`. */
const ENTITIES = [
  'DocumentBlueprint',
  'DocumentType',
  'Document',
  'MediaType',
  'Media',
  'MemberGroup',
  'MemberType',
  'Member',
  'DataType',
  'Language',
  'Script',
  'Stylesheet',
  'Template',
  'DictionaryItem',
  'PartialView',
  'UserGroup',
  'User',
  'Webhook',
] as const

/** Operations on an entity that change nothing about it, or are about something else. */
const NOT_A_CHANGE = /^(Folder|Validate|ByIdValidate|Item|Tree|Filter|Search|Current|Configuration)/

export function serverEventFor(
  operation: OperationInfo,
  params: Readonly<Record<string, string>>,
  response: Response,
): ServerEvent | undefined {
  if (response.status < 200 || response.status >= 300) return undefined
  const verb = /^(Post|Put|Delete)(.+)$/.exec(operation.operationId)
  if (!verb) return undefined
  const [, method, verbRest] = verb as unknown as [string, string, string]
  // `DeleteRecycleBinMediaById` deletes a media item; `…ByIdRestore` updates one.
  const rest = verbRest.startsWith('RecycleBin') ? verbRest.slice('RecycleBin'.length) : verbRest
  const entity = ENTITIES.find((name) => rest.startsWith(name))
  if (!entity) return undefined
  const after = rest.slice(entity.length)
  if (NOT_A_CHANGE.test(after)) return undefined

  const generated = response.headers.get('umb-generated-resource')
  const key = generated ?? params.id ?? params.isoCode ?? params.path
  if (!key) return undefined
  const eventType: ServerEventType =
    method === 'Delete'
      ? 'Deleted'
      : after.endsWith('MoveToRecycleBin')
        ? 'Trashed'
        : generated
          ? 'Created'
          : 'Updated'
  return { eventSource: `Umbraco:CMS:${entity}`, eventType, key }
}
