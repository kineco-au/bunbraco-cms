/**
 * The two labels Umbraco's bundle builder hard-codes.
 *
 * The builder workspace is vendored and its copy is English in the template
 * rather than dictionary keys, so there is no key to override: `Name of the
 * package` labels the name input and `Package Content` heads the picker box.
 * Everything else in that screen is already a key or a field name.
 *
 * Corrected after the element's first render, the same way the client
 * credential dialog's prefix is, because both strings are written by the
 * element's own template and there is nothing further upstream to intercept.
 *
 * Does nothing if upstream changes either string, so the cost of a vendor bump
 * is the correction and never an error — `tests/bundles-backoffice.test.ts`
 * asserts both are still there to correct.
 */

/** Vendored text to the text that replaces it. */
export const BUILDER_LABELS = [
  ['Name of the package', 'Name of the bundle'],
  ['Package Content', 'Bundle content'],
]

/** The replacement for a vendored string, or undefined when it is not one of ours. */
export function correctionFor(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  return BUILDER_LABELS.find(([before]) => before === trimmed)?.[1]
}

function correct(root) {
  const input = root?.querySelector('#package-name-input')
  const label = correctionFor(input?.getAttribute('label'))
  if (label) input.setAttribute('label', label)

  for (const box of root?.querySelectorAll('uui-box') ?? []) {
    const headline = correctionFor(box.getAttribute('headline'))
    if (headline) box.setAttribute('headline', headline)
  }
}

/**
 * Wraps the element's own `updated`, not `firstUpdated`: the builder renders
 * its header before the definition has loaded and fills it in afterwards, so a
 * one-shot correction would run against a template that is not there yet.
 */
function patch(element) {
  const proto = element?.prototype
  const original = proto?.updated
  if (typeof original !== 'function') return false
  proto.updated = function updated(changed) {
    original.call(this, changed)
    correct(this.shadowRoot)
  }
  return true
}

export const onInit = () => {
  customElements
    .whenDefined('umb-workspace-package-builder')
    .then(patch)
    .catch(() => {})
}
