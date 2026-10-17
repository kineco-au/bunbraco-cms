/**
 * Umbraco's notifications dialog, on a site that cannot send e-mail (story
 * 045): a banner saying so, and every toggle disabled, rather than choices
 * saved for e-mails that never come.
 *
 * The dialog is not an extension point and its class is not exported, so it is
 * patched rather than replaced, as the log viewer's menu is: once the element
 * is defined, each update disables its toggles and Save and puts the banner
 * above them. `tests/notifications-dialog.test.ts` pins the vendored dialog
 * this relies on, so a re-vendor that moves it fails the suite rather than the
 * editor. The server refuses a new subscription regardless.
 */
const TAG = 'umb-document-notifications-modal'
export const BANNER_CLASS = 'crombolo-notifications-unavailable'
export const UNAVAILABLE =
  "This site can't send e-mail yet, so it can't tell you when this page changes. Ask an administrator to set up e-mail, then come back to choose what to hear about."

/** Whether this site can send notification e-mails; asked once per page load. */
let answer
export function canSendNotifications(fetcher = fetch) {
  answer ??= (async () => {
    const href = document.querySelector('base')?.getAttribute('href') ?? '/umbraco/'
    const response = await fetcher(`${href.replace(/\/$/, '')}/crombolo/api/email`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    // Unknown is not unavailable: Umbraco's dialog stays as it is.
    if (!response.ok) return true
    return (await response.json()).canSendNotifications !== false
  })().catch(() => true)
  return answer
}

/** Disables the dialog's choices and says why. Safe to call on every update. */
export function markUnavailable(root, message = UNAVAILABLE) {
  for (const toggle of root.querySelectorAll('uui-toggle')) toggle.disabled = true
  for (const button of root.querySelectorAll('uui-button[color="positive"]')) button.disabled = true
  const box = root.querySelector('uui-box')
  if (!box || box.querySelector(`.${BANNER_CLASS}`)) return
  const banner = box.ownerDocument.createElement('p')
  banner.className = BANNER_CLASS
  banner.setAttribute('role', 'status')
  banner.setAttribute(
    'style',
    'margin: 0 0 var(--uui-size-space-4); color: var(--uui-color-text-alt);',
  )
  banner.textContent = message
  box.prepend(banner)
}

export const onInit = async () => {
  // The dialog is loaded the first time someone opens it.
  const element = await customElements.whenDefined(TAG)
  const prototype = element.prototype
  const original = prototype.updated
  prototype.updated = function patched(changed) {
    original?.call(this, changed)
    void canSendNotifications().then((ok) => {
      if (!ok && this.renderRoot) markUnavailable(this.renderRoot)
    })
  }
}
