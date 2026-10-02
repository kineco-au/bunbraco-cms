/**
 * The paths the vendored client hard-codes.
 *
 * Umbraco's `UmbracoPath` moves the editor, not its API: the Management API is
 * declared by the contract and the client's generated SDK calls it at
 * `/umbraco/management/api/v1/...` however the backoffice is mounted. The two
 * SignalR hubs are built the same way in the client's own source. So these stay
 * put while `backOfficePath` moves the shell, the login page, the static assets
 * and the SPA's own routes.
 */
export const MANAGEMENT_API_PREFIX = '/umbraco/management/api/'

export const MANAGEMENT_API_PATH = `${MANAGEMENT_API_PREFIX}v1`

/** `server-event.context.js`: `${serverURL}/umbraco/serverEventHub`. */
export const SERVER_EVENT_HUB_PATH = '/umbraco/serverEventHub'

/** `preview.context.js`: `${serverUrl}/umbraco/PreviewHub`. */
export const PREVIEW_HUB_PATH = '/umbraco/PreviewHub'

/** Where the editor is mounted unless a site overrides `backOfficePath`. */
export const DEFAULT_BACKOFFICE_PATH = '/bunbraco'
