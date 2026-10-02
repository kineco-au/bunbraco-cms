/**
 * The System information modal, reached from the header logo popover.
 *
 * It names the product in four places that no localisation key covers: three
 * row labels built as plain strings in `sysinfo.element.js`, and the heading it
 * puts above the text it copies to the clipboard.
 *
 * The rows are corrected at their source rather than in the DOM. The element
 * assembles every row into one string and assigns it to `_systemInformation`, a
 * lit reactive property, so wrapping that property's setter corrects the rows
 * before they are ever rendered — no observer, and no reaching into a shadow
 * root. The clipboard heading is prepended inside a private method that nothing
 * can reach, so that one is taken on the way out to the clipboard instead.
 */

/**
 * The exact phrases to correct. Spelled out rather than replacing the product
 * name wherever it appears, because the same text carries the browser's user
 * agent and the current URL — a blanket replacement would rewrite whatever a
 * site happens to have in its address.
 */
const PHRASES = [
  'Umbraco build version',
  'Umbraco assembly version',
  'Umbraco client version',
  'Umbraco system information',
]

/** A fixed point: its own output contains none of the phrases, so re-applying it changes nothing. */
export function rebrandSysinfo(text) {
  if (typeof text !== 'string') return text
  let corrected = text
  for (const phrase of PHRASES) {
    corrected = corrected.replaceAll(phrase, phrase.replace('Umbraco', 'Bunbraco'))
  }
  return corrected
}

/** True when the string is the modal's clipboard payload rather than someone's own copy. */
export function isSysinfoClipboardText(text) {
  return typeof text === 'string' && text.includes('Umbraco system information')
}

/**
 * Wraps the reactive property's setter. Does nothing at all if the accessor is
 * not where lit puts it, so an upstream change costs the correction and never
 * an error.
 */
function patchRows(element) {
  const accessor = Object.getOwnPropertyDescriptor(element?.prototype ?? {}, '_systemInformation')
  if (!accessor?.get || !accessor?.set) return false
  Object.defineProperty(element.prototype, '_systemInformation', {
    ...accessor,
    get() {
      return accessor.get.call(this)
    },
    set(value) {
      accessor.set.call(this, rebrandSysinfo(value))
    },
  })
  return true
}

/**
 * Corrects the heading on its way to the clipboard. Installed only once the
 * modal's element exists — so a session that never opens System information
 * never patches anything — and it passes every other string through untouched.
 */
function patchClipboard() {
  const clipboard = navigator.clipboard
  if (typeof clipboard?.writeText !== 'function') return
  const write = clipboard.writeText.bind(clipboard)
  try {
    clipboard.writeText = (text) =>
      write(isSysinfoClipboardText(text) ? rebrandSysinfo(text) : text)
  } catch {
    // A read-only `writeText` leaves the copied heading stale, which is the
    // one thing here worth less than a working copy button.
  }
}

export const onInit = () => {
  customElements
    .whenDefined('umb-sysinfo')
    .then((element) => {
      if (patchRows(element)) patchClipboard()
    })
    .catch(() => {})
}
