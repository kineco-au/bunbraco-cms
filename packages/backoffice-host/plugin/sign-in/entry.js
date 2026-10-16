/**
 * Puts crombolo's sign-in dialog in place of the client's. The client opens
 * `Umb.Modal.AppAuth` when a session ends while the backoffice is open, and
 * draws it before any private manifest has loaded — so it is replaced from a
 * public app entry point, which the client runs before it routes.
 *
 * Re-registered under the same alias rather than through `overwrites`: the
 * modal is looked up with `byTypeAndAlias`, which does not resolve overwrites.
 */
export const DIALOG_ALIAS = 'Umb.Modal.AppAuth'

export const onInit = (_host, extensionRegistry) => {
  extensionRegistry.unregister(DIALOG_ALIAS)
  extensionRegistry.register({
    type: 'modal',
    alias: DIALOG_ALIAS,
    name: 'Crombolo Sign-in Dialog',
    element: () => import('./sign-in-dialog.js'),
  })
}
