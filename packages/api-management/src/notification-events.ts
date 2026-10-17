/**
 * Which of Umbraco's eleven notification actions a Management API operation
 * performs, and on which item (story 045). Pure: the router hands the server
 * what it says, and the server finds who asked to hear of it.
 */

/** What a successful operation did, for the people subscribed to its page. */
export interface RaisedContentChange {
  /** `Umb.Document.Publish` and the rest; create-and-publish is two. */
  actions: string[]
  /** The item it names: a document's key, or for a rollback the version's. */
  key: string
  keyKind: 'document' | 'version'
  /** A branch publish: one change for the page, "and the pages under it". */
  withDescendants?: boolean
}

interface Mapping {
  actions: string[]
  from: 'created' | 'id' | 'body-parent'
  /** A publish that only sets a schedule publishes nothing yet: the job notifies when it does. */
  scheduleOnly?: boolean
  keyKind?: 'document' | 'version'
  withDescendants?: boolean
}

const CREATE = 'Umb.Document.Create'
const UPDATE = 'Umb.Document.Update'
const PUBLISH = 'Umb.Document.Publish'

const BY_OPERATION: Record<string, Mapping> = {
  PostDocument: { actions: [CREATE], from: 'created' },
  PostDocumentCreateAndPublish: { actions: [CREATE, PUBLISH], from: 'created' },
  PutDocumentById: { actions: [UPDATE], from: 'id' },
  PutDocumentByIdUpdateAndPublish: { actions: [UPDATE, PUBLISH], from: 'id' },
  PutDocumentByIdPublish: { actions: [PUBLISH], from: 'id', scheduleOnly: true },
  PutDocumentByIdPublishWithDescendants: {
    actions: [PUBLISH],
    from: 'id',
    withDescendants: true,
  },
  PutDocumentByIdMoveToRecycleBin: { actions: ['Umb.Document.Delete'], from: 'id' },
  PutDocumentByIdMove: { actions: ['Umb.Document.Move'], from: 'id' },
  // Notified on the original, as Umbraco does.
  PostDocumentByIdCopy: { actions: ['Umb.Document.Duplicate'], from: 'id' },
  // Notified on the parent whose children were sorted; sorting at the root notifies nobody.
  PutDocumentByIdSortChildren: { actions: ['Umb.Document.Sort'], from: 'id' },
  PutDocumentSort: { actions: ['Umb.Document.Sort'], from: 'body-parent' },
  PostDocumentVersionByIdRollback: {
    actions: ['Umb.Document.Rollback'],
    from: 'id',
    keyKind: 'version',
  },
  PutRecycleBinDocumentByIdRestore: { actions: ['Umb.DocumentRecycleBin.Restore'], from: 'id' },
  PostDocumentByIdPublicAccess: { actions: ['Umb.Document.PublicAccess'], from: 'id' },
  PutDocumentByIdPublicAccess: { actions: ['Umb.Document.PublicAccess'], from: 'id' },
  DeleteDocumentByIdPublicAccess: { actions: ['Umb.Document.PublicAccess'], from: 'id' },
}

/** Whether the router has to keep the request body for this operation. */
export const changeReadsBody = (operationId: string): boolean =>
  BY_OPERATION[operationId]?.from === 'body-parent' ||
  BY_OPERATION[operationId]?.scheduleOnly === true

/** Whether every culture in a publish request is scheduled for later rather than published now. */
const onlySchedules = (body: unknown): boolean => {
  const schedules = (
    body as { publishSchedules?: Array<{ schedule?: { publishTime?: unknown } | null }> }
  )?.publishSchedules
  return (
    Array.isArray(schedules) &&
    schedules.length > 0 &&
    schedules.every((entry) => Boolean(entry?.schedule?.publishTime))
  )
}

/** The change a successful operation made, if it is one anybody can subscribe to. */
export function contentChangeFor(
  operationId: string,
  params: Readonly<Record<string, string>>,
  response: Pick<Response, 'status' | 'headers'>,
  body: unknown,
): RaisedContentChange | undefined {
  if (response.status < 200 || response.status >= 300) return undefined
  const mapping = BY_OPERATION[operationId]
  if (!mapping) return undefined
  if (mapping.scheduleOnly && onlySchedules(body)) return undefined
  const key =
    mapping.from === 'created'
      ? response.headers.get('umb-generated-resource')
      : mapping.from === 'body-parent'
        ? ((body as { parent?: { id?: unknown } | null } | undefined)?.parent?.id as
            | string
            | undefined)
        : params.id
  if (!key) return undefined
  return {
    actions: mapping.actions,
    key: key.toLowerCase(),
    keyKind: mapping.keyKind ?? 'document',
    ...(mapping.withDescendants ? { withDescendants: true } : {}),
  }
}
