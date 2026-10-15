/**
 * The webhook events this site raises, and which Management API operation
 * raises each. Aliases are Umbraco's, so the backoffice's event picker and an
 * imported site's choices mean the same thing. docs/webhooks.md.
 */

export type WebhookEventType = 'Content' | 'Media'

export interface WebhookEventInfo {
  alias: string
  eventName: string
  eventType: WebhookEventType
}

export const WEBHOOK_EVENTS: readonly WebhookEventInfo[] = [
  { alias: 'Umbraco.ContentSaved', eventName: 'Content Saved', eventType: 'Content' },
  { alias: 'Umbraco.ContentPublish', eventName: 'Content Published', eventType: 'Content' },
  { alias: 'Umbraco.ContentUnpublish', eventName: 'Content Unpublished', eventType: 'Content' },
  { alias: 'Umbraco.ContentDelete', eventName: 'Content Deleted', eventType: 'Content' },
  {
    alias: 'Umbraco.ContentMovedToRecycleBin',
    eventName: 'Content Moved to Recycle Bin',
    eventType: 'Content',
  },
  { alias: 'Umbraco.ContentMoved', eventName: 'Content Moved', eventType: 'Content' },
  { alias: 'Umbraco.ContentCopied', eventName: 'Content Copied', eventType: 'Content' },
  { alias: 'Umbraco.MediaSave', eventName: 'Media Saved', eventType: 'Media' },
  { alias: 'Umbraco.MediaDelete', eventName: 'Media Deleted', eventType: 'Media' },
]

export const WEBHOOK_EVENT_ALIASES: ReadonlySet<string> = new Set(
  WEBHOOK_EVENTS.map((event) => event.alias),
)

/** Something happened to one item: what, and to which. */
export interface RaisedWebhookEvent {
  alias: string
  key: string
}

const BY_OPERATION: Record<string, string> = {
  PostDocument: 'Umbraco.ContentSaved',
  PutDocumentById: 'Umbraco.ContentSaved',
  PutDocumentByIdPublish: 'Umbraco.ContentPublish',
  PutDocumentByIdPublishWithDescendants: 'Umbraco.ContentPublish',
  PostDocumentCreateAndPublish: 'Umbraco.ContentPublish',
  PutDocumentByIdUpdateAndPublish: 'Umbraco.ContentPublish',
  PutDocumentByIdUnpublish: 'Umbraco.ContentUnpublish',
  DeleteDocumentById: 'Umbraco.ContentDelete',
  DeleteRecycleBinDocumentById: 'Umbraco.ContentDelete',
  PutDocumentByIdMoveToRecycleBin: 'Umbraco.ContentMovedToRecycleBin',
  PutDocumentByIdMove: 'Umbraco.ContentMoved',
  PostDocumentByIdCopy: 'Umbraco.ContentCopied',
  PostMedia: 'Umbraco.MediaSave',
  PutMediaById: 'Umbraco.MediaSave',
  DeleteMediaById: 'Umbraco.MediaDelete',
  DeleteRecycleBinMediaById: 'Umbraco.MediaDelete',
}

/**
 * The event a successful operation raises, if any. Pure. The item is the one
 * the operation created (its generated-resource header) or the one it names.
 */
export function webhookEventFor(
  operationId: string,
  params: Readonly<Record<string, string>>,
  response: Pick<Response, 'status' | 'headers'>,
): RaisedWebhookEvent | undefined {
  if (response.status < 200 || response.status >= 300) return undefined
  const alias = BY_OPERATION[operationId]
  if (!alias) return undefined
  const key = response.headers.get('umb-generated-resource') ?? params.id
  return key ? { alias, key: key.toLowerCase() } : undefined
}
