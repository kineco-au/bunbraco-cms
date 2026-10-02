/**
 * The prefix label in the Create client credential dialog.
 *
 * The dialog prints the required prefix in a decorative `prepend` beside the Id
 * input, and submits the input's value whole — so an administrator reads that
 * label and types the prefix themselves. It is hardcoded in the vendored element
 * as a private field, and it names the prefix the server rejected as of
 * migration 020, which makes a stale label a dialog nobody can complete.
 *
 * Corrected after the element's first render rather than in its template: the
 * prepend is built inside a private method, so there is nothing to intercept
 * further upstream.
 */

/** Must match `CLIENT_ID_PREFIX` in packages/server/src/adapters/users.ts. */
export const REQUIRED_PREFIX = 'bunbraco-back-office-'

/** True for the vendored label, and false for anything a correction produced. */
export function needsCorrection(text) {
  return typeof text === 'string' && text.trim() === 'umbraco-back-office-'
}

function correct(root) {
  const prepend = root?.querySelector('.prepend')
  if (prepend && needsCorrection(prepend.textContent)) prepend.textContent = REQUIRED_PREFIX
}

/**
 * Wraps the element's own `firstUpdated`, which the vendored class defines and
 * which runs once the prepend exists. Does nothing if it is not there, so an
 * upstream change costs the correction and never an error.
 */
function patch(element) {
  const proto = element?.prototype
  const original = proto?.firstUpdated
  if (typeof original !== 'function') return false
  proto.firstUpdated = function firstUpdated(changed) {
    original.call(this, changed)
    correct(this.shadowRoot)
  }
  return true
}

export const onInit = () => {
  customElements
    .whenDefined('umb-create-user-client-credential-modal')
    .then(patch)
    .catch(() => {})
}
